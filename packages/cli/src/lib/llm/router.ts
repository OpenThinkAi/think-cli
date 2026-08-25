/**
 * LLM routing: which provider serves a given operation, and what happens when
 * it can't.
 *
 * Two modes, chosen by config:
 *
 *   REGISTRY (cortex.llm.providers set) — provider-agnostic. Any number of
 *   named providers, each an OpenAI-compatible endpoint or the Anthropic SDK,
 *   selected per operation. This is the general case.
 *
 *   LEGACY (cortex.llmProvider + cortex.local) — the original two-provider
 *   local-first policy. Still supported verbatim; bridged onto the same
 *   primitives. Registry config wins when both are present.
 *
 * The invariant both modes share, and the reason this file owns consent:
 *
 *   **Consent is gated on data egress, not on provider identity.**
 *
 * Any provider that sends cortex content off this machine requires LLM consent
 * before a single byte leaves — whether that is Anthropic, OpenAI, DeepSeek, or
 * an OpenAI-compatible endpoint on someone else's hardware. Egress was
 * previously inferred from "is this the Anthropic client?", which held only
 * while exactly two providers existed. Pointing the so-called "local" client at
 * a public API bypassed the gate entirely.
 *
 * "SKIP" throughout is an `LlmSkippedError` the caller catches to leave work
 * pending — never a hard failure, never an un-consented send. Transport errors
 * from a configured server (down, 5xx) are NOT overflow and do not silently
 * reroute: a misconfigured backend is a loud problem, not a quiet reroute of
 * on-device content to the cloud.
 */

import { getConfig, type LocalLlmConfig, type LlmConfig, type LlmProviderConfig } from '../config.js';
import { getThinkConfigDir } from '../paths.js';
import path from 'node:path';
import { hasLlmConsent } from '../llm-consent.js';
import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmContextOverflowError,
  LlmSkippedError,
  LlmUnavailableError,
  LlmTimeoutError,
  estimateTokens,
} from './client.js';
import { OpenAiCompatibleLlmClient, DEFAULT_TIMEOUT_MS } from './openai-compatible.js';
import { AnthropicLlmClient } from './anthropic.js';

/** Legacy provider selector. Retained for `cortex.llmProvider`. */
export type LlmProvider = 'auto' | 'local' | 'anthropic';

/** Resolved, env-overlaid local-LLM settings (legacy path). */
export interface ResolvedLocalConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  ctxBudget: number;
  timeoutMs?: number;
  disableThinking?: boolean;
}

export const DEFAULT_CTX_BUDGET = 28_000;

/** Operation names used for per-operation provider selection. */
export const OP_CURATION = 'curation';
export const OP_EVENT_DETECTION = 'event-detection';

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

// `0.0.0.0` is a bind address, not really a connect address, but people do put
// it in endpoint URLs after copying a server's listen line — and connecting to
// it reaches the local host. Treating it as loopback matches what actually
// happens on the wire; omitting it would demand consent for a purely local call.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/**
 * Does sending to `endpoint` put cortex content on the network?
 *
 * Loopback only is treated as on-machine. Anything else — including a box on
 * your own LAN — is off-machine unless the operator says otherwise via an
 * explicit `offMachine: false`. Default-deny: the cost of a wrong `false` is a
 * silent, irreversible disclosure of the user's entire memory store; the cost
 * of a wrong `true` is one consent prompt.
 *
 * An unparseable endpoint is treated as off-machine for the same reason.
 */
export function inferOffMachine(endpoint: string): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return !LOOPBACK_HOSTS.has(host);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** A provider config with every default applied and env overlaid. */
export interface ResolvedProvider {
  name: string;
  kind: 'openai' | 'anthropic';
  endpoint: string;
  model: string;
  apiKey: string;
  offMachine: boolean;
  ctxBudget: number;
  timeoutMs: number;
  disableThinking: boolean;
}

function intFromEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Resolve one registry entry, applying defaults and inferring egress. */
export function resolveProviderConfig(name: string, cfg: LlmProviderConfig): ResolvedProvider {
  const endpoint = (cfg.endpoint ?? '').trim();
  const apiKey =
    (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? cfg.apiKey ?? 'lm-studio';
  // Anthropic always leaves the machine. For everything else, honour an
  // explicit declaration and otherwise infer from the endpoint host.
  const offMachine = cfg.kind === 'anthropic' ? true : cfg.offMachine ?? inferOffMachine(endpoint);
  return {
    name,
    kind: cfg.kind,
    endpoint,
    model: (cfg.model ?? '').trim(),
    apiKey: apiKey.trim(),
    offMachine,
    ctxBudget: cfg.ctxBudget ?? DEFAULT_CTX_BUDGET,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    disableThinking: cfg.disableThinking ?? false,
  };
}

/** Build the full registry from `cortex.llm`. Empty when unconfigured. */
export function resolveRegistry(cfg?: LlmConfig): Map<string, ResolvedProvider> {
  const out = new Map<string, ResolvedProvider>();
  for (const [name, p] of Object.entries(cfg?.providers ?? {})) {
    out.set(name, resolveProviderConfig(name, p));
  }
  return out;
}

/**
 * Pick the provider name for `operation`: an explicit per-operation mapping,
 * else `default`, else the sole provider when exactly one is registered.
 *
 * `THINK_LLM_PROVIDER` overrides when it names a registered provider. NOTE the
 * split semantics: in LEGACY mode that variable takes `auto|local|anthropic`,
 * but here it must name a provider in the registry. A shell profile carrying
 * the legacy value is ignored (with a warning) rather than silently honoured,
 * because `local` is not a provider name unless the user made one.
 */
export function selectProviderName(
  operation: string,
  cfg: LlmConfig | undefined,
  registry: Map<string, ResolvedProvider>,
  warn: (msg: string) => void = defaultWarn,
): string | undefined {
  const envName = process.env.THINK_LLM_PROVIDER?.trim();
  if (envName && registry.has(envName)) return envName;
  // THINK_LLM_PROVIDER has split semantics: in LEGACY mode it takes
  // 'auto'|'local'|'anthropic'; here it must name a registered provider. A
  // profile carrying the legacy value would otherwise be silently ignored the
  // moment a registry is configured, which looks like the registry misbehaving.
  if (envName && envName !== 'auto') {
    warn(
      `[think] THINK_LLM_PROVIDER="${envName}" does not name a provider in cortex.llm.providers ` +
        `(${[...registry.keys()].join(', ') || 'none'}) — ignoring it. In registry mode this variable ` +
        'must match a provider name, not the legacy "local"/"anthropic" values.',
    );
  }
  const mapped = cfg?.operations?.[operation];
  if (mapped) return mapped;
  if (cfg?.default) return cfg.default;
  if (registry.size === 1) return [...registry.keys()][0];
  return undefined;
}

/** Instantiate the transport for a resolved provider. */
export function buildClient(p: ResolvedProvider): LlmClient {
  if (p.kind === 'anthropic') return new AnthropicLlmClient();
  return new OpenAiCompatibleLlmClient({
    endpoint: p.endpoint,
    model: p.model,
    apiKey: p.apiKey,
    timeoutMs: p.timeoutMs,
    disableThinking: p.disableThinking,
    label: p.name,
  });
}

// ---------------------------------------------------------------------------
// Legacy config bridge
// ---------------------------------------------------------------------------

/**
 * Merge `cortex.local` config with `THINK_LOCAL_*` env overrides. Env wins so
 * CI/agents can retarget without editing config. Empty `endpoint` means "no
 * local backend configured".
 */
export function resolveLocalConfig(cfg?: LocalLlmConfig): ResolvedLocalConfig {
  const env = process.env;
  return {
    endpoint: (env.THINK_LOCAL_ENDPOINT ?? cfg?.endpoint ?? '').trim(),
    model: (env.THINK_LOCAL_MODEL ?? cfg?.model ?? '').trim(),
    apiKey: (env.THINK_LOCAL_API_KEY ?? cfg?.apiKey ?? 'lm-studio').trim(),
    ctxBudget: intFromEnv(env.THINK_LOCAL_CTX_BUDGET) ?? cfg?.ctxBudget ?? DEFAULT_CTX_BUDGET,
    timeoutMs: intFromEnv(env.THINK_LOCAL_TIMEOUT_MS) ?? cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    disableThinking:
      env.THINK_LOCAL_DISABLE_THINKING != null
        ? /^(1|true|yes)$/i.test(env.THINK_LOCAL_DISABLE_THINKING.trim())
        : cfg?.disableThinking ?? false,
  };
}

/** Resolve the legacy provider: env wins, else config, else 'auto'. */
export function resolveProvider(configured?: LlmProvider): LlmProvider {
  const raw = (process.env.THINK_LLM_PROVIDER ?? configured ?? 'auto').trim();
  return raw === 'local' || raw === 'anthropic' ? raw : 'auto';
}

/** The slice of cortex config this module reads. */
export interface CortexConfigSlice {
  llmProvider?: LlmProvider;
  local?: LocalLlmConfig;
  llm?: LlmConfig;
}

/**
 * Will curation route to an OpenAI-compatible (typically smaller) model?
 * Decides whether `think curate` uses the two-pass split (tier A + event
 * detection) or the single combined Anthropic pass.
 *
 * Registry mode: true when the provider selected for `curation` is
 * `kind: 'openai'`. Legacy mode: the original local-first rule.
 */
export function isLocalCurationActive(cfg?: CortexConfigSlice): boolean {
  const registry = resolveRegistry(cfg?.llm);
  if (registry.size > 0) {
    // No warn sink: this is a probe, and the real routing call warns already.
    const name = selectProviderName(OP_CURATION, cfg?.llm, registry, () => {});
    const chosen = name ? registry.get(name) : undefined;
    return chosen?.kind === 'openai';
  }
  const provider = resolveProvider(cfg?.llmProvider);
  if (provider === 'anthropic') return false;
  if (provider === 'local') return true;
  const local = resolveLocalConfig(cfg?.local);
  return local.endpoint.length > 0 && local.model.length > 0;
}

// ---------------------------------------------------------------------------
// Shared failure shaping
// ---------------------------------------------------------------------------

/**
 * A timeout is a tuning problem, not an outage — say so, and name the knob.
 * Skipping (rather than throwing) keeps the established posture: leave the work
 * pending instead of failing a scheduled run.
 */
function timeoutSkip(e: LlmTimeoutError): LlmSkippedError {
  return new LlmSkippedError(
    `${e.message}\n` +
      '  The server was reachable — this was think giving up waiting, not the server failing.\n' +
      '  Raise "timeoutMs" for this provider (or THINK_LOCAL_TIMEOUT_MS) if the model is simply slow,\n' +
      '  or lower "cortex.curatorPromptCharCap" so each pass has less to chew through.',
  );
}

/**
 * Build the graceful-skip error for an unreachable server: the "is it running?"
 * prompt plus how to turn the backend off if it wasn't intended.
 */
function unavailableSkip(e: LlmUnavailableError): LlmSkippedError {
  return new LlmSkippedError(
    `can't reach your LLM server at ${e.endpoint} — is it running? (e.g. \`localqwen up\`)\n` +
      `  If you don't intend to use it, set "llmProvider": "anthropic" in ${configFilePath()}\n` +
      '  (or remove the cortex.local / cortex.llm block) to curate with Claude instead.',
  );
}

/**
 * The config file this install actually reads. Resolved at call time rather
 * than hardcoded: the location moves with THINK_HOME / XDG_CONFIG_HOME, and a
 * message naming the wrong file is worse than no path at all.
 */
function configFilePath(): string {
  return path.join(getThinkConfigDir(), 'config.json');
}

/** The consent refusal for a provider that would put content on the network. */
function egressSkip(p: { name: string; endpoint: string; kind: string }): LlmSkippedError {
  const where = p.kind === 'anthropic' ? 'Anthropic' : p.endpoint || p.name;
  return new LlmSkippedError(
    `provider "${p.name}" sends cortex content off this machine (${where}) and LLM consent ` +
      'has not been granted. Skipping — nothing was sent.\n' +
      `  Grant consent with THINK_LLM_CONSENT=1 (or "cortex.llmConsent": true in ${configFilePath()}),\n` +
      '  or point this operation at an on-device provider. If this endpoint IS on your machine,\n' +
      `  set "cortex.llm.providers.${p.name}.offMachine": false.`,
  );
}

// ---------------------------------------------------------------------------
// Registry router
// ---------------------------------------------------------------------------

export interface RegistryRouterOptions {
  operation: string;
  registry: Map<string, ResolvedProvider>;
  llm?: LlmConfig;
  /** Injectable for tests; defaults to `buildClient`. */
  clientFor?: (p: ResolvedProvider) => LlmClient;
  consent?: () => boolean;
  warn?: (msg: string) => void;
}

/**
 * Provider-agnostic router. Selects a provider for the operation, refuses to
 * send off-machine without consent, and applies the configured fallback when
 * the task doesn't fit.
 */
export class RegistryLlmClient implements LlmClient {
  readonly name = 'registry';
  constructor(private readonly opts: RegistryRouterOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { registry, llm, operation } = this.opts;
    const consent = this.opts.consent ?? hasLlmConsent;
    const clientFor = this.opts.clientFor ?? buildClient;

    const name = selectProviderName(operation, llm, registry, this.opts.warn ?? defaultWarn);
    const chosen = name ? registry.get(name) : undefined;
    if (!chosen) {
      throw new LlmSkippedError(
        `no LLM provider selected for operation "${operation}". Set cortex.llm.default, or ` +
          `cortex.llm.operations["${operation}"], to one of: ` +
          `${[...registry.keys()].join(', ') || '(none configured)'}.`,
      );
    }

    // Egress gate FIRST — before size checks, before any network call.
    if (chosen.offMachine && !consent()) throw egressSkip(chosen);

    if (chosen.kind === 'openai' && (!chosen.endpoint || !chosen.model)) {
      throw new LlmSkippedError(
        `provider "${chosen.name}" is missing ${!chosen.endpoint ? 'an endpoint' : 'a model'}. ` +
          'Set both on the provider in cortex.llm.providers.',
      );
    }

    const est = estimateTokens(req);
    if (est > chosen.ctxBudget) {
      return this.fallback(
        req,
        consent,
        clientFor,
        `task ~${est} tokens exceeds ${chosen.name}'s context budget ${chosen.ctxBudget}`,
      );
    }

    try {
      return await clientFor(chosen).complete(req);
    } catch (e) {
      if (e instanceof LlmTimeoutError) throw timeoutSkip(e);
      if (e instanceof LlmUnavailableError) throw unavailableSkip(e);
      if (e instanceof LlmContextOverflowError) {
        return this.fallback(
          req,
          consent,
          clientFor,
          `${chosen.name} rejected the task as too large (${e.message})`,
        );
      }
      throw e;
    }
  }

  private async fallback(
    req: LlmRequest,
    consent: () => boolean,
    clientFor: (p: ResolvedProvider) => LlmClient,
    reason: string,
  ): Promise<LlmResponse> {
    const fallbackName = this.opts.llm?.fallback;
    if (!fallbackName || fallbackName === 'skip') {
      throw new LlmSkippedError(`${reason}, and no fallback provider is configured. Skipping.`);
    }
    const fb = this.opts.registry.get(fallbackName);
    if (!fb) {
      throw new LlmSkippedError(
        `${reason}, and the configured fallback "${fallbackName}" is not a registered provider. Skipping.`,
      );
    }
    if (fb.offMachine && !consent()) {
      throw new LlmSkippedError(
        `${reason}. Fallback "${fb.name}" sends content off this machine and LLM consent has not ` +
          'been granted. Skipping — nothing was sent.',
      );
    }
    (this.opts.warn ?? defaultWarn)(`[think] ${reason}; falling back to provider "${fb.name}".`);
    try {
      return await clientFor(fb).complete(req);
    } catch (e) {
      if (e instanceof LlmTimeoutError) throw timeoutSkip(e);
      if (e instanceof LlmUnavailableError) throw unavailableSkip(e);
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy router (cortex.llmProvider + cortex.local)
// ---------------------------------------------------------------------------

export interface RouterOptions {
  provider: LlmProvider;
  local: ResolvedLocalConfig;
  /** Built lazily so a missing/invalid endpoint never throws until used. */
  localClient: () => LlmClient;
  anthropicClient: () => LlmClient;
  /** Consent probe — injectable for tests. */
  consent?: () => boolean;
  /** Warning sink — defaults to stderr. Injectable for tests. */
  warn?: (msg: string) => void;
}

export class RouterLlmClient implements LlmClient {
  readonly name = 'router';
  constructor(private readonly opts: RouterOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { provider, local } = this.opts;
    const consent = this.opts.consent ?? hasLlmConsent;

    if (provider === 'anthropic') {
      return this.opts.anthropicClient().complete(req);
    }

    const hasLocal = local.endpoint.length > 0 && local.model.length > 0;

    // Egress gate. `cortex.local` is named "local" but is just an endpoint —
    // pointing it at a public API must not bypass consent. Loopback is
    // on-machine and unaffected; this only bites a genuinely remote endpoint.
    if (hasLocal && inferOffMachine(local.endpoint) && !consent()) {
      throw egressSkip({ name: 'local', endpoint: local.endpoint, kind: 'openai' });
    }

    if (provider === 'local') {
      if (!hasLocal) {
        throw new LlmSkippedError(
          'llmProvider is "local" but no local endpoint/model is configured ' +
            '(set cortex.local.endpoint + cortex.local.model, or THINK_LOCAL_ENDPOINT/MODEL).',
        );
      }
      const est = estimateTokens(req);
      if (est > local.ctxBudget) {
        throw new LlmSkippedError(
          `task ~${est} tokens exceeds local context budget ${local.ctxBudget} and ` +
            'llmProvider is pinned to "local" (no cloud fallback). Skipping.',
        );
      }
      // Pinned local: a runtime overflow is also a skip, not a reroute.
      try {
        return await this.opts.localClient().complete(req);
      } catch (e) {
        if (e instanceof LlmTimeoutError) throw timeoutSkip(e);
        if (e instanceof LlmUnavailableError) throw unavailableSkip(e);
        if (e instanceof LlmContextOverflowError) {
          throw new LlmSkippedError(
            'local model rejected the task as too large and llmProvider is pinned ' +
              `to "local" (no cloud fallback). Skipping. (${e.message})`,
          );
        }
        throw e;
      }
    }

    // provider === 'auto'
    if (!hasLocal) {
      // Inert until opted in: behave exactly as pre-local-first think.
      return this.opts.anthropicClient().complete(req);
    }

    const est = estimateTokens(req);
    if (est > local.ctxBudget) {
      return this.fallbackOrSkip(
        req,
        consent,
        `task ~${est} tokens exceeds local context budget ${local.ctxBudget}`,
      );
    }

    try {
      return await this.opts.localClient().complete(req);
    } catch (e) {
      // Local server unreachable → graceful skip (NOT a cloud reroute, even in
      // auto with consent). Availability is not size: the user opted into local,
      // so a dead server means "try later", not "quietly bill Claude".
      if (e instanceof LlmTimeoutError) throw timeoutSkip(e);
      if (e instanceof LlmUnavailableError) throw unavailableSkip(e);
      if (e instanceof LlmContextOverflowError) {
        // Estimate said it fit; the server disagreed. Runtime backstop.
        return this.fallbackOrSkip(
          req,
          consent,
          `local model rejected the task as too large (${e.message})`,
        );
      }
      throw e; // other error — surface it, don't silently reroute.
    }
  }

  private async fallbackOrSkip(
    req: LlmRequest,
    consent: () => boolean,
    reason: string,
  ): Promise<LlmResponse> {
    if (consent()) {
      (this.opts.warn ?? defaultWarn)(
        `[think] local LLM can't handle this task (${reason}); falling back to Anthropic (consent granted).`,
      );
      return this.opts.anthropicClient().complete(req);
    }
    throw new LlmSkippedError(
      `${reason}, and Anthropic fallback is not available (LLM consent not granted). ` +
        'Skipping — set THINK_LLM_CONSENT=1 (or cortex.llmConsent) to allow the cloud fallback.',
    );
  }
}

function defaultWarn(msg: string): void {
  process.stderr.write(msg + '\n');
}

/**
 * Build the client for an operation from current config + env. Registry config
 * wins; otherwise the legacy local-first router. Clients are constructed lazily
 * so a config with no local endpoint never instantiates an OpenAI client.
 */
export function getDefaultLlmClient(operation: string = OP_CURATION): LlmClient {
  const cfg = getConfig().cortex as CortexConfigSlice | undefined;
  const registry = resolveRegistry(cfg?.llm);
  if (registry.size > 0) {
    return new RegistryLlmClient({ operation, registry, llm: cfg?.llm });
  }
  const local = resolveLocalConfig(cfg?.local);
  const provider = resolveProvider(cfg?.llmProvider);
  return new RouterLlmClient({
    provider,
    local,
    localClient: () =>
      new OpenAiCompatibleLlmClient({
        endpoint: local.endpoint,
        model: local.model,
        apiKey: local.apiKey,
        timeoutMs: local.timeoutMs,
        disableThinking: local.disableThinking,
        label: 'local',
      }),
    anthropicClient: () => new AnthropicLlmClient(),
  });
}

/**
 * RouterLlmClient — the local-first policy engine.
 *
 * Decision table (provider resolved from `cortex.llmProvider` / THINK_LLM_PROVIDER):
 *
 *   provider = 'anthropic'           → Anthropic, always.
 *   provider = 'local'               → local only. Too big / overflow → SKIP.
 *   provider = 'auto' (default):
 *       no local endpoint configured → Anthropic (legacy behaviour — inert).
 *       fits local ctx budget        → local; runtime overflow → fall back.
 *       over budget                  → fall back.
 *   fall back := consent? Anthropic : SKIP(warn)
 *
 * "SKIP" is an `LlmSkippedError` the caller catches to leave work pending —
 * never a hard failure, never an un-consented cloud send. Transport errors
 * from the local server (down, 5xx) are NOT overflow and bubble up unchanged:
 * local-first means a misconfigured local server is a loud problem, not a
 * silent reroute of on-device content to the cloud.
 */

import { getConfig, type LocalLlmConfig } from '../config.js';
import { hasLlmConsent } from '../llm-consent.js';
import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmContextOverflowError,
  LlmSkippedError,
  LlmUnavailableError,
  estimateTokens,
} from './client.js';
import { LocalLlmClient } from './local.js';
import { AnthropicLlmClient } from './anthropic.js';

export type LlmProvider = 'auto' | 'local' | 'anthropic';

/** Resolved, env-overlaid local-LLM settings. `endpoint`/`model` may be empty. */
export interface ResolvedLocalConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  ctxBudget: number;
}

export const DEFAULT_CTX_BUDGET = 28_000;

/**
 * Merge `cortex.local` config with `THINK_LOCAL_*` env overrides. Env wins so
 * CI/agents can retarget without editing config. Empty `endpoint` means "no
 * local backend configured".
 */
export function resolveLocalConfig(cfg?: LocalLlmConfig): ResolvedLocalConfig {
  const env = process.env;
  const ctxRaw = env.THINK_LOCAL_CTX_BUDGET;
  const ctxParsed = ctxRaw ? Number.parseInt(ctxRaw, 10) : NaN;
  return {
    endpoint: (env.THINK_LOCAL_ENDPOINT ?? cfg?.endpoint ?? '').trim(),
    model: (env.THINK_LOCAL_MODEL ?? cfg?.model ?? '').trim(),
    apiKey: (env.THINK_LOCAL_API_KEY ?? cfg?.apiKey ?? 'lm-studio').trim(),
    ctxBudget: Number.isFinite(ctxParsed) && ctxParsed > 0
      ? ctxParsed
      : cfg?.ctxBudget ?? DEFAULT_CTX_BUDGET,
  };
}

/** Resolve the provider: env `THINK_LLM_PROVIDER` wins, else config, else 'auto'. */
export function resolveProvider(configured?: LlmProvider): LlmProvider {
  const raw = (process.env.THINK_LLM_PROVIDER ?? configured ?? 'auto').trim();
  return raw === 'local' || raw === 'anthropic' ? raw : 'auto';
}

/**
 * Will curation route to the local model? Decides whether the curate command
 * uses the local two-pass split (tier A + event detection) or the single
 * combined Anthropic pass. True when the provider is pinned to `local`, or
 * `auto` with a local endpoint+model configured. Pinned `anthropic`, or `auto`
 * with no local endpoint, → false (single combined pass, unchanged behaviour).
 *
 * Reads config + env itself so callers don't have to thread the resolved
 * provider/local config through.
 */
export function isLocalCurationActive(cfg?: CortexConfigSlice): boolean {
  const provider = resolveProvider(cfg?.llmProvider);
  if (provider === 'anthropic') return false;
  if (provider === 'local') return true;
  const local = resolveLocalConfig(cfg?.local);
  return local.endpoint.length > 0 && local.model.length > 0;
}

/** The slice of cortex config this module reads. */
export interface CortexConfigSlice {
  llmProvider?: LlmProvider;
  local?: LocalLlmConfig;
}

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
        if (e instanceof LlmUnavailableError) throw unavailableSkip(e);
        if (e instanceof LlmContextOverflowError) {
          throw new LlmSkippedError(
            `local model rejected the task as too large and llmProvider is pinned ` +
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
      if (e instanceof LlmUnavailableError) throw unavailableSkip(e);
      if (e instanceof LlmContextOverflowError) {
        // Estimate said it fit; the server disagreed. Runtime backstop.
        return this.fallbackOrSkip(req, consent, `local model rejected the task as too large (${e.message})`);
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
 * Build the graceful-skip error for an unreachable local server: the
 * "is it running?" prompt plus how to turn local mode off if it wasn't
 * intended. The caller (commands/curate.ts) prints `LlmSkippedError.message`.
 */
function unavailableSkip(e: LlmUnavailableError): LlmSkippedError {
  return new LlmSkippedError(
    `can't reach your local LLM server at ${e.endpoint} — is it running? (e.g. \`localqwen up\`)\n` +
      '  If you don\'t intend to use a local model, set "llmProvider": "anthropic" in ' +
      '~/.config/think/config.json (or remove the cortex.local block) to curate with Claude instead.',
  );
}

/**
 * Build the default router from current config + env. Clients are constructed
 * lazily so a config with no local endpoint never instantiates a LocalLlmClient
 * (and a request that only ever hits Anthropic never reads local settings).
 */
export function getDefaultLlmClient(): LlmClient {
  const cfg = getConfig().cortex;
  const local = resolveLocalConfig(cfg?.local);
  const provider = resolveProvider(cfg?.llmProvider);
  return new RouterLlmClient({
    provider,
    local,
    localClient: () =>
      new LocalLlmClient({ endpoint: local.endpoint, model: local.model, apiKey: local.apiKey }),
    anthropicClient: () => new AnthropicLlmClient(),
  });
}

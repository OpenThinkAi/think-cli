/**
 * Check: every configured LLM provider endpoint is reachable
 * (AGT-1308 AC1, AC5).
 *
 * THIS CHECK SENDS NO CORTEX CONTENT. It is a liveness probe: an
 * unauthenticated GET of the provider's `/models` listing, with no prompt, no
 * memory text and no file contents in the request — and deliberately without
 * the provider's API key, since any HTTP response at all (including 401 or
 * 404) already proves the server answered. "Reachable" means the TCP/TLS
 * conversation completed, nothing more.
 *
 * WARN, NOT FAIL, WHEN A FALLBACK IS CONFIGURED. Pointing an operation at a
 * local server that is only sometimes up is a legitimate setup (the work Mac
 * runs compaction against a local model that is often down), and
 * `cortex.llm.fallback` is precisely the user saying "I know, go elsewhere".
 * Failing that machine's `think doctor` would train people to ignore the exit
 * code. Without a fallback there is nowhere for the work to go, so it fails.
 */

import { fetch as undiciFetch } from 'undici';
import { getConfig } from '../config.js';
import { resolveLocalConfig, resolveRegistry, type ResolvedProvider } from '../llm/router.js';
import { DEFAULT_TIMEOUT_MS } from '../llm/openai-compatible.js';
import { result, plural, type CheckResult } from './types.js';

export const LLM_PROVIDERS_CHECK_ID = 'llm-providers';

/**
 * Liveness probe deadline. Deliberately short and unrelated to a provider's
 * `timeoutMs` (15 minutes by default, sized for a 27B model's prefill): this
 * asks only whether something is listening, and `think doctor` must never
 * hang on a black-holed address.
 */
export const PROBE_TIMEOUT_MS = 3_000;

/** One provider's probe outcome. `skipped` covers transports with no
 *  liveness endpoint to ask. */
export interface ProviderProbe {
  name: string;
  status: 'reachable' | 'unreachable' | 'skipped';
  detail: string;
}

export interface LlmProvidersOptions {
  /** Providers to probe. Defaults to the configured registry (see below). */
  providers?: ResolvedProvider[];
  /**
   * Whether `cortex.llm.fallback` names somewhere to go. `'skip'` is not a
   * fallback — it means "leave the work pending" — so it does not soften the
   * status.
   */
  hasFallback?: boolean;
  /** Probe seam. Tests MUST inject; the default opens a real connection. */
  probe?: (provider: ResolvedProvider, timeoutMs: number) => Promise<ProviderProbe>;
  /** Per-probe deadline in ms. */
  timeoutMs?: number;
}

export async function checkLlmProviders(
  options: LlmProvidersOptions = {},
): Promise<CheckResult> {
  const providers = options.providers ?? configuredProviders();
  const hasFallback = options.hasFallback ?? configuredFallback();
  const probe = options.probe ?? probeProviderEndpoint;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (providers.length === 0) {
    return result(
      LLM_PROVIDERS_CHECK_ID,
      'pass',
      'No LLM provider configured.',
    );
  }

  // Sequential rather than concurrent: a handful of providers at 3s each is
  // bounded and small, and one probe cannot starve another's event-loop turn.
  const probes: ProviderProbe[] = [];
  for (const provider of providers) {
    probes.push(await probe(provider, timeoutMs));
  }

  const unreachable = probes.filter((p) => p.status === 'unreachable');
  if (unreachable.length === 0) {
    const skipped = probes.filter((p) => p.status === 'skipped');
    const skipNote = skipped.length > 0
      ? ` (${skipped.map((p) => `${p.name}: ${p.detail}`).join(', ')})`
      : '';
    return result(
      LLM_PROVIDERS_CHECK_ID,
      'pass',
      `${plural(probes.length - skipped.length, 'provider')} reachable${skipNote}.`,
    );
  }

  const detail = unreachable.map((p) => `${p.name} (${p.detail})`).join('; ');
  // Never fixable: doctor cannot start someone's model server, and it must not
  // rewrite their provider config to route around one.
  if (hasFallback) {
    return result(
      LLM_PROVIDERS_CHECK_ID,
      'warn',
      `${plural(unreachable.length, 'provider')} unreachable: ${detail}. ` +
        'A fallback is configured, so work routes there instead.',
      false,
    );
  }
  return result(
    LLM_PROVIDERS_CHECK_ID,
    'fail',
    `${plural(unreachable.length, 'provider')} unreachable: ${detail}. ` +
      'No `cortex.llm.fallback` is configured, so LLM-backed work has nowhere to go.',
    false,
  );
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

/**
 * Every provider this machine would actually send to: the `cortex.llm`
 * registry when one is configured, else the legacy `cortex.local` endpoint
 * bridged onto the same shape (the router treats them the same way, so the
 * check has to as well, or a legacy config would report "no LLM provider
 * configured" while happily routing curation to a dead server).
 */
function configuredProviders(): ResolvedProvider[] {
  let cortex;
  try {
    cortex = getConfig().cortex;
  } catch {
    return [];
  }

  const registry = [...resolveRegistry(cortex?.llm).values()];
  if (registry.length > 0) return registry;

  const legacy = resolveLocalConfig(cortex?.local);
  if (legacy.endpoint.length === 0) return [];
  return [{
    name: 'local',
    kind: 'openai',
    endpoint: legacy.endpoint,
    model: legacy.model,
    apiKey: legacy.apiKey,
    offMachine: false,
    ctxBudget: legacy.ctxBudget,
    timeoutMs: legacy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    disableThinking: legacy.disableThinking ?? false,
  }];
}

/** True when `cortex.llm.fallback` names a provider (not `'skip'`). */
function configuredFallback(): boolean {
  try {
    const fallback = getConfig().cortex?.llm?.fallback?.trim();
    return fallback !== undefined && fallback.length > 0 && fallback !== 'skip';
  } catch {
    return false;
  }
}

/**
 * The real probe: GET `<endpoint>/models`, no auth header, no body.
 *
 * Uses undici's `fetch` for the same reason `OpenAiCompatibleLlmClient` does —
 * Node's global fetch carries its own timeout policy this module should not
 * inherit — and an `AbortSignal.timeout`, which can only LOWER a deadline, so
 * `timeoutMs` is the real ceiling here.
 *
 * Any HTTP status counts as reachable. A 401/403/404 means a server answered,
 * which is what this check asks; whether the key is right is the transport's
 * problem, not doctor's, and probing it would mean sending a credential to
 * report on a machine's health.
 */
export async function probeProviderEndpoint(
  provider: ResolvedProvider,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProviderProbe> {
  if (provider.kind !== 'openai') {
    return {
      name: provider.name,
      status: 'skipped',
      detail: `${provider.kind} transport — no liveness endpoint to probe`,
    };
  }
  if (provider.endpoint.length === 0) {
    return {
      name: provider.name,
      status: 'unreachable',
      detail: 'no endpoint configured',
    };
  }

  const url = `${provider.endpoint.replace(/\/+$/, '')}/models`;
  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      name: provider.name,
      status: 'reachable',
      detail: `HTTP ${response.status} from ${url}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: provider.name,
      status: 'unreachable',
      detail: `${provider.endpoint}: ${message}`,
    };
  }
}

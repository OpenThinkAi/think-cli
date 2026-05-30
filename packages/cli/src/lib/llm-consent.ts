import { getConfig } from './config.js';

const ENV_VAR = 'THINK_LLM_CONSENT';

export class LlmConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConsentError';
  }
}

/**
 * Truthy values for the env var. We intentionally accept several common
 * shapes (`1`, `true`, `yes`, case-insensitive) instead of strict equality
 * because operators copy-paste these from docs in different conventions.
 */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes)$/i.test(value.trim());
}

/**
 * Throws LlmConsentError when consent has not been granted via either
 * `THINK_LLM_CONSENT=1` env var or `cortex.llmConsent: true` in the config
 * file. The error carries an actionable message the caller can print
 * verbatim — see `formatConsentFailure()` for the canonical text.
 *
 * AGT-065: every Claude Agent SDK call site in this codebase routes
 * through this gate (via `lib/claude-sdk.ts`'s wrapped `query` export).
 * Default-deny is the deliberate posture: shipping memory content to
 * Anthropic is not free privacy-wise (curator + backfill + episode
 * curation + retro dedupe each ship distinct envelopes), and a fresh
 * install previously began doing so silently on first `think curate`.
 */
export function requireLlmConsent(): void {
  if (hasLlmConsent()) return;
  throw new LlmConsentError(formatConsentFailure());
}

/**
 * Non-throwing consent check. Returns true when consent has been granted via
 * either `THINK_LLM_CONSENT` env var or `cortex.llmConsent: true` in config.
 *
 * Used by the local-first router (lib/llm/router.ts): when a task is too big
 * for the local model, the router falls back to Anthropic ONLY if consent is
 * granted; otherwise it skips-and-warns rather than shipping content the user
 * never agreed to send. The throwing `requireLlmConsent` is the right call at
 * a hard gate; this is the right call when "no consent" has a graceful path.
 */
export function hasLlmConsent(): boolean {
  if (isTruthy(process.env[ENV_VAR])) return true;
  return getConfig().cortex?.llmConsent === true;
}

/**
 * Canonical user-facing error text for consent-not-granted. Exported so
 * callers can render it consistently — `requireLlmConsent` populates it
 * into `LlmConsentError.message` automatically; tests + integration
 * layers that want to print without throwing can use this directly.
 */
export function formatConsentFailure(): string {
  return [
    'LLM consent not granted — refusing to ship cortex content to Anthropic.',
    '',
    'think curate / long-term backfill / episode curation / retro dedupe each',
    'send memory content to Claude (one envelope per call). To opt in, set EITHER:',
    '',
    '  • Environment variable (one-shot or shell profile):',
    `      export ${ENV_VAR}=1`,
    '',
    '  • Persistent config (`~/.config/think/config.json`):',
    '      { "cortex": { "llmConsent": true, ... } }',
    '',
    'See SECURITY.md "Per-curation data envelope" for what gets shipped each call.',
  ].join('\n');
}

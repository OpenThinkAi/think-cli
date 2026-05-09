import { query as rawQuery } from '@anthropic-ai/claude-agent-sdk';
import { requireLlmConsent } from './llm-consent.js';

/**
 * Gated `query` re-export: every Claude Agent SDK call site in this
 * codebase imports `query` from this module instead of from
 * `@anthropic-ai/claude-agent-sdk` directly. The wrapper enforces the
 * THINK_LLM_CONSENT gate before each call (AGT-065), so a future caller
 * can't forget to gate — the gate is mechanical, not conventional.
 *
 * `requireLlmConsent` throws `LlmConsentError` when consent isn't
 * granted; commands catch and surface that as a friendly exit, while
 * unit tests can assert the throw without touching the SDK at all.
 */
export const query: typeof rawQuery = ((...args: Parameters<typeof rawQuery>) => {
  requireLlmConsent();
  return rawQuery(...args);
}) as typeof rawQuery;

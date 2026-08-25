/**
 * Back-compat re-export. The implementation moved to `openai-compatible.ts`
 * when it was renamed to say what it actually is: an adapter for any OpenAI
 * `/chat/completions` server, not a local-only one.
 *
 * Kept because `LocalLlmClient` is referenced by published typings and by
 * existing tests. New code should import from `./openai-compatible.js` and
 * declare egress via the provider registry's `offMachine` — see router.ts.
 *
 * @deprecated Use `OpenAiCompatibleLlmClient` from `./openai-compatible.js`.
 */

export {
  OpenAiCompatibleLlmClient,
  OpenAiCompatibleLlmClient as LocalLlmClient,
  isOverflow,
  DEFAULT_TIMEOUT_MS,
  type OpenAiCompatibleOptions,
  type OpenAiCompatibleOptions as LocalLlmOptions,
} from './openai-compatible.js';

/**
 * AnthropicLlmClient — the cloud backend, wrapping the gated Claude Agent SDK
 * `query()` re-exported from lib/claude-sdk.ts.
 *
 * Deliberately preserves think's existing curation call exactly (same SDK,
 * same one-shot `tools: []` query, same single-`result` read) so routing to
 * Anthropic is byte-for-byte the legacy path: subscription billing is
 * unchanged, and the consent gate still fires inside the wrapped `query`.
 *
 * The `schema` field is treated as advisory here: the curation prompt already
 * instructs the model to "respond only with a valid JSON object", so we return
 * the raw text and let the caller parse it (via `extractFirstFencedBlock`).
 * We do NOT force tool_use on this path — that would diverge from the prompt
 * the model has been tuned against. Consequently `LlmResponse.json` is left
 * undefined; callers parse `text`.
 */

import { query } from '../claude-sdk.js';
import { type LlmClient, type LlmRequest, type LlmResponse } from './client.js';

/** Default model for the Anthropic path when a request omits `model`. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** The slice of the Agent SDK `query` we depend on — injectable for tests. */
export type QueryFn = typeof query;

export class AnthropicLlmClient implements LlmClient {
  readonly name = 'anthropic';
  private readonly queryFn: QueryFn;

  /** `queryFn` defaults to the gated SDK `query`; tests inject a fake. */
  constructor(queryFn: QueryFn = query) {
    this.queryFn = queryFn;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Flatten messages into the single prompt string the Agent SDK takes. For
    // one-shot curation there is exactly one user message; if a caller ever
    // passes multiple turns we join them so nothing is silently dropped.
    const prompt = req.messages.map((m) => m.content).join('\n\n');

    let result = '';
    for await (const message of this.queryFn({
      prompt,
      options: {
        systemPrompt: req.system,
        tools: [],
        model: req.model ?? DEFAULT_MODEL,
        persistSession: false,
      },
    })) {
      if ('result' in message && typeof message.result === 'string') {
        result = message.result;
      }
    }

    if (!result) {
      throw new Error('No result returned from Anthropic curation');
    }

    return { text: result };
  }
}

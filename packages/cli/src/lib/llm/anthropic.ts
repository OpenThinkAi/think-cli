/**
 * AnthropicLlmClient — the Anthropic backend, with two transports.
 *
 * AGENT SDK (default): the gated `query()` re-exported from lib/claude-sdk.ts,
 * one-shot with `tools: []`. Byte-for-byte think's original curation call, so
 * subscription billing is unchanged and the consent gate still fires inside the
 * wrapped `query`. `schema` is ADVISORY here: the curation prompts already say
 * "respond only with a valid JSON object" and are tuned against that, so we
 * return raw text and let the caller parse it. Forcing tool_use would diverge
 * from the prompt the model was tuned on.
 *
 * MESSAGES API (when `req.strictSchema`): `@anthropic-ai/sdk` with a forced
 * `tool_use` whose `input_schema` the API enforces server-side. This is the
 * path the daemon compaction/supersession workers have always used, and it is
 * why they can treat a malformed response as a bug rather than a retry. It
 * needs an API key.
 *
 * The split is deliberate. `strictSchema` is opt-in precisely so that porting
 * an operation onto this client cannot silently change how hard its output
 * shape is enforced — the failure mode that matters is a caller that used to
 * get server-validated JSON quietly starting to get prose.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TextBlockParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { query } from '../claude-sdk.js';
import { requireLlmConsent } from '../llm-consent.js';
import { resolveThinkApiKey } from '../api-key.js';
import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmStructuredOutputError,
} from './client.js';

/** Default model for the Anthropic path when a request omits `model`. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** The slice of the Agent SDK `query` we depend on — injectable for tests. */
export type QueryFn = typeof query;

/** Minimal shape of the Messages API call we make — injectable for tests. */
export interface MessagesCreateFn {
  (body: Record<string, unknown>): Promise<{
    content: Array<Record<string, unknown>>;
    stop_reason?: string | null;
  }>;
}

export interface AnthropicLlmOptions {
  /** Defaults to the gated SDK `query`; tests inject a fake. */
  queryFn?: QueryFn;
  /** Defaults to a real `Anthropic` client bound to the resolved think key. */
  messagesCreate?: MessagesCreateFn;
}

export class AnthropicLlmClient implements LlmClient {
  readonly name = 'anthropic';
  private readonly queryFn: QueryFn;
  private readonly messagesCreateOverride?: MessagesCreateFn;

  /**
   * Back-compat: the original constructor took `queryFn` positionally. Both
   * `new AnthropicLlmClient(fakeQuery)` and the options object work.
   */
  constructor(opts: QueryFn | AnthropicLlmOptions = {}) {
    const o: AnthropicLlmOptions = typeof opts === 'function' ? { queryFn: opts } : opts;
    this.queryFn = o.queryFn ?? query;
    this.messagesCreateOverride = o.messagesCreate;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (req.strictSchema && req.schema) return this.completeStrict(req);
    return this.completeViaAgentSdk(req);
  }

  /** Agent SDK path — unchanged legacy behaviour, schema advisory. */
  private async completeViaAgentSdk(req: LlmRequest): Promise<LlmResponse> {
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

  /**
   * Messages API path — the schema becomes a forced tool the API validates.
   * Returns the tool input as `json` AND as serialized `text`, so callers that
   * parse text and callers that read `json` both work.
   */
  private async completeStrict(req: LlmRequest): Promise<LlmResponse> {
    // The Agent SDK path gets its gate inside the wrapped `query`; this path
    // bypasses that wrapper, so gate it explicitly. Without this line the
    // strict transport would be an un-gated route to Anthropic.
    requireLlmConsent();

    const schema = req.schema!;
    const tool: Tool = {
      name: schema.name,
      description: schema.description ?? `Return the ${schema.name} result.`,
      input_schema: schema.schema as Tool['input_schema'],
    };

    const systemBlock: TextBlockParam = {
      type: 'text',
      text: req.system,
      ...(req.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };

    const create = this.messagesCreateOverride ?? defaultMessagesCreate();
    const response = await create({
      model: req.model ?? DEFAULT_MODEL,
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      system: [systemBlock],
      tools: [tool],
      tool_choice: { type: 'tool', name: schema.name, disable_parallel_tool_use: true },
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const toolUse = response.content.find(
      (b) => b.type === 'tool_use' && b.name === schema.name,
    ) as { input?: unknown } | undefined;

    const truncated = response.stop_reason === 'max_tokens';

    if (!toolUse || toolUse.input === undefined) {
      throw new LlmStructuredOutputError(
        `Anthropic returned no ${schema.name} tool_use block (strictSchema was requested).` +
          (truncated ? ` The response hit max_tokens=${req.maxTokens} — raise the budget.` : ''),
        truncated,
      );
    }

    return {
      text: JSON.stringify(toolUse.input),
      json: toolUse.input,
      ...(truncated ? { truncated: true } : {}),
    };
  }
}

/** Lazily bind a real Messages client so no key is read until strict mode runs. */
function defaultMessagesCreate(): MessagesCreateFn {
  const client = new Anthropic({ apiKey: resolveThinkApiKey() });
  return (body) =>
    client.messages.create(
      body as unknown as Parameters<typeof client.messages.create>[0],
    ) as unknown as Promise<{ content: Array<Record<string, unknown>> }>;
}

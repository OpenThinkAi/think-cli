/**
 * LocalLlmClient — OpenAI-compatible adapter for an on-device model server
 * (oMLX/Qwen, the same `localqwen up` server hal9k targets).
 *
 * Ported from hal9k-cli's `openaiCallModel` (src/local-review.ts): POST to
 * `<endpoint>/chat/completions`, Bearer auth, strip Qwen chat-format special
 * tokens from the output. think adds two things hal9k didn't need:
 *   - `schema` → OpenAI `response_format: { type: 'json_schema' }` so small
 *     models emit conformant JSON server-side.
 *   - context-overflow detection: a 4xx whose body mentions context/length is
 *     surfaced as `LlmContextOverflowError` so the router can fall back.
 *
 * No consent gate here — local calls never leave the machine. Consent is the
 * Anthropic client's concern.
 */

import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmContextOverflowError,
  LlmUnavailableError,
} from './client.js';

/** Qwen/oMLX chat-format markers that leak into completions — strip them. */
const SPECIAL_TOKEN_RE = /<\|(?:im_end|im_start|endoftext|eot_id)\|>/g;

/** Substrings in an error body that mean "prompt too long for this model". */
const OVERFLOW_HINTS = [
  'context length',
  'context window',
  'maximum context',
  'too long',
  'too many tokens',
  'exceeds',
  'reduce the length',
];

export interface LocalLlmOptions {
  /** OpenAI-compatible base URL, e.g. `http://localhost:8080/v1`. */
  endpoint: string;
  /** Model id served at the endpoint. */
  model: string;
  /** Bearer token; defaults to `"lm-studio"`. */
  apiKey?: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class LocalLlmClient implements LlmClient {
  readonly name = 'local';
  private readonly baseURL: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LocalLlmOptions) {
    this.baseURL = opts.endpoint.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? 'lm-studio';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const messages = [
      { role: 'system', content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.schema) {
      // OpenAI-compatible structured output. Servers that don't support
      // json_schema typically ignore the field and the prompt's own JSON
      // instruction carries the load; the caller validates either way.
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.schema.name,
          ...(req.schema.description ? { description: req.schema.description } : {}),
          schema: req.schema.schema,
          strict: true,
        },
      };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Transport failure (server down, DNS, refused) — an availability failure,
      // NOT an overflow. Typed so the router can turn it into a graceful skip
      // (with a "is it running?" message) rather than a hard error or a silent
      // reroute to the cloud.
      throw new LlmUnavailableError(
        `cannot reach local LLM endpoint ${this.baseURL} (${(e as Error).message})`,
        this.baseURL,
      );
    }

    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 500);
      if (isOverflow(res.status, errText)) {
        throw new LlmContextOverflowError(
          `local LLM endpoint ${this.baseURL} rejected the request as too large ` +
            `(HTTP ${res.status}): ${errText.slice(0, 200)}`,
        );
      }
      throw new Error(
        `local LLM endpoint ${this.baseURL} returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      );
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = (await res.json()) as ChatCompletionResponse;
    } catch (e) {
      throw new Error(
        `local LLM endpoint ${this.baseURL} returned non-JSON response: ${(e as Error).message}`,
      );
    }

    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(
        `local LLM endpoint ${this.baseURL} response had no choices[0].message.content`,
      );
    }

    const text = content.replace(SPECIAL_TOKEN_RE, '').trim();
    return { text };
  }
}

/**
 * Decide whether a non-OK response is a context-overflow (router falls back)
 * vs a generic error (bubbles up). 413 is unambiguous; 400 needs a body hint
 * because "bad request" covers many causes. Exported for unit testing.
 */
export function isOverflow(status: number, body: string): boolean {
  if (status === 413) return true;
  if (status === 400 || status === 422) {
    const lower = body.toLowerCase();
    return OVERFLOW_HINTS.some((h) => lower.includes(h));
  }
  return false;
}

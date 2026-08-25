/**
 * OpenAiCompatibleLlmClient — adapter for ANY server speaking the OpenAI
 * `/chat/completions` shape: an on-device oMLX/Qwen server, LM Studio, vLLM,
 * OpenAI itself, DeepSeek, OpenRouter, Together. The transport is identical;
 * only `endpoint`, `model` and `apiKey` differ.
 *
 * This file was previously `local.ts` and the class `LocalLlmClient`. The name
 * was a lie with teeth: nothing here is inherently local, and assuming it was
 * is exactly what let cortex content reach a third-party API without passing
 * the consent gate. Egress is now a property of the *provider config*
 * (`offMachine`), enforced by the router — see router.ts. `local.ts` remains
 * as a back-compat re-export.
 *
 * Beyond the plain OpenAI body this adds:
 *   - `schema` -> `response_format: { type: 'json_schema' }` so small models
 *     emit conformant JSON server-side.
 *   - context-overflow detection: a 4xx whose body mentions context/length is
 *     surfaced as `LlmContextOverflowError` so the router can fall back.
 *   - an explicit request deadline (`timeoutMs`). Without one, Node/undici
 *     aborts at its 300s default and the abort is indistinguishable from a
 *     dead server. A 27B model doing a 30k-token prefill plus generation
 *     exceeds 300s routinely, so the default here is deliberately generous.
 *   - `disableThinking` -> `chat_template_kwargs.enable_thinking = false`, so
 *     reasoning models do not spend a structured-output token budget on a
 *     preamble the caller throws away.
 *
 * NOTE: no `tools` field is ever sent. mlx_lm.server crashes server-side when
 * one is present; structured output goes through `response_format` instead.
 */

import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmContextOverflowError,
  LlmUnavailableError,
  LlmTimeoutError,
} from './client.js';

/**
 * Default request deadline. Generous on purpose: the failure this replaces was
 * undici's silent 300s cutoff killing a healthy generation mid-flight.
 */
export const DEFAULT_TIMEOUT_MS = 900_000;

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

export interface OpenAiCompatibleOptions {
  /** OpenAI-compatible base URL, e.g. `http://localhost:8080/v1`. */
  endpoint: string;
  /** Model id served at the endpoint. */
  model: string;
  /** Bearer token; defaults to `"lm-studio"`. */
  apiKey?: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Request deadline in ms. Defaults to `DEFAULT_TIMEOUT_MS`. Exceeding it
   * raises `LlmTimeoutError`, NOT `LlmUnavailableError` — see that class.
   */
  timeoutMs?: number;
  /**
   * Suppress the reasoning preamble on Qwen-style chat templates by sending
   * `chat_template_kwargs: { enable_thinking: false }`. Servers that do not
   * know the field ignore it, exactly as they ignore `response_format`.
   */
  disableThinking?: boolean;
  /** Label used in logs/telemetry. Defaults to `'openai-compatible'`. */
  label?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly name: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly disableThinking: boolean;

  constructor(opts: OpenAiCompatibleOptions) {
    this.baseURL = opts.endpoint.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? 'lm-studio';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.disableThinking = opts.disableThinking ?? false;
    this.name = opts.label ?? 'openai-compatible';
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
    if (this.disableThinking) {
      // Qwen3-style chat templates read this. Unknown keys are ignored by
      // servers that don't implement it, same as `response_format` below.
      body.chat_template_kwargs = { enable_thinking: false };
    }
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
    // An explicit deadline. Without one, Node/undici imposes its own (300s at
    // time of writing) and reports the abort as a transport failure — which
    // reads as "server is down" for what is really "model is still working".
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      // Distinguish "we gave up waiting" from "nothing answered". Conflating
      // them is how a healthy-but-slow backend gets misreported as an outage.
      if (ac.signal.aborted) {
        throw new LlmTimeoutError(
          `LLM endpoint ${this.baseURL} did not respond within ${Math.round(
            this.timeoutMs / 1000,
          )}s. The server may still be generating — raise timeoutMs if the model is simply slow.`,
          this.baseURL,
          this.timeoutMs,
        );
      }
      // Transport failure (server down, DNS, refused) — an availability failure,
      // NOT an overflow. Typed so the router can turn it into a graceful skip
      // (with a "is it running?" message) rather than a hard error or a silent
      // reroute to the cloud.
      throw new LlmUnavailableError(
        `cannot reach LLM endpoint ${this.baseURL} (${(e as Error).message})`,
        this.baseURL,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 500);
      if (isOverflow(res.status, errText)) {
        throw new LlmContextOverflowError(
          `LLM endpoint ${this.baseURL} rejected the request as too large ` +
            `(HTTP ${res.status}): ${errText.slice(0, 200)}`,
        );
      }
      throw new Error(
        `LLM endpoint ${this.baseURL} returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      );
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = (await res.json()) as ChatCompletionResponse;
    } catch (e) {
      throw new Error(
        `LLM endpoint ${this.baseURL} returned non-JSON response: ${(e as Error).message}`,
      );
    }

    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(
        `LLM endpoint ${this.baseURL} response had no choices[0].message.content`,
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

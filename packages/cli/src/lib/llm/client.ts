/**
 * LlmClient — the single abstraction every think curation call routes through.
 *
 * Modelled on hal9k's `callModel({ model, system, user }) => string` adapter
 * but widened just enough for think's needs: a `schema` hint for structured
 * output and a parsed-JSON convenience field on the response. Two concrete
 * implementations live alongside this file:
 *
 *   - `LocalLlmClient`    (./local.ts)     — OpenAI-compatible oMLX/Qwen, on-device.
 *   - `AnthropicLlmClient` (./anthropic.ts) — the Claude Agent SDK path (cloud).
 *
 * and a `RouterLlmClient` (./router.ts) that picks between them per the
 * local-first policy. Callers depend only on this interface, so tests inject a
 * fake client and never touch a network or an SDK.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A structured-output request. When present on an `LlmRequest`, clients that
 * can enforce a JSON shape server-side should do so:
 *   - LocalLlmClient maps this to OpenAI `response_format: json_schema`.
 *   - AnthropicLlmClient currently relies on the prompt's own "respond with
 *     JSON" instruction (the curation prompt already does this) and treats the
 *     schema as advisory — so the field is a hint, not a hard contract across
 *     every backend. The caller still parses/validates the returned text.
 */
export interface LlmJsonSchema {
  /** Schema/tool name (e.g. "curation_result"). */
  name: string;
  description?: string;
  /** A JSON Schema object describing the expected output. */
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  /** System prompt. */
  system: string;
  /** Conversation turns. For one-shot curation this is a single user message. */
  messages: LlmMessage[];
  /** Hard cap on output tokens. */
  maxTokens: number;
  temperature?: number;
  /** Structured-output hint — see `LlmJsonSchema`. */
  schema?: LlmJsonSchema;
  /**
   * Preferred model id. The Anthropic client uses it; the local client ignores
   * it in favour of its configured model (the endpoint serves one id).
   */
  model?: string;
}

export interface LlmResponse {
  /** Raw text the model returned (already stripped of provider artifacts). */
  text: string;
  /**
   * Parsed object, when a client both received a `schema` AND could decode the
   * response to JSON itself. Callers should prefer this when set but must still
   * be able to parse `text` (the Anthropic path leaves this undefined and the
   * caller parses `text`).
   */
  json?: unknown;
}

export interface LlmClient {
  /** Stable label for logging/telemetry: `'local'`, `'anthropic'`, `'router'`. */
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Thrown by a client when the request overflows the model's context window —
 * the one condition the router treats as "the local model can't handle this
 * task's size" and uses to trigger the Anthropic fallback (auto) or a skip
 * (local-pinned). Distinct from generic transport errors (server down, 5xx),
 * which bubble up unchanged because they are NOT a size problem and must not
 * silently reroute on-device content to the cloud.
 */
export class LlmContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmContextOverflowError';
  }
}

/**
 * Thrown by the router when a task cannot run anywhere allowed: too big for the
 * local model AND the Anthropic fallback is unavailable (no consent, or the
 * provider is pinned to `'local'`). The "skip + warn" posture — callers catch
 * this, emit a warning, and leave the work for a later run rather than failing
 * hard or shipping content without consent.
 */
export class LlmSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmSkippedError';
  }
}

/**
 * Thrown by a local client when its server can't be reached (process down, DNS,
 * connection refused) — an *availability* failure, distinct from a *size*
 * overflow. The router turns this into a graceful skip (leave the work pending,
 * print "is it running?" + how to disable local mode) rather than a hard error
 * or a silent reroute to the cloud. Carries the endpoint for the message.
 */
export class LlmUnavailableError extends Error {
  constructor(message: string, readonly endpoint: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * Crude token estimate: ~4 chars/token across system + every message body +
 * the serialized schema. Deliberately the same order-of-magnitude heuristic
 * the curator's char-cap uses (curator.ts) — good enough to decide routing,
 * with the runtime `LlmContextOverflowError` as the real backstop when the
 * estimate is wrong at the margin.
 */
export function estimateTokens(req: LlmRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) chars += m.content.length;
  if (req.schema) chars += JSON.stringify(req.schema.schema).length;
  return Math.ceil(chars / 4);
}

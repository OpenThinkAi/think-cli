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
   * Preferred model id. The Anthropic client uses it; the OpenAI-compatible
   * client ignores it in favour of its configured model (the endpoint serves
   * one id).
   */
  model?: string;
  /**
   * Demand SERVER-SIDE enforcement of `schema`, not just a prompt instruction.
   *
   * Opt-in because the two families enforce differently and the difference is
   * observable. Without it the Anthropic path leaves the schema advisory and
   * relies on the prompt — which is correct for prompts tuned that way (the
   * curation prompts are), and wrong for callers that depend on the shape
   * (compaction's freeform-JSON attempt failed 100% of shape validations).
   *
   * With it: Anthropic forces `tool_use` via the Messages API, which needs an
   * API key; OpenAI-compatible servers already receive `response_format:
   * json_schema` either way. A caller that sets this is saying "a malformed
   * response is a bug, not a retry" — so moving such an op between providers
   * must not quietly downgrade it.
   */
  strictSchema?: boolean;
  /**
   * Ask the provider to cache the system prompt across calls where it can
   * (Anthropic `cache_control: ephemeral`). A hint: providers without a cache
   * ignore it. Worth setting for a long, fixed system prompt reused per item —
   * the daemon workers hit the same prompt once per entry.
   */
  cacheSystem?: boolean;
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
  /**
   * The provider stopped because the output hit `maxTokens`, not because the
   * model finished. Anthropic reports `stop_reason: 'max_tokens'`; OpenAI-
   * compatible servers report `finish_reason: 'length'`.
   *
   * Worth surfacing because a truncated structured response is usually
   * unparseable, and "bad JSON" is a much less actionable diagnosis than
   * "your token budget was too small". The supersession worker treats it as a
   * hard error rather than retrying an identical call that will truncate again.
   */
  truncated?: boolean;
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
 * Chars-per-token divisor. Deliberately BELOW the familiar 4.0 so the estimate
 * errs high: this number gates whether a task is allowed to run, so
 * under-counting is the dangerous direction — it waves an oversized prompt
 * through and the failure surfaces much later (a truncated response, or a
 * multi-minute generation that blows the request timeout).
 *
 * Measured against a real curation envelope on Qwen3.8-27B: 109,252 prompt
 * chars tokenized to 31,780 tokens — 3.44 chars/token. The old 4.0 divisor
 * predicted 27,313 and cleared a 28,000 budget the prompt was in fact ~3,800
 * tokens over. 3.5 keeps a margin without over-rejecting.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Thrown when a `strictSchema` request came back without the structured payload
 * the caller demanded — the model answered, but not in the required shape.
 *
 * Typed separately from a transport error on purpose: this one is transient
 * model non-determinism and IS worth one retry, whereas a 5xx or a rate limit
 * must propagate untouched. The daemon workers rely on exactly that
 * distinction — they retry this and nothing else.
 */
export class LlmStructuredOutputError extends Error {
  /**
   * The shape failure was caused by hitting `maxTokens`, not by the model
   * ignoring the schema. Carried on the error because the two demand opposite
   * responses: non-determinism is worth a retry, truncation is not — an
   * identical call truncates identically. Callers that retry must check this.
   */
  readonly truncated: boolean;
  constructor(message: string, truncated = false) {
    super(message);
    this.name = 'LlmStructuredOutputError';
    this.truncated = truncated;
  }
}

/**
 * Thrown when a request exceeded its own deadline. Deliberately NOT an
 * `LlmUnavailableError`: a slow-but-healthy backend is a different problem from
 * an unreachable one, and conflating them produces the worst possible advice —
 * "is it running?" when it is running fine and still generating.
 *
 * A big local model can legitimately need minutes (prefill + generation), so
 * this is a tuning signal (`timeoutMs`), not an outage.
 */
export class LlmTimeoutError extends Error {
  constructor(message: string, readonly endpoint: string, readonly timeoutMs: number) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Crude token estimate across system + every message body + the serialized
 * schema. Good enough to decide routing, with the runtime
 * `LlmContextOverflowError` as the real backstop when the estimate is wrong at
 * the margin. See `CHARS_PER_TOKEN` for why it rounds against the caller.
 */
export function estimateTokens(req: LlmRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) chars += m.content.length;
  if (req.schema) chars += JSON.stringify(req.schema.schema).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

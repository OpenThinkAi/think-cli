/**
 * Supersession LLM call — AGT-303
 *
 * Calls Claude to determine whether a new retro supersedes, duplicates, or
 * coexists with a set of same-cortex same-kind candidates. Uses a forced
 * tool_use call so the API enforces output shape server-side.
 *
 * The candidate-pull is the caller's responsibility. This module only
 * builds the prompt and calls the Anthropic SDK.
 */

// @anthropic-ai/sdk is a direct dep (not just a transitive dep via claude-agent-sdk)
// because the agent SDK does not re-export the Anthropic class or Message types.
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  LlmStructuredOutputError,
  type LlmClient,
  type LlmJsonSchema,
  type LlmResponse,
} from '../../lib/llm/client.js';
import { getDefaultLlmClient, OP_SUPERSESSION } from '../../lib/llm/router.js';
import {
  SUPERSESSION_SYSTEM_PROMPT,
  buildSupersessionMessages,
} from './prompt.js';

// Imported for local use in `runSupersession`'s signature; re-exported so
// callers (e.g. worker.ts) keep importing these input types from call.ts.
import type { RetroEntry, RetroCandidate } from './prompt.js';
export type { RetroEntry, RetroCandidate };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupersessionResult {
  /**
   * IDs of candidates that the new retro replaces (may be empty).
   * Always empty when `isDuplicate` is true — enforced in the parser.
   */
  supersedes: string[];
  /** 1–4 short lowercase topic strings (capped at 4 in the parser). */
  topics: string[];
  /**
   * True when the new retro is essentially a duplicate of an existing one.
   * When true the daemon MUST skip storing the new retro.
   * `supersedes` will be empty in this case — callers MUST NOT delete
   * any candidate when `isDuplicate` is true.
   *
   * The tool input_schema uses `is_duplicate` (snake_case) — the parser
   * maps it to this camelCase field on the way out.
   */
  isDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 300;
const TEMPERATURE = 0.1;

/**
 * Transport-neutral view of SUPERSESSION_TOOL — derived, not duplicated, so the
 * Anthropic tool and the OpenAI json_schema can't drift apart.
 */
const SUPERSESSION_SCHEMA: LlmJsonSchema = {
  get name() {
    return SUPERSESSION_TOOL.name;
  },
  get description() {
    return SUPERSESSION_TOOL.description;
  },
  get schema() {
    return SUPERSESSION_TOOL.input_schema as unknown as Record<string, unknown>;
  },
};

const SUPERSESSION_TOOL: Tool = {
  name: 'submit_supersession',
  description:
    'Submit the supersession judgment: which candidates the new retro replaces, topic tags, and a duplicate flag.',
  input_schema: {
    type: 'object',
    properties: {
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Candidate ids the new retro replaces. Must be empty when is_duplicate is true.',
      },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: '1–4 short lowercase topic tags.',
      },
      is_duplicate: {
        type: 'boolean',
        description: 'True when the new retro is essentially a duplicate of an existing candidate.',
      },
    },
    required: ['supersedes', 'topics', 'is_duplicate'],
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseSupersessionToolInput(input: unknown): SupersessionResult {
  if (!input || typeof input !== 'object') {
    throw new Error('Supersession tool_use.input is not an object');
  }
  const obj = input as Record<string, unknown>;

  const isDuplicate = typeof obj.is_duplicate === 'boolean' ? obj.is_duplicate : false;

  // When isDuplicate is true, callers must NOT delete any candidate —
  // treat it as a skip-storage-only result. Enforce here rather than
  // relying on callers to read the JSDoc.
  const supersedes = isDuplicate
    ? []
    : Array.isArray(obj.supersedes)
      ? obj.supersedes.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

  // Cap at 4 to match the system prompt contract ("1–4 short lowercase strings").
  const topics = (
    Array.isArray(obj.topics)
      ? obj.topics.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : []
  ).slice(0, 4);

  return { supersedes, topics, isDuplicate };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the supersession check for a new retro against a set of candidates.
 *
 * Uses Haiku 4.5 with forced tool_use so the API enforces output shape
 * server-side. alpha.11 tried Haiku with freeform JSON and hit 100% downstream
 * parse failures (reverted in alpha.13); this iteration moves to tool_use so
 * structural conformance is no longer the model's job. Retries once on a
 * missing tool_use block (transient non-determinism).
 *
 * `max_tokens: 300` is sized for the compact tool input. If the candidate
 * count is ever raised significantly (> ~20 long IDs), revisit this limit.
 *
 * The caller is responsible for fetching the candidate list (filter by
 * `kind = 'retro'` AND same cortex via vector search) before calling this.
 *
 * @param newRetro    The new retro entry being ingested.
 * @param candidates  Same-cortex, same-kind candidates above the similarity threshold.
 */
export async function runSupersession(
  newRetro: RetroEntry,
  candidates: RetroCandidate[],
): Promise<SupersessionResult> {
  const client: LlmClient = getDefaultLlmClient(OP_SUPERSESSION);
  const { messages } = buildSupersessionMessages(newRetro, candidates);

  // strictSchema keeps the server-side shape enforcement this worker has always
  // had (forced tool_use on Anthropic, response_format json_schema elsewhere).
  // cacheSystem preserves the ephemeral prompt cache — the system prompt is
  // fixed and re-sent once per retro.
  // A shape failure is transient — surface it as a null payload so the existing
  // retry-once path handles it. Transport errors propagate untouched.
  const callModel = async (): Promise<LlmResponse | null> => {
    try {
      return await client.complete({
        system: SUPERSESSION_SYSTEM_PROMPT,
        messages: messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        schema: SUPERSESSION_SCHEMA,
        strictSchema: true,
        cacheSystem: true,
        model: MODEL,
      });
    } catch (e) {
      if (e instanceof LlmStructuredOutputError) {
        // Truncation is not non-determinism: retrying an identical call
        // truncates identically. Fail now with the actionable message.
        if (e.truncated) {
          throw new Error(
            `Supersession response truncated at max_tokens=${MAX_TOKENS} — increase budget or reduce candidate count`,
          );
        }
        return null;
      }
      throw e;
    }
  };

  // Truncation is not worth retrying: an identical call truncates identically.
  // `truncated` is the provider-neutral form of Anthropic's
  // stop_reason === 'max_tokens' / OpenAI's finish_reason === 'length'.
  const failIfTruncated = (r: LlmResponse | null): void => {
    if (r?.truncated) {
      throw new Error(
        `Supersession response truncated at max_tokens=${MAX_TOKENS} — increase budget or reduce candidate count`,
      );
    }
  };

  // First attempt
  const response = await callModel();
  failIfTruncated(response);
  const toolInput = payloadOf(response);
  if (toolInput !== null) {
    try {
      return parseSupersessionToolInput(toolInput);
    } catch (firstErr) {
      console.warn(`[supersession] parse failed on attempt 1, retrying`, firstErr);
    }
  } else {
    console.warn('[supersession] no structured payload on attempt 1, retrying');
  }

  // Retry once on missing or unparseable output (transient non-determinism).
  const retryResponse = await callModel();
  failIfTruncated(retryResponse);
  const retryToolInput = payloadOf(retryResponse);
  if (retryToolInput === null) {
    throw new Error('Supersession response missing structured payload after retry');
  }
  return parseSupersessionToolInput(retryToolInput);
}

/**
 * The structured payload, however the transport delivered it: `json` when the
 * provider returned a validated object, else a JSON parse of `text`.
 */
function payloadOf(r: LlmResponse | null): unknown | null {
  if (r === null) return null;
  if (r.json !== undefined) return r.json;
  if (!r.text) return null;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

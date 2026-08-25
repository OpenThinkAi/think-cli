/**
 * Compaction SDK call — AGT-298
 *
 * Wraps the Anthropic SDK `messages.create` call for the compaction worker.
 * Uses a cached system prompt (cache_control: ephemeral) and a forced tool_use
 * call so the API enforces the JSON output shape server-side. Retries once on
 * any invalid response.
 *
 * Network errors (5xx, rate limit) are NOT caught here — they bubble up to
 * the queue layer (AGT-299) for retry with backoff.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { LlmStructuredOutputError, type LlmClient, type LlmJsonSchema } from '../../lib/llm/client.js';
import { getDefaultLlmClient, OP_COMPACTION } from '../../lib/llm/router.js';
import {
  COMPACTION_SYSTEM_PROMPT,
  buildCompactionMessages,
} from './prompt.js';
import type { NewEntry, CandidateEntry } from './prompt.js';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { NewEntry, CandidateEntry };

/**
 * Successful compaction result. All three fields are validated before this
 * type is returned — invalid shapes from the model go through one retry and
 * then become `CompactionResponseInvalid`.
 */
export interface CompactionSuccess {
  status: 'ok';
  compacted_text: string;
  supersedes: string[];
  topics: string[];
}

/**
 * Returned when the model response is unusable after one retry. Covers three
 * distinct failure modes: no tool_use block, schema validation failure
 * (e.g. empty compacted_text), or empty topics array. The queue (AGT-299)
 * marks the entry as compaction-skipped (AGT-304) on receiving this.
 */
export interface CompactionResponseInvalid {
  status: 'response_invalid';
}

export type CompactionResult = CompactionSuccess | CompactionResponseInvalid;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Compaction model. Haiku 4.5 — alpha.11 tried Haiku with freeform JSON and
// hit 100% validateShape failures (reverted in alpha.13). This iteration uses
// forced tool_use with a server-validated input_schema so structural conformance
// is no longer the model's job. validateShape() remains as a belt-and-braces
// check for business rules (non-empty compacted_text, non-empty topics).
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 600;
const TEMPERATURE = 0.2;

/**
 * Transport-neutral view of COMPACTION_TOOL. Derived from it rather than
 * duplicated so the Anthropic tool and the OpenAI json_schema cannot drift.
 */
const COMPACTION_SCHEMA: LlmJsonSchema = {
  get name() {
    return COMPACTION_TOOL.name;
  },
  get description() {
    return COMPACTION_TOOL.description;
  },
  get schema() {
    return COMPACTION_TOOL.input_schema as unknown as Record<string, unknown>;
  },
};

const COMPACTION_TOOL: Tool = {
  name: 'submit_compaction',
  description:
    'Submit the compacted entry, list of superseded entry ids, and topic tags.',
  input_schema: {
    type: 'object',
    properties: {
      compacted_text: {
        type: 'string',
        description: 'One-line self-contained rewrite of the new entry.',
      },
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of context entries that the new entry replaces.',
      },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: '1–4 short lowercase topic tags.',
      },
    },
    required: ['compacted_text', 'supersedes', 'topics'],
  },
};

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------

/**
 * Validate business rules on tool_use.input. The API has already enforced the
 * structural shape via input_schema; this only catches semantic problems an
 * input_schema can't express (empty compacted_text → data loss if caller
 * deletes superseded entries).
 *
 * Returns the typed result or null on failure.
 */
function validateShape(parsed: unknown): CompactionSuccess | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.compacted_text !== 'string' || obj.compacted_text.trim() === '') return null;
  if (!Array.isArray(obj.supersedes)) return null;
  if (!obj.supersedes.every((s) => typeof s === 'string')) return null;
  if (!Array.isArray(obj.topics)) return null;
  if (!obj.topics.every((t) => typeof t === 'string')) return null;

  return {
    status: 'ok',
    compacted_text: obj.compacted_text,
    supersedes: obj.supersedes as string[],
    topics: obj.topics as string[],
  };
}

// ---------------------------------------------------------------------------
// Single attempt
// ---------------------------------------------------------------------------

async function attemptCompaction(
  client: LlmClient,
  newEntry: NewEntry,
  candidates: CandidateEntry[],
): Promise<CompactionSuccess | null> {
  const { messages } = buildCompactionMessages(newEntry, candidates);

  // strictSchema: this worker treats a malformed response as a bug, not a
  // retry-and-hope — an earlier freeform-JSON iteration failed 100% of shape
  // validations. On Anthropic that means forced tool_use with a server-side
  // input_schema; on an OpenAI-compatible server, response_format json_schema.
  // cacheSystem preserves the ephemeral prompt cache this worker relies on:
  // the system prompt is fixed and re-sent once per entry.
  let response;
  try {
    response = await client.complete({
      system: COMPACTION_SYSTEM_PROMPT,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      schema: COMPACTION_SCHEMA,
      strictSchema: true,
      cacheSystem: true,
      model: MODEL,
    });
  } catch (e) {
    // A shape failure is transient model non-determinism — return null so the
    // caller's retry-once path runs. Everything else (5xx, rate limit, consent)
    // propagates untouched, which the tests pin.
    if (e instanceof LlmStructuredOutputError) return null;
    throw e;
  }

  const payload = response.json ?? safeParse(response.text);
  if (payload === undefined) return null;

  return validateShape(payload);
}

/** Parse a text response for backends that don't return structured `json`. */
function safeParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the compaction call against the Anthropic API.
 *
 * - Enforces LLM consent gate before any network call.
 * - On any invalid response (no tool_use block or business-rule failure):
 *   retries once with the identical prompt.
 * - On second failure: returns `{ status: "response_invalid" }`.
 * - Network errors (5xx, rate limit) bubble up to the caller unchanged.
 *
 * @param newEntry   The new memory entry to compact.
 * @param candidates Top-K similar candidate entries from the vector store.
 */
export async function runCompaction(
  newEntry: NewEntry,
  candidates: CandidateEntry[],
): Promise<CompactionResult> {
  const client = getDefaultLlmClient(OP_COMPACTION);

  const first = await attemptCompaction(client, newEntry, candidates);
  if (first !== null) return first;

  const second = await attemptCompaction(client, newEntry, candidates);
  if (second !== null) return second;

  return { status: 'response_invalid' };
}

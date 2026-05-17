/**
 * Compaction SDK call — AGT-298
 *
 * Wraps the Anthropic SDK `messages.create` call for the compaction worker.
 * Uses a cached system prompt (cache_control: ephemeral), parses the JSON
 * response, validates the shape, and retries once on any invalid response.
 *
 * Network errors (5xx, rate limit) are NOT caught here — they bubble up to
 * the queue layer (AGT-299) for retry with backoff.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  COMPACTION_SYSTEM_PROMPT,
  buildCompactionMessages,
} from './prompt.js';
import type { NewEntry, CandidateEntry } from './prompt.js';
import { requireLlmConsent } from '../../lib/llm-consent.js';

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
 * distinct failure modes: JSON parse error, schema validation failure, and
 * empty response.content (no text block). The queue (AGT-299) marks the
 * entry as compaction-skipped (AGT-304) on receiving this.
 */
export interface CompactionResponseInvalid {
  status: 'response_invalid';
}

export type CompactionResult = CompactionSuccess | CompactionResponseInvalid;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 600;
const TEMPERATURE = 0.2;

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed value matches the expected compaction result shape.
 * Hand-rolled — zod would add dep weight for a three-field schema (see ticket
 * comment re: tool_use migration in a future stable iteration).
 *
 * Returns the typed result or null on failure.
 */
function validateShape(parsed: unknown): CompactionSuccess | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  // compacted_text must be a non-empty string — an empty string produces data
  // loss if the caller deletes the entries named in supersedes.
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
  client: Anthropic,
  newEntry: NewEntry,
  candidates: CandidateEntry[],
): Promise<CompactionSuccess | null> {
  const { messages } = buildCompactionMessages(newEntry, candidates);

  const systemBlock: TextBlockParam = {
    type: 'text',
    text: COMPACTION_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' },
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [systemBlock],
    messages,
  });

  // Extract the first text content block.
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return null;
  }

  return validateShape(parsed);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the compaction call against the Anthropic API.
 *
 * - Enforces LLM consent gate before any network call.
 * - On any invalid response (no text block, JSON parse error, schema
 *   validation failure): retries once with the identical prompt.
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
  requireLlmConsent();

  const client = new Anthropic();

  // First attempt
  const first = await attemptCompaction(client, newEntry, candidates);
  if (first !== null) return first;

  // Single retry on any invalid response
  const second = await attemptCompaction(client, newEntry, candidates);
  if (second !== null) return second;

  return { status: 'response_invalid' };
}

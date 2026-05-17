/**
 * Supersession LLM call — AGT-303
 *
 * Calls Claude to determine whether a new retro supersedes, duplicates, or
 * coexists with a set of same-cortex same-kind candidates.
 *
 * The candidate-pull is the caller's responsibility.  This module only
 * builds the prompt and calls the Anthropic SDK.
 */

// @anthropic-ai/sdk is a direct dep (not just a transitive dep via claude-agent-sdk)
// because the agent SDK does not re-export the Anthropic class or Message types.
import Anthropic from '@anthropic-ai/sdk';
import { requireLlmConsent } from '../../lib/llm-consent.js';
import {
  SUPERSESSION_SYSTEM_PROMPT,
  buildSupersessionMessages,
  type RetroEntry,
  type RetroCandidate,
} from './prompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupersessionResult {
  /** IDs of candidates that the new retro replaces (may be empty). */
  supersedes: string[];
  /** 1–4 short lowercase topic strings. */
  topics: string[];
  /**
   * True when the new retro is essentially a duplicate of an existing one.
   * The daemon should skip storing when this is true.
   */
  is_duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip optional markdown code fences (```json or ```) from a string.
 * Applied before JSON.parse so that models that occasionally wrap their
 * output still produce valid results.
 */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function parseSupersessionResponse(text: string): SupersessionResult {
  const cleaned = stripFences(text);
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned) as unknown;
  } catch (err) {
    throw new Error(
      `Supersession JSON parse failed. Raw (${text.length} chars): "${text.slice(0, 300)}"`,
      { cause: err },
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Supersession response is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const supersedes = Array.isArray(obj.supersedes)
    ? obj.supersedes.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  const topics = Array.isArray(obj.topics)
    ? obj.topics.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];

  const is_duplicate = typeof obj.is_duplicate === 'boolean' ? obj.is_duplicate : false;

  return { supersedes, topics, is_duplicate };
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the supersession check for a new retro against a set of candidates.
 *
 * Uses `claude-sonnet-4-6` with `temperature: 0.1` (classification task) and
 * a cached system prompt (`cache_control: { type: "ephemeral" }`).  Strips
 * markdown code fences before JSON.parse to handle models that wrap output.
 * Retries once on parse failure (recovers from transient non-determinism;
 * systematic failures will still fail on the second attempt).
 *
 * `max_tokens: 300` is sized for compact JSON output. If the candidate count
 * is ever raised significantly (> ~20 long IDs), revisit this limit.
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
  requireLlmConsent();

  const client = new Anthropic();
  const { messages } = buildSupersessionMessages(newRetro, candidates);

  const callClaude = (): Promise<Anthropic.Message> =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      temperature: 0.1,
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: SUPERSESSION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    });

  // First attempt
  const response = await callClaude();
  const rawText = extractText(response);

  try {
    return parseSupersessionResponse(rawText);
  } catch {
    // Retry once on transient parse failure (non-deterministic model output).
    // Fence stripping handles systematic wrapping; this retry is a last resort
    // for genuinely transient failures.
    const retryResponse = await callClaude();
    const retryText = extractText(retryResponse);
    return parseSupersessionResponse(retryText);
  }
}

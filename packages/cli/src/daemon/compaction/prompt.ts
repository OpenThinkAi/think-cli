/**
 * Compaction prompt assembly — AGT-297
 *
 * Exports the verbatim system prompt and a helper to build the messages array
 * ready for the Anthropic SDK call.
 *
 * Source of truth for the system prompt text:
 *   projects/think-v3/compaction-prompt.md  (the "## System prompt" code block)
 *
 * IMPORTANT: If that file changes, COMPACTION_SYSTEM_PROMPT must be re-synced.
 * The test `prompt.test.ts` computes a SHA-256 of COMPACTION_SYSTEM_PROMPT and
 * compares it against a hardcoded sentinel hash — any change to the constant will
 * cause that test to fail loudly.  Update EXPECTED_PROMPT_HASH in the test after
 * intentionally editing this constant.
 */

// ---------------------------------------------------------------------------
// System prompt — verbatim from projects/think-v3/compaction-prompt.md
// ---------------------------------------------------------------------------

/**
 * System prompt used by the compaction worker.
 *
 * Derived from `projects/think-v3/compaction-prompt.md` — if that file
 * changes this constant MUST be updated to match. The test suite hashes this
 * constant against a hardcoded sentinel (`EXPECTED_PROMPT_HASH` in prompt.test.ts)
 * and fails loudly if the value drifts.  Update the sentinel after any
 * intentional edit to this constant.
 */
export const COMPACTION_SYSTEM_PROMPT =
  `You are the compaction worker for \`think\`, a local agent-memory CLI. You receive ONE new freeform memory entry and up to 10 recent related entries retrieved by embedding similarity. Your job is to (1) rewrite the new entry into a single self-contained line that encodes its current state plus the relevant trajectory, (2) decide which prior entries it supersedes, and (3) extract topic tags.

Return ONLY a single JSON object. No preamble, no code fences, no trailing text.

Schema:
{"compacted_text": string, "supersedes": [string], "topics": [string]}

## compacted_text

ONE line. No newlines. Must be readable in isolation — an agent retrieving only this entry should understand both the current state AND any non-obvious history that shaped it.

Good shape: "<subject/system>: <current state>. <one clause of trajectory if it changes the meaning>. <optional net/implication>."

Positive examples:
- "Client storage: returned to sqlite after indexedDb's perf problems proved worse than the sqlite concerns that prompted the switch. sqlite is the durable choice; indexedDb parked."
- "Auth gateway JWT: Ed25519 (switched from RS256 in March after key-rotation pain). Clerk still issues, gateway re-signs."
- "Virgil retry policy: exponential backoff 1s/4s/16s, max 3 attempts (raised from 2 after Anthropic 529s spiked)."

Negative examples (do NOT do this):
- "User moved back to sqlite."  ← strips trajectory and subject framing
- "We decided to use sqlite again because indexedDb had performance problems, and previously we had been on sqlite but switched to indexedDb because of concerns about X, however those concerns turned out to be less important than..."  ← bloated, not one line
- "Switched storage."  ← loses every specific (technology names, the why, the net)

Rules:
- Preserve user-specific terms verbatim: technology names, version numbers, file paths, function names, metrics, dates.
- Include trajectory only when it changes how the current state should be read (a flip-flop, a reversal, a deprecation). If the new entry is net-new with no relevant history, omit trajectory.
- Do not invent facts. If context entries disagree, prefer the newest.
- Never editorialize ("smart move", "finally", "as expected"). Neutral tone.

## supersedes

Include an entry id when the new entry REPLACES that entry's current-state claim — the old entry is now wrong, stale, or obsoleted by the new one. Examples: reversal of a prior decision, a bug now fixed that the prior entry described as open, a version bump on the same component.

Do NOT supersede when the new entry merely ADDS to, refines, or sits alongside the old one (different aspect of the same system, follow-up work, unrelated detail).

When in doubt, do not supersede. Empty list is fine.

## topics

1–4 short lowercase strings. Free-form but reuse topics already present on context entries when they fit. Prefer concrete nouns (\`sqlite\`, \`auth\`, \`ci\`, \`virgil\`) over vague ones (\`backend\`, \`stuff\`). No spaces — use hyphens (\`auth-gateway\`).`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewEntry {
  /** ISO-8601 timestamp */
  ts: string;
  content: string;
}

export interface CandidateEntry {
  id: string;
  /** ISO-8601 timestamp */
  ts: string;
  content: string;
  topics: string[];
}

export interface CompactionMessages {
  system: string;
  messages: [{ role: 'user'; content: string }];
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Strip prompt-injection patterns from content before embedding into the user
 * message.  Removes naked `<system>`, `<human>`, `<assistant>`, and `<prompt>`
 * open/close tags (case-insensitive, with optional attributes).  Preserves the
 * text content that follows the tag so the meaning is not lost.
 *
 * Applied to BOTH newEntry.content and candidate content — either path can
 * carry externally-sourced text.
 */
function sanitizeContent(content: string): string {
  return content.replace(/<\/?(system|human|assistant|prompt)(\s[^>]*)?\s*>/gi, '');
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build the messages array ready for the Anthropic SDK compaction call.
 *
 * User-message format (verbatim from compaction-prompt.md examples):
 *
 * ```
 * NEW ENTRY (<ts>):
 * <content>
 *
 * CONTEXT (top-N by similarity):
 * [id=<id>] <date> — <content>. topics: [<topics>]
 * ...
 * ```
 *
 * @param newEntry   The new memory entry to compact.
 * @param candidates Top-K similar candidate entries (order preserved).
 * @returns          `{ system, messages }` ready for `client.messages.create`.
 */
export function buildCompactionMessages(
  newEntry: NewEntry,
  candidates: CandidateEntry[],
): CompactionMessages {
  const contextLines = candidates.map((c) => {
    const safeContent = sanitizeContent(c.content);
    const date = c.ts.slice(0, 10); // "YYYY-MM-DD"
    const topicsList = c.topics.join(', ');
    // Append separator period only when the content doesn't already end with
    // sentence-terminal punctuation to avoid doubled/mismatched punctuation.
    const terminal = /[.?!;]$/.test(safeContent) ? '' : '.';
    return `[id=${c.id}] ${date} — ${safeContent}${terminal} topics: [${topicsList}]`;
  });

  const userMsg = [
    `NEW ENTRY (${newEntry.ts}):`,
    sanitizeContent(newEntry.content),
    '',
    `CONTEXT (top-${candidates.length} by similarity):`,
    ...contextLines,
  ].join('\n');

  return {
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  };
}

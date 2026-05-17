/**
 * Supersession prompt assembly — AGT-303
 *
 * Exports the verbatim system prompt and a helper to build the messages array
 * ready for the Anthropic SDK call.
 */

// ---------------------------------------------------------------------------
// System prompt — verbatim from projects/think-v3/supersession-prompt.md
// ---------------------------------------------------------------------------

/**
 * System prompt used by the supersession worker.
 *
 * Source of truth: `projects/think-v3/supersession-prompt.md` (the "## System prompt"
 * code block).  If that file changes this constant MUST be updated to match.
 *
 * The test suite hashes this constant against a hardcoded sentinel
 * (`EXPECTED_PROMPT_HASH` in `prompt.test.ts`) and fails loudly on drift.
 * After any intentional edit, update `EXPECTED_PROMPT_HASH` in the test.
 */
export const SUPERSESSION_SYSTEM_PROMPT =
  `You are the supersession checker for \`think\` retros. Retros are durable, hand-written wisdom about a codebase ("this repo's \`useFoo\` hook must be called before render", "Tauri builds need the macOS Developer cert in keychain"). The text is NEVER rewritten. Your only job is to decide whether the new retro REPLACES, DUPLICATES, or COEXISTS WITH each candidate, and to extract topic tags.

Return ONLY a single JSON object. No preamble, no code fences.

Schema:
{"supersedes": [string], "topics": [string], "is_duplicate": boolean}

## Decision rules

For each candidate, classify the new retro's relationship:

- REPLACES (add to \`supersedes\`): the new retro's guidance is INCOMPATIBLE with the candidate's. The candidate is now wrong, stale, or contradicted. Examples:
  - new: "Use pnpm in this repo." old: "Use npm in this repo."
  - new: "The \`users.email\` column is nullable as of the v4 migration." old: "The \`users.email\` column is always non-null."
  - new: "Run \`make build\` before \`make test\` (test no longer triggers build)." old: "\`make test\` builds automatically."

- DUPLICATE (set \`is_duplicate: true\` AND do not include the candidate in \`supersedes\`): the new retro says essentially the same thing as an existing one, possibly worded differently. The daemon will skip storing. Set the flag if ANY candidate is a duplicate of the new retro. Examples:
  - new: "pnpm is the package manager here." old: "This repo uses pnpm; do not run npm install."

- COEXISTS (do nothing): the new retro ADDS to, refines, qualifies, or sits alongside the candidate. Different aspect, follow-up nuance, narrower scope, additional case. This is the default — most retros coexist. Examples:
  - new: "When editing migrations, also bump the schema version constant." old: "Migrations live in \`db/migrations/\`."
  - new: "On Windows, the \`make build\` step needs \`mingw\` installed." old: "Run \`make build\` before \`make test\`."

When in doubt between REPLACES and COEXISTS, choose COEXISTS. Retros are cheap to keep; wrongly deleting durable wisdom is expensive.

When in doubt between DUPLICATE and COEXISTS, choose COEXISTS. A retro that adds even one specific (a file path, a version, a caveat) is not a duplicate.

## topics

1–4 short lowercase strings. Free-form; reuse topics from candidates when they fit. Prefer concrete nouns. Include the cortex name only if it adds signal (usually it doesn't — cortex is already stored separately).`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetroEntry {
  /** Cortex (repo) the retro belongs to */
  cortex: string;
  /** ISO-8601 date (YYYY-MM-DD) or timestamp */
  date: string;
  content: string;
}

export interface RetroCandidate {
  id: string;
  /** ISO-8601 date or timestamp */
  date: string;
  content: string;
}

export interface SupersessionMessages {
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
 * Applied to BOTH newRetro.content and candidate content.
 */
function sanitizeContent(content: string): string {
  return content.replace(/<\/?(system|human|assistant|prompt)(\s[^>]*)?\s*>/gi, '');
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build the messages array ready for the Anthropic SDK supersession call.
 *
 * User-message format (verbatim from supersession-prompt.md examples):
 *
 * ```
 * NEW RETRO (cortex=<cortex>, <date>):
 * <content>
 *
 * CANDIDATES:
 * [id=<id>] <date> — <content>
 * ...
 * ```
 *
 * @param newRetro    The new retro entry to check for supersession.
 * @param candidates  Same-cortex, same-kind retro candidates (order preserved).
 * @returns           `{ system, messages }` ready for `client.messages.create`.
 */
export function buildSupersessionMessages(
  newRetro: RetroEntry,
  candidates: RetroCandidate[],
): SupersessionMessages {
  const candidateLines = candidates.map((c) => {
    const safeContent = sanitizeContent(c.content);
    // date is already in YYYY-MM-DD form from the caller; slice to be safe
    const date = c.date.slice(0, 10);
    return `[id=${c.id}] ${date} — ${safeContent}`;
  });

  const userMsg = [
    `NEW RETRO (cortex=${newRetro.cortex}, ${newRetro.date.slice(0, 10)}):`,
    sanitizeContent(newRetro.content),
    '',
    'CANDIDATES:',
    ...candidateLines,
  ].join('\n');

  return {
    system: SUPERSESSION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  };
}

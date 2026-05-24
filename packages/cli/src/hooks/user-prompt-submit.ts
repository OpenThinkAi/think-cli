/**
 * Claude Code `UserPromptSubmit` hook — AGT-312
 *
 * Entrypoint invoked by Claude Code on every user prompt. Reads the hook
 * payload from stdin, calls the think daemon's `recall` RPC with the user's
 * prompt as the query, and emits relevant context back via the
 * `hookSpecificOutput.additionalContext` field so Claude Code injects it into
 * the agent context before processing the prompt.
 *
 * Protocol ref: Claude Code hook protocol (UserPromptSubmit shape).
 *
 * Input (stdin, JSON):
 *   { user_prompt: string; cwd: string; session_id: string }
 *
 * Output (stdout, JSON):
 *   { hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string } }
 *   — or empty object when daemon is unavailable or no entries found.
 *
 * Fail-open contract: any error (stdin parse, daemon connect, recall RPC)
 * causes exit 0 with no additionalContext. The hook MUST NOT block the user's
 * prompt; degraded recall is preferable to a blocked prompt.
 *
 * Security note: `additionalContext` is injected into the agent's context
 * window. This hook surfaces only content the user themselves stored in think
 * (their own memories, engrams, and long-term entries) — the `scope: "accessible"`
 * recall scope is defined in `packages/cli/src/daemon/recall.ts` to enumerate only
 * locally-cloned cortexes belonging to the authenticated user, never remote peers
 * or shared stores. Each entry's content is truncated to MAX_ENTRY_CHARS to bound
 * the injection blast radius. Content is otherwise passed verbatim — no HTML
 * escaping or instruction-stripping is applied, because this is an intra-process
 * trusted channel and such transforms would degrade recall utility.
 *
 * Performance target: <500ms warm (daemon already running). The RPC timeout
 * is set to 400ms so that even accounting for stdin read and serialization the
 * total hook latency stays below the warm target. Cold-start (daemon not yet
 * running) will exceed 500ms due to daemon spawn time; in that case the hook
 * falls back to the DaemonUnavailableError path and returns empty output rather
 * than waiting up to the full spawn timeout.
 *
 * Note on `cwd` and `session_id`: these fields are parsed from stdin but not
 * forwarded to the recall RPC. The daemon recall endpoint does not currently
 * support workspace-scoped filtering, so both fields are intentionally unused.
 * When workspace-scoped recall lands (future AGT), wire `cwd` through here.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDaemon } from '../lib/daemon-client.js';
import type { RecallEntry } from '../daemon/recall.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of recall entries to inject. */
export const RECALL_LIMIT = 5;

/**
 * Per-RPC timeout in milliseconds.
 *
 * 400ms keeps warm hook latency well under the 500ms target even after
 * accounting for stdin read and JSON serialization overhead. Slow or
 * overloaded daemon calls are dropped (fail open) rather than delaying
 * the user's prompt.
 */
export const RECALL_TIMEOUT_MS = 400;

/**
 * Minimum prompt length (trimmed characters) before a recall RPC is issued.
 *
 * One-word follow-ups ("ok", "yes", "k") produce low-quality recall results
 * and waste a daemon round-trip. Skip recall for trivially short prompts.
 */
export const MIN_PROMPT_LENGTH = 10;

/**
 * Maximum character length per injected recall entry's content field.
 *
 * Truncating at this limit bounds the blast radius of a poisoned or
 * excessively-long memory entry — 2 000 chars is ample for any meaningful
 * memory while preventing multi-KB entries from flooding the context window.
 */
export const MAX_ENTRY_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/** Read all of stdin and return as a string. Accepts an optional stream for testing. */
export async function readStdin(stream?: NodeJS.ReadableStream): Promise<string> {
  const src = stream ?? process.stdin;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    src.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)));
    src.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    src.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Emit the hook response with additionalContext to an output stream. */
export function writeWithContext(additionalContext: string, out?: NodeJS.WritableStream): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  (out ?? process.stdout).write(JSON.stringify(output) + '\n');
}

/** Emit an empty hook response (daemon unavailable or no entries). */
export function writeEmpty(out?: NodeJS.WritableStream): void {
  (out ?? process.stdout).write(JSON.stringify({}) + '\n');
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Format recall entries into a compact markdown block suitable for injection
 * into the agent's context window.
 */
export function buildAdditionalContext(entries: RecallEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((e) => {
    const cortexTag = e.cortex ? `[${e.cortex}] ` : '';
    const body = (e.content ?? '').slice(0, MAX_ENTRY_CHARS);
    return `- ${cortexTag}${body}`;
  });

  return `Relevant context from think (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Hook entrypoint. Accepts optional I/O streams for unit-testing without
 * spawning a subprocess. Production callers omit both arguments (fall back to
 * `process.stdin` / `process.stdout`).
 */
export async function main(
  stdin?: NodeJS.ReadableStream,
  stdout?: NodeJS.WritableStream,
): Promise<void> {
  // ── 1. Read + parse stdin ─────────────────────────────────────────────────
  let userPrompt: string;
  let sessionId: string | null = null;
  try {
    const raw = await readStdin(stdin);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prompt = parsed['user_prompt'];
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      writeEmpty(stdout);
      return;
    }
    userPrompt = prompt.trim();
    if (typeof parsed['session_id'] === 'string' && parsed['session_id'].length > 0) {
      sessionId = parsed['session_id'];
    }
  } catch {
    // Malformed stdin — fail open, don't block the prompt.
    writeEmpty(stdout);
    return;
  }

  // ── 1a. Skip trivially short prompts ─────────────────────────────────────
  if (userPrompt.length < MIN_PROMPT_LENGTH) {
    // One-word follow-ups ("ok", "yes", "continue") produce low-quality recall.
    // Skip the daemon RPC to avoid noise and unnecessary latency.
    writeEmpty(stdout);
    return;
  }

  // ── 2. Connect to daemon ──────────────────────────────────────────────────
  let client: Awaited<ReturnType<typeof connectDaemon>>;
  try {
    client = await connectDaemon();
  } catch {
    // Daemon unavailable or unexpected connect error — fail open silently.
    writeEmpty(stdout);
    return;
  }

  // ── 3. Call recall RPC ────────────────────────────────────────────────────
  let entries: RecallEntry[];
  try {
    const result = await client.call(
      'recall',
      {
        query: userPrompt,
        scope: 'accessible',
        limit: RECALL_LIMIT,
        source: 'hook',
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      RECALL_TIMEOUT_MS,
    );
    entries = result as RecallEntry[];
  } catch {
    // Recall failed (timeout, daemon error, etc.) — fail open.
    client.close();
    writeEmpty(stdout);
    return;
  }

  client.close();

  // ── 4. Build + emit output ────────────────────────────────────────────────
  if (!Array.isArray(entries) || entries.length === 0) {
    writeEmpty(stdout);
    return;
  }

  const additionalContext = buildAdditionalContext(entries);
  if (additionalContext.length === 0) {
    writeEmpty(stdout);
    return;
  }

  writeWithContext(additionalContext, stdout);
}

// ---------------------------------------------------------------------------
// Script entrypoint — guarded so main() only runs when invoked directly by
// Claude Code (or the shell), not on every module import (e.g. during tests).
//
// ESM has no `require.main === module` equivalent. The canonical guard is
// comparing import.meta.url against the resolved path of process.argv[1] —
// but `fs.realpathSync` is required on BOTH sides because macOS resolves
// symlinks (e.g. `/tmp` → `/private/tmp`) in `import.meta.url` while leaving
// `process.argv[1]` unresolved. A direct string compare silently fails for
// the same physical file when either path traverses a symlink, which makes
// the hook a no-op (and Claude Code surfaces the empty/failed response as
// "UserPromptSubmit hook error … :2"). Same idiom as `daemon/index.ts`
// auto-execute block (fix shipped in alpha.7).
// ---------------------------------------------------------------------------
let _invokedAsScript = false;
if (process.argv[1]) {
  try {
    _invokedAsScript = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // If realpath fails (path missing, perms), assume not script-invoked.
  }
}
if (_invokedAsScript) {
  main().catch(() => {
    // Catch-all: any unhandled rejection — fail open, don't crash Claude Code.
    writeEmpty();
  });
}

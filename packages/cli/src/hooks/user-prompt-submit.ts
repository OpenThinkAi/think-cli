#!/usr/bin/env node
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
 * (their own memories, engrams, and long-term entries). It never surfaces
 * credentials, secrets, or data from other users. Content is passed verbatim
 * — no sanitization is applied beyond what `think recall` already enforces.
 *
 * Performance target: <500ms warm (daemon already running).
 */

import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';
import type { RecallEntry } from '../daemon/recall.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of recall entries to inject. */
const RECALL_LIMIT = 5;

/** Per-RPC timeout — keep short so the hook doesn't delay the prompt. */
const RECALL_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/** Read all of stdin and return as a string. */
async function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Emit the hook response with additionalContext to stdout. */
function writeWithContext(additionalContext: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

/** Emit an empty hook response (daemon unavailable or no entries). */
function writeEmpty(): void {
  process.stdout.write(JSON.stringify({}) + '\n');
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Format recall entries into a compact markdown block suitable for injection
 * into the agent's context window.
 */
function buildAdditionalContext(entries: RecallEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((e) => {
    const cortexTag = e.cortex ? `[${e.cortex}] ` : '';
    return `- ${cortexTag}${e.content}`;
  });

  return `Relevant context from think (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── 1. Read + parse stdin ─────────────────────────────────────────────────
  let userPrompt: string;
  try {
    const raw = await readStdin();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prompt = parsed['user_prompt'];
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      // No usable prompt — exit cleanly with no context.
      writeEmpty();
      return;
    }
    userPrompt = prompt.trim();
  } catch {
    // Malformed stdin — fail open, don't block the prompt.
    writeEmpty();
    return;
  }

  // ── 2. Connect to daemon ──────────────────────────────────────────────────
  let client;
  try {
    client = await connectDaemon();
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      // Daemon not running — fail open silently.
      writeEmpty();
      return;
    }
    // Unexpected connect error — still fail open.
    writeEmpty();
    return;
  }

  // ── 3. Call recall RPC ────────────────────────────────────────────────────
  let entries: RecallEntry[];
  try {
    const result = await client.call(
      'recall',
      { query: userPrompt, scope: 'accessible', limit: RECALL_LIMIT },
      RECALL_TIMEOUT_MS,
    );
    entries = result as RecallEntry[];
  } catch {
    // Recall failed (timeout, daemon error, etc.) — fail open.
    client.close();
    writeEmpty();
    return;
  }

  client.close();

  // ── 4. Build + emit output ────────────────────────────────────────────────
  if (!Array.isArray(entries) || entries.length === 0) {
    writeEmpty();
    return;
  }

  const additionalContext = buildAdditionalContext(entries);
  if (additionalContext.length === 0) {
    writeEmpty();
    return;
  }

  writeWithContext(additionalContext);
}

main().catch(() => {
  // Catch-all: any unhandled rejection — fail open, don't crash Claude Code.
  writeEmpty();
});

/**
 * Refresh every managed block the AGT-1305 registry knows about, from the
 * CURRENT (just-installed) template — AGT-1306 / think-3 design doc,
 * "Self-heal set": "Refresh every managed block think knows about."
 *
 * Two halves:
 *
 *  - `refreshRegisteredBlocks` does the actual work. It is plain, synchronous,
 *    and has no re-exec awareness of its own — it just rebuilds whatever
 *    `listRegisteredBlocks()` reports using the template code that is loaded
 *    in the CURRENT process. That is exactly why it must never be called
 *    in-process from `think update` after `npm install -g` has replaced
 *    dist/ (see restartDaemonViaBin in daemon-drift.ts for the identical
 *    hazard with the daemon): the old process's copy of this function still
 *    embeds the OLD template, so calling it directly would "refresh" every
 *    file to stale content.
 *
 *  - `refreshBlocksViaBin` is the re-exec seam `think update` actually calls.
 *    It shells out to `node <pkgRoot>/dist/index.js refresh-blocks-internal`
 *    (the hidden CLI entry point in commands/refresh-blocks-internal.ts) so
 *    the refresh always runs inside the freshly installed code, and parses
 *    the machine-readable JSON result that command prints on stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  listRegisteredBlocks,
  recordBlockWrite,
  type BlockKind,
} from './block-registry.js';
import {
  buildBlock,
  buildRetroBlock,
  upsertBlock,
  WORKLOG_UPSERT,
  RETRO_UPSERT,
} from '../commands/init.js';

export interface BlockRefreshFailure {
  path: string;
  kind: BlockKind;
  /** Human-readable reason — permissions, vanished file, ambiguous markers, etc. */
  reason: string;
}

export interface BlockRefreshResult {
  /**
   * Paths whose managed block was actually rewritten (created / replaced /
   * deduped / migrated / appended). A file whose block already matches the
   * current template is NOT included here — `upsertBlock` returns
   * `{ kind: 'unchanged' }` for it and never calls `writeFileSync`, so its
   * mtime is untouched (AC1).
   *
   * Under `dryRun` this is the same list, one step earlier: the paths a real
   * refresh WOULD rewrite.
   */
  refreshed: string[];
  failures: BlockRefreshFailure[];
}

export interface RefreshBlocksOptions {
  /**
   * Compute the outcome without writing anything (AGT-1308). `think doctor`
   * reports "managed blocks out of date" this way, so its report is produced
   * by the very code `--fix` then runs for real — the two cannot drift apart
   * the way a separate staleness heuristic would.
   */
  dryRun?: boolean;
}

/**
 * Extract the cortex name baked into an existing retro block's body (e.g.
 * "...run: think brief --context <cortex>"). The registry (AGT-1305) records
 * only path/kind/markers — not the cortex — so rebuilding a retro block from
 * today's template needs the cortex re-derived from the text already on
 * disk. Per AGT-1306's implementation notes: never guess a cortex out of
 * thin air; if it can't be found in the existing block, the caller must
 * report the entry as a failure rather than fabricate one.
 */
function extractRetroCortex(blockBody: string): string | null {
  const match = blockBody.match(/think brief --context (\S+)/);
  return match ? match[1] : null;
}

function upsertOptionsFor(kind: BlockKind) {
  return kind === 'retro' ? RETRO_UPSERT : WORKLOG_UPSERT;
}

/**
 * Build the up-to-date block body for one registry entry. Throws (caller
 * catches, per-entry) rather than returning a sentinel, so every reason a
 * rebuild can't proceed — vanished file, marker drift, an un-derivable
 * cortex — flows through the same failure path.
 */
function buildCurrentBlockFor(kind: BlockKind, entryPath: string, beginMarker: string, endMarker: string): string {
  if (kind !== 'retro') {
    return buildBlock(kind === 'minimal');
  }

  const content = fs.readFileSync(entryPath, 'utf-8');
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error('registered marker pair not found in file');
  }
  const body = content.slice(beginIdx + beginMarker.length, endIdx);
  const cortex = extractRetroCortex(body);
  if (!cortex) {
    throw new Error('could not determine the cortex baked into the existing retro block');
  }
  return buildRetroBlock(cortex);
}

/**
 * Rebuild every registered managed block from the template loaded in THIS
 * process. Never throws: a single entry failing (permissions, a vanished
 * file, a marker pair that no longer matches the current template) is
 * collected into `failures` and every other entry is still attempted (AC5).
 */
export function refreshRegisteredBlocks(options: RefreshBlocksOptions = {}): BlockRefreshResult {
  const dryRun = options.dryRun === true;
  const entries = listRegisteredBlocks();
  const refreshed: string[] = [];
  const failures: BlockRefreshFailure[] = [];

  for (const entry of entries) {
    try {
      const opts = upsertOptionsFor(entry.kind);
      // The registry's marker pair should always match the current
      // template's constants — marker text is meant to be stable across
      // template revisions (only the body between them changes). If it
      // doesn't, rewriting with today's markers risks `upsertBlock` finding
      // no clean pair and appending a second, duplicate block. Treat that
      // mismatch as an ambiguous-marker failure rather than guessing.
      if (entry.beginMarker !== opts.beginMarker || entry.endMarker !== opts.endMarker) {
        throw new Error('registered marker pair does not match the current template — skipped to avoid an ambiguous rewrite');
      }

      const block = buildCurrentBlockFor(entry.kind, entry.path, opts.beginMarker, opts.endMarker);
      const result = upsertBlock(entry.path, block, { ...opts, dryRun });
      // Re-registering is itself a write to the registry file, so it is
      // skipped under a dry run along with the block write it records.
      if (!dryRun) recordBlockWrite(entry.path, entry.kind, opts.beginMarker, opts.endMarker);
      if (result.kind !== 'unchanged') {
        refreshed.push(entry.path);
      }
    } catch (err) {
      failures.push({
        path: entry.path,
        kind: entry.kind,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { refreshed, failures };
}

/** Exec seam for tests; production default is execFileSync. Returns stdout. */
export type SpawnFn = (file: string, args: string[]) => string;

export interface BlockRefreshViaBinResult {
  ok: boolean;
  refreshed: string[];
  failures: BlockRefreshFailure[];
  /** Set when ok=false — spawn failed, or its stdout wasn't parseable JSON. */
  error?: string;
}

/**
 * Run the refresh by spawning `node <pkgRoot>/dist/index.js
 * refresh-blocks-internal` — NOT by calling `refreshRegisteredBlocks`
 * in-process — so it always executes the freshly installed template, exactly
 * as `restartDaemonViaBin` shells out for the daemon restart (see that
 * function's doc comment in daemon-drift.ts for why an in-process call after
 * `npm install -g` is unsafe).
 */
export function refreshBlocksViaBin(pkgRoot: string, spawn?: SpawnFn): BlockRefreshViaBinResult {
  const bin = path.join(pkgRoot, 'dist', 'index.js');
  const run: SpawnFn = spawn ?? ((file, args) => execFileSync(file, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }));
  try {
    const stdout = run(process.execPath, [bin, 'refresh-blocks-internal']);
    const parsed = JSON.parse(stdout) as BlockRefreshResult;
    return { ok: true, refreshed: parsed.refreshed, failures: parsed.failures };
  } catch (err) {
    return {
      ok: false,
      refreshed: [],
      failures: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

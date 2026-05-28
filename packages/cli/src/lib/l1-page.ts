/**
 * L1 JSONL page helpers — shared across all daemon write paths.
 *
 * Extracted from sync-handler.ts / supersession/apply.ts / compaction/apply.ts
 * to eliminate three copies of the same rotation logic.
 *
 * Naming convention: pages are numbered `000001.jsonl`, `000002.jsonl`, …
 * Rotation happens when the active page reaches `L1_PAGE_SIZE` non-empty lines.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Maximum number of JSONL lines per page before rotating to a new file. */
export const L1_PAGE_SIZE = 1000;

/**
 * Returns the absolute path to the active L1 JSONL page for the given cortex
 * directory. Creates a new numbered page when the current one has reached
 * `L1_PAGE_SIZE` lines.
 *
 * `cortexDir` must be the full path to the cortex's directory inside the repo
 * working tree. The directory does not have to exist yet — callers are
 * expected to create it (e.g. via `appendToL1Page`) before writing.
 *
 * NOTE: this read-then-write is not atomic under concurrent callers.
 * A per-cortex write queue (mutex) should wrap L1 writes in a future ticket
 * before the daemon handles real concurrency.
 */
export function getActivePage(cortexDir: string): string {
  let files: string[] = [];
  try {
    files = fs.readdirSync(cortexDir)
      .filter(f => /^\d{6}\.jsonl$/.test(f))
      .sort();
  } catch {
    files = [];
  }

  if (files.length === 0) {
    return path.join(cortexDir, '000001.jsonl');
  }

  const latestFile = files[files.length - 1];
  const latestPath = path.join(cortexDir, latestFile);

  let lineCount = 0;
  try {
    const raw = fs.readFileSync(latestPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.length > 0) lineCount++;
    }
  } catch {
    lineCount = 0;
  }

  if (lineCount >= L1_PAGE_SIZE) {
    const nextNum = parseInt(latestFile, 10) + 1;
    return path.join(cortexDir, String(nextNum).padStart(6, '0') + '.jsonl');
  }

  return latestPath;
}

/**
 * Append a single JSONL line (serialized from `obj`) to the active L1 page
 * for the given cortex directory. Creates the directory and page file if they
 * do not yet exist.
 *
 * Does NOT commit or push — that is the push-debounce worker's responsibility.
 */
export function appendToL1Page(cortexDir: string, obj: Record<string, unknown>): void {
  fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 });
  const pagePath = getActivePage(cortexDir);
  fs.appendFileSync(pagePath, JSON.stringify(obj) + '\n', 'utf-8');
}

/**
 * Append an already-serialized JSONL line to the active L1 page. Used by the
 * outbox drain in `push-debouncer.ts`, which stores the wire-format line in
 * `l1_outbox.line` and writes it verbatim — bypassing a redundant JSON
 * round-trip and preserving the exact bytes the producer enqueued.
 *
 * The `line` argument must NOT end with a newline; this helper appends one.
 */
export function appendRawLineToL1Page(cortexDir: string, line: string): void {
  fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 });
  const pagePath = getActivePage(cortexDir);
  fs.appendFileSync(pagePath, line + '\n', 'utf-8');
}

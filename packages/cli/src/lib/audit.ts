import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/client.js';

export interface AuditEntry {
  timestamp: string;
  type: 'export' | 'import' | 'network-send' | 'network-receive';
  peer: string;
  host?: string;
  file?: string;
  entryIds: string[];
  count: number;
}

// AGT-063: rotation threshold. Active log size > 2MB → rename to .1 (one
// archive deep, oldest dropped on the next rotation) and start fresh. Sized
// for ~10k entries at typical line lengths; the AC asked for 10k lines and
// fs.statSync is O(1) where line counting would be O(n) per append. The
// audit log is appended on every sync event, so the cheap check matters.
const ROTATION_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB

function auditLogPath(): string {
  return path.join(getDataDir(), 'sync-audit.log');
}

function archivedLogPath(): string {
  return path.join(getDataDir(), 'sync-audit.log.1');
}

function shouldRotate(activePath: string): boolean {
  try {
    const stat = fs.statSync(activePath);
    return stat.size >= ROTATION_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

function rotate(activePath: string): void {
  const archive = archivedLogPath();
  // One archive deep: a pre-existing .1 from the previous rotation is
  // dropped here. If a deeper retention policy is ever wanted, this is the
  // place to tier it (e.g. .1 → .2 then drop .2).
  try {
    fs.renameSync(activePath, archive);
  } catch {
    // Best-effort: rotation failure should not block the audit append.
    // Worst case the active log keeps growing past the threshold for a
    // bit longer; the next successful rotation catches up.
  }
}

export function logAudit(entry: AuditEntry): void {
  const activePath = auditLogPath();
  if (shouldRotate(activePath)) {
    rotate(activePath);
  }
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(activePath, line, 'utf-8');
}

function parseAuditLines(raw: string): AuditEntry[] {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Reads the active log + the most recent archive (`sync-audit.log.1`),
 * concatenated in chronological order — archive first since rotation
 * moves older entries there. Callers downstream of this don't need to
 * know about rotation; the archive is a transparent extension of the
 * tail of `think audit`.
 */
export function readAuditLog(): AuditEntry[] {
  const archive = archivedLogPath();
  const active = auditLogPath();

  const archived = fs.existsSync(archive)
    ? parseAuditLines(fs.readFileSync(archive, 'utf-8'))
    : [];
  const live = fs.existsSync(active)
    ? parseAuditLines(fs.readFileSync(active, 'utf-8'))
    : [];

  return [...archived, ...live];
}

/**
 * Drops entries with `timestamp < beforeIso` from the active log (and
 * optionally the rotated archive). Returns the number of lines pruned
 * across both files. Used by `think audit prune --before <date>`.
 *
 * The compare is lexicographic on ISO-8601 strings — valid for the
 * timestamp shape the rest of the pipeline writes.
 */
export function pruneAuditLog(beforeIso: string, opts: { includeArchive?: boolean } = {}): number {
  let pruned = 0;
  const targets = [auditLogPath()];
  if (opts.includeArchive) targets.push(archivedLogPath());

  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    const all = parseAuditLines(fs.readFileSync(file, 'utf-8'));
    const kept = all.filter((e) => e.timestamp >= beforeIso);
    pruned += all.length - kept.length;
    if (kept.length === 0) {
      fs.unlinkSync(file);
    } else {
      const out = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(file, out, 'utf-8');
    }
  }

  return pruned;
}

// Test seam: lets unit tests assert + override the threshold without
// monkey-patching the module-level constant. Keeping the production
// constant immutable; this is opt-in for tests only.
export const __testing__ = {
  ROTATION_THRESHOLD_BYTES,
  archivedLogPath,
  auditLogPath,
};

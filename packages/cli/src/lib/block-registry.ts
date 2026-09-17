import fs from 'node:fs';
import path from 'node:path';
import { getBlockRegistryPath } from './paths.js';

// Registry of every file `think init` has written a managed block into
// (AGT-1305 / think-3 design doc, "Instruction blocks"). `think update`
// (AGT-1306) walks this to refresh every managed block on upgrade, and
// `think doctor` (AGT-1308) walks it to report which are out of date.
//
// One JSON array lives at `getBlockRegistryPath()` (under THINK_HOME).
// Each entry records the absolute path of the file, which kind of block
// was written there, and the exact marker pair that delimits it — the
// markers are stored on the entry (rather than re-derived from `kind` by
// a caller) so pruning is self-contained: staleness is just "does this
// file still exist and still contain this marker pair," with no need to
// import init.ts's template constants here and risk a cycle.
export type BlockKind = 'work-log' | 'minimal' | 'retro';

export interface BlockRegistryEntry {
  /** Absolute path to the file the block was written into. */
  path: string;
  kind: BlockKind;
  beginMarker: string;
  endMarker: string;
}

const VALID_KINDS: readonly BlockKind[] = ['work-log', 'minimal', 'retro'];

function isValidEntry(value: unknown): value is BlockRegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.kind === 'string' &&
    (VALID_KINDS as string[]).includes(v.kind) &&
    typeof v.beginMarker === 'string' &&
    typeof v.endMarker === 'string'
  );
}

/**
 * Read the registry file as-is (no pruning). Tolerates a missing file, an
 * unreadable file, and malformed/corrupt JSON — all resolve to an empty
 * registry rather than throwing, since a corrupt registry must never take
 * down `think init`. Individual malformed entries (wrong shape, from a
 * future/older schema) are dropped silently rather than corrupting the
 * whole read.
 */
function readRegistryRaw(): BlockRegistryEntry[] {
  const registryPath = getBlockRegistryPath();
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

/**
 * Write the registry atomically: write to a sibling temp file, then rename
 * over the target. `rename(2)` is atomic on the same filesystem, so a
 * process that dies mid-write (or a concurrent `think` invocation) never
 * observes a half-written registry file.
 */
function writeRegistryAtomic(entries: BlockRegistryEntry[]): void {
  const registryPath = getBlockRegistryPath();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(registryPath),
    `.block-registry.json.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

/**
 * A file can carry two independently-managed blocks at once — the
 * work-log block and the retro block use distinct marker pairs and
 * coexist (see init.ts's WORKLOG_UPSERT / RETRO_UPSERT). `--minimal` and
 * the default template are two *kinds* but share the same marker pair and
 * occupy the same slot, since only one of them can be present in a file
 * at a time (switching between them replaces in place). Dedupe therefore
 * keys on (path, slot), not (path, kind) — otherwise switching
 * `--minimal` <-> default would leave a stale entry behind under the old
 * kind, pointing at a marker pair that's still technically present (the
 * markers themselves don't change, only the body between them does).
 */
function slotFor(kind: BlockKind): 'worklog' | 'retro' {
  return kind === 'retro' ? 'retro' : 'worklog';
}

/**
 * Drop entries whose file no longer exists, or no longer contains the
 * entry's marker pair (in order). This is the AC #3 guarantee: registered
 * files are re-validated every time the registry is touched, so a file
 * that was deleted or hand-edited to remove the markers falls out of the
 * registry rather than being reported as still-managed forever.
 */
function pruneStaleEntries(entries: BlockRegistryEntry[]): BlockRegistryEntry[] {
  return entries.filter((entry) => {
    let content: string;
    try {
      content = fs.readFileSync(entry.path, 'utf-8');
    } catch {
      return false;
    }
    const beginIdx = content.indexOf(entry.beginMarker);
    const endIdx = content.indexOf(entry.endMarker);
    return beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;
  });
}

/**
 * Record that `think init` wrote (or refreshed) a managed block of `kind`
 * into `entryPath`, delimited by `beginMarker`/`endMarker`. Idempotent:
 * re-running for the same (path, slot) updates the existing entry in
 * place rather than appending a duplicate. Prunes stale entries first, so
 * every write also self-heals the registry.
 *
 * Safe to call even when nothing changed on disk (an `unchanged` upsert
 * result) — the registry is meant to reflect "this file currently carries
 * this managed block," not "this file was just modified," so a no-op
 * write still needs to be registered the first time (or re-registered if
 * a prior entry was pruned out from under it).
 */
export function recordBlockWrite(
  entryPath: string,
  kind: BlockKind,
  beginMarker: string,
  endMarker: string,
): void {
  const absPath = path.resolve(entryPath);
  const targetSlot = slotFor(kind);
  const existing = pruneStaleEntries(readRegistryRaw());
  const next = existing.filter((entry) => !(entry.path === absPath && slotFor(entry.kind) === targetSlot));
  next.push({ path: absPath, kind, beginMarker, endMarker });
  writeRegistryAtomic(next);
}

/**
 * The current, valid set of registered managed blocks — pruned of entries
 * whose file is gone or no longer carries the recorded markers. This is a
 * read-only view: unlike `recordBlockWrite`, it does not persist the
 * pruned result back to disk (AC #3 ties dropping stale entries to "the
 * next write," not to every read), so a plain listing never has the
 * surprising side effect of mutating the registry file underneath a
 * concurrent `think init`.
 */
export function listRegisteredBlocks(): BlockRegistryEntry[] {
  const entries = pruneStaleEntries(readRegistryRaw());
  return [...entries].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

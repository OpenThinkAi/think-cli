/**
 * Daemon `retro_migrate` handler — iterative-learning v3 (retro locality).
 *
 * Folds retros from one or more SOURCE cortices into a TARGET (home) cortex,
 * tagging each with its source as a `repo:<source>` context (the v3 model:
 * retros live on the home cortex, scoped by context tag, not on per-repo
 * branches). Implemented as ordinary synced writes so it self-propagates:
 *
 *   - COPY: each source retro is re-written into the target via `handleSync`
 *     (kind=retro) — full L1 outbox + L2 + embedding + debounced push, plus the
 *     near-duplicate fold and async supersession check. Topics become
 *     [...original, repo:<source>, migrated:<source>].
 *   - REMOVE: the source retro is tombstoned the same way the supersession
 *     worker does — L2 `deleted_at` + an L1 tombstone line enqueued to the
 *     outbox + `pushDebouncer.notify` — so the removal syncs to every peer
 *     rather than being a local-only L2 mutation.
 *
 * Idempotent: a source retro already copied (target has a non-deleted retro
 * with the same content carrying the `migrated:<source>` marker) is skipped, so
 * re-running — or running after the remote already migrated — is a no-op. The
 * near-duplicate fold is a second backstop against double-insertion.
 *
 * Dry-run by default (`apply` false): counts what WOULD migrate, mutates
 * nothing. Forward-only: once a tombstone is pushed it is synced, so reversal is
 * not a clean operation in the append-only model — preview with dry-run first.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getCortexDb } from '../db/engrams.js';
import { handleSync } from './sync-handler.js';
import { enqueueL1Outbox } from '../lib/l1-page.js';
import { pushDebouncer } from './push-debouncer.js';
import { applyRetroTombstone } from '../db/retro-queries.js';
import { sanitizeName } from '../lib/paths.js';
import { contextTopic, CONTEXT_TOPIC_PREFIX, normalizeContext } from '../lib/working-context.js';

/** Reserved topic prefix marking a retro as migrated from a given source. */
export const MIGRATED_TOPIC_PREFIX = 'migrated:';

interface SourceRetroRow {
  id: string;
  ts: string;
  author: string;
  content: string;
  origin_peer_id: string | null;
  kind: string | null;
  topics_json: string | null;
  source_ids: string | null;
}

export interface PerSourceResult {
  source: string;
  /** Total non-deleted retros found in the source cortex. */
  total: number;
  /** Retros migrated (apply) or that would migrate (dry-run). */
  migrated: number;
  /** Retros skipped because already migrated into the target. */
  skipped: number;
}

export interface RetroMigrateResult {
  to: string;
  apply: boolean;
  sources: PerSourceResult[];
  totalMigrated: number;
  totalSkipped: number;
}

function parseTopics(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Tombstone a source retro in a way that syncs (L2 deleted_at + L1 outbox line). */
function tombstoneSourceRetro(
  srcDb: DatabaseSync,
  source: string,
  to: string,
  row: SourceRetroRow,
  origTopics: string[],
  now: string,
): void {
  srcDb.prepare(
    `UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).run(now, row.id);

  // Reconstruct the L1 tombstone line from the durable L2 row (mirrors the
  // supersession worker — the worktree L1 page is unreliable in the plumbing
  // push model).
  let sourceIds: unknown[] = [];
  try {
    sourceIds = row.source_ids ? (JSON.parse(row.source_ids) as unknown[]) : [];
  } catch {
    sourceIds = [];
  }
  const tombstone: Record<string, unknown> = {
    id: row.id,
    ts: row.ts,
    author: row.author,
    origin_peer_id: row.origin_peer_id,
    kind: row.kind ?? 'retro',
    content: row.content,
    topics: origTopics,
    supersedes: [],
    compacted_from: null,
    source_ids: sourceIds,
    deleted_at: now,
    tombstone_reason: `migrated_to:${to}`,
  };
  enqueueL1Outbox(srcDb, row.id, JSON.stringify(tombstone), now);
  // Tombstone the curator `retros` row too, if one exists for this id.
  applyRetroTombstone(source, row.id, now, `migrated_to:${to}`);
  pushDebouncer.notify(source);
}

export async function handleRetroMigrate(
  params: Record<string, unknown>,
): Promise<RetroMigrateResult> {
  const toRaw = params['to'];
  if (typeof toRaw !== 'string' || toRaw.trim().length === 0) {
    throw new Error("retro_migrate: missing or empty required param 'to'");
  }
  const to = toRaw.trim();
  sanitizeName(to);

  const fromRaw = params['from'];
  if (!Array.isArray(fromRaw) || fromRaw.some((s) => typeof s !== 'string')) {
    throw new Error("retro_migrate: 'from' must be an array of cortex names");
  }
  // De-dupe, drop the target, normalize.
  const sources = Array.from(new Set((fromRaw as string[]).map((s) => s.trim()).filter((s) => s.length > 0 && s !== to)));
  for (const s of sources) sanitizeName(s);

  const apply = params['apply'] === true;
  const now = new Date().toISOString();

  const targetDb = getCortexDb(to);
  const result: RetroMigrateResult = { to, apply, sources: [], totalMigrated: 0, totalSkipped: 0 };

  for (const source of sources) {
    const srcDb = getCortexDb(source);
    const rows = srcDb.prepare(
      `SELECT id, ts, author, content, origin_peer_id, kind, topics_json, source_ids
         FROM memories WHERE kind = 'retro' AND deleted_at IS NULL`,
    ).all() as unknown as SourceRetroRow[];

    const marker = `${MIGRATED_TOPIC_PREFIX}${source}`;
    const per: PerSourceResult = { source, total: rows.length, migrated: 0, skipped: 0 };

    for (const row of rows) {
      // Idempotency: skip if the target already holds this content with the
      // source's migration marker.
      const exists = targetDb.prepare(
        `SELECT 1 FROM memories
          WHERE kind = 'retro' AND deleted_at IS NULL AND content = ?
            AND EXISTS (SELECT 1 FROM json_each(topics_json) WHERE value = ?)
          LIMIT 1`,
      ).get(row.content, marker);
      if (exists) {
        per.skipped += 1;
        continue;
      }

      if (!apply) {
        per.migrated += 1; // would migrate
        continue;
      }

      const origTopics = parseTopics(row.topics_json);
      // [...original (minus any stale repo:/migrated: tags), repo:<source>, migrated:<source>]
      const cleaned = origTopics.filter(
        (t) => !t.toLowerCase().startsWith(CONTEXT_TOPIC_PREFIX) && !t.toLowerCase().startsWith(MIGRATED_TOPIC_PREFIX),
      );
      const ctx = normalizeContext(source) ?? source;
      const newTopics = Array.from(new Set([...cleaned, contextTopic(ctx), marker]));

      // Copy into target via the normal synced write path. force=true bypasses
      // the M1 write-time quality gate: migrated retros are EXISTING data, not
      // new writes — re-gating could silently drop short-but-real legacy lessons.
      await handleSync({ cortex: to, content: row.content, kind: 'retro', topics: newTopics, force: true });
      // Remove from source (synced tombstone).
      tombstoneSourceRetro(srcDb, source, to, row, origTopics, now);
      per.migrated += 1;
    }

    result.sources.push(per);
    result.totalMigrated += per.migrated;
    result.totalSkipped += per.skipped;
  }

  return result;
}

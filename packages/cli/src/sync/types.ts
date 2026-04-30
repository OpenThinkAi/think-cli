/**
 * Contract every sync backend (git, http, relay, …) implements.
 *
 * Data-model invariants every adapter relies on:
 *
 * - **Memory ids are content-derived**. The id is `deterministicId(ts, author,
 *   content)` — two peers writing identical content produce the same row id,
 *   and `INSERT OR IGNORE` is the dedup mechanism. There is no LWW conflict
 *   to resolve and adapters do not need a logical clock.
 *
 * - **Memories are immutable via sync**. Once a memory is created, its fields
 *   never change through sync. Adapters never serialize or apply `deleted_at`
 *   on memories. Engram deletes are strictly local and never leave the
 *   machine — this is enforced by the `engrams never propagate` contract test.
 *
 * - **`memories.sync_version` is the per-cortex local push cursor.** It is a
 *   monotonic counter assigned on every local insert, used by the push side
 *   to find "what's new since I last pushed." It is not sent across the wire
 *   and not comparable across peers.
 *
 * - **Cursors live in `sync_cursors`**. Adapters key their push/pull cursors
 *   by `(backend, direction)` in this table; multiple adapters can coexist
 *   on the same cortex without collision.
 *
 * - **Engrams never sync**. Adapters must not read from or write to the
 *   `engrams` table during sync.
 */
export interface SyncAdapter {
  readonly name: string;

  /** Push locally-created memories to the remote */
  push(cortex: string): Promise<SyncResult>;

  /** Pull remotely-created memories into local SQLite */
  pull(cortex: string): Promise<SyncResult>;

  /** Push + Pull in one call */
  sync(cortex: string): Promise<SyncResult>;

  /** List cortexes available on the remote */
  listRemoteCortexes(): Promise<string[]>;

  /** Create a new cortex on the remote */
  createCortex(cortex: string): Promise<void>;

  /** Check if the backend is configured and reachable */
  isAvailable(): boolean;

  /**
   * Cheap probe of whether the remote is currently reachable. Used by
   * `cortex sync --if-online` to skip silently when offline (VPN down,
   * server unreachable, DNS dead) instead of letting full sync log a
   * stack of network errors every minute.
   *
   * Must complete in well under one scheduler tick (~5s). Must NOT
   * surface auth failures as "unreachable" — return true on a reachable
   * but auth-rejecting host so the caller's subsequent sync runs and
   * surfaces the real auth error loudly (see `formatSyncError`'s
   * hivedb#4 note).
   */
  isReachable(): Promise<boolean>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

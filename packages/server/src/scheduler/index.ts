import type { Database } from '../db.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { Vault } from '../vault/index.js';

const DEFAULT_POLL_TIMEOUT_MS = 60_000;

interface SubscriptionRow {
  id: string;
  kind: string;
  pattern: string;
  cursor: string | null;
}

export interface PollOutcome {
  subscription_id: string;
  kind: string;
  status: 'ok' | 'skipped' | 'error';
  events_inserted: number;
  events_emitted: number;
  error?: string;
}

export interface TickReport {
  started_at: string;
  finished_at: string;
  outcomes: PollOutcome[];
}

export interface SchedulerHandle {
  /**
   * Run one full tick (one pass over every active subscription) and
   * resolve when all polls have completed (success, skip, or error).
   * Returns a structured report so tests can assert per-subscription
   * outcomes without needing to scrape logs.
   *
   * Calling `tickOnce()` while a previous tick is still running waits
   * for it to complete and then runs a fresh tick — same overlap-guard
   * semantics as the timer-driven path.
   */
  tickOnce(): Promise<TickReport>;
  /** Stop the recurring timer. Idempotent; safe after `start()` was never called. */
  stop(): void;
  /** Start the recurring timer. Idempotent. */
  start(): void;
}

export interface SchedulerOptions {
  db: Database;
  registry: ConnectorRegistry;
  vault: Vault;
  intervalMs: number;
  /** Per-poll wall-clock cap; defaults to 60s. Throws via the error branch. */
  pollTimeoutMs?: number;
  /** Injected for tests; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

function withTimeout<T>(p: Promise<T>, ms: number, kind: string, subId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`poll timed out after ${ms}ms (kind=${kind}, subscription_id=${subId})`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function safeParseCursor(raw: string | null, subscriptionId: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Unparseable cursor on disk — log + reset. The connector rebuilds
    // from scratch on the next tick, which is the same behaviour as a
    // brand-new subscription. Including subscription_id so an operator
    // can locate the offending row when multiple subscriptions corrupt
    // their cursors at once.
    console.warn(
      `[open-think-server] dropping unparseable cursor for subscription_id=${subscriptionId}; resetting to null`,
    );
    return null;
  }
}

/**
 * Per-subscription scheduler. One tick = one serial pass over every
 * active subscription. Serial across subs because:
 *   - `node:sqlite` is `DatabaseSync` — parallel JS isn't real
 *     parallelism for the writes
 *   - per-source rate limits are per-credential, not per-process, so
 *     parallelism doesn't help GitHub
 *   - the "skip if previous tick still running" guard stays simple
 *
 * A wedged connector blocks the rest of the tick, mitigated by
 * `pollTimeoutMs` (default 60s) wrapping `Promise.race` on each poll.
 *
 * The timer uses `setTimeout`-recurse rather than `setInterval` so a
 * slow tick simply delays the next start instead of overlapping with
 * itself.
 */
export function createScheduler(opts: SchedulerOptions): SchedulerHandle {
  const { db, registry, vault, intervalMs } = opts;
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date().toISOString());

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<TickReport> | null = null;

  async function runTick(): Promise<TickReport> {
    const started_at = now();
    const outcomes: PollOutcome[] = [];

    const subs = db
      .prepare('SELECT id, kind, pattern, cursor FROM subscriptions')
      .all() as SubscriptionRow[];

    for (const sub of subs) {
      const connector = registry.get(sub.kind);
      if (!connector) {
        console.warn(
          `[open-think-server] no connector registered for kind=${sub.kind}; skipping subscription_id=${sub.id}`,
        );
        outcomes.push({
          subscription_id: sub.id,
          kind: sub.kind,
          status: 'skipped',
          events_inserted: 0,
          events_emitted: 0,
        });
        continue;
      }

      try {
        // `cursor` is intentionally `unknown` here. The framework persists
        // each connector's cursor as opaque JSON (see types.ts) and can't
        // statically reach the connector's TCursor at this seam. The
        // `as never` cast is the framework-side acknowledgement that
        // narrowing is the connector's responsibility — it's the only
        // entity that knows what shape its own cursor takes.
        const cursor = safeParseCursor(sub.cursor, sub.id);
        // Decrypted credential lookup. `null` if no row in
        // `source_credentials`; throws if the row exists but the key
        // can't decrypt it (rotated key, corrupted blob). The throw is
        // re-raised here so it falls into the per-poll error branch
        // below — the operator gets a logged failure isolated to this
        // subscription, with no credential bytes in the message.
        const credential = vault.load(db, sub.id);
        const result = await withTimeout(
          connector.poll({
            subscription: { id: sub.id, kind: sub.kind, pattern: sub.pattern },
            credential,
            cursor: cursor as never,
          }),
          pollTimeoutMs,
          sub.kind,
          sub.id,
        );

        const polledAt = now();
        const cursorJson = JSON.stringify(result.nextCursor);

        // One tx per subscription: events insert + cursor update + last_polled_at
        // either all land or none do. `INSERT OR IGNORE` dedups on the
        // events_sub_id_unique index so a connector replaying ids on a
        // transient retry doesn't poison the table.
        let eventsInserted = 0;
        const eventsCreatedAt = polledAt;
        db.exec('BEGIN');
        try {
          const insertEvent = db.prepare(
            'INSERT OR IGNORE INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
          );
          for (const evt of result.events) {
            const r = insertEvent.run(
              evt.id,
              sub.id,
              JSON.stringify(evt.payload),
              eventsCreatedAt,
            );
            if (r.changes > 0) eventsInserted++;
          }
          db.prepare(
            'UPDATE subscriptions SET cursor = ?, last_polled_at = ? WHERE id = ?',
          ).run(cursorJson, polledAt, sub.id);
          db.exec('COMMIT');
        } catch (txErr) {
          db.exec('ROLLBACK');
          throw txErr;
        }

        outcomes.push({
          subscription_id: sub.id,
          kind: sub.kind,
          status: 'ok',
          events_inserted: eventsInserted,
          events_emitted: result.events.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Failure isolation: log, record, continue. last_polled_at is
        // intentionally NOT bumped on failure here — but note that it has
        // a second writer in `GET /v1/events`, so a recent CLI read can
        // mask a wedged source. Operators looking for source-side health
        // should also consult tick-level signals.
        console.error(
          `[open-think-server] poll failed for subscription_id=${sub.id} kind=${sub.kind}: ${message}`,
        );
        outcomes.push({
          subscription_id: sub.id,
          kind: sub.kind,
          status: 'error',
          events_inserted: 0,
          events_emitted: 0,
          error: message,
        });
      }
    }

    return { started_at, finished_at: now(), outcomes };
  }

  async function tickOnce(): Promise<TickReport> {
    // Overlap guard: if a tick is already running, wait for it before
    // starting a fresh one. Tests that fire `tickOnce()` back-to-back
    // get the same serialization the timer-driven path provides.
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // The previous tick should never throw — runTick catches per-poll
        // failures. If something escaped, swallow it here so the next
        // caller still gets a fresh attempt.
      }
    }
    const p = runTick();
    inFlight = p;
    // Clear `inFlight` once `p` settles. Done in a separate chain so the
    // overlap-guard comparison stays `inFlight === p` instead of
    // `inFlight === <p.finally-wrapper>`. The trailing `.catch` is a
    // no-op rejection suppressor: `p` itself is returned to the caller
    // (who is responsible for its rejection); the .finally-wrapped
    // promise is unowned and would otherwise become an unhandled
    // rejection if `p` ever rejected.
    p.finally(() => {
      if (inFlight === p) inFlight = null;
    }).catch(() => {});
    return p;
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tickOnce()
        .catch((err: unknown) => {
          console.error('[open-think-server] scheduler tick crashed:', err);
        })
        .finally(() => {
          scheduleNext();
        });
    }, intervalMs);
    // Don't keep the event loop alive for the timer — server liveness is
    // owned by the HTTP listener, not the scheduler.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    tickOnce,
    start(): void {
      if (timer !== null || stopped) return;
      scheduleNext();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

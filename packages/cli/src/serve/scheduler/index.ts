import type { Database } from '../db.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { Vault } from '../vault/index.js';
import {
  processTerminalEvent,
  selectUncuratedEvents,
  type EventRow,
} from '../event-curator.js';
import { pushDebouncer, getPushDebouncerMetrics } from '../../daemon/push-debouncer.js';
import { useDirectApiCuration } from '../../lib/curator.js';

const DEFAULT_POLL_TIMEOUT_MS = 60_000;
/**
 * Default per-tick cap on uncurated events drained from the events
 * table. One event = one Claude `runTerminalEventCuration` call (with up
 * to one internal retry on malformed output), so the cap is also the
 * per-tick LLM-spend ceiling per proxy. A 64-event backfill at the
 * default settings drains in ceil(64/10) = 7 ticks.
 *
 * Picked at 10 because the prior bottleneck shapes the right ceiling: a
 * fresh subscription's first poll fetches every closed PR in a repo
 * (which is GitHub's no-`since` semantics, not a connector choice). For
 * an active repo with ~50 closed PRs that's 5 ticks at 10/tick — minutes
 * at the default 600s interval, but well under the rate at which the
 * default sonnet-4-6 tier exhausts on the operator's Anthropic quota.
 * Operators who want faster drain can raise the env var; operators on a
 * tight budget can lower it.
 */
const DEFAULT_CURATE_BATCH_SIZE = 10;

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
  /**
   * Count of events the connector emitted that were rejected at ingest
   * because they were not terminal (`terminal !== true`). These are
   * logged and dropped, not stored. Adding it to the outcome surface
   * lets operators and tests assert on rejection volume without
   * scraping stderr.
   */
  events_rejected_non_terminal: number;
  error?: string;
}

/**
 * Per-event outcome from the curator drain that runs after the poll
 * loop in each tick. One entry per uncurated row the drain pass touched
 * (capped by `curateBatchSize`). Empty when the drain is disabled
 * (missing `peerId`/`getCortexName`) or the active cortex resolves to
 * `null` for this tick.
 */
export interface CurateOutcome {
  event_id: string;
  subscription_id: string;
  status:
    | 'curated'
    | 'already-curated'
    | 'error';
  /** Set when `status === 'curated'` — uuidv7 ids of the memories written. */
  memory_ids?: string[];
  /** Set when `status === 'error'`; the message from the thrown error. */
  error?: string;
}

/**
 * Reason a tick's drain pass produced no `curate_outcomes`. Surfaced so
 * tests + operator dashboards can distinguish "drain ran, found nothing"
 * (`'empty-queue'`) from "drain didn't run at all" (the other four).
 * Operators reading per-tick reports can use this to diagnose a silent
 * proxy without scraping stderr.
 *
 * **Semantics:** `null` means the drain ran AND attempted at least one
 * event — inspect `curate_outcomes` to see per-event results (which may
 * still all be `'error'`). A string value means the drain produced zero
 * outcomes for the named reason. `'error'` specifically means a drain
 * *infrastructure* failure (config read, sqlite query) — distinct from
 * a per-event curator throw, which surfaces inside `curate_outcomes` as
 * `{ status: 'error' }` with `curate_skip_reason` still `null`.
 */
export type CurateSkipReason =
  | 'disabled-no-peer-id'
  | 'disabled-no-cortex-resolver'
  | 'no-active-cortex'
  | 'empty-queue'
  | 'error'
  | null;

export interface TickReport {
  started_at: string;
  /**
   * Timestamp after the poll loop finishes — does NOT include the
   * post-poll drain pass. Operators alerting on poll-cycle latency
   * should subtract `started_at` from `poll_finished_at`, not
   * `finished_at`; the drain can add up to `curateBatchSize` × LLM
   * round-trip seconds of additional wall time on top of the poll
   * window.
   */
  poll_finished_at: string;
  /** Timestamp after the entire tick (polls + drain) completes. */
  finished_at: string;
  outcomes: PollOutcome[];
  /**
   * Per-event drain results. Always present (possibly empty) so the
   * shape is stable across drain-on/drain-off configurations.
   */
  curate_outcomes: CurateOutcome[];
  /**
   * `null` when the drain ran and processed at least one event;
   * otherwise the reason it produced no outcomes. Lets a tick report
   * answer "did the drain do anything?" without inspecting array
   * length + scheduler config.
   */
  curate_skip_reason: CurateSkipReason;
  /**
   * Snapshot of process-lifetime push-debouncer metrics at tick completion
   * (AGT-478 AC #5). Lets operators observe permanent push failures in the
   * tick report without scraping `daemon.log` directly.
   *
   * - `failures_nff`: total cycles where all retries were exhausted with a
   *   non-fast-forward rejection still outstanding. A rising counter means the
   *   proxy is not propagating curated memory to origin.
   * - `successes`: total successful pushes since daemon start (sanity baseline).
   * - `last_failure_at`: ISO timestamp of the most recent permanent NFF failure,
   *   or `null` if none has occurred.
   */
  push_debouncer: {
    failures_nff: number;
    successes: number;
    last_failure_at: string | null;
  };
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
  /**
   * Resolved proxy peer-id from `getProxyPeerId`. Required for the
   * post-poll curator drain to run — without an identity, memories can't
   * be stamped. When unset, the drain is a no-op and `tickOnce()`
   * reports `curate_skip_reason: 'disabled-no-peer-id'`. Existing tests
   * that construct a scheduler directly (no boot) can stay drain-free
   * by omitting this field.
   */
  peerId?: string;
  /**
   * Called once per tick to resolve the team cortex the drain should
   * write to. Indirected behind a function so an operator
   * `think cortex switch`-ing against a running proxy takes effect on
   * the next tick without a restart. Return `null` to skip drain for
   * the tick (`curate_skip_reason: 'no-active-cortex'`). Required
   * alongside `peerId` for the drain to run.
   */
  getCortexName?: () => string | null;
  /**
   * Maximum events drained per tick. Each event is one Claude API
   * call (plus the curator's one internal retry on malformed output),
   * so this is the per-tick LLM-spend ceiling. Backlog drains over
   * multiple ticks at this rate. Defaults to `DEFAULT_CURATE_BATCH_SIZE`
   * (10). Operators who need faster drain raise it; tight-budget
   * deployments lower it.
   */
  curateBatchSize?: number;
  /**
   * Test seam: override `processTerminalEvent` so tests can return
   * deterministic outcomes without instantiating the SDK. Production
   * callers leave unset.
   */
  processEvent?: typeof processTerminalEvent;
  /**
   * Test seam: override `selectUncuratedEvents` so tests can drive a
   * specific event-row sequence into the drain without seeding the
   * events table. Production callers leave unset.
   */
  selectEvents?: typeof selectUncuratedEvents;
  /**
   * Batch-level push trigger, called ONCE per drain after the whole curate
   * batch rather than once per event (#66). Per-event pushes otherwise
   * dominate tick time on large backfills: each is a rebase+commit+push
   * round-trip to the shared cortex branch, and curation writes are spaced
   * by LLM latency, so the push-debouncer's 500ms window never coalesces
   * them. Defaults to the module push-debouncer singleton. Injectable for
   * tests.
   */
  notifyPush?: (cortex: string) => void;
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
      `[open-think serve] dropping unparseable cursor for subscription_id=${subscriptionId}; resetting to null`,
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
  // Clamp to >= 1: a 0 or negative limit is operator error (a typo in
  // env-var wiring would silently disable the drain), so coerce to the
  // smallest useful batch instead of going silent.
  const curateBatchSize = Math.max(1, opts.curateBatchSize ?? DEFAULT_CURATE_BATCH_SIZE);
  const processEvent = opts.processEvent ?? processTerminalEvent;
  const selectEvents = opts.selectEvents ?? selectUncuratedEvents;
  const notifyPush = opts.notifyPush ?? ((cortex: string) => pushDebouncer.notify(cortex));
  // No-op handed to each per-event write so writeMemoriesForEvent does NOT
  // push per event; the drain fires a single batch push at the end (#66).
  const suppressPerEventPush = (): void => {};

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<TickReport> | null = null;

  /**
   * Drain up to `curateBatchSize` uncurated events from the events
   * table. Each event runs through the full curate → write → mark
   * pipeline via `processTerminalEvent`. Per-event failures are logged
   * and recorded as `{ status: 'error', error }` outcomes — the row
   * stays `curated_at = NULL` so the next tick retries.
   *
   * The entire body is wrapped in a top-level catch so a drain
   * *infrastructure* failure (a thrown `getCortexName()`, a sqlite
   * error inside `selectEvents`) cannot escape into `runTick()` and
   * silently abort the surrounding poll loop. Infrastructure failures
   * surface as `curate_skip_reason: 'error'` with no per-event
   * outcomes; the next tick retries from a clean slate.
   *
   * Returns the outcome list plus a reason string when nothing was
   * produced (drain disabled, no active cortex, empty queue, drain
   * infrastructure failure). Reason is `null` when at least one event
   * was touched.
   */
  async function runDrain(backend: 'api' | 'agent-sdk'): Promise<{
    curate_outcomes: CurateOutcome[];
    curate_skip_reason: CurateSkipReason;
  }> {
    try {
      if (opts.peerId === undefined) {
        return { curate_outcomes: [], curate_skip_reason: 'disabled-no-peer-id' };
      }
      if (opts.getCortexName === undefined) {
        return { curate_outcomes: [], curate_skip_reason: 'disabled-no-cortex-resolver' };
      }
      const cortexName = opts.getCortexName();
      if (cortexName === null) {
        return { curate_outcomes: [], curate_skip_reason: 'no-active-cortex' };
      }

      const events: EventRow[] = selectEvents(db, { limit: curateBatchSize });
      if (events.length === 0) {
        return { curate_outcomes: [], curate_skip_reason: 'empty-queue' };
      }

      const curate_outcomes: CurateOutcome[] = [];
      let curatedAny = false;
      for (const event of events) {
        // Per-event timing telemetry: the dominant cost in a curation is the
        // LLM call inside processEvent, so wall-time around it is the number we
        // need to reason about throughput. Logged per event (serve-only).
        const ev_started = Date.now();
        try {
          const outcome = await processEvent({
            db,
            event,
            peerId: opts.peerId,
            cortexName,
            // Suppress the per-event push; we coalesce into one batch push
            // after the loop (#66). The batch push's `git add -- <cortex>`
            // stages the whole cortex dir, so it still captures every memory
            // written during this drain.
            notifyPush: suppressPerEventPush,
          });
          if (outcome.status === 'curated') curatedAny = true;
          curate_outcomes.push({
            event_id: event.id,
            subscription_id: event.subscription_id,
            status: outcome.status,
            memory_ids: outcome.status === 'curated' ? outcome.ids : undefined,
          });
          console.log(
            `[open-think serve] [curate] event=${event.id} backend=${backend} ms=${Date.now() - ev_started} status=${outcome.status} memories=${outcome.status === 'curated' ? outcome.ids.length : 0}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(
            `[open-think serve] [curate] event=${event.id} backend=${backend} ms=${Date.now() - ev_started} status=error memories=0`,
          );
          // Per-event failure isolation: log, record, continue.
          // `curated_at` stays NULL on throw — `processTerminalEvent`
          // only marks it after the writer succeeds — so the next tick
          // will retry the row. We do NOT propagate the throw because
          // one event's curator failure (rate-limit, malformed LLM
          // response, transient SDK error) must not block the rest of
          // the batch.
          console.error(
            `[open-think serve] curate failed for event_id=${event.id} subscription_id=${event.subscription_id}: ${message}`,
          );
          curate_outcomes.push({
            event_id: event.id,
            subscription_id: event.subscription_id,
            status: 'error',
            error: message,
          });
        }
      }
      // One push for the whole batch (#66) — coalesces what would otherwise
      // be one rebase+commit+push per event. Skipped when nothing was
      // curated (all events errored or were already-curated) so we don't
      // fire an empty cycle.
      if (curatedAny) notifyPush(cortexName);
      return { curate_outcomes, curate_skip_reason: null };
    } catch (err) {
      // Drain *infrastructure* failure: getCortexName() threw, or
      // selectEvents() threw before any event was touched, or
      // something else unexpected blew up. We catch here so it does
      // not propagate up into runTick() and silently abort the
      // surrounding poll loop — polls must keep running so the proxy
      // doesn't go dark. Per-event failures inside the for-loop are
      // caught separately above.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[open-think serve] curator drain crashed: ${message}`);
      return { curate_outcomes: [], curate_skip_reason: 'error' };
    }
  }

  async function runTick(): Promise<TickReport> {
    const started_at = now();
    const outcomes: PollOutcome[] = [];

    const subs = db
      .prepare('SELECT id, kind, pattern, cursor FROM subscriptions')
      .all() as unknown as SubscriptionRow[];

    for (const sub of subs) {
      const connector = registry.get(sub.kind);
      if (!connector) {
        console.warn(
          `[open-think serve] no connector registered for kind=${sub.kind}; skipping subscription_id=${sub.id}`,
        );
        outcomes.push({
          subscription_id: sub.id,
          kind: sub.kind,
          status: 'skipped',
          events_inserted: 0,
          events_emitted: 0,
          events_rejected_non_terminal: 0,
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
        let eventsRejectedNonTerminal = 0;
        const eventsCreatedAt = polledAt;
        db.exec('BEGIN');
        try {
          const insertEvent = db.prepare(
            'INSERT OR IGNORE INTO events (id, subscription_id, payload_json, episode_key, created_at, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
          );
          for (const evt of result.events) {
            // Terminal-event contract: the proxy ingests only events
            // the connector has flagged as terminal. Non-terminal
            // emissions are a connector contract violation under
            // Phase 1 — log + drop so they don't poison the events
            // table or the curator downstream. Logged with the
            // subscription_id and event id so operators can locate
            // the offending connector when this fires.
            if (evt.terminal !== true) {
              eventsRejectedNonTerminal++;
              console.warn(
                `[open-think serve] dropping non-terminal event from kind=${sub.kind} subscription_id=${sub.id} event_id=${evt.id}: connectors must emit only terminal events`,
              );
              continue;
            }
            const r = insertEvent.run(
              evt.id,
              sub.id,
              JSON.stringify(evt.payload),
              evt.episodeKey,
              eventsCreatedAt,
              // Source settle time when the connector supplied a clean one;
              // null → the cortex-writer falls back to insertion time.
              evt.occurredAt ?? null,
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
          events_rejected_non_terminal: eventsRejectedNonTerminal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Failure isolation: log, record, continue. last_polled_at is
        // intentionally NOT bumped on failure here — but note that it has
        // a second writer in `GET /v1/events`, so a recent CLI read can
        // mask a wedged source. Operators looking for source-side health
        // should also consult tick-level signals.
        console.error(
          `[open-think serve] poll failed for subscription_id=${sub.id} kind=${sub.kind}: ${message}`,
        );
        outcomes.push({
          subscription_id: sub.id,
          kind: sub.kind,
          status: 'error',
          events_inserted: 0,
          events_emitted: 0,
          events_rejected_non_terminal: 0,
          error: message,
        });
      }
    }

    // Captured before runDrain so operators alerting on poll-cycle
    // latency don't accidentally include drain wall time (which can
    // add curateBatchSize × LLM round-trip seconds per tick).
    const poll_finished_at = now();
    const curate_backend = useDirectApiCuration() ? 'api' : 'agent-sdk';
    const { curate_outcomes, curate_skip_reason } = await runDrain(curate_backend);
    const finished_at = now();

    // Tick phase-breakdown telemetry (serve-only). The timestamps were already
    // computed for TickReport; this just surfaces them so operators can READ
    // where a tick's wall-clock goes (poll vs curate) instead of inferring it.
    const poll_ms = Date.parse(poll_finished_at) - Date.parse(started_at);
    const curate_ms = Date.parse(finished_at) - Date.parse(poll_finished_at);
    const n_curated = curate_outcomes.filter((o) => o.status === 'curated').length;
    const n_errored = curate_outcomes.filter((o) => o.status === 'error').length;
    console.log(
      `[open-think serve] [tick] total_ms=${poll_ms + curate_ms} ` +
        `poll_ms=${poll_ms} curate_ms=${curate_ms} polled=${outcomes.length} ` +
        `curated=${n_curated} errored=${n_errored} ` +
        `curate_backend=${curate_backend} ` +
        `curate_skip=${curate_skip_reason ?? 'none'}`,
    );

    const pdm = getPushDebouncerMetrics();
    return {
      started_at,
      poll_finished_at,
      finished_at,
      outcomes,
      curate_outcomes,
      curate_skip_reason,
      push_debouncer: {
        failures_nff: pdm.pushFailuresNonFastForward,
        successes: pdm.pushSuccesses,
        last_failure_at: pdm.lastPushErrorAt,
      },
    };
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
          console.error('[open-think serve] scheduler tick crashed:', err);
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

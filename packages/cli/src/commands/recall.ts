import { Command, Option } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { searchEngrams } from '../db/engram-queries.js';
import { searchMemories, getLongtermSummary, getMemories } from '../db/memory-queries.js';
import {
  searchLongTermEvents,
  getLongTermEventById,
  getRecentLongTermEventsForContext,
  getLongTermEvents,
} from '../db/long-term-queries.js';
import type { MemoryRow } from '../db/memory-queries.js';
import type { LongTermEventRow } from '../db/long-term-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import type { RecallScope } from '../daemon/recall.js';
import { NOTE_FTS_FALLBACK, NOTE_FTS_EXPLICIT, validateKind, validateSince } from '../daemon/recall.js';
import { formatRecallOutput, cortexSet, DEFAULT_RECALL_LIMIT } from '../lib/recall-format.js';
import { detectWorkingContext, normalizeContext } from '../lib/working-context.js';

export function printDecisions(m: MemoryRow): void {
  if (!m.decisions) return;
  try {
    const decisions = JSON.parse(m.decisions) as string[];
    for (const d of decisions) {
      console.log(`    ${chalk.yellow('⚡')} ${chalk.yellow(d)}`);
    }
  } catch { /* skip malformed */ }
}

// Render a list of long-term events with supersession chains.
// Events are grouped into chains (following supersedes links), and each
// chain is rendered chronologically with arrows between entries.
function renderLongTermEvents(cortex: string, events: LongTermEventRow[]): void {
  if (events.length === 0) return;

  // Build a map of id → event for chain walking. Pull in superseded ancestors
  // that weren't in the search results so chains render complete.
  const byId = new Map<string, LongTermEventRow>();
  for (const e of events) byId.set(e.id, e);
  const toFetchAncestor = (id: string) => {
    if (byId.has(id)) return;
    const anc = getLongTermEventById(cortex, id);
    if (anc) byId.set(anc.id, anc);
  };
  for (const e of events) {
    if (e.supersedes) toFetchAncestor(e.supersedes);
  }
  // Walk ancestry fully — if we added an ancestor that itself supersedes
  // someone, chase that too, bounded to avoid cycles.
  for (let depth = 0; depth < 20; depth++) {
    let added = false;
    for (const e of [...byId.values()]) {
      if (e.supersedes && !byId.has(e.supersedes)) {
        toFetchAncestor(e.supersedes);
        added = true;
      }
    }
    if (!added) break;
  }

  // Find chain heads: events no one supersedes. A chain is: head, then
  // whoever supersedes head, then whoever supersedes that, etc.
  const supersedesOf = new Map<string, string>(); // id → who supersedes this id
  for (const e of byId.values()) {
    if (e.supersedes) supersedesOf.set(e.supersedes, e.id);
  }

  const isHead = (e: LongTermEventRow) => !e.supersedes;
  const heads = [...byId.values()].filter(isHead);
  // Events with no link either way — standalones — also render as heads.
  const standalone = heads.filter(e => !supersedesOf.has(e.id));
  const chainHeads = heads.filter(e => supersedesOf.has(e.id));

  const printChain = (head: LongTermEventRow) => {
    let cur: LongTermEventRow | undefined = head;
    let first = true;
    while (cur) {
      const topics = (() => { try { return JSON.parse(cur.topics) as string[]; } catch { return []; } })();
      const topicsTag = topics.length > 0 ? chalk.dim(` [${topics.join(', ')}]`) : '';
      const prefix = first ? '  ' : `    ${chalk.gray('↓')}  `;
      console.log(`${prefix}${chalk.gray(cur.ts.slice(0, 10))}  ${chalk.cyan(cur.kind.padEnd(10))} ${cur.title}${topicsTag}`);
      console.log(`      ${chalk.dim(cur.content)}`);
      const nextId: string | undefined = supersedesOf.get(cur.id);
      cur = nextId ? byId.get(nextId) : undefined;
      first = false;
    }
  };

  // Sort heads by their own ts for consistent output.
  standalone.sort((a, b) => a.ts.localeCompare(b.ts));
  chainHeads.sort((a, b) => a.ts.localeCompare(b.ts));

  for (const h of chainHeads) printChain(h);
  for (const s of standalone) printChain(s);
}

// Long-term events dedupe by id (deterministic, append-only). Memories and
// engrams have no stable dedupe id — same (ts, author, content) can land
// twice with distinct uuidv7s when the curate flow promotes overlapping
// engrams across runs. Callers pick the visible-identity key. First
// occurrence wins, preserving FTS rank in the default path and recency in
// --all.
function dedupeBy<T>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * Renders the "all recent memories + long-term summary" view for a cortex.
 * Extracted so `think brief` can reuse it for its personal-context section.
 * Does NOT close the cortex DB — the caller is responsible for that.
 */
export function renderPersonalAll(cortex: string, { days, query }: { days: number; query?: string }): void {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const recentMemories = dedupeBy(
    getMemories(cortex, { since: cutoff }),
    m => JSON.stringify([m.ts, m.author, m.content]),
  );
  const longterm = getLongtermSummary(cortex);
  const allEvents = getLongTermEvents(cortex, { since: cutoff, limit: 200 });
  const matchingEngrams = dedupeBy(
    searchEngrams(cortex, query ?? ''),
    e => JSON.stringify([e.created_at, e.content]),
  );

  if (allEvents.length > 0) {
    console.log(chalk.cyan('Long-term history:'));
    renderLongTermEvents(cortex, allEvents);
    console.log();
  }

  if (recentMemories.length > 0) {
    console.log(chalk.cyan(`Team memories (last ${days} days):`));
    for (const m of recentMemories) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
      printDecisions(m);
    }
    console.log();
  }

  if (longterm && allEvents.length === 0) {
    console.log(chalk.cyan('Long-term context (legacy summary):'));
    console.log(`  ${longterm}`);
    console.log();
  }

  if (matchingEngrams.length > 0) {
    console.log(chalk.cyan(`Matching engrams (local):`));
    for (const e of matchingEngrams) {
      const ts = e.created_at.slice(0, 16).replace('T', ' ');
      console.log(`  ${chalk.gray(ts)} ${e.content}`);
    }
    console.log();
  }

  if (recentMemories.length === 0 && matchingEngrams.length === 0 && !longterm && allEvents.length === 0) {
    console.log(chalk.dim('No results found.'));
  }
}


/**
 * AGT-318: Formatted FTS recall — maps searchMemories results to RecallEntry[]
 * and renders via the pure formatter (formatRecallOutput).
 * Called by the recall action when the daemon is unavailable (FTS degraded mode).
 */
function runFormattedFtsRecall(
  cortex: string,
  query: string,
  opts: { engrams?: boolean; limit: number; full?: boolean },
): void {
  const { limit } = opts;

  const rawMemories = dedupeBy(
    searchMemories(cortex, query, limit),
    m => JSON.stringify([m.ts, m.author, m.content]),
  );

  // Map MemoryRow to RecallEntry (fts_fallback path; no similarity/score data).
  // The memories table contains kind=memory, kind=retro, kind=event rows.
  // Cast through unknown because MemoryRow type does not expose the kind
  // column yet (it exists in the DB but has not been added to the TS interface).
  const entries = rawMemories.map(m => ({
    id: m.id,
    ts: m.ts,
    kind: m.kind ?? null,
    content: m.content,
    topics: [] as string[],
    similarity: 0,
    score: 0,
    cortex,
    compacted_from: null,
    supersedes: [] as string[],
    activity_seq: null,
    fts_fallback: true as const,
  }));

  const cortexes = cortexSet(entries);
  // Ensure the cortex appears in the set even when results are empty.
  cortexes.add(cortex);

  const formatted = formatRecallOutput(entries, cortexes, { full: opts.full });
  console.log(formatted);

  // Optionally include engrams (legacy v2 local index not part of the v3 kind model).
  if (opts.engrams) {
    const matchingEngrams = dedupeBy(
      searchEngrams(cortex, query, limit),
      e => JSON.stringify([e.created_at, e.content]),
    );
    if (matchingEngrams.length > 0) {
      console.log();
      console.log(chalk.cyan(`Matching engrams (${matchingEngrams.length}):`));
      for (const e of matchingEngrams) {
        const ts = e.created_at.slice(0, 16).replace("T", " ");
        console.log(`  ${chalk.gray(ts)} ${e.content}`);
      }
    }
  }
}

export const recallCommand = new Command('recall')
  .argument('<query>', 'What to recall')
  .description('Search memories and local engrams')
  .option('--engrams', 'Also search local engrams (not just memories)')
  .option('--all', 'Dump all recent memories + long-term summary (ignores query for memories)')
  .option('--days <n>', 'Days of memories to include (only with --all)', '14')
  .option('--limit <n>', 'Max results to return (default: 8)', String(DEFAULT_RECALL_LIMIT))
  .option('--full', 'Return all entries including superseded and compacted-raw; lifts 200-char truncation')
  .option('--json', 'Emit results as a JSON array (one object per entry; FTS path only); incompatible with --all')
  .option('--include-superseded', 'Include superseded entries but still hide compacted-raw memories')
  .option('--kind <kind>', 'Filter by entry kind: memory, retro, or event')
  .option('--topic <topic>', 'Filter by topic — case-insensitive exact match on the entry topics array')
  .option('--context <name>', 'Boost retros tagged for this repo context (default: the git repo you are in)')
  .option('--no-context', 'Disable the working-context boost (do not auto-detect the repo)')
  .option('--since <date>', 'Only entries at or after this ISO-8601 date (e.g. 2026-05-01)')
  .option('--no-embed', 'Skip semantic ranking; use FTS keyword search (fast, offline, deterministic). Also set by THINK_NO_EMBED=1.')
  .addOption(
    new Option(
      '--scope <value>',
      'Federation scope: active = single cortex; accessible = all your cortexes (default); all = future remote peers',
    )
      .choices(['active', 'accessible', 'all'])
      .default('accessible'),
  )
  .addHelpText(
    'after',
    `
Ranking:
  By default, semantic results are recency-weighted: an entry written more
  recently scores higher than a semantically similar but older one (the boost
  decays exponentially the further an entry is from the newest). To rank by
  pure cosine similarity instead, turn the weighting off:

    think config set recall.recencyDecay 0

  (default 0.05; higher values bias harder toward recent entries). This applies
  to the semantic path only — --no-embed (full-text search) is unaffected.`,
  )
  .action(async function (this: Command, query: string, opts: { engrams?: boolean; all?: boolean; days: string; limit: string; full?: boolean; json?: boolean; includeSuperseded?: boolean; scope: string; embed: boolean; kind?: string; topic?: string; context?: string | boolean; since?: string }) {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    // AGT-308: scope is validated by Commander .choices() before action runs.
    const scope = opts.scope as RecallScope;

    // AGT-324: honor both --no-embed flag and THINK_NO_EMBED=1 env var.
    // Commander.js --no-embed convention: sets opts.embed=false (not opts.noEmbed).
    const noEmbed = opts.embed === false || process.env.THINK_NO_EMBED === '1';

    // AGT-319: validate --limit: must be a positive integer.
    const limitRaw = opts.limit;
    const limit = parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit <= 0 || String(limit) !== limitRaw.trim()) {
      console.error(`error: --limit must be a positive integer, got '${limitRaw}'`);
      process.exitCode = 1;
      return;
    }

    // AGT-320: Validate --kind and --since eagerly on the CLI side so users get a
    // clear error before any daemon RPC or FTS query is attempted (fail fast).
    if (opts.kind !== undefined) {
      try { validateKind(opts.kind); }
      catch (e) { console.error((e as Error).message); process.exitCode = 1; return; }
    }
    if (opts.since !== undefined) {
      try { validateSince(opts.since); }
      catch (e) { console.error((e as Error).message); process.exitCode = 1; return; }
    }

    if (opts.all && opts.json) {
      console.error("error: --json is not compatible with --all");
      process.exitCode = 1;
      return;
    }

    if (opts.all) {
      const days = parseInt(opts.days, 10);
      renderPersonalAll(cortex, { days, query });
      closeCortexDb(cortex);
      return;
    }

    // ────────────────────────────────────────────────────────────────────
    // Daemon recall path (semantic vector search + federation + filters).
    //
    // The CLI tries the daemon RPC first when --no-embed is NOT set. The
    // daemon handler does the embed call, vector search via search-vectors,
    // recency-weighted reranking, filter application, and federation.
    //
    // Falls back to local FTS5 when:
    //   - --no-embed (explicit opt-out — see NOTE_FTS_EXPLICIT)
    //   - daemon spawn/connect fails (see NOTE_FTS_FALLBACK)
    //   - daemon RPC errors mid-call (e.g. embed model crash)
    // FTS mode silently ignores filter flags that only the daemon understands
    // (--kind, --topic, --since, --include-superseded, --scope); a warning
    // is emitted for each so the user knows the flag was a no-op.
    // ────────────────────────────────────────────────────────────────────

    if (!noEmbed) {
      // Dynamic import of daemon-client keeps the FTS-only path (the
      // --no-embed branch below) free of any daemon module-load cost —
      // useful for offline / CI runs that explicitly opt out of semantic
      // recall and never need the IPC stack.
      type DaemonClient = Awaited<ReturnType<typeof import('../lib/daemon-client.js').connectDaemon>>;
      let client: DaemonClient | null = null;
      try {
        const { connectDaemon } = await import('../lib/daemon-client.js');
        client = await connectDaemon();
      } catch {
        client = null;
      }

      if (client !== null) {
        // --scope all is documented as "future remote peers" but is not yet
        // wired to remote-peer federation. The daemon treats it identically
        // to --scope accessible. Warn loudly so users don't infer that
        // remote-peer federation is happening silently.
        if (scope === 'all') {
          console.warn(chalk.yellow(
            "note: --scope all is not yet wired to remote-peer federation; behaves like --scope accessible (queries all locally-cloned cortexes).",
          ));
        }

        const rpcParams: Record<string, unknown> = { query, limit, scope, source: 'recall' };
        const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
        if (sessionId) rpcParams['session_id'] = sessionId;
        if (scope === 'active') rpcParams['cortex'] = cortex;
        if (opts.kind !== undefined) rpcParams['kind'] = opts.kind;
        if (opts.topic !== undefined) rpcParams['topic'] = opts.topic;
        // v3 working-context boost: pass the repo context so retros tagged
        // repo:<context> surface first. --context <name> overrides; --no-context
        // (opts.context === false) disables; otherwise auto-detect from cwd.
        if (opts.context !== false) {
          const ctx = typeof opts.context === 'string'
            ? normalizeContext(opts.context)
            : detectWorkingContext();
          if (ctx) rpcParams['context'] = ctx;
        }
        if (opts.since !== undefined) rpcParams['since'] = opts.since;
        if (opts.full) rpcParams['full'] = true;
        if (opts.includeSuperseded) rpcParams['includeSuperseded'] = true;

        type DaemonRecallEntry = {
          id: string;
          ts: string;
          cortex: string;
          kind: string | null;
          content: string;
          topics: string[];
          supersedes: string[] | null;
          compacted_from: string[] | null;
          similarity: number | null;
          score: number | null;
          activity_seq: number | null;
          fts_fallback?: true;
        };

        let entries: DaemonRecallEntry[];
        try {
          entries = (await client.call('recall', rpcParams)) as DaemonRecallEntry[];
        } catch (err) {
          console.error(`error: recall failed — ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          client.close();
          closeCortexDb(cortex);
          return;
        }
        client.close();

        // Surface the degradation note when the daemon's internal embed call
        // failed and it auto-fell-back to FTS5 ranking. Checked independently
        // of result count so the user can distinguish "no matches" from
        // "semantic search bypassed and also no matches" — the latter is
        // worth knowing because re-running once the model is available may
        // surface different results.
        const daemonUsedFts = entries[0]?.fts_fallback === true;
        if (daemonUsedFts) console.log(NOTE_FTS_FALLBACK);

        if (opts.json) {
          // Strip the internal `fts_fallback` signal from machine-readable
          // output — it is not part of the documented JSON entry schema and
          // agent schema-validators should not have to know about it. The
          // note above is the user-facing surface for that information.
          const jsonEntries = entries.map((e) => {
            const out: Record<string, unknown> = { ...e };
            delete out['fts_fallback'];
            return out;
          });
          process.stdout.write(JSON.stringify(jsonEntries) + '\n');
          closeCortexDb(cortex);
          return;
        }

        // Normalize the daemon's wire entries into RecallEntry shape for the
        // formatter. The wire type is structurally RecallEntry with three
        // nullable fields; default them and let the rest spread through (so a
        // new wire field doesn't silently drop here).
        const recallEntries = entries.map((e) => ({
          ...e,
          similarity: e.similarity ?? 0,
          score: e.score ?? e.similarity ?? 0,
          supersedes: e.supersedes ?? [],
        }));
        const cortexes = recallEntries.length > 0 ? cortexSet(recallEntries) : new Set<string>([cortex]);
        process.stdout.write(formatRecallOutput(recallEntries, cortexes, { full: opts.full }) + '\n');
        closeCortexDb(cortex);
        return;
      }

      // Daemon unavailable — fall through to FTS with a note.
      console.log(NOTE_FTS_FALLBACK);
    }

    // ────────────────────────────────────────────────────────────────────
    // FTS5 fallback path (local L2 keyword search via searchMemories).
    // Reached when --no-embed is set, daemon spawn/connect failed, or the
    // explicit opt-out env var THINK_NO_EMBED=1 is set. Warns on any
    // daemon-only flag so the user knows it was ignored.
    // ────────────────────────────────────────────────────────────────────

    if (opts.includeSuperseded) {
      console.warn(chalk.yellow("note: --include-superseded requires the daemon (vector recall); the FTS fallback does not apply supersession filters."));
    }
    if (opts.kind !== undefined) {
      console.warn(chalk.yellow("note: --kind " + opts.kind + " requires the daemon (vector recall); the FTS fallback returns all entry kinds."));
    }
    if (opts.topic !== undefined) {
      console.warn(chalk.yellow("note: --topic " + opts.topic + " requires the daemon (vector recall); the FTS fallback ignores topic filters."));
    }
    if (opts.since !== undefined) {
      console.warn(chalk.yellow("note: --since " + opts.since + " requires the daemon (vector recall); the FTS fallback ignores the date filter."));
    }
    if (this.getOptionValueSource('scope') === 'cli' && scope !== 'active') {
      const scopeNote = scope === 'all'
        ? '--scope all requires the daemon for cross-cortex federation; start the daemon (think daemon start) or omit --scope to use the FTS fallback on the active cortex'
        : `--scope ${scope} requires the daemon (vector recall); the FTS fallback queries the active cortex only`;
      console.warn(chalk.yellow(`Note: ${scopeNote}.`));
    }

    if (opts.json) {
      const rawMemories = dedupeBy(
        searchMemories(cortex, query, limit),
        m => JSON.stringify([m.ts, m.author, m.content]),
      );
      const jsonEntries = rawMemories.map(m => ({
        id: m.id,
        ts: m.ts,
        cortex,
        kind: m.kind ?? null,
        content: m.content,
        topics: [] as string[],
        supersedes: null,
        compacted_from: null,
        similarity: null,
        activity_seq: null,
      }));
      process.stdout.write(JSON.stringify(jsonEntries) + '\n');
      closeCortexDb(cortex);
      return;
    }

    if (noEmbed) console.log(NOTE_FTS_EXPLICIT);
    runFormattedFtsRecall(cortex, query, { engrams: opts.engrams, limit, full: opts.full });
    closeCortexDb(cortex);
  });

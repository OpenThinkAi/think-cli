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
 * Run FTS-only recall against the local L2 index (the v2 search path).
 * Used directly when the daemon is unavailable (degraded mode — AGT-289).
 */
function runFtsRecall(cortex: string, query: string, opts: { engrams?: boolean; limit: number }): void {
  const { limit } = opts;

  // Default: FTS search against memories AND long-term events.
  const matchingMemories = dedupeBy(
    searchMemories(cortex, query, limit),
    m => JSON.stringify([m.ts, m.author, m.content]),
  );

  // Long-term: FTS match on title/content + topic match (free-form tokens).
  const queryTopics = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const ftsEvents = searchLongTermEvents(cortex, query, limit);
  const topicEvents = getRecentLongTermEventsForContext(cortex, { topics: queryTopics, limit });
  const matchingEvents = dedupeBy([...ftsEvents, ...topicEvents], e => e.id);

  if (matchingEvents.length > 0) {
    console.log(chalk.cyan(`Long-term history (${matchingEvents.length}):`));
    renderLongTermEvents(cortex, matchingEvents);
    console.log();
  }

  if (matchingMemories.length > 0) {
    console.log(chalk.cyan(`Matching memories (${matchingMemories.length}):`));
    for (const m of matchingMemories) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
      printDecisions(m);
    }
    console.log();
  } else if (matchingEvents.length === 0) {
    // Fall back to long-term summary when neither FTS nor events match
    const longterm = getLongtermSummary(cortex);
    if (longterm) {
      console.log(chalk.dim('No matching memories or events. Showing legacy long-term summary:'));
      console.log(`  ${longterm}`);
      console.log();
    } else {
      console.log(chalk.dim('No matching memories or long-term events.'));
      console.log();
    }
  }

  // Optionally include engrams
  if (opts.engrams) {
    const matchingEngrams = dedupeBy(
      searchEngrams(cortex, query, limit),
      e => JSON.stringify([e.created_at, e.content]),
    );
    if (matchingEngrams.length > 0) {
      console.log(chalk.cyan(`Matching engrams (${matchingEngrams.length}):`));
      for (const e of matchingEngrams) {
        const ts = e.created_at.slice(0, 16).replace('T', ' ');
        console.log(`  ${chalk.gray(ts)} ${e.content}`);
      }
      console.log();
    }
  }
}

export const recallCommand = new Command('recall')
  .argument('<query>', 'What to recall')
  .description('Search memories and local engrams')
  .option('--engrams', 'Also search local engrams (not just memories)')
  .option('--all', 'Dump all recent memories + long-term summary (ignores query for memories)')
  .option('--days <n>', 'Days of memories to include (only with --all)', '14')
  .option('--limit <n>', 'Max results to return', '20')
  .option('--full', 'Return all entries including superseded and compacted-raw (overrides --include-superseded)')
  .option('--include-superseded', 'Include superseded entries but still hide compacted-raw memories')
  .addOption(
    new Option(
      '--scope <value>',
      'Federation scope: active = single cortex; accessible = all your cortexes (default); all = future remote peers',
    )
      .choices(['active', 'accessible', 'all'])
      .default('accessible'),
  )
  .action(function (this: Command, query: string, opts: { engrams?: boolean; all?: boolean; days: string; limit: string; full?: boolean; includeSuperseded?: boolean; scope: string }) {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    // AGT-308: scope is validated by Commander .choices() before action runs.
    const scope = opts.scope as RecallScope;

    const limit = parseInt(opts.limit, 10);

    if (opts.all) {
      const days = parseInt(opts.days, 10);
      renderPersonalAll(cortex, { days, query });
      closeCortexDb(cortex);
      return;
    }

    // AGT-289: Hook point for daemon recall routing. When the daemon recall RPC
    // is wired (later phase), call probeDaemon(100) here — if daemon is up,
    // route to daemon for vector recall; if not, print the degraded note and
    // fall through to runFtsRecall. Currently FTS is the only path.
    //
    // AGT-305: When the daemon path is wired, pass full and includeSuperseded
    // through to the RPC params so the daemon applies the right filters:
    //   { ..., full: opts.full ?? false, includeSuperseded: opts.includeSuperseded ?? false }
    //
    // AGT-308: Pass scope through to the daemon recall RPC params:
    //   { ..., scope }
    //
    // AGT-307 / AGT-318 rendering note: when daemon results are wired here,
    // every RecallEntry carries a non-empty `cortex` field. Rendering must:
    //   - Multi-cortex results: show `[cortex-name]` tag per entry.
    //   - Single-cortex results: omit per-entry tag; state cortex in header.
    //
    // AGT-307 / AGT-319 JSON invariant: when --json lands, always include
    // `cortex` per entry in the serialised output — the field is load-bearing
    // for agent consumers and must never be omitted from machine-readable output.

    // AGT-305: Warn when supersession/compaction filter flags are passed in
    // FTS (degraded) mode — they have no effect until the daemon path is wired.
    if (opts.full || opts.includeSuperseded) {
      const flag = opts.full ? '--full' : '--include-superseded';
      console.warn(chalk.yellow(`Note: ${flag} requires the daemon (vector recall); the FTS fallback does not apply supersession or compaction filters.`));
    }

    // AGT-308: Warn when --scope was explicitly provided in FTS (degraded) mode
    // and has no effect until the daemon path is wired (AGT-289). Check the
    // Commander value source so we do NOT warn when the user ran plain
    // `think recall` without passing --scope (the default 'accessible' is silent).
    if (this.getOptionValueSource('scope') === 'cli' && scope !== 'active') {
      const scopeNote = scope === 'all'
        ? '--scope all is ALPHA and not yet active; behaves like accessible once the daemon path is wired'
        : `--scope ${scope} requires the daemon (vector recall); the FTS fallback queries the active cortex only`;
      console.warn(chalk.yellow(`Note: ${scopeNote}.`));
    }

    runFtsRecall(cortex, query, { engrams: opts.engrams, limit });
    closeCortexDb(cortex);
  });

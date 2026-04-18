import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { searchEngrams } from '../db/engram-queries.js';
import { searchMemories, getLongtermSummary } from '../db/memory-queries.js';
import {
  searchLongTermEvents,
  getLongTermEventById,
  getRecentLongTermEventsForContext,
  getLongTermEvents,
} from '../db/long-term-queries.js';
import type { MemoryRow } from '../db/memory-queries.js';
import type { LongTermEventRow } from '../db/long-term-queries.js';
import { closeCortexDb } from '../db/engrams.js';

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

function dedupeEvents(events: LongTermEventRow[]): LongTermEventRow[] {
  const seen = new Set<string>();
  const out: LongTermEventRow[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export const recallCommand = new Command('recall')
  .argument('<query>', 'What to recall')
  .description('Search memories and local engrams')
  .option('--engrams', 'Also search local engrams (not just memories)')
  .option('--all', 'Dump all recent memories + long-term summary (ignores query for memories)')
  .option('--days <n>', 'Days of memories to include (only with --all)', '14')
  .option('--limit <n>', 'Max results to return', '20')
  .action(async (query: string, opts: { engrams?: boolean; all?: boolean; days: string; limit: string }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const limit = parseInt(opts.limit, 10);

    if (opts.all) {
      // Legacy behavior: dump everything
      const { getMemories } = await import('../db/memory-queries.js');
      const days = parseInt(opts.days, 10);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const recentMemories = getMemories(cortex, { since: cutoff });
      const longterm = getLongtermSummary(cortex);
      // Cap long-term events by the same day-window the user asked for,
      // with a hard limit so this can't explode as the log grows.
      const allEvents = getLongTermEvents(cortex, { since: cutoff, limit: 200 });
      const matchingEngrams = searchEngrams(cortex, query);

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
        // Only fall back to the legacy summary if no structured events exist yet.
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

      closeCortexDb(cortex);
      return;
    }

    // Default: FTS search against memories AND long-term events.
    const matchingMemories = searchMemories(cortex, query, limit);

    // Long-term: FTS match on title/content + topic match (free-form tokens).
    const queryTopics = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const ftsEvents = searchLongTermEvents(cortex, query, limit);
    const topicEvents = getRecentLongTermEventsForContext(cortex, { topics: queryTopics, limit });
    const matchingEvents = dedupeEvents([...ftsEvents, ...topicEvents]);

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
      const matchingEngrams = searchEngrams(cortex, query, limit);
      if (matchingEngrams.length > 0) {
        console.log(chalk.cyan(`Matching engrams (${matchingEngrams.length}):`));
        for (const e of matchingEngrams) {
          const ts = e.created_at.slice(0, 16).replace('T', ' ');
          console.log(`  ${chalk.gray(ts)} ${e.content}`);
        }
        console.log();
      }
    }

    closeCortexDb(cortex);
  });

import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import type { CortexConfig } from '../lib/config.js';
import { getPendingEngrams, getPendingEpisodeEngrams, markPromoted, markPurged, pruneExpiredEngrams } from '../db/engram-queries.js';
import { getMemories, getLongtermSummary, setLongtermSummary, insertMemory, getMemoryByEpisodeKey, tombstoneMemory } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import {
  readCuratorMd,
  assembleCurationPrompt,
  assembleEpisodeCurationPrompt,
  filterRecentMemories,
  runCuration,
  runEpisodeCuration,
  runConsolidation,
} from '../lib/curator.js';
import { getSyncAdapter } from '../sync/registry.js';
import type { MemoryEntry } from '../lib/curator.js';
import { acquireCurateLock } from '../lib/curate-lock.js';

export const curateCommand = new Command('curate')
  .description('Run curation: evaluate pending engrams and promote to memories')
  .option('--dry-run', 'Preview what would be committed without saving')
  .option('--consolidate', 'Run long-term memory consolidation only (no curation)')
  .option('--episode <key>', 'Curate a specific episode into a narrative memory')
  .option('--if-idle', 'Only curate if the user appears idle (used by auto-curation scheduler)')
  .action(async (opts: { dryRun?: boolean; consolidate?: boolean; episode?: string; ifIdle?: boolean }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      if (opts.ifIdle) {
        // Silent no-op when the scheduler fires with no cortex configured
        return;
      }
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const author = config.cortex!.author;

    // Concurrency lock: prevent two curation runs from writing to the same
    // cortex DB at once. Scheduler firings can overlap if curation takes
    // longer than the scheduler interval. Skip for --dry-run (read-only).
    if (!opts.dryRun) {
      const lock = acquireCurateLock(cortex);
      if (!lock.acquired) {
        if (opts.ifIdle) {
          if (process.env.THINK_IDLE_DEBUG) {
            console.log(chalk.dim(`[auto-curate] skipped: another curation is running (pid ${lock.heldByPid ?? '?'})`));
          }
        } else {
          console.log(chalk.yellow(`Another curation is already running (pid ${lock.heldByPid ?? '?'}). Skipping.`));
        }
        closeCortexDb(cortex);
        return;
      }
      // Lock released automatically on process exit via registered hooks.
    }

    // --if-idle: bail early unless conditions are right. The scheduler fires
    // on a fixed cadence, so most firings should exit here in milliseconds.
    // Skip the check for explicit episode/consolidate runs — those are manual.
    if (opts.ifIdle && !opts.episode && !opts.consolidate) {
      const shouldRun = shouldRunIdleCuration(cortex, config.cortex);
      if (!shouldRun.run) {
        if (process.env.THINK_IDLE_DEBUG) {
          console.log(chalk.dim(`[auto-curate] skipped: ${shouldRun.reason}`));
        }
        closeCortexDb(cortex);
        return;
      }
      if (process.env.THINK_IDLE_DEBUG) {
        console.log(chalk.dim(`[auto-curate] running: ${shouldRun.reason}`));
      }
    }

    // 0. Sync: pull latest memories from remote before curation
    const adapter = getSyncAdapter();
    if (adapter?.isAvailable()) {
      try {
        const pullResult = await adapter.pull(cortex);
        if (pullResult.pulled > 0) {
          console.log(chalk.dim(`  Pulled ${pullResult.pulled} memories from ${adapter.name}`));
        }
      } catch {
        console.log(chalk.dim('  Sync pull skipped (remote unavailable)'));
      }
    }

    // Episode curation: separate flow for narrative synthesis
    if (opts.episode) {
      const episodeEngrams = getPendingEpisodeEngrams(cortex, opts.episode);
      if (episodeEngrams.length === 0) {
        console.log(chalk.dim(`No pending engrams for episode: ${opts.episode}`));
        closeCortexDb(cortex);
        return;
      }

      // Get existing narrative for this episode (if re-curating after new rounds)
      const existingMemoryRow = getMemoryByEpisodeKey(cortex, opts.episode);
      const existingMemory: MemoryEntry | null = existingMemoryRow ? {
        ts: existingMemoryRow.ts,
        author: existingMemoryRow.author,
        content: existingMemoryRow.content,
        source_ids: JSON.parse(existingMemoryRow.source_ids),
      } : null;

      console.log(chalk.cyan(`Curating episode: ${opts.episode} (${episodeEngrams.length} engrams${existingMemory ? ', updating existing narrative' : ''})...`));

      const prompt = assembleEpisodeCurationPrompt({
        episodeKey: opts.episode,
        pendingEngrams: episodeEngrams,
        existingMemory,
        author,
      });

      if (opts.dryRun) {
        console.log();
        console.log(chalk.cyan('Episode prompt would be sent to LLM:'));
        console.log(chalk.dim(`  ${episodeEngrams.length} engrams, ${existingMemory ? 'updating' : 'creating'} narrative`));
        for (const e of episodeEngrams) {
          const ts = e.created_at.slice(0, 16).replace('T', ' ');
          console.log(chalk.dim(`  ${ts}: ${e.content.slice(0, 100)}${e.content.length > 100 ? '...' : ''}`));
        }
        closeCortexDb(cortex);
        return;
      }

      let narrative: string;
      try {
        narrative = await runEpisodeCuration(prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Episode curation failed: ${message}`));
        closeCortexDb(cortex);
        process.exit(1);
      }

      // Tombstone old memory if re-curating
      if (existingMemoryRow) {
        tombstoneMemory(cortex, existingMemoryRow.id);
      }

      // Accumulate all source IDs across all rounds
      const allSourceIds = [
        ...(existingMemory?.source_ids ?? []),
        ...episodeEngrams.map(e => e.id),
      ];

      // Insert new narrative memory
      insertMemory(cortex, {
        ts: new Date().toISOString(),
        author,
        content: narrative,
        source_ids: allSourceIds,
        episode_key: opts.episode,
      });

      // Mark episode engrams as promoted
      markPromoted(cortex, episodeEngrams.map(e => e.id));

      // Push if adapter available
      if (adapter?.isAvailable()) {
        try {
          const pushResult = await adapter.push(cortex);
          if (pushResult.pushed > 0) {
            console.log(chalk.dim(`  Pushed ${pushResult.pushed} memories to ${adapter.name}`));
          }
        } catch {
          console.log(chalk.dim('  Sync push skipped (remote unavailable)'));
        }
      }

      console.log();
      console.log(`${chalk.green('✓')} Episode curated: ${opts.episode}`);
      console.log(`  ${episodeEngrams.length} engrams synthesized into narrative`);
      closeCortexDb(cortex);
      return;
    }

    // 1. Read all memories from local SQLite and split into recent vs older
    const allMemories = getMemories(cortex);
    const memoryEntries: MemoryEntry[] = allMemories.map(m => ({
      ts: m.ts,
      author: m.author,
      content: m.content,
      source_ids: JSON.parse(m.source_ids),
    }));
    const { recent, older } = filterRecentMemories(memoryEntries);

    // 2. Read existing long-term summary from local SQLite
    const longtermSummary = getLongtermSummary(cortex);

    // Handle --consolidate: just run long-term memory consolidation
    if (opts.consolidate) {
      if (older.length === 0) {
        console.log(chalk.dim('No memories older than 2 weeks to consolidate.'));
        return;
      }

      console.log(chalk.cyan(`Consolidating ${older.length} older memories into long-term summary...`));

      try {
        const newSummary = await runConsolidation(longtermSummary, older);
        if (opts.dryRun) {
          console.log();
          console.log(chalk.cyan('Proposed long-term summary:'));
          console.log(newSummary);
          return;
        }
        setLongtermSummary(cortex, newSummary);
        console.log(chalk.green('✓') + ` Long-term summary updated (${older.length} memories consolidated)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Consolidation failed: ${message}`));
        process.exit(1);
      }
      return;
    }

    // 3. Read pending engrams
    const pending = getPendingEngrams(cortex);
    if (pending.length === 0) {
      console.log(chalk.dim('No pending engrams to evaluate.'));
      closeCortexDb(cortex);
      return;
    }

    console.log(chalk.cyan(`Evaluating ${pending.length} engrams (${recent.length} recent memories, long-term summary ${longtermSummary ? 'loaded' : 'absent'})...`));

    // 4. Read curator.md
    const curatorMd = readCuratorMd();

    // 5. Assemble and run curation prompt
    const curationPrompt = assembleCurationPrompt({
      recentMemories: recent,
      longtermSummary,
      curatorMd,
      pendingEngrams: pending,
      author,
      selectivity: config.cortex?.selectivity,
      granularity: config.cortex?.granularity,
      maxMemoriesPerRun: config.cortex?.maxMemoriesPerRun,
    });

    let curationResult;
    try {
      curationResult = await runCuration(curationPrompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Curation failed: ${message}`));
      closeCortexDb(cortex);
      process.exit(1);
    }

    const newEntries = curationResult.memories;

    // Always set author and timestamp — don't trust the LLM to fill these correctly
    for (const entry of newEntries) {
      entry.author = author;
      if (!entry.ts) entry.ts = new Date().toISOString();
    }

    // 6. Classify engrams: promoted (fed into a memory), purged (curator said noise),
    //    or held (implicit — neither promoted nor purged; stays pending for next run).
    const promotedIds = new Set<string>();
    for (const entry of newEntries) {
      for (const id of entry.source_ids) {
        promotedIds.add(id);
      }
    }

    const pendingIdSet = new Set(pending.map(e => e.id));
    // Only purge IDs the curator actually saw this run, and don't let an engram
    // be both promoted and purged (promotion wins).
    const purgedIds = curationResult.purgeIds
      .filter(id => pendingIdSet.has(id) && !promotedIds.has(id));

    const heldCount = pending.length - promotedIds.size - purgedIds.length;

    // 7. Dry run — show preview and exit
    if (opts.dryRun) {
      console.log();
      if (newEntries.length === 0) {
        console.log(chalk.dim('Curator would produce no new memories.'));
      } else {
        console.log(chalk.cyan('Would append:'));
        for (const entry of newEntries) {
          console.log(chalk.green(`  + `) + `[${entry.ts}] ${entry.content}`);
        }
      }
      console.log();
      console.log(`${pending.length} evaluated, ${newEntries.length} would promote, ${purgedIds.length} would purge, ${heldCount} would stay pending`);
      closeCortexDb(cortex);
      return;
    }

    // 8. Confirm before commit (if configured)
    if (config.cortex?.confirmBeforeCommit && newEntries.length > 0) {
      console.log();
      console.log(chalk.cyan('Proposed memories:'));
      for (let i = 0; i < newEntries.length; i++) {
        console.log(chalk.green(`  ${i + 1}. `) + newEntries[i].content);
      }
      console.log();

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question('  Save these memories? [Y/n/edit] ', (ans) => {
          rl.close();
          resolve(ans.trim().toLowerCase());
        });
      });

      if (answer === 'n' || answer === 'no') {
        console.log(chalk.dim('  Aborted. Engrams left as pending.'));
        closeCortexDb(cortex);
        return;
      }

      if (answer === 'e' || answer === 'edit') {
        for (let i = 0; i < newEntries.length; i++) {
          const editRl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const edited = await new Promise<string>((resolve) => {
            editRl.question(`  ${i + 1}. ${chalk.dim('(enter to keep, or type replacement)')}\n     ${newEntries[i].content}\n     > `, (ans) => {
              editRl.close();
              resolve(ans.trim());
            });
          });
          if (edited) {
            newEntries[i].content = edited;
          }
        }
      }
    }

    // 9. Write memories to local SQLite
    if (newEntries.length > 0) {
      for (const entry of newEntries) {
        insertMemory(cortex, {
          ts: entry.ts,
          author: entry.author,
          content: entry.content,
          source_ids: entry.source_ids,
          decisions: entry.decisions,
        });
      }
    }

    // 10. Mark engrams by outcome. Anything not promoted or purged stays pending.
    if (promotedIds.size > 0) {
      markPromoted(cortex, [...promotedIds]);
    }
    if (purgedIds.length > 0) {
      markPurged(cortex, purgedIds);
    }

    // 11. Prune expired engrams
    const pruned = pruneExpiredEngrams(cortex);

    // 12. Auto-consolidate if there are older memories and no long-term summary yet
    if (older.length > 0 && !longtermSummary) {
      console.log(chalk.dim(`  Consolidating ${older.length} older memories into long-term summary...`));
      try {
        const newSummary = await runConsolidation(null, older);
        setLongtermSummary(cortex, newSummary);
        console.log(chalk.dim(`  Long-term summary created`));
      } catch {
        console.log(chalk.dim(`  Long-term consolidation skipped (will retry next run)`));
      }
    }

    // 13. Sync: push new memories to remote after curation
    if (adapter?.isAvailable() && newEntries.length > 0) {
      try {
        const pushResult = await adapter.push(cortex);
        if (pushResult.pushed > 0) {
          console.log(chalk.dim(`  Pushed ${pushResult.pushed} memories to ${adapter.name}`));
        }
      } catch {
        console.log(chalk.dim('  Sync push skipped (remote unavailable) — will push on next sync'));
      }
    }

    // 14. Report
    console.log();
    console.log(`${chalk.green('✓')} Curation complete`);
    console.log(`  ${pending.length} evaluated, ${newEntries.length} promoted, ${purgedIds.length} purged, ${heldCount} still pending`);
    if (pruned > 0) {
      console.log(`  ${pruned} expired engrams pruned`);
    }

    closeCortexDb(cortex);
  });

const DEFAULT_IDLE_WINDOW_MINUTES = 3;
const DEFAULT_STALE_WINDOW_MINUTES = 60;

// Decide whether an auto-curation run should proceed. Returns a reason
// string either way — useful for --if-idle telemetry and debugging.
function shouldRunIdleCuration(
  cortex: string,
  cortexConfig: CortexConfig | undefined,
): { run: boolean; reason: string } {
  const pending = getPendingEngrams(cortex);

  if (pending.length === 0) {
    return { run: false, reason: 'no pending engrams' };
  }

  const idleMinutes = cortexConfig?.idleWindowMinutes ?? DEFAULT_IDLE_WINDOW_MINUTES;
  const staleMinutes = cortexConfig?.staleWindowMinutes ?? DEFAULT_STALE_WINDOW_MINUTES;
  const now = Date.now();

  // pending is ordered created_at ASC — oldest first, newest last.
  const oldest = pending[0];
  const newest = pending[pending.length - 1];
  const oldestAgeMin = (now - new Date(oldest.created_at).getTime()) / 60000;
  const newestAgeMin = (now - new Date(newest.created_at).getTime()) / 60000;

  // Staleness cap wins: if the oldest engram is too old, curate regardless
  // of how recently the user synced.
  if (oldestAgeMin >= staleMinutes) {
    return { run: true, reason: `staleness cap hit (oldest pending ${oldestAgeMin.toFixed(1)}min old)` };
  }

  // Otherwise, respect the idle window — if the user is still actively
  // syncing, let the burst settle.
  if (newestAgeMin < idleMinutes) {
    return { run: false, reason: `still active (newest engram ${newestAgeMin.toFixed(1)}min old, idle threshold ${idleMinutes}min)` };
  }

  return { run: true, reason: `idle (${pending.length} pending, newest ${newestAgeMin.toFixed(1)}min old)` };
}

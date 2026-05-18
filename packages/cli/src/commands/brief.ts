/**
 * think brief — task-start orientation dump (v3 recall semantics, AGT-322)
 *
 * Calls the daemon recall RPC twice:
 *   1. Personal cortex, all kinds  -> "personal context" section
 *   2. Repo cortex, kind=retro     -> "repo lessons" section
 *
 * Both sections render via the AGT-318 pure formatter (formatRecallOutput).
 *
 * Back-compat notes:
 *   - --days from v2 is accepted but ignored; recency comes from activity_seq.
 *     A "note:" is printed when --days is explicitly passed.
 *   - --cortex is still required (identifies the repo cortex for retros).
 *   - --limit controls per-section limit (applied to each recall call).
 *   - --no-sync is preserved for back-compat but has no effect.
 */

import { existsSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { getConfig } from "../lib/config.js";
import { getIndexDbPath } from "../lib/paths.js";
import { connectDaemon, DaemonUnavailableError } from "../lib/daemon-client.js";
import { formatRecallOutput, cortexSet, DEFAULT_RECALL_LIMIT } from "../lib/recall-format.js";
import type { RecallEntry } from "../daemon/recall.js";

function isRecallEntryArray(val: unknown): val is RecallEntry[] {
  return Array.isArray(val);
}

export const briefCommand = new Command("brief")
  .description("Task-start brief: personal-cortex context + repo-cortex retros")
  .argument("[query]", "Optional search query forwarded to both sections")
  .option("--cortex <name>", "Repo cortex to read retros from (required)")
  .option(
    "--days <n>",
    "[deprecated, ignored] Days filter (v2 back-compat; recency is now determined automatically)",
  )
  .option(
    "--limit <n>",
    "Max entries per section",
    String(DEFAULT_RECALL_LIMIT),
  )
  .option("--no-sync", "Accepted for back-compat; no effect. The daemon manages sync; --no-sync no longer prevents daemon use.")
  .addHelpText('after', `
Scope:
  Combines two sources into one task-start context dump:
    1. Personal context — all-kind entries from your active cortex
       (memories, retros, events ranked by recency x semantic similarity).
    2. Repo lessons — retros from the named repo cortex
       (durable wisdom for the target codebase).

  --cortex is required.

  Agents: run at task start to inherit prior lessons for a codebase.

Examples:
  think brief --cortex fx-tracker
  think brief "migrations" --cortex my-repo
  think brief --cortex think-cli --limit 12
`)
  .action(async function (this: Command, query: string | undefined, opts: {
    cortex?: string;
    days?: string;
    limit: string;
    sync: boolean;
  }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const targetCortex = opts.cortex ?? globalOpts.cortex;

    if (!targetCortex) {
      console.error(chalk.red("think brief: --cortex is required."));
      console.error(chalk.red("Pass it as: think brief --cortex <name>  or  think -C <name> brief"));
      process.exitCode = 1;
      return;
    }

    const config = getConfig();
    const activeCortex = config.cortex?.active;

    if (!activeCortex) {
      console.error(chalk.red("No active cortex. Run: think cortex switch <name>"));
      process.exitCode = 1;
      return;
    }

    if (this.getOptionValueSource("days") === "cli") {
      console.log("note: --days is ignored; recency is determined automatically by the daemon.");
    }

    const limit = parseInt(opts.limit, 10);
    const effectiveQuery = query ?? "task start context";

    let client;
    try {
      client = await connectDaemon();
    } catch (err) {
      // Graceful degradation: warn but continue with empty sections rather than hard-exiting.
      // think brief is a read-only orientation command; partial output is more useful than failure.
      if (err instanceof DaemonUnavailableError) {
        console.warn(chalk.yellow("note: daemon unavailable — " + err.message + ". Check daemon log: " + err.logPath));
        console.warn(chalk.yellow("note: running in degraded mode (empty sections). Start the daemon for full results."));
      } else {
        console.warn(chalk.yellow("note: daemon unavailable (" + (err instanceof Error ? err.message : String(err)) + "); running in degraded mode."));
      }
      console.log("── personal context ──");
      console.log("note: no entries available (daemon offline)");
      console.log();
      console.log("── repo lessons [" + targetCortex + "] ──");
      console.log("note: no retros available (daemon offline)");
      return;
    }

    try {
      const personalRaw = await client.call("recall", {
        cortex: activeCortex,
        scope: "active",
        query: effectiveQuery,
        limit,
      });

      const personalEntries = isRecallEntryArray(personalRaw) ? personalRaw : [];

      console.log("── personal context ──");
      if (personalEntries.length === 0) {
        console.log(`note: no entries found in personal cortex ${activeCortex}`);
      } else {
        const personalCortexes = cortexSet(personalEntries);
        personalCortexes.add(activeCortex);
        console.log(formatRecallOutput(personalEntries, personalCortexes));
      }

      console.log();

      // Pre-flight: check that the target cortex DB exists locally.
      // The daemon returns empty (not an error) for unknown cortex names;
      // this check surfaces a diagnostic when the name is likely a typo.
      if (!existsSync(getIndexDbPath(targetCortex))) {
        console.log(`── repo lessons [${targetCortex}] ──`);
        console.warn(chalk.yellow(`note: no local cortex named "${targetCortex}" — check spelling or run: think retro "..." --cortex ${targetCortex}`));
        return;
      }

      const repoRaw = await client.call("recall", {
        cortex: targetCortex,
        scope: "active",
        query: effectiveQuery,
        limit,
        kind: "retro",
      });

      const repoEntries = isRecallEntryArray(repoRaw) ? repoRaw : [];

      console.log("── repo lessons [" + targetCortex + "] ──");
      if (repoEntries.length === 0) {
        console.log(`note: no retros found for cortex ${targetCortex}`);
      } else {
        const repoCortexes = cortexSet(repoEntries);
        repoCortexes.add(targetCortex);
        console.log(formatRecallOutput(repoEntries, repoCortexes));
      }
    } finally {
      client.close();
    }
  });

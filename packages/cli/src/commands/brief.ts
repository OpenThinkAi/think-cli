/**
 * think brief — task-start orientation dump (iterative-learning v3 locality)
 *
 * Calls the daemon recall RPC twice, BOTH against the home cortex:
 *   1. Home cortex, all kinds                       -> "personal context"
 *   2. Home cortex, kind=retro, topic=repo:<context> -> "repo lessons [context]"
 *
 * v3 change: retros no longer live on a separate per-repo cortex branch — they
 * live on the home cortex tagged `repo:<context>`. So brief reads retros from
 * the home cortex (active, or -C) and scopes them to the CONTEXT, which is
 * auto-detected from the git repo you run it in. When no context is detected
 * (outside a repo), the repo-lessons section falls back to all retros.
 *
 * Both sections render via the AGT-318 pure formatter (formatRecallOutput).
 *
 * Back-compat notes:
 *   - --days from v2 is accepted but ignored; recency comes from activity_seq.
 *   - --cortex / -C selects the HOME cortex to read from (default: active).
 *   - --context overrides the auto-detected repo context.
 *   - --limit controls per-section limit (applied to each recall call).
 *   - --no-sync is preserved for back-compat but has no effect.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getConfig } from "../lib/config.js";
import { connectDaemon, DaemonUnavailableError } from "../lib/daemon-client.js";
import { formatRecallOutput, cortexSet, DEFAULT_RECALL_LIMIT } from "../lib/recall-format.js";
import { detectWorkingContext, contextTopic, normalizeContext } from "../lib/working-context.js";
import type { RecallEntry } from "../daemon/recall.js";

function isRecallEntryArray(val: unknown): val is RecallEntry[] {
  return Array.isArray(val);
}

export const briefCommand = new Command("brief")
  .description("Task-start brief: home-cortex context + retros scoped to this repo")
  .argument("[query]", "Optional search query forwarded to both sections")
  .option("--cortex <name>", "Home cortex to read from (default: active cortex)")
  .option("--context <name>", "Repo context to scope retros to (default: the git repo you are in)")
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
Scope (iterative-learning v3):
  Combines two sources, both from your HOME cortex, into one task-start dump:
    1. Personal context — all-kind entries from your home cortex
       (memories, retros, events ranked by recency x semantic similarity).
    2. Repo lessons — retros tagged for the CURRENT repo context
       (auto-detected from the git repo you run this in).

  Retros live on the home cortex now (tagged repo:<context>), not on a separate
  per-repo branch. Outside a git repo, repo lessons fall back to all retros.

  Agents: run at task start to inherit prior lessons for the codebase.

Examples:
  think brief                       (context auto-detected from the repo)
  think brief "migrations"
  think brief --context fx-tracker  (force the repo context)
  think -C engineering brief        (read from the engineering home cortex)
`)
  .action(async function (this: Command, query: string | undefined, opts: {
    cortex?: string;
    context?: string;
    days?: string;
    limit: string;
    sync: boolean;
  }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const homeCortex = opts.cortex ?? globalOpts.cortex ?? config.cortex?.active;

    if (!homeCortex) {
      console.error(chalk.red("No home cortex. Run: think cortex switch <name>  or pass: think -C <name> brief"));
      process.exitCode = 1;
      return;
    }

    // Context the retros section scopes to: explicit --context, else the git
    // repo we're in. Null → not in a repo → show all retros (no topic filter).
    const context = opts.context ? normalizeContext(opts.context) : detectWorkingContext();
    const repoLabel = context ?? "all";

    if (this.getOptionValueSource("days") === "cli") {
      console.log("note: --days is ignored; recency is determined automatically by the daemon.");
    }

    // v3 deprecation hint: pre-v3, `think brief --cortex <repo>` meant "read
    // retros from the <repo> per-repo cortex." Now `--cortex`/`-C` selects the
    // HOME cortex and retros are scoped by the auto-detected repo context, so an
    // old invocation silently returns different (often empty) results. Surface a
    // note whenever a cortex was passed explicitly so the change isn't silent.
    // (Commander routes the `--cortex` long-name to the program-global option in
    // every position, so a command-local `--cortex` is indistinguishable from a
    // global `-C` — the note fires for both, and its wording is accurate either
    // way: `--cortex`/`-C` does select the home cortex now.)
    const cortexExplicit =
      this.getOptionValueSource("cortex") === "cli" ||
      this.parent?.getOptionValueSource("cortex") === "cli";
    if (cortexExplicit) {
      console.log(
        "note: --cortex/-C on 'think brief' now selects the HOME cortex, not a per-repo cortex.\n" +
        "  Retros are scoped to the repo you're in; use --context <name> to scope to a different repo.",
      );
    }

    const limit = parseInt(opts.limit, 10);
    const effectiveQuery = query ?? "task start context";
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID;

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
      console.log("── repo lessons [" + repoLabel + "] ──");
      console.log("note: no retros available (daemon offline)");
      return;
    }

    try {
      const personalRaw = await client.call("recall", {
        cortex: homeCortex,
        scope: "active",
        query: effectiveQuery,
        limit,
        source: "brief",
        ...(sessionId ? { session_id: sessionId } : {}),
      });

      const personalEntries = isRecallEntryArray(personalRaw) ? personalRaw : [];

      console.log("── personal context ──");
      if (personalEntries.length === 0) {
        console.log(`note: no entries found in home cortex ${homeCortex}`);
      } else {
        const personalCortexes = cortexSet(personalEntries);
        personalCortexes.add(homeCortex);
        console.log(formatRecallOutput(personalEntries, personalCortexes));
      }

      console.log();

      // Repo lessons: retros from the SAME home cortex, scoped to the current
      // repo context via the reserved repo:<context> topic (the v3 locality
      // model — no separate per-repo cortex). When no context is detected,
      // omit the topic filter and show all retros.
      const repoRaw = await client.call("recall", {
        cortex: homeCortex,
        scope: "active",
        query: effectiveQuery,
        limit,
        kind: "retro",
        ...(context ? { topic: contextTopic(context) } : {}),
        source: "brief",
        ...(sessionId ? { session_id: sessionId } : {}),
      });

      const repoEntries = isRecallEntryArray(repoRaw) ? repoRaw : [];

      console.log("── repo lessons [" + repoLabel + "] ──");
      if (repoEntries.length === 0) {
        console.log(
          context
            ? `note: no retros tagged repo:${context} in ${homeCortex} yet`
            : `note: no retros found in ${homeCortex}`,
        );
      } else {
        const repoCortexes = cortexSet(repoEntries);
        repoCortexes.add(homeCortex);
        console.log(formatRecallOutput(repoEntries, repoCortexes));
      }
    } finally {
      client.close();
    }
  });

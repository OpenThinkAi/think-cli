/**
 * The `think doctor` check list, and the repair each fixable check maps to
 * (AGT-1308 AC1/AC3/AC4).
 *
 * This is the ONE place where a check is bound to its production inputs. The
 * check functions themselves take everything by injection and know nothing
 * about the real home, the real socket or the network; wiring them up here
 * keeps `packages/cli/tests/lib/doctor/` able to exercise every branch without
 * either.
 *
 * EXTENSION POINT: `doctorChecks()` returns a plain array, so a new check is
 * one entry plus one file under `lib/doctor/`. The retired-vocabulary scan of
 * unmanaged instruction files (`~/CLAUDE.md`, `~/AGENTS.md`, …) is AGT-1309's
 * ticket and is deliberately NOT implemented here — it lands as another entry
 * in this array.
 *
 * EVERY REPAIR IS A FUNCTION SELF-HEAL ALREADY CALLS (AC4). `--fix` reaps
 * LaunchAgents with AGT-1301's reaper, refreshes blocks with AGT-1306's
 * refresher, migrates rows with AGT-1302's migration, reconciles the index
 * with AGT-1299's reconcile, and restarts the daemon through #91's
 * `restartDaemonViaBin`. None of them is reimplemented here, and none of them
 * writes outside a managed marker pair (AC5).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reapStaleLaunchAgents } from '../launch-agent.js';
import { refreshRegisteredBlocks } from '../block-refresh.js';
import { migrateStrandedEngrams } from '../engram-migration.js';
import { reconcilePlumbingStaleIndex } from '../git.js';
import { restartDaemonViaBin } from '../daemon-drift.js';
import { resolvePackageEntry } from '../pkg-paths.js';
import { plural, type CheckResult } from './types.js';
import { checkStaleLaunchAgents, STALE_LAUNCH_AGENTS_CHECK_ID } from './launch-agents.js';
import { checkManagedBlocks, MANAGED_BLOCKS_CHECK_ID } from './managed-blocks.js';
import { checkUnmigratedEngrams, ENGRAM_ROWS_CHECK_ID } from './engram-rows.js';
import { checkRepoIndex, REPO_INDEX_CHECK_ID } from './repo-index.js';
import { checkDaemonVersion, DAEMON_CHECK_ID } from './daemon.js';
import { checkLlmProviders, LLM_PROVIDERS_CHECK_ID } from './llm-providers.js';
import { checkClaudeIntegration, CLAUDE_INTEGRATION_CHECK_ID } from './claude-integration.js';
import { checkThinkHomes, THINK_HOMES_CHECK_ID } from './think-homes.js';

/** What a repair did, for the line `--fix` prints before re-running. */
export interface FixOutcome {
  ok: boolean;
  detail: string;
}

export interface DoctorCheckDefinition {
  id: string;
  /** Read-only. Never throws — see `runDoctorChecks`. */
  run: () => Promise<CheckResult>;
  /**
   * The repair for this check, when one is safe. Absent means the check can
   * never report `fixable: true`; present does not mean it always does — the
   * result decides, per run.
   */
  fix?: () => Promise<FixOutcome>;
}

/** The check list, in the order `think doctor` prints it. */
export function doctorChecks(): DoctorCheckDefinition[] {
  return [
    {
      id: STALE_LAUNCH_AGENTS_CHECK_ID,
      run: async () => checkStaleLaunchAgents(),
      fix: async () => {
        const reaped = reapStaleLaunchAgents();
        return {
          ok: true,
          detail: reaped.length === 0
            ? 'No stale LaunchAgents left to remove.'
            : `Removed ${plural(reaped.length, 'stale LaunchAgent')}: ${reaped.map((a) => a.label).join(', ')}.`,
        };
      },
    },
    {
      id: MANAGED_BLOCKS_CHECK_ID,
      run: async () => checkManagedBlocks(),
      // In-process is correct HERE, unlike in `think update`: no install has
      // just replaced dist/ underneath us, so the template loaded in this
      // process IS the installed one. (`think update` must use
      // `refreshBlocksViaBin` for exactly the opposite reason.)
      fix: async () => {
        const { refreshed, failures } = refreshRegisteredBlocks();
        const parts: string[] = [];
        if (refreshed.length > 0) parts.push(`Refreshed ${plural(refreshed.length, 'managed block')}.`);
        for (const failure of failures) parts.push(`Could not refresh ${failure.path}: ${failure.reason}.`);
        return {
          ok: failures.length === 0,
          detail: parts.length > 0 ? parts.join(' ') : 'No managed block needed refreshing.',
        };
      },
    },
    {
      id: ENGRAM_ROWS_CHECK_ID,
      run: () => checkUnmigratedEngrams(),
      fix: async () => {
        const summary = await migrateStrandedEngrams();
        const rescued = summary.totals.events + summary.totals.memories;
        const failed = summary.totals.failed;
        // A cortex that could not be migrated at all reports through
        // `CortexEngramMigration.error`, not through `totals.failed` — without
        // surfacing it, a sweep that touched nothing would read as success.
        const errored = summary.cortexes.filter((cortex) => cortex.error !== undefined);
        const parts = [
          `Rescued ${plural(rescued, 'engram row')}` +
            (summary.totals.repaired > 0 ? `, repaired ${summary.totals.repaired}` : '') +
            (failed > 0 ? `; ${failed} failed and will be retried.` : '.'),
        ];
        for (const cortex of errored) parts.push(`Could not migrate ${cortex.cortex}: ${cortex.error}.`);
        return { ok: failed === 0 && errored.length === 0, detail: parts.join(' ') };
      },
    },
    {
      id: REPO_INDEX_CHECK_ID,
      run: async () => checkRepoIndex(),
      fix: async () => {
        const reconciled = reconcilePlumbingStaleIndex();
        return {
          ok: reconciled,
          detail: reconciled
            ? 'Reset the stale index to HEAD, preserving every in-flight append.'
            : 'The index is no longer provably stale — nothing was touched.',
        };
      },
    },
    {
      id: DAEMON_CHECK_ID,
      run: () => checkDaemonVersion(),
      fix: async () => {
        const pkgRoot = packageRoot();
        if (pkgRoot === null) {
          return { ok: false, detail: 'Could not locate the installed package to restart the daemon.' };
        }
        const restart = restartDaemonViaBin(pkgRoot);
        return {
          ok: restart.ok,
          detail: restart.ok
            ? 'Restarted the daemon on the installed build.'
            : `Could not restart the daemon: ${restart.error ?? 'unknown error'}.`,
        };
      },
    },
    {
      id: LLM_PROVIDERS_CHECK_ID,
      run: () => checkLlmProviders(),
    },
    {
      id: CLAUDE_INTEGRATION_CHECK_ID,
      run: async () => checkClaudeIntegration(),
    },
    {
      id: THINK_HOMES_CHECK_ID,
      run: async () => checkThinkHomes(),
    },
  ];
}

/**
 * Run every check in order. A check that throws is reported as a `fail` rather
 * than taking down the command: `think doctor` exists to diagnose a broken
 * install, so it has to survive one.
 */
export async function runDoctorChecks(
  checks: DoctorCheckDefinition[] = doctorChecks(),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check.run());
    } catch (err) {
      results.push({
        id: check.id,
        status: 'fail',
        detail: `Check threw: ${err instanceof Error ? err.message : String(err)}.`,
        // A check that could not complete has no diagnosis to repair from.
        fixable: false,
      });
    }
  }
  return results;
}

/** One repair that `--fix` attempted. */
export interface AppliedFix {
  id: string;
  outcome: FixOutcome;
}

/**
 * Apply the repairs for every non-passing result that reported
 * `fixable: true` AND whose check actually carries a `fix` (AC3). A result
 * that is passing, unfixable, or whose check has no repair is skipped — the
 * status is the gate, so a healthy machine's `think doctor --fix` does nothing
 * at all.
 */
export async function applyDoctorFixes(
  checks: DoctorCheckDefinition[],
  results: CheckResult[],
): Promise<AppliedFix[]> {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const applied: AppliedFix[] = [];
  for (const result of results) {
    if (result.status === 'pass' || !result.fixable) continue;
    const fix = byId.get(result.id)?.fix;
    if (!fix) continue;
    try {
      applied.push({ id: result.id, outcome: await fix() });
    } catch (err) {
      applied.push({
        id: result.id,
        outcome: { ok: false, detail: `Repair threw: ${err instanceof Error ? err.message : String(err)}.` },
      });
    }
  }
  return applied;
}

/** Root of the installed `@openthink/think` package, or null. */
function packageRoot(): string | null {
  try {
    return resolvePackageEntry(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

/**
 * `think doctor` — report this machine's think install, and repair what is
 * safe (AGT-1308).
 *
 * Every problem found on 2026-09-17 was found by hand: stranded engram rows,
 * LaunchAgents invoking a deleted command, a cortex index inverted behind a
 * plumbing-advanced HEAD, a daemon serving last week's code. This command
 * asks all of those questions in one place.
 *
 * The checks live in `lib/doctor/` — one exported, unit-tested function each,
 * every input injected — and are bound to their production inputs in
 * `lib/doctor/registry.ts`. This file is only presentation and exit code.
 *
 * Two guarantees the design doc makes and this command keeps:
 *
 *  - It NEVER sends cortex content anywhere. The only network call any check
 *    makes is an unauthenticated `GET /models` liveness probe against an
 *    already-configured provider (AC5).
 *  - It NEVER edits a file outside managed markers. The only writes `--fix`
 *    performs are the self-heal repairs: removing think's own stale plists,
 *    rewriting think's own managed blocks between their markers, migrating
 *    think's own rows, reconciling think's own cortex repo, restarting think's
 *    own daemon (AC3, AC5).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  doctorChecks,
  runDoctorChecks,
  applyDoctorFixes,
  type DoctorCheckDefinition,
} from '../lib/doctor/registry.js';
import type { CheckResult, CheckStatus } from '../lib/doctor/types.js';

/** Glyph + colour per status, matching the house style used elsewhere. */
function marker(status: CheckStatus): string {
  if (status === 'pass') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('⚠');
  return chalk.red('✗');
}

function printResults(results: CheckResult[]): void {
  for (const result of results) {
    const id = result.status === 'pass' ? chalk.dim(result.id) : chalk.bold(result.id);
    console.log(`${marker(result.status)} ${id}  ${result.detail}`);
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const fixable = results.filter((r) => r.status !== 'pass' && r.fixable).length;

  console.log();
  if (failed === 0 && warned === 0) {
    console.log(chalk.green(`✓ ${results.length} checks passed.`));
  } else {
    console.log(
      chalk.dim(`${results.length} checks · `) +
        (failed > 0 ? chalk.red(`${failed} failed`) : chalk.dim('0 failed')) +
        chalk.dim(' · ') +
        (warned > 0 ? chalk.yellow(`${warned} warned`) : chalk.dim('0 warned')),
    );
  }
  if (fixable > 0) {
    console.log(chalk.dim(`Run \`think doctor --fix\` to repair ${fixable} of them.`));
  }
}

export const doctorCommand = new Command('doctor')
  .description('Report this machine\'s think install health, and repair what is safe')
  .option('--json', 'Emit the checks as JSON on stdout (nothing else is printed there)')
  .option('--fix', 'Apply the repairs for fixable checks, then run the checks again')
  .action(async (options: { json?: boolean; fix?: boolean }) => {
    const checks: DoctorCheckDefinition[] = doctorChecks();
    let results = await runDoctorChecks(checks);

    if (options.fix) {
      const applied = await applyDoctorFixes(checks, results);
      // Repair progress goes to stderr unconditionally, so `--json --fix`
      // still leaves stdout as one pure JSON document (AC2).
      const note = options.json ? console.error : console.log;
      if (applied.length === 0) {
        note(chalk.dim('Nothing to fix.'));
      } else {
        for (const fix of applied) {
          note(`${fix.outcome.ok ? chalk.green('✓') : chalk.yellow('⚠')} ${fix.id}  ${fix.outcome.detail}`);
        }
        note('');
      }
      // Re-run against the repaired machine: the reported state is always the
      // state the command leaves behind, and the exit code reflects what is
      // still broken rather than what was broken on entry (AC3).
      results = await runDoctorChecks(checks);
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printResults(results);
    }

    // AC2: exit 0 when nothing failed, 1 otherwise. A warn never fails the
    // exit code — a second think home or a provider with a configured
    // fallback must not block a setup script gating on this.
    if (results.some((result) => result.status === 'fail')) {
      process.exitCode = 1;
    }
  });

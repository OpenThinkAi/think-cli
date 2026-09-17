/**
 * Unit tests for the check runner and the `--fix` gate — AGT-1308 AC1/AC3.
 *
 * Every check here is a fake. Nothing in this file runs a real check, so
 * nothing reaps a LaunchAgent, opens a socket, or touches a cortex. What is
 * asserted is the contract around the checks: the list is complete and
 * ordered, one broken check cannot take down the command, and `--fix` runs a
 * repair ONLY for a non-passing result that declared itself fixable.
 */

import { describe, it, expect } from 'vitest';
import {
  doctorChecks,
  runDoctorChecks,
  applyDoctorFixes,
  type DoctorCheckDefinition,
} from '../../../src/lib/doctor/registry.js';
import type { CheckResult } from '../../../src/lib/doctor/types.js';
import { STALE_LAUNCH_AGENTS_CHECK_ID } from '../../../src/lib/doctor/launch-agents.js';
import { MANAGED_BLOCKS_CHECK_ID } from '../../../src/lib/doctor/managed-blocks.js';
import { ENGRAM_ROWS_CHECK_ID } from '../../../src/lib/doctor/engram-rows.js';
import { REPO_INDEX_CHECK_ID } from '../../../src/lib/doctor/repo-index.js';
import { DAEMON_CHECK_ID } from '../../../src/lib/doctor/daemon.js';
import { LLM_PROVIDERS_CHECK_ID } from '../../../src/lib/doctor/llm-providers.js';
import { CLAUDE_INTEGRATION_CHECK_ID } from '../../../src/lib/doctor/claude-integration.js';
import { THINK_HOMES_CHECK_ID } from '../../../src/lib/doctor/think-homes.js';

function fakeCheck(
  id: string,
  result: CheckResult,
  fix?: () => Promise<{ ok: boolean; detail: string }>,
): DoctorCheckDefinition {
  return { id, run: async () => result, ...(fix ? { fix } : {}) };
}

function res(id: string, partial: Partial<CheckResult> = {}): CheckResult {
  return { id, status: 'pass', detail: 'ok', fixable: false, ...partial };
}

describe('doctorChecks (AGT-1308 AC1)', () => {
  it('covers every check the ticket lists, in a stable order', () => {
    expect(doctorChecks().map((check) => check.id)).toEqual([
      STALE_LAUNCH_AGENTS_CHECK_ID,
      MANAGED_BLOCKS_CHECK_ID,
      ENGRAM_ROWS_CHECK_ID,
      REPO_INDEX_CHECK_ID,
      DAEMON_CHECK_ID,
      LLM_PROVIDERS_CHECK_ID,
      CLAUDE_INTEGRATION_CHECK_ID,
      THINK_HOMES_CHECK_ID,
    ]);
  });

  it('carries a repair for exactly the checks AC3 names, and no others', () => {
    const withFix = doctorChecks().filter((check) => check.fix !== undefined).map((c) => c.id);

    expect(withFix).toEqual([
      STALE_LAUNCH_AGENTS_CHECK_ID,
      MANAGED_BLOCKS_CHECK_ID,
      ENGRAM_ROWS_CHECK_ID,
      REPO_INDEX_CHECK_ID,
      DAEMON_CHECK_ID,
    ]);
  });
});

describe('runDoctorChecks (AGT-1308)', () => {
  it('returns one result per check, in order', async () => {
    const results = await runDoctorChecks([
      fakeCheck('a', res('a')),
      fakeCheck('b', res('b', { status: 'warn', detail: 'hmm' })),
    ]);

    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(results[1].status).toBe('warn');
  });

  it('turns a throwing check into a fail rather than crashing the command', async () => {
    const results = await runDoctorChecks([
      {
        id: 'boom',
        run: async () => {
          throw new Error('sqlite is on fire');
        },
      },
      fakeCheck('after', res('after')),
    ]);

    expect(results[0]).toEqual({
      id: 'boom',
      status: 'fail',
      detail: 'Check threw: sqlite is on fire.',
      fixable: false,
    });
    // The rest of the run still happens — one broken check is not the end.
    expect(results[1].status).toBe('pass');
  });
});

describe('applyDoctorFixes (AGT-1308 AC3)', () => {
  it('repairs only non-passing, fixable results', async () => {
    const calls: string[] = [];
    const mkFix = (id: string) => async () => {
      calls.push(id);
      return { ok: true, detail: `fixed ${id}` };
    };

    const checks = [
      fakeCheck('passing', res('passing'), mkFix('passing')),
      fakeCheck('unfixable', res('unfixable', { status: 'fail', fixable: false }), mkFix('unfixable')),
      fakeCheck('fixable-fail', res('fixable-fail', { status: 'fail', fixable: true }), mkFix('fixable-fail')),
      fakeCheck('fixable-warn', res('fixable-warn', { status: 'warn', fixable: true }), mkFix('fixable-warn')),
    ];
    const results = await runDoctorChecks(checks);

    const applied = await applyDoctorFixes(checks, results);

    expect(calls).toEqual(['fixable-fail', 'fixable-warn']);
    expect(applied.map((a) => a.id)).toEqual(['fixable-fail', 'fixable-warn']);
    expect(applied[0].outcome).toEqual({ ok: true, detail: 'fixed fixable-fail' });
  });

  it('does nothing on a healthy machine', async () => {
    const checks = [fakeCheck('a', res('a'), async () => ({ ok: true, detail: 'nope' }))];
    const applied = await applyDoctorFixes(checks, await runDoctorChecks(checks));

    expect(applied).toEqual([]);
  });

  it('skips a fixable result whose check carries no repair', async () => {
    const checks = [fakeCheck('a', res('a', { status: 'fail', fixable: true }))];
    const applied = await applyDoctorFixes(checks, await runDoctorChecks(checks));

    expect(applied).toEqual([]);
  });

  it('records a repair that throws instead of aborting the rest', async () => {
    const checks = [
      fakeCheck('boom', res('boom', { status: 'fail', fixable: true }), async () => {
        throw new Error('EACCES');
      }),
      fakeCheck('ok', res('ok', { status: 'fail', fixable: true }), async () => ({ ok: true, detail: 'done' })),
    ];
    const applied = await applyDoctorFixes(checks, await runDoctorChecks(checks));

    expect(applied[0].outcome).toEqual({ ok: false, detail: 'Repair threw: EACCES.' });
    expect(applied[1].outcome.ok).toBe(true);
  });
});

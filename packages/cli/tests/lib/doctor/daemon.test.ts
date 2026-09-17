/**
 * Unit tests for checkDaemonVersion() — AGT-1308 AC1.
 *
 * Both sources are injected in every test: no socket is opened, no PID file is
 * read, and no real daemon is contacted. The matrix mirrors
 * `needsDaemonRestart` (#91) deliberately — the check must not invent a
 * different notion of drift from the one `--fix` acts on.
 */

import { describe, it, expect } from 'vitest';
import { checkDaemonVersion, DAEMON_CHECK_ID } from '../../../src/lib/doctor/daemon.js';

describe('checkDaemonVersion (AGT-1308)', () => {
  it('passes when the daemon reports the installed version', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: true, version: '3.0.0' }),
      pidStatus: () => ({ running: true, pid: 4242 }),
      installedVersion: '3.0.0',
    });

    expect(result).toEqual({
      id: DAEMON_CHECK_ID,
      status: 'pass',
      detail: 'Daemon is running 3.0.0 (status RPC), matching the installed CLI.',
      fixable: false,
    });
  });

  it('fails, fixable, when the daemon serves an older version', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: true, version: '2.6.0' }),
      pidStatus: () => ({ running: true, pid: 4242 }),
      installedVersion: '3.0.0',
    });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('serving 2.6.0');
    expect(result.detail).toContain('installed CLI is 3.0.0');
  });

  it('treats a reachable daemon with no version as stale (predates the status RPC)', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: true, version: null }),
      pidStatus: () => ({ running: true, pid: 4242 }),
      installedVersion: '3.0.0',
    });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('older than the status RPC');
  });

  it('warns, unfixable, when no daemon is running at all', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: false, version: null }),
      pidStatus: () => ({ running: false }),
      installedVersion: '3.0.0',
    });

    // Doctor reports a missing daemon; starting one is the user's decision.
    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('think daemon start');
  });

  it('mentions a stale PID file left behind by a dead daemon', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: false, version: null }),
      pidStatus: () => ({ running: false, pid: 999, stale: true }),
      installedVersion: '3.0.0',
    });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('stale PID file');
  });

  it('fails, fixable, when the process is alive but its socket does not answer', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: false, version: null }),
      pidStatus: () => ({ running: true, pid: 4242 }),
      installedVersion: '3.0.0',
    });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('4242');
    expect(result.detail).toContain('socket did not answer');
  });

  it('warns when the installed version cannot be read to compare against', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: true, version: '3.0.0' }),
      pidStatus: () => ({ running: true, pid: 4242 }),
      installedVersion: null,
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
  });

  it('survives a PID file it cannot read', async () => {
    const result = await checkDaemonVersion({
      inspect: async () => ({ reachable: false, version: null }),
      pidStatus: () => {
        throw new Error('EACCES');
      },
      installedVersion: '3.0.0',
    });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('No daemon is running');
  });
});

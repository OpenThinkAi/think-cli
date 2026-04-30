import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  getAgentLabel as getSyncLabel,
  getPlistPath as getSyncPlistPath,
  getLogPath as getSyncLogPath,
} from '../../src/lib/auto-sync.js';
import {
  getAgentLabel as getCurateLabel,
  getPlistPath as getCuratePlistPath,
  getLogPath as getCurateLogPath,
} from '../../src/lib/auto-curate.js';

// These tests cover the parts of auto-sync that don't touch launchctl: label
// derivation, plist path, log path. The launchctl-touching paths
// (install/uninstall/status loaded-state) are exercised via manual smoke on a
// dev box — same convention auto-curate follows. The high-value invariants
// here are the ones AC #4 hangs on: auto-sync and auto-curate must produce
// DIFFERENT labels and paths for the same THINK_HOME, so toggling one cannot
// affect the other.

describe('auto-sync label derivation', () => {
  const originalThinkHome = process.env.THINK_HOME;

  beforeEach(() => {
    // The label-derivation helpers don't read the directory, only the
    // string value. A non-existent path is sufficient for these assertions.
    process.env.THINK_HOME = '/tmp/auto-sync-test-fixed';
  });

  afterEach(() => {
    if (originalThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalThinkHome;
  });

  it('derives a label under ai.openthink.sync.* when THINK_HOME is set', () => {
    const label = getSyncLabel();
    expect(label.startsWith('ai.openthink.sync.')).toBe(true);
    // Suffix is the first 8 hex chars of sha1(THINK_HOME). Validate the shape
    // rather than the exact value so the helper can change hashing
    // implementation without breaking the test.
    expect(label).toMatch(/^ai\.openthink\.sync\.[0-9a-f]{8}$/);
  });

  it('falls back to ai.openthink.sync.default when THINK_HOME is unset', () => {
    delete process.env.THINK_HOME;
    expect(getSyncLabel()).toBe('ai.openthink.sync.default');
  });

  it('produces a different label than auto-curate for the same THINK_HOME', () => {
    // AC #4: auto-sync and auto-curate must be independently togglable. If
    // their labels collide for the same THINK_HOME, `launchctl unload` for
    // one would tear down the other.
    expect(getSyncLabel()).not.toBe(getCurateLabel());
  });

  it('produces a different plist path than auto-curate for the same THINK_HOME', () => {
    expect(getSyncPlistPath()).not.toBe(getCuratePlistPath());
  });

  it('produces a different log path than auto-curate for the same THINK_HOME', () => {
    expect(getSyncLogPath()).not.toBe(getCurateLogPath());
  });

  it('uses auto-sync.log under THINK_HOME', () => {
    expect(getSyncLogPath()).toBe(join('/tmp/auto-sync-test-fixed', 'auto-sync.log'));
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  getAgentLabel as getSubscribeLabel,
  getPlistPath as getSubscribePlistPath,
  getLogPath as getSubscribeLogPath,
} from '../../src/lib/auto-subscribe.js';
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

// AC #4 (extended): auto-subscribe joins auto-sync and auto-curate as a third
// independently-togglable LaunchAgent. The high-value invariant: for the same
// THINK_HOME, all three agents must produce DIFFERENT labels and paths so
// `launchctl unload` for one cannot tear down the others.

describe('auto-subscribe label derivation', () => {
  const originalThinkHome = process.env.THINK_HOME;

  beforeEach(() => {
    process.env.THINK_HOME = '/tmp/auto-subscribe-test-fixed';
  });

  afterEach(() => {
    if (originalThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalThinkHome;
  });

  it('derives a label under ai.openthink.subscribe.* when THINK_HOME is set', () => {
    const label = getSubscribeLabel();
    expect(label.startsWith('ai.openthink.subscribe.')).toBe(true);
    expect(label).toMatch(/^ai\.openthink\.subscribe\.[0-9a-f]{8}$/);
  });

  it('falls back to ai.openthink.subscribe.default when THINK_HOME is unset', () => {
    delete process.env.THINK_HOME;
    expect(getSubscribeLabel()).toBe('ai.openthink.subscribe.default');
  });

  it('produces a different label than auto-sync and auto-curate for the same THINK_HOME', () => {
    expect(getSubscribeLabel()).not.toBe(getSyncLabel());
    expect(getSubscribeLabel()).not.toBe(getCurateLabel());
  });

  it('produces a different plist path than auto-sync and auto-curate for the same THINK_HOME', () => {
    expect(getSubscribePlistPath()).not.toBe(getSyncPlistPath());
    expect(getSubscribePlistPath()).not.toBe(getCuratePlistPath());
  });

  it('produces a different log path than auto-sync and auto-curate for the same THINK_HOME', () => {
    expect(getSubscribeLogPath()).not.toBe(getSyncLogPath());
    expect(getSubscribeLogPath()).not.toBe(getCurateLogPath());
  });

  it('uses auto-subscribe.log under THINK_HOME', () => {
    expect(getSubscribeLogPath()).toBe(join('/tmp/auto-subscribe-test-fixed', 'auto-subscribe.log'));
  });
});

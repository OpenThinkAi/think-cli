import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  getAgentLabel as getSubscribeLabel,
  getPlistPath as getSubscribePlistPath,
  getLogPath as getSubscribeLogPath,
} from '../../src/lib/auto-subscribe.js';

// AC #4: auto-subscribe is a per-THINK_HOME, independently-togglable
// LaunchAgent. The label, plist and log path are all derived from the home's
// hash so two homes on one machine cannot tear down each other's agent.
//
// AGT-1303 removed auto-sync and auto-curate, so auto-subscribe is now the
// only LaunchAgent think installs; the cross-agent distinctness assertions
// went with them.

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

  it('derives a different label and plist path per THINK_HOME', () => {
    const label = getSubscribeLabel();
    const plist = getSubscribePlistPath();
    process.env.THINK_HOME = '/tmp/auto-subscribe-test-other';
    expect(getSubscribeLabel()).not.toBe(label);
    expect(getSubscribePlistPath()).not.toBe(plist);
  });

  it('uses auto-subscribe.log under THINK_HOME', () => {
    expect(getSubscribeLogPath()).toBe(join('/tmp/auto-subscribe-test-fixed', 'auto-subscribe.log'));
  });
});

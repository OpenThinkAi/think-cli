import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmConsentError, requireLlmConsent } from '../../src/lib/llm-consent.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';

// AGT-065: every Claude Agent SDK call site routes through `lib/claude-sdk.ts`
// which calls requireLlmConsent before forwarding. The default posture is
// fail-closed — a fresh install must opt in via THINK_LLM_CONSENT or the
// `cortex.llmConsent` config field.
describe('requireLlmConsent — opt-in gate (AGT-065)', () => {
  let originalHome: string | undefined;
  let originalEnv: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    originalEnv = process.env.THINK_LLM_CONSENT;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-consent-test-'));
    process.env.THINK_HOME = tmpHome;
    delete process.env.THINK_LLM_CONSENT;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    if (originalEnv === undefined) delete process.env.THINK_LLM_CONSENT;
    else process.env.THINK_LLM_CONSENT = originalEnv;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('throws LlmConsentError when neither env nor config grants consent (default-deny)', () => {
    expect(() => requireLlmConsent()).toThrow(LlmConsentError);
  });

  it('error message includes both env-var and config snippets the user can copy', () => {
    try {
      requireLlmConsent();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmConsentError);
      const msg = (err as Error).message;
      expect(msg).toContain('THINK_LLM_CONSENT');
      expect(msg).toContain('export THINK_LLM_CONSENT=1');
      expect(msg).toContain('"llmConsent": true');
      expect(msg).toContain('SECURITY.md');
    }
  });

  it.each(['1', 'true', 'yes', 'TRUE', 'Yes'])(
    'env var "%s" satisfies the gate',
    (value) => {
      process.env.THINK_LLM_CONSENT = value;
      expect(() => requireLlmConsent()).not.toThrow();
    },
  );

  it.each(['0', 'false', 'no', '', '   '])(
    'env var "%s" does NOT satisfy the gate',
    (value) => {
      process.env.THINK_LLM_CONSENT = value;
      expect(() => requireLlmConsent()).toThrow(LlmConsentError);
    },
  );

  it('cortex.llmConsent: true in config satisfies the gate', () => {
    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', llmConsent: true },
    });
    expect(() => requireLlmConsent()).not.toThrow();
  });

  it('cortex.llmConsent: false in config does NOT satisfy the gate', () => {
    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', llmConsent: false },
    });
    expect(() => requireLlmConsent()).toThrow(LlmConsentError);
  });

  it('env var trumps missing config (env-only opt-in works)', () => {
    process.env.THINK_LLM_CONSENT = '1';
    saveConfig({
      ...getConfig(),
      cortex: { author: 'test' }, // llmConsent unset
    });
    expect(() => requireLlmConsent()).not.toThrow();
  });
});

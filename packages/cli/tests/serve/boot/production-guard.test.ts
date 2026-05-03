import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { BootGuardError, runBootGuards } from '../../../src/serve/boot.js';

const validKey = randomBytes(32).toString('base64');

describe('runBootGuards (AGT-029 AC #6)', () => {
  it('production + missing THINK_VAULT_KEY → throws', () => {
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(BootGuardError);
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/THINK_VAULT_KEY/);
  });

  it('production + valid THINK_VAULT_KEY → passes', () => {
    const cfg = runBootGuards({
      THINK_TOKEN: 't',
      NODE_ENV: 'production',
      THINK_VAULT_KEY: validKey,
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(4823);
    expect(cfg.pollIntervalSeconds).toBe(600);
  });

  it('non-production + missing THINK_VAULT_KEY → passes (dev path generates the key)', () => {
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't' } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('refuses to boot without THINK_TOKEN', () => {
    expect(() =>
      runBootGuards({} as NodeJS.ProcessEnv),
    ).toThrow(/THINK_TOKEN/);
  });

  it('rejects malformed PORT', () => {
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', PORT: 'abc' } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', PORT: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', PORT: '99999' } as NodeJS.ProcessEnv),
    ).toThrow(/PORT/);
  });

  it('rejects malformed THINK_POLL_INTERVAL_SECONDS', () => {
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', THINK_POLL_INTERVAL_SECONDS: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/THINK_POLL_INTERVAL_SECONDS/);
    expect(() =>
      runBootGuards({ THINK_TOKEN: 't', THINK_POLL_INTERVAL_SECONDS: 'x' } as NodeJS.ProcessEnv),
    ).toThrow(/THINK_POLL_INTERVAL_SECONDS/);
  });
});

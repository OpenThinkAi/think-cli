/**
 * AGT-1327 — `think config set/get cortex.llm.*`.
 *
 * Before this ticket, `cortex.llm.providers.<name>.<leaf>` (the provider
 * registry — lib/config.ts `LlmConfig`) fell through to the flat
 * `ALLOWED_KEYS` check and was rejected with "Unknown config key", which
 * forced a hand-edit of `~/.config/think/config.json` on the work Mac
 * (real-world trigger: `think config set
 * cortex.llm.providers.localqwen.model Qwen3-Coder-30B-A3B-Instruct-8bit`).
 *
 * Covers: nested set/get, intermediate-object creation, per-leaf
 * validation failures (kind/endpoint/model/apiKeyEnv/offMachine/
 * disableThinking/ctxBudget/timeoutMs), `fallback`'s provider-or-"skip"
 * rule, the `cortex.llmConsent` flat key, and the unknown-leaf error for
 * `cortex.llm.*` names this command does not support (`default`,
 * `operations.<op>`, a bare provider with no leaf, a made-up leaf).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { configCommand } from '../../src/commands/config-cmd.js';
import { getConfigDir, type Config } from '../../src/lib/config.js';

describe('think config set/get — cortex.llm.* (AGT-1327)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-llm-keys-test-'));
    process.env.THINK_HOME = tmpHome;

    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logs.push(String(line)); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // `config set/get` calls process.exit(1) on a rejected key/value — turn
    // that into a throw so a regression surfaces as a failed assertion.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeProgram(): Command {
    const prog = new Command();
    prog.addCommand(configCommand);
    return prog;
  }

  async function set(key: string, value: string): Promise<void> {
    await makeProgram().parseAsync(['node', 'think', 'config', 'set', key, value]);
  }

  async function get(key: string): Promise<void> {
    await makeProgram().parseAsync(['node', 'think', 'config', 'get', key]);
  }

  function readPersistedConfig(): Config {
    const configPath = join(getConfigDir(), 'config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Config;
  }

  // -------------------------------------------------------------------------
  // AC1 / AC5 — nested set/get, intermediate object creation
  // -------------------------------------------------------------------------

  it('creates cortex, cortex.llm, cortex.llm.providers and the named provider from nothing', async () => {
    expect(existsSync(join(getConfigDir(), 'config.json'))).toBe(false);

    await set('cortex.llm.providers.localqwen.model', 'Qwen3-Coder-30B-A3B-Instruct-8bit');

    const persisted = readPersistedConfig();
    expect(persisted.cortex?.llm?.providers?.localqwen?.model).toBe('Qwen3-Coder-30B-A3B-Instruct-8bit');
  });

  it('reads a nested provider leaf back with config get', async () => {
    await set('cortex.llm.providers.localqwen.model', 'Qwen3-Coder-30B-A3B-Instruct-8bit');
    logs = [];

    await get('cortex.llm.providers.localqwen.model');

    expect(logs.join('\n')).toContain('Qwen3-Coder-30B-A3B-Instruct-8bit');
  });

  it('prints the resulting provider block after a successful provider set', async () => {
    await set('cortex.llm.providers.localqwen.endpoint', 'http://127.0.0.1:8000/v1');
    await set('cortex.llm.providers.localqwen.model', 'Qwen3-Coder-30B-A3B-Instruct-8bit');
    logs = [];

    await set('cortex.llm.providers.localqwen.kind', 'openai');

    const out = logs.join('\n');
    expect(out).toContain('"kind": "openai"');
    expect(out).toContain('"endpoint": "http://127.0.0.1:8000/v1"');
    expect(out).toContain('"model": "Qwen3-Coder-30B-A3B-Instruct-8bit"');
  });

  it('sets a second provider without disturbing the first', async () => {
    await set('cortex.llm.providers.localqwen.model', 'qwen-model');
    await set('cortex.llm.providers.claude.kind', 'anthropic');

    const persisted = readPersistedConfig();
    expect(persisted.cortex?.llm?.providers?.localqwen?.model).toBe('qwen-model');
    expect(persisted.cortex?.llm?.providers?.claude?.kind).toBe('anthropic');
  });

  // -------------------------------------------------------------------------
  // AC4 — daemon-restart note
  // -------------------------------------------------------------------------

  it('notes that the daemon must be restarted after a provider set', async () => {
    await set('cortex.llm.providers.localqwen.model', 'qwen-model');
    expect(logs.join('\n')).toContain('think daemon stop && think daemon start');
  });

  it('notes that the daemon must be restarted after a fallback set', async () => {
    await set('cortex.llm.fallback', 'skip');
    expect(logs.join('\n')).toContain('think daemon stop && think daemon start');
  });

  // -------------------------------------------------------------------------
  // AC2 — per-leaf validation. Invalid → error, nothing written, exit 1.
  // -------------------------------------------------------------------------

  it('rejects an unknown kind and writes nothing', async () => {
    await expect(set('cortex.llm.providers.localqwen.kind', 'ollama'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be one of: openai, anthropic/);
    expect(existsSync(join(getConfigDir(), 'config.json'))).toBe(false);
  });

  it('accepts both known kinds', async () => {
    await set('cortex.llm.providers.a.kind', 'openai');
    await set('cortex.llm.providers.b.kind', 'anthropic');
    const persisted = readPersistedConfig();
    expect(persisted.cortex?.llm?.providers?.a?.kind).toBe('openai');
    expect(persisted.cortex?.llm?.providers?.b?.kind).toBe('anthropic');
  });

  it('rejects a non-URL endpoint', async () => {
    await expect(set('cortex.llm.providers.localqwen.endpoint', 'not-a-url'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be a valid URL/);
  });

  it('rejects a non-http(s) endpoint scheme', async () => {
    await expect(set('cortex.llm.providers.localqwen.endpoint', 'ftp://example.com'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be an http:\/\/ or https:\/\/ URL/);
  });

  it('accepts a valid http endpoint', async () => {
    await set('cortex.llm.providers.localqwen.endpoint', 'http://127.0.0.1:8000/v1');
    expect(readPersistedConfig().cortex?.llm?.providers?.localqwen?.endpoint).toBe('http://127.0.0.1:8000/v1');
  });

  it('rejects an empty model', async () => {
    await expect(set('cortex.llm.providers.localqwen.model', ''))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be a non-empty string/);
  });

  it('rejects an empty apiKeyEnv', async () => {
    await expect(set('cortex.llm.providers.localqwen.apiKeyEnv', '   '))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be a non-empty string/);
  });

  it('accepts a non-empty apiKeyEnv', async () => {
    await set('cortex.llm.providers.deepseek.apiKeyEnv', 'DEEPSEEK_API_KEY');
    expect(readPersistedConfig().cortex?.llm?.providers?.deepseek?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
  });

  it('rejects a non-boolean offMachine', async () => {
    await expect(set('cortex.llm.providers.localqwen.offMachine', 'yes'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be "true" or "false"/);
  });

  it('coerces offMachine/disableThinking to real booleans', async () => {
    await set('cortex.llm.providers.localqwen.offMachine', 'false');
    await set('cortex.llm.providers.localqwen.disableThinking', 'true');
    const persisted = readPersistedConfig();
    expect(persisted.cortex?.llm?.providers?.localqwen?.offMachine).toBe(false);
    expect(persisted.cortex?.llm?.providers?.localqwen?.disableThinking).toBe(true);
  });

  it('rejects a non-integer ctxBudget', async () => {
    await expect(set('cortex.llm.providers.localqwen.ctxBudget', '30k'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be a positive integer/);
  });

  it('rejects a zero timeoutMs', async () => {
    await expect(set('cortex.llm.providers.localqwen.timeoutMs', '0'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be a positive integer/);
  });

  it('coerces ctxBudget/timeoutMs to real numbers', async () => {
    await set('cortex.llm.providers.localqwen.ctxBudget', '32000');
    await set('cortex.llm.providers.localqwen.timeoutMs', '900000');
    const persisted = readPersistedConfig();
    expect(persisted.cortex?.llm?.providers?.localqwen?.ctxBudget).toBe(32000);
    expect(persisted.cortex?.llm?.providers?.localqwen?.timeoutMs).toBe(900000);
  });

  // -------------------------------------------------------------------------
  // fallback — provider name or 'skip' sentinel
  // -------------------------------------------------------------------------

  it('accepts fallback = "skip" with no providers configured', async () => {
    await set('cortex.llm.fallback', 'skip');
    expect(readPersistedConfig().cortex?.llm?.fallback).toBe('skip');
  });

  it('accepts fallback naming a registered provider', async () => {
    await set('cortex.llm.providers.claude.kind', 'anthropic');
    await set('cortex.llm.fallback', 'claude');
    expect(readPersistedConfig().cortex?.llm?.fallback).toBe('claude');
  });

  it('rejects fallback naming an unregistered provider and writes nothing', async () => {
    await set('cortex.llm.providers.claude.kind', 'anthropic');
    logs = [];
    await expect(set('cortex.llm.fallback', 'nonexistent'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must name a registered provider \(claude\) or "skip"/);
    expect(readPersistedConfig().cortex?.llm?.fallback).toBeUndefined();
  });

  it('prints the top-level llm block after a fallback set', async () => {
    await set('cortex.llm.providers.claude.kind', 'anthropic');
    await set('cortex.llm.fallback', 'claude');
    expect(logs.join('\n')).toContain('"fallback": "claude"');
  });

  // -------------------------------------------------------------------------
  // AC3 — unknown cortex.llm.* leaves still error
  // -------------------------------------------------------------------------

  it('rejects cortex.llm.default (out of scope) listing the accepted leaves', async () => {
    await expect(set('cortex.llm.default', 'localqwen'))
      .rejects.toThrow(/process\.exit\(1\)/);
    const out = logs.join('\n');
    expect(out).toMatch(/Unknown config key: cortex\.llm\.default/);
    expect(out).toContain('cortex.llm.fallback');
    expect(out).toContain('cortex.llm.providers.<name>.');
  });

  it('rejects cortex.llm.operations.<op> (out of scope)', async () => {
    await expect(set('cortex.llm.operations.summary', 'localqwen'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key/);
  });

  it('rejects a bare provider path with no leaf', async () => {
    await expect(set('cortex.llm.providers.localqwen', 'x'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key/);
  });

  it('rejects a made-up provider leaf', async () => {
    await expect(set('cortex.llm.providers.localqwen.bogus', 'x'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key/);
  });

  it('config get on an unknown cortex.llm.* leaf also errors', async () => {
    await expect(get('cortex.llm.default'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key: cortex\.llm\.default/);
  });

  it('config get on a valid-but-unset leaf reports "not set", not an error', async () => {
    await get('cortex.llm.providers.localqwen.model');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('is not set');
  });

  // -------------------------------------------------------------------------
  // cortex.llmConsent — the real consent key (a flat CortexConfig field,
  // NOT nested under cortex.llm — see lib/config.ts and lib/llm-consent.ts).
  // -------------------------------------------------------------------------

  it('sets and reads back cortex.llmConsent', async () => {
    await set('cortex.llmConsent', 'true');
    expect(readPersistedConfig().cortex?.llmConsent).toBe(true);

    logs = [];
    await get('cortex.llmConsent');
    expect(logs.join('\n')).toContain('true');
  });

  it('rejects a non-boolean cortex.llmConsent and writes nothing', async () => {
    await expect(set('cortex.llmConsent', 'yes'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/must be "true" or "false"/);
    expect(existsSync(join(getConfigDir(), 'config.json'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Flat keys still work unchanged (`config get` is new; sanity-check it).
  // -------------------------------------------------------------------------

  it('config get still rejects a genuinely unknown flat key', async () => {
    await expect(get('cortex.notARealKey'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key/);
  });

  it('config get reads back an ordinary flat key', async () => {
    await set('cortex.author', 'matt');
    logs = [];
    await get('cortex.author');
    expect(logs.join('\n')).toContain('matt');
  });

  // -------------------------------------------------------------------------
  // Security (stamp review r1)
  // -------------------------------------------------------------------------

  it('rejects a __proto__ provider name as an unknown key rather than polluting Object.prototype', async () => {
    await expect(set('cortex.llm.providers.__proto__.kind', 'openai'))
      .rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key/);
    // eslint-disable-next-line no-prototype-builtins
    expect(({} as Record<string, unknown>).kind).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'kind')).toBe(false);
  });

  it('rejects constructor/prototype provider names the same way', async () => {
    await expect(set('cortex.llm.providers.constructor.kind', 'openai'))
      .rejects.toThrow(/process\.exit\(1\)/);
    await expect(set('cortex.llm.providers.prototype.kind', 'openai'))
      .rejects.toThrow(/process\.exit\(1\)/);
  });

  it('redacts a previously-set apiKey in the printed block when a different leaf is updated', async () => {
    await set('cortex.llm.providers.localqwen.apiKey', 'sk-super-secret');
    logs = [];

    await set('cortex.llm.providers.localqwen.model', 'qwen-model');

    const out = logs.join('\n');
    expect(out).not.toContain('sk-super-secret');
    expect(out).toContain('"apiKey": "<redacted>"');
    // The value really is preserved on disk — only the echo is masked.
    expect(readPersistedConfig().cortex?.llm?.providers?.localqwen?.apiKey).toBe('sk-super-secret');
  });

  it('redacts apiKey inside every provider when printing the top-level llm block for fallback', async () => {
    await set('cortex.llm.providers.claude.kind', 'anthropic');
    await set('cortex.llm.providers.claude.apiKey', 'sk-another-secret');
    logs = [];

    await set('cortex.llm.fallback', 'claude');

    const out = logs.join('\n');
    expect(out).not.toContain('sk-another-secret');
    expect(out).toContain('"apiKey": "<redacted>"');
  });

  it('still shows the confirmation line in full when apiKey itself is the leaf being set', async () => {
    await set('cortex.llm.providers.localqwen.apiKey', 'sk-first-set');
    // The top confirmation ("✓ key = value") echoes the value just set —
    // that's the leaf the user is actively changing, not incidental spill.
    expect(logs.join('\n')).toContain('sk-first-set');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { initCommand } from '../../src/commands/init.js';

const BEGIN_MARKER = '<!-- think:begin (managed by `think init` — do not edit between markers) -->';
const END_MARKER = '<!-- think:end -->';

describe('think init — scoped marker block', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-project-'));
    prevHome = process.env.HOME;
    process.env.HOME = homeRoot;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    vi.restoreAllMocks();
  });

  function run(): Promise<void> {
    return initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
  }

  function readClaude(): string {
    return readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
  }

  function writeOteamConfig(body: unknown): void {
    const dir = path.join(homeRoot, '.open-team');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify(body), 'utf-8');
  }

  it('creates CLAUDE.md with begin/end markers on a fresh install', async () => {
    await run();
    const content = readClaude();
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('# Work Logging');
    expect(content.indexOf(BEGIN_MARKER)).toBeLessThan(content.indexOf(END_MARKER));
  });

  it('omits the oteam line when no oteam config is present', async () => {
    await run();
    expect(readClaude()).not.toContain('oteam assign');
  });

  it('includes the oteam line when ~/.open-team/config.json has at least one workspace', async () => {
    writeOteamConfig({ workspaces: { foo: '/tmp/foo' }, default: 'foo' });
    await run();
    const content = readClaude();
    expect(content).toContain('think recall');
    expect(content).toContain('oteam assign');
    expect(content).toContain('think sync');
  });

  it('also accepts the legacy `vaults` config key', async () => {
    writeOteamConfig({ vaults: { foo: '/tmp/foo' }, default: 'foo' });
    await run();
    expect(readClaude()).toContain('oteam assign');
  });

  it('treats an empty workspaces map as "no oteam"', async () => {
    writeOteamConfig({ workspaces: {} });
    await run();
    expect(readClaude()).not.toContain('oteam assign');
  });

  it('treats malformed config.json as "no oteam" (no throw)', async () => {
    const dir = path.join(homeRoot, '.open-team');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf-8');
    await run();
    expect(readClaude()).not.toContain('oteam assign');
  });

  it('is idempotent across re-runs (no growth, no diff outside markers)', async () => {
    await run();
    const first = readClaude();
    await run();
    const second = readClaude();
    expect(second).toEqual(first);
  });

  it('replaces only content between markers, preserving surrounding text', async () => {
    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const before = '# My existing rules\n\nDo not delete me.\n\n';
    const after = '\n## Trailing section\n\nKeep me too.\n';
    writeFileSync(
      claudePath,
      `${before}${BEGIN_MARKER}\n# Work Logging\n\nstale body\n${END_MARKER}\n${after}`,
      'utf-8',
    );

    await run();
    const content = readClaude();
    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
    expect(content).not.toContain('stale body');
    expect(content).toContain('**After every commit');
  });

  it('migrates a legacy unscoped block in place and leaves a notice', async () => {
    const logs: string[] = [];
    (console.log as unknown as { mockImplementation: (fn: (...a: unknown[]) => void) => void }).mockImplementation(
      (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      },
    );

    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const userContent = '# My personal preferences\n\nbe terse.\n\n';
    const legacyBody = `# Work Logging

**After every commit, push, do the thing.**

think sync "summary"
`;
    writeFileSync(claudePath, userContent + legacyBody, 'utf-8');

    await run();
    const content = readClaude();
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('be terse.');
    // Legacy variant text should be gone — replaced by the canonical block.
    expect(content).not.toContain('do the thing');
    // Exactly one Work Logging heading after migration (the canonical one).
    expect(content.match(/# Work Logging/g)?.length).toBe(1);

    expect(logs.some((l) => l.toLowerCase().includes('migrated'))).toBe(true);
  });

  it('writes AGENTS.md only when it already exists', async () => {
    await run();
    expect(existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(false);

    // Now seed AGENTS.md and re-run.
    writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Existing agents file\n', 'utf-8');
    await run();
    const agents = readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# Existing agents file');
    expect(agents).toContain(BEGIN_MARKER);
    expect(agents).toContain(END_MARKER);
  });
});

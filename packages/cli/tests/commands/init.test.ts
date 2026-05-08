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

const RETRO_BEGIN_MARKER = '<!-- think:retro:begin (managed by `think init --retro` — do not edit between markers) -->';
const RETRO_END_MARKER = '<!-- think:retro:end -->';

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

  it('includes the iterative-learning and retro-read sections with generic <repo-basename> placeholder', async () => {
    await run();
    const content = readClaude();
    expect(content).toContain('# Iterative Learning');
    expect(content).toContain('# Reading retros at task start');
    expect(content).toContain('think retro "<observation>" --cortex <repo-basename>');
    expect(content).toContain('think brief --cortex <repo-basename>');
    // No specific cortex baked into the base block — that's the per-repo block's job.
    expect(content).not.toContain('--cortex fx-tracker');
  });

  it('orders sections worklog → (oteam line if present) → retro inside the markers', async () => {
    writeOteamConfig({ workspaces: { foo: '/tmp/foo' } });
    await run();
    const content = readClaude();
    const worklogIdx = content.indexOf('# Work Logging');
    const oteamIdx = content.indexOf('Under an `oteam` workspace');
    const iterativeIdx = content.indexOf('# Iterative Learning');
    const readIdx = content.indexOf('# Reading retros at task start');
    expect(worklogIdx).toBeGreaterThan(-1);
    expect(oteamIdx).toBeGreaterThan(worklogIdx);
    expect(iterativeIdx).toBeGreaterThan(oteamIdx);
    expect(readIdx).toBeGreaterThan(iterativeIdx);
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

  it('migrates a legacy unscoped block in place, writes a backup, and prints a notice', async () => {
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const userContent = '# My personal preferences\n\nbe terse.\n\n';
    const legacyBody = `# Work Logging

**After every commit, push, do the thing.**

think sync "summary"
`;
    const original = userContent + legacyBody;
    writeFileSync(claudePath, original, 'utf-8');

    await run();
    const content = readClaude();
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('be terse.');
    // Legacy variant text should be gone — replaced by the canonical block.
    expect(content).not.toContain('do the thing');
    // Exactly one Work Logging heading after migration (the canonical one).
    expect(content.match(/# Work Logging/g)?.length).toBe(1);

    // Backup file present, byte-equal to pre-migration contents.
    const backupPath = claudePath + '.think-backup';
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf-8')).toEqual(original);

    expect(logs.some((l) => l.toLowerCase().includes('migrated'))).toBe(true);
    expect(logs.some((l) => l.includes('.think-backup'))).toBe(true);
  });

  it('preserves trailing sections after a migrated legacy block', async () => {
    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const trailing = '# Other section\n\nkeep me.\n';
    writeFileSync(
      claudePath,
      `# Work Logging\n\n**After every commit, do X.**\n\nthink sync "x"\n\n${trailing}`,
      'utf-8',
    );

    await run();
    const content = readClaude();
    expect(content).toContain(trailing);
    expect(content).toContain(BEGIN_MARKER);
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

describe('think init --retro — iterative-learning block', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;
  let prevExit: typeof process.exit;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-project-'));
    prevHome = process.env.HOME;
    process.env.HOME = homeRoot;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prevExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    process.exit = prevExit;
    vi.restoreAllMocks();
  });

  function runRetro(cortex: string): Promise<void> {
    return initCommand.parseAsync(
      ['--dir', projectDir, '--yes', '--retro', '--cortex', cortex],
      { from: 'user' },
    );
  }

  function runWorklog(): Promise<void> {
    return initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
  }

  function readClaude(): string {
    return readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
  }

  it('creates CLAUDE.md with retro markers and bakes the cortex name into both commands', async () => {
    await runRetro('fx-tracker');
    const content = readClaude();
    expect(content).toContain(RETRO_BEGIN_MARKER);
    expect(content).toContain(RETRO_END_MARKER);
    expect(content).toContain('# Iterative Learning');
    expect(content).toContain('think brief --cortex fx-tracker');
    expect(content).toContain('think retro "<observation>" --cortex fx-tracker');
    expect(content.indexOf(RETRO_BEGIN_MARKER)).toBeLessThan(content.indexOf(RETRO_END_MARKER));
  });

  it('is idempotent across re-runs', async () => {
    await runRetro('my-repo');
    const first = readClaude();
    await runRetro('my-repo');
    const second = readClaude();
    expect(second).toEqual(first);
    expect((second.match(/think:retro:begin/g) ?? []).length).toBe(1);
    expect((second.match(/think:retro:end/g) ?? []).length).toBe(1);
  });

  it('updates the cortex name in place when re-run with a different value', async () => {
    await runRetro('old-cortex');
    expect(readClaude()).toContain('think brief --cortex old-cortex');

    await runRetro('new-cortex');
    const content = readClaude();
    expect(content).toContain('think brief --cortex new-cortex');
    expect(content).toContain('think retro "<observation>" --cortex new-cortex');
    expect(content).not.toContain('old-cortex');
    // Still exactly one retro block.
    expect((content.match(/think:retro:begin/g) ?? []).length).toBe(1);
  });

  it('coexists with the work-logging block (both managed independently)', async () => {
    await runWorklog();
    await runRetro('fx-tracker');

    const content = readClaude();
    // Both blocks present.
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain(RETRO_BEGIN_MARKER);
    expect(content).toContain(RETRO_END_MARKER);
    expect(content).toContain('# Work Logging');
    expect(content).toContain('# Iterative Learning');
    expect(content).toContain('think brief --cortex fx-tracker');

    // Re-running the work-log path leaves the retro block untouched.
    const before = content;
    await runWorklog();
    const after = readClaude();
    expect(after).toEqual(before);

    // Re-running the retro path leaves the work-log block untouched.
    await runRetro('fx-tracker');
    expect(readClaude()).toEqual(before);
  });

  it('creates CLAUDE.md when missing (file did not exist before retro init)', async () => {
    expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
    await runRetro('greenfield');
    expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
    const content = readClaude();
    expect(content).toContain(RETRO_BEGIN_MARKER);
    expect(content).toContain('think brief --cortex greenfield');
  });

  it('errors clearly and exits non-zero when --retro is passed without --cortex', async () => {
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await expect(
      initCommand.parseAsync(['--dir', projectDir, '--yes', '--retro'], { from: 'user' }),
    ).rejects.toThrow('process.exit:1');

    const joined = errors.join('\n');
    expect(joined).toContain('--cortex');
    expect(joined).toMatch(/required/i);
    // CLAUDE.md should not have been written.
    expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
  });

  it('errors when --cortex is passed without --retro', async () => {
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await expect(
      initCommand.parseAsync(
        ['--dir', projectDir, '--yes', '--cortex', 'foo'],
        { from: 'user' },
      ),
    ).rejects.toThrow('process.exit:1');

    expect(errors.join('\n')).toContain('--cortex is only meaningful with --retro');
  });

  it('writes the retro block to AGENTS.md when it already exists', async () => {
    writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Existing agents file\n', 'utf-8');
    await runRetro('fx-tracker');
    const agents = readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# Existing agents file');
    expect(agents).toContain(RETRO_BEGIN_MARKER);
    expect(agents).toContain('think brief --cortex fx-tracker');
  });

  it('does not run legacy work-log migration on the retro path', async () => {
    // Seed CLAUDE.md with content that would trigger the legacy work-log
    // migration heuristic. The retro path must ignore it: no `.think-backup`
    // file, no work-log markers added.
    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const seeded = `# My personal preferences\n\nbe terse.\n\n# Work Logging\n\n**After every commit, do X.**\n\nthink sync "x"\n`;
    writeFileSync(claudePath, seeded, 'utf-8');

    await runRetro('fx-tracker');

    const content = readClaude();
    // Legacy block left exactly as-is.
    expect(content).toContain('**After every commit, do X.**');
    // Retro block appended.
    expect(content).toContain(RETRO_BEGIN_MARKER);
    // No work-log markers were inserted.
    expect(content).not.toContain(BEGIN_MARKER);
    // No backup file was written by the retro path.
    expect(existsSync(claudePath + '.think-backup')).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
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
    // AGT-067: WORKLOG_BLOCK reframed from "After every commit, push, …
    // this is not optional" to a minimum-necessary-shaped "After
    // shipping a change … run think sync to record the outcome".
    expect(content).toContain('After shipping a change');
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

describe('think init --retro — directory resolution (AC #6)', () => {
  let homeRoot: string;
  let prevHome: string | undefined;
  let prevCwd: string;
  let prevExit: typeof process.exit;
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-retro-dir-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = homeRoot;
    prevCwd = process.cwd();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prevExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit;
    tempDir1 = '';
    tempDir2 = '';
  });

  afterEach(() => {
    // Restore cwd BEFORE rmSync so we're never trying to remove the current dir.
    process.chdir(prevCwd);
    if (tempDir1) rmSync(tempDir1, { recursive: true, force: true });
    if (tempDir2) rmSync(tempDir2, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    process.exit = prevExit;
    vi.restoreAllMocks();
  });

  it('--retro no -d inside a git repo writes to git toplevel without prompting', async () => {
    tempDir1 = mkdtempSync(path.join(tmpdir(), 'think-retro-git-'));
    execSync('git init', { cwd: tempDir1, stdio: 'ignore' });
    process.chdir(tempDir1);

    await initCommand.parseAsync(['--retro', '--cortex', 'my-repo'], { from: 'user' });

    const claudePath = path.join(tempDir1, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toContain('think brief --cortex my-repo');
  });

  it('--retro no -d outside a git repo with --yes resolves to cwd', async () => {
    tempDir1 = mkdtempSync(path.join(tmpdir(), 'think-retro-nogit-'));
    process.chdir(tempDir1);

    await initCommand.parseAsync(['--retro', '--cortex', 'my-repo', '--yes'], { from: 'user' });

    // File should land in the actual cwd (tempDir1), not in $HOME.
    const resolvedCwd = process.cwd();
    const claudePath = path.join(resolvedCwd, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toContain('think brief --cortex my-repo');
    expect(existsSync(path.join(homeRoot, 'CLAUDE.md'))).toBe(false);
  });

  it('--retro with explicit -d honors the override regardless of git state', async () => {
    tempDir1 = mkdtempSync(path.join(tmpdir(), 'think-retro-explicit-'));

    await initCommand.parseAsync(
      ['--retro', '--cortex', 'my-repo', '--dir', tempDir1],
      { from: 'user' },
    );

    const claudePath = path.join(tempDir1, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toContain('think brief --cortex my-repo');
  });

  it('base think init (no --retro) with --yes still uses $HOME, not cwd', async () => {
    tempDir1 = mkdtempSync(path.join(tmpdir(), 'think-base-init-'));
    process.chdir(tempDir1);

    await initCommand.parseAsync(['--yes'], { from: 'user' });

    expect(existsSync(path.join(homeRoot, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(path.join(tempDir1, 'CLAUDE.md'))).toBe(false);
  });
});

// AGT-067: --minimal flag writes a conservative work-log template; --yes
// skips the new disclosure prompt; --minimal and --retro are mutually
// exclusive; the new default template carries the privacy disclosure
// paragraph naming the engrams → curation → Anthropic data flow.
describe('think init — minimum-necessary defaults + --minimal flag (AGT-067)', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-067-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-067-project-'));
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

  function readClaude(): string {
    return readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
  }

  it('--minimal writes the minimal template (no decision narration, no oteam adaptation, no retro pattern)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });

    const content = readClaude();
    expect(content).toContain('# Work Logging (minimal)');
    expect(content).toContain('When you ship a change, log the outcome');
    // No decision-narration example
    expect(content).not.toContain('Decided against X because Y');
    // No retro pattern in minimal template
    expect(content).not.toContain('# Iterative Learning');
    // No oteam adaptation in minimal template
    expect(content).not.toContain('Under an `oteam` workspace');
  });

  it('default template (no --minimal) includes the privacy disclosure paragraph (AC #2)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });

    const content = readClaude();
    expect(content).toContain('Privacy: where these entries go');
    expect(content).toContain('THINK_LLM_CONSENT');
    expect(content).toContain('cortex.llmConsent');
    // Reframed away from over-collection — old framing should be gone
    expect(content).not.toContain('this is not optional');
    expect(content).not.toContain('non-trivial tool-assisted action');
    // New "shipped outcomes" framing should be present
    expect(content).toContain('After shipping a change');
  });

  it('--minimal and --retro are mutually exclusive', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(
      initCommand.parseAsync(['--dir', projectDir, '--minimal', '--retro', '--cortex', 'foo'], { from: 'user' }),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
    exitSpy.mockRestore();
  });

  it('--minimal skips the disclosure prompt (AC #3 bypass) and writes silently', async () => {
    // Without --yes or --minimal we'd hit the disclosure prompt — which would
    // hang in a non-TTY test. --minimal is one of the documented bypass paths;
    // confirming the file lands without any prompt interaction.
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });
    expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
  });

  it('--yes (existing flag) skips the disclosure prompt and writes the new default template (AC #5)', async () => {
    // Pre-AGT-067 callers passing --yes got the maximal "every meaningful
    // action" template. Post-AGT-067 they get the new minimum-necessary
    // default (still skipping the prompt, but with the toned-down framing).
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });

    const content = readClaude();
    expect(content).toContain('After shipping a change');
    expect(content).not.toContain('this is not optional');
  });

  it('--minimal is idempotent across re-runs — block markers wrap the body so upsert replaces in place', async () => {
    // Round-1 stamp review caught this: pre-fix, MINIMAL_WORKLOG_BLOCK
    // returned without BEGIN/END_MARKER wrapping, so each `--minimal`
    // re-run appended a fresh block. Now markered, upsert replaces.
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });

    const content = readClaude();
    const headerCount = (content.match(/# Work Logging \(minimal\)/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('switching --minimal ↔ default replaces the block in place (no duplicate sections)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });

    const content = readClaude();
    // After switching, only the default-template header should remain;
    // the minimal header is replaced (not appended alongside).
    expect(content).not.toContain('# Work Logging (minimal)');
    expect(content).toContain('# Work Logging\n');
    expect(content).toContain('After shipping a change');
  });
});

// AGT-321: v3 block detection, --version flag, daemon-reachability fallback.
describe('think init — v3 block (AGT-321)', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-v3-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-v3-project-'));
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

  function readClaude(): string {
    return readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
  }

  it('--block-version v3 writes v3 block even when daemon is unreachable', async () => {
    // No daemon running in test env; --version v3 forces v3 regardless.
    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v3'], { from: 'user' });
    const content = readClaude();
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('# think v3');
    expect(content).toContain('think_recall');
    expect(content).toContain('think sync');
    expect(content).toContain('think retro');
    expect(content).toContain('think event');
    // v3 block should not contain the v2-only privacy disclosure
    expect(content).not.toContain('# Work Logging\n');
  });

  it('--block-version v3 block is idempotent (second run does not duplicate)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v3'], { from: 'user' });
    const first = readClaude();
    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v3'], { from: 'user' });
    const second = readClaude();
    expect(second).toEqual(first);
    expect((second.match(/# think v3/g) ?? []).length).toBe(1);
  });

  it('--block-version v2 forces v2 block regardless of daemon state', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v2'], { from: 'user' });
    const content = readClaude();
    expect(content).toContain('# Work Logging');
    expect(content).not.toContain('# think v3');
  });

  it('daemon-unreachable falls back to v2 block (no --block-version flag)', async () => {
    // No daemon running in CI/test — expect v2 fallback.
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    const content = readClaude();
    // v2 block contains "# Work Logging"; v3 block does not.
    expect(content).toContain('# Work Logging');
    expect(content).not.toContain('# think v3');
  });

  it('v3 block contains all three verb descriptions', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v3'], { from: 'user' });
    const content = readClaude();
    // Paragraph (a): implicit recall via hook + MCP
    expect(content).toContain('UserPromptSubmit hook');
    expect(content).toContain('additionalContext');
    expect(content).toContain('think_recall\` MCP tool');
    // Paragraph (b): three verbs
    expect(content).toContain('kind=memory');
    expect(content).toContain('kind=retro');
    expect(content).toContain('kind=event');
    // Paragraph (c): cortex inference
    expect(content).toContain('repo basename');
    expect(content).toContain('--cortex <name>');
  });

  it('v3 block uses the same BEGIN/END markers (idempotent replace with v2)', async () => {
    // Write v2 first, then upgrade to v3 — markers must allow in-place replace.
    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v2'], { from: 'user' });
    expect(readClaude()).toContain('# Work Logging');

    await initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v3'], { from: 'user' });
    const content = readClaude();
    expect(content).toContain('# think v3');
    // Only one begin marker — replaced, not appended.
    expect((content.match(/think:begin/g) ?? []).length).toBe(1);
    expect((content.match(/think:end/g) ?? []).length).toBe(1);
  });

  it('--retro --cortex still works unchanged alongside v3 detection', async () => {
    // retro path should be unaffected by v3 changes
    await initCommand.parseAsync(
      ['--dir', projectDir, '--yes', '--retro', '--cortex', 'my-repo'],
      { from: 'user' },
    );
    const content = readClaude();
    expect(content).toContain(RETRO_BEGIN_MARKER);
    expect(content).toContain('think brief --cortex my-repo');
    expect(content).toContain('think retro "<observation>" --cortex my-repo');
  });

  it('invalid --block-version value exits with error', async () => {
    const prevExit = process.exit;
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await expect(
        initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v4'], { from: 'user' }),
      ).rejects.toThrow('process.exit:1');
      expect(errors.join('\n')).toContain("--block-version must be 'v2' or 'v3'");
    } finally {
      process.exit = prevExit;
    }
  });

  it('--minimal and --block-version are mutually exclusive', async () => {
    const prevExit = process.exit;
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await expect(
        initCommand.parseAsync(['--dir', projectDir, '--yes', '--minimal', '--block-version', 'v3'], { from: 'user' }),
      ).rejects.toThrow('process.exit:1');
      expect(errors.join('\n')).toContain('--minimal and --block-version are mutually exclusive');
    } finally {
      process.exit = prevExit;
    }
  });

  it('--retro and --block-version are mutually exclusive', async () => {
    const prevExit = process.exit;
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await expect(
        initCommand.parseAsync(['--dir', projectDir, '--yes', '--retro', '--cortex', 'my-repo', '--block-version', 'v3'], { from: 'user' }),
      ).rejects.toThrow('process.exit:1');
      expect(errors.join('\n')).toContain('--block-version has no effect with --retro');
    } finally {
      process.exit = prevExit;
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import {
  initCommand,
  DISCLOSURE_YELLOW_LINES,
  DISCLOSURE_DIM_LINES,
} from '../../src/commands/init.js';

// AGT-1300 (think-3): vocabulary retired with the engram tier / curator.
// Must not appear in any managed template or in the interactive disclosure
// copy — see the "forbidden vocabulary" describe block below.
const FORBIDDEN_STRINGS = ['--decision', 'think curate', 'local event', 'curator consent'];

const BEGIN_MARKER = '<!-- think:begin (managed by `think init` — do not edit between markers) -->';
const END_MARKER = '<!-- think:end -->';

const RETRO_BEGIN_MARKER = '<!-- think:retro:begin (managed by `think init --retro` — do not edit between markers) -->';
const RETRO_END_MARKER = '<!-- think:retro:end -->';

/**
 * Extract the managed span delimited by `beginMarker`/`endMarker` (markers
 * included), or `null` when the pair is missing or inverted.
 *
 * Returning `null` rather than `''` is what keeps a byte-identity assertion
 * honest: two files that both *lack* the block would otherwise yield equal
 * empty strings and pass a comparison that proves nothing.
 */
function extractManagedSpan(
  content: string,
  beginMarker: string,
  endMarker: string,
): string | null {
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return content.slice(beginIdx, endIdx + endMarker.length);
}

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

  it('creates CLAUDE.md with begin/end markers on a fresh install', async () => {
    await run();
    const content = readClaude();
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('# Work Logging');
    expect(content.indexOf(BEGIN_MARKER)).toBeLessThan(content.indexOf(END_MARKER));
  });

  it('describes all three write verbs and auto-detects context (no baked cortex)', async () => {
    await run();
    const content = readClaude();
    expect(content).toContain('think sync "<content>"');
    expect(content).toContain('think retro "<content>"');
    expect(content).toContain('think event "<content>"');
    expect(content).toContain('think brief');
    // The base block auto-detects the repo context — no baked cortex/context.
    expect(content).not.toContain('--context fx-tracker');
    expect(content).not.toContain('--cortex fx-tracker');
  });

  it('orders sections hook/verbs → decision example → privacy inside the markers', async () => {
    await run();
    const content = readClaude();
    const headingIdx = content.indexOf('# Work Logging');
    const verbsIdx = content.indexOf('Three verbs for writing');
    const decisionIdx = content.indexOf('Log a decision with `think event`');
    const privacyIdx = content.indexOf('Privacy: what leaves the machine');
    expect(headingIdx).toBeGreaterThan(-1);
    expect(verbsIdx).toBeGreaterThan(headingIdx);
    expect(decisionIdx).toBeGreaterThan(verbsIdx);
    expect(privacyIdx).toBeGreaterThan(decisionIdx);
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
    // AGT-1300: WORKLOG_BLOCK collapsed onto the single (formerly "v3")
    // shape — hook/MCP recall note plus the three write verbs.
    expect(content).toContain('Three verbs for writing');
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

  // AGT-1300: `think init` used to probe `$HOME/.think/daemon.sock`
  // (`isV3DaemonReachable`) and write a different template depending on
  // whether the daemon answered. That probe is deleted — this pins the
  // observable behavior that motivated deleting it: the block written does
  // not depend on daemon reachability at all.
  it('writes the same block whether or not a daemon socket is present', async () => {
    await run();
    const withoutSocket = readClaude();

    // Simulate what the old isV3DaemonReachable() treated as "daemon up":
    // a live socket at $HOME/.think/daemon.sock. think init no longer reads
    // this path at all; recreating it here proves that, rather than just
    // asserting on the absence of the deleted function.
    const thinkDir = path.join(homeRoot, '.think');
    mkdirSync(thinkDir, { recursive: true });
    writeFileSync(path.join(thinkDir, 'daemon.sock'), '');

    await run();
    const withSocket = readClaude();

    expect(withSocket).toEqual(withoutSocket);
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
    expect(content).toContain('think brief --context fx-tracker');
    expect(content).toContain('think retro "<observation>" --context fx-tracker');
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
    expect(readClaude()).toContain('think brief --context old-cortex');

    await runRetro('new-cortex');
    const content = readClaude();
    expect(content).toContain('think brief --context new-cortex');
    expect(content).toContain('think retro "<observation>" --context new-cortex');
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
    expect(content).toContain('think brief --context fx-tracker');

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
    expect(content).toContain('think brief --context greenfield');
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
    expect(agents).toContain('think brief --context fx-tracker');
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
    expect(readFileSync(claudePath, 'utf-8')).toContain('think brief --context my-repo');
  });

  it('--retro no -d outside a git repo with --yes resolves to cwd', async () => {
    tempDir1 = mkdtempSync(path.join(tmpdir(), 'think-retro-nogit-'));
    process.chdir(tempDir1);

    await initCommand.parseAsync(['--retro', '--cortex', 'my-repo', '--yes'], { from: 'user' });

    // File should land in the actual cwd (tempDir1), not in $HOME.
    const resolvedCwd = process.cwd();
    const claudePath = path.join(resolvedCwd, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toContain('think brief --context my-repo');
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
    expect(readFileSync(claudePath, 'utf-8')).toContain('think brief --context my-repo');
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

  it('--minimal writes the minimal template (no decision narration, no retro pattern)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });

    const content = readClaude();
    expect(content).toContain('# Work Logging (minimal)');
    expect(content).toContain('When you ship a change, log the outcome');
    // No decision-narration example
    expect(content).not.toContain('Decided against X because Y');
    // No retro pattern in minimal template
    expect(content).not.toContain('# Iterative Learning');
  });

  it('default template (no --minimal) includes the privacy disclosure paragraph (AC #2)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });

    const content = readClaude();
    // AGT-1300: paragraph reframed to name what actually leaves the machine
    // (compaction/supersession through the configured LLM provider), not
    // "the curator".
    expect(content).toContain('Privacy: what leaves the machine');
    expect(content).toContain('Compaction');
    expect(content).toContain('THINK_LLM_CONSENT');
    expect(content).toContain('cortex.llmConsent');
    // Reframed away from over-collection — old framing should be gone
    expect(content).not.toContain('this is not optional');
    expect(content).not.toContain('non-trivial tool-assisted action');
    // New three-verbs framing should be present
    expect(content).toContain('Three verbs for writing');
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
    // action" template. Post-AGT-067/AGT-1300 they get the current
    // minimum-necessary default (still skipping the prompt).
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });

    const content = readClaude();
    expect(content).toContain('Three verbs for writing');
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
    expect(content).toContain('Three verbs for writing');
  });
});

// AGT-1300 (think-3): `think init` used to probe the daemon socket and write
// one of two templates (`v2`/`v3`) depending on reachability, selectable by
// force via `--block-version`. Both the probe and the flag are gone — there
// is exactly one non-minimal template, and user-facing text never says
// "v2"/"v3" (think-3 design doc, decision 5).
describe('think init — one template, --block-version removed (AGT-1300)', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;
  let prevExit: typeof process.exit;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-1300-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-1300-project-'));
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

  function readClaude(): string {
    return readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
  }

  it('the default template contains no "v2"/"v3" user-facing wording', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    const content = readClaude();
    expect(content).not.toMatch(/\bv2\b/i);
    expect(content).not.toMatch(/\bv3\b/i);
    // Shape that used to be gated behind daemon reachability is now always present.
    expect(content).toContain('think_recall');
    expect(content).toContain('UserPromptSubmit hook');
    expect(content).toContain('kind=memory');
    expect(content).toContain('kind=retro');
    expect(content).toContain('kind=event');
  });

  it('passing --block-version exits non-zero with a one-line note, not a generic unknown-option error, and writes nothing', async () => {
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await expect(
      initCommand.parseAsync(['--dir', projectDir, '--yes', '--block-version', 'v3'], { from: 'user' }),
    ).rejects.toThrow('process.exit:1');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--block-version');
    expect(errors[0].toLowerCase()).not.toContain('unknown option');
    expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
  });

  it('--block-version is rejected the same way regardless of value, --minimal, or --retro', async () => {
    for (const args of [
      ['--dir', projectDir, '--yes', '--block-version', 'v2'],
      ['--dir', projectDir, '--minimal', '--block-version', 'v3'],
      ['--dir', projectDir, '--yes', '--retro', '--cortex', 'my-repo', '--block-version', 'v3'],
      ['--dir', projectDir, '--yes', '--block-version', 'bogus'],
    ]) {
      await expect(initCommand.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit:1');
      expect(existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
    }
  });
});

// AGT-1300 (think-3): vocabulary retired with the engram tier / curator must
// not resurface in any managed template or in the interactive disclosure
// copy shown before writing the default template.
describe('think init — forbidden vocabulary is absent everywhere (AGT-1300)', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-vocab-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-vocab-project-'));
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

  it('default template contains none of the forbidden strings, and does carry the exact decision example', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    const content = readClaude();
    for (const s of FORBIDDEN_STRINGS) expect(content).not.toContain(s);
    expect(content).toContain('think event "Decided against X because Y" --silent');
  });

  it('--minimal template contains none of the forbidden strings', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--minimal'], { from: 'user' });
    const content = readClaude();
    for (const s of FORBIDDEN_STRINGS) expect(content).not.toContain(s);
  });

  it('--retro template contains none of the forbidden strings', async () => {
    await initCommand.parseAsync(
      ['--dir', projectDir, '--yes', '--retro', '--cortex', 'fx-tracker'],
      { from: 'user' },
    );
    const content = readClaude();
    for (const s of FORBIDDEN_STRINGS) expect(content).not.toContain(s);
  });

  it('the interactive disclosure copy contains none of the forbidden strings', () => {
    const allLines = [...DISCLOSURE_YELLOW_LINES, ...DISCLOSURE_DIM_LINES].join('\n');
    for (const s of FORBIDDEN_STRINGS) expect(allLines).not.toContain(s);
    // And it should still name the actual data flow.
    expect(allLines).toContain('THINK_LLM_CONSENT');
  });
});

// AGT-1140: `think init` writes its managed block to CLAUDE.md and, when that
// file already exists, to AGENTS.md as well — but nothing asserted the two land
// byte-identical. The invariant has broken in the wild once already: a
// pre-2.3.1 `~/.open-team` probe appended a conditional line to the block, so
// on-disk copies of the two files drifted by three lines. The drift is
// invisible to users because different harnesses read different files — Claude
// Code reads CLAUDE.md, opencode/Cursor read AGENTS.md — so it has to be caught
// here. These tests lock the guarantee across every variant the write path can
// emit. They deliberately assert nothing about the block's *content*, which
// stays free to change; only that whatever is emitted lands in both files
// character for character.
describe('think init — managed block is byte-identical in CLAUDE.md and AGENTS.md (AGT-1140)', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-init-1140-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-init-1140-project-'));
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

  function read(file: string): string {
    return readFileSync(path.join(projectDir, file), 'utf-8');
  }

  const CLAUDE_PREAMBLE = '# Personal preferences\n\nbe terse.\n';
  const AGENTS_PREAMBLE = '# Existing agents file\n';

  function seedBothTargets(): void {
    // Distinct surrounding prose on purpose: it keeps the assertion scoped to
    // the managed span, so an extraction bug that compared whole files (or
    // returned the whole file on a marker miss) fails loudly here.
    writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_PREAMBLE, 'utf-8');
    writeFileSync(path.join(projectDir, 'AGENTS.md'), AGENTS_PREAMBLE, 'utf-8');
  }

  /** Assert both files carry the same span, and return it for variant pinning. */
  function expectSpansIdentical(beginMarker: string, endMarker: string): string {
    const claudeSpan = extractManagedSpan(read('CLAUDE.md'), beginMarker, endMarker);
    const agentsSpan = extractManagedSpan(read('AGENTS.md'), beginMarker, endMarker);

    // Guard before comparing: two missing blocks are both null and would
    // otherwise compare equal.
    expect(claudeSpan).not.toBeNull();
    expect(agentsSpan).not.toBeNull();
    expect(agentsSpan).toBe(claudeSpan);

    // Untouched, still-distinct prose around the block.
    expect(read('CLAUDE.md')).toContain('be terse.');
    expect(read('AGENTS.md')).toContain('# Existing agents file');

    return claudeSpan as string;
  }

  async function runInit(args: string[]): Promise<void> {
    await initCommand.parseAsync(['--dir', projectDir, ...args], { from: 'user' });
  }

  it('default block is byte-identical between the two files', async () => {
    seedBothTargets();
    await runInit(['--yes']);
    const span = expectSpansIdentical(BEGIN_MARKER, END_MARKER);
    // Pin the variant so this case can't silently drift onto another template.
    expect(span).toContain('# Work Logging');
    expect(span).not.toContain('# Work Logging (minimal)');
  });

  it('--minimal block is byte-identical between the two files', async () => {
    seedBothTargets();
    await runInit(['--minimal']);
    const span = expectSpansIdentical(BEGIN_MARKER, END_MARKER);
    expect(span).toContain('# Work Logging (minimal)');
  });

  it('--retro block is byte-identical between the two files', async () => {
    seedBothTargets();
    await runInit(['--yes', '--retro', '--cortex', 'fx-tracker']);
    const span = expectSpansIdentical(RETRO_BEGIN_MARKER, RETRO_END_MARKER);
    expect(span).toContain('think brief --context fx-tracker');
    expect(span).toContain('think retro "<observation>" --context fx-tracker');
  });

  it('stays identical when a re-run replaces an existing block in place', async () => {
    // Replace-in-place is the other half of the write path, and the place a
    // per-target branch would most plausibly diverge: the two files reach the
    // replacement with different `before`/`after` context around the markers.
    // Switching --minimal <-> default is the only remaining in-place swap
    // now that --block-version is gone.
    seedBothTargets();
    await runInit(['--minimal']);
    const minimalSpan = expectSpansIdentical(BEGIN_MARKER, END_MARKER);

    await runInit(['--yes']);
    const defaultSpan = expectSpansIdentical(BEGIN_MARKER, END_MARKER);

    // Sanity: the re-run really did swap the block, so identity above is not
    // just the untouched minimal output being compared to itself.
    expect(defaultSpan).not.toBe(minimalSpan);
    expect(defaultSpan).toContain('# Work Logging');
    expect(defaultSpan).not.toContain('(minimal)');
  });

  it('keeps both blocks identical when the work-log and retro blocks coexist', async () => {
    seedBothTargets();
    await runInit(['--yes']);
    await runInit(['--yes', '--retro', '--cortex', 'fx-tracker']);

    expectSpansIdentical(BEGIN_MARKER, END_MARKER);
    expectSpansIdentical(RETRO_BEGIN_MARKER, RETRO_END_MARKER);
  });

  it('extractManagedSpan has teeth: one differing character fails the comparison', () => {
    // Guards the guarantee itself. If the extractor were lenient (returning ''
    // or the whole file on a marker miss), every case above would pass while
    // the files drifted.
    const body = `${BEGIN_MARKER}\nline one\nline two\n${END_MARKER}`;
    const a = `# preamble a\n\n${body}\n\ntrailing a\n`;
    const b = `# totally different preamble\n\n${body}\n`;
    expect(extractManagedSpan(b, BEGIN_MARKER, END_MARKER)).toBe(
      extractManagedSpan(a, BEGIN_MARKER, END_MARKER),
    );

    const drifted = a.replace('line two', 'line twp');
    expect(extractManagedSpan(drifted, BEGIN_MARKER, END_MARKER)).not.toBe(
      extractManagedSpan(a, BEGIN_MARKER, END_MARKER),
    );

    // A missing marker is null, never an empty string that would compare equal
    // to another missing block.
    expect(extractManagedSpan('no markers here\n', BEGIN_MARKER, END_MARKER)).toBeNull();
    expect(
      extractManagedSpan(`${END_MARKER}\n${BEGIN_MARKER}\n`, BEGIN_MARKER, END_MARKER),
    ).toBeNull();
  });
});

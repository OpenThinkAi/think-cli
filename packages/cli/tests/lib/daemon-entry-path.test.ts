/**
 * Tests for resolveDaemonEntryFromDir + getDaemonEntryPath.
 *
 * Regression coverage for the bundled-dist layout where tsup flattens
 * `src/lib/daemon-client.ts` into `dist/daemon-client-HASH.js` (no `dist/lib/`
 * subdir). The previous implementation walked `../..` from `__dirname` which
 * worked in the unbundled dev layout but overshot the package root once
 * bundled, breaking `think daemon start` on the published alpha.
 *
 * Issue: github.com/OpenThinkAi/think-cli/issues/58
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDaemonEntryFromDir,
  getDaemonEntryPath,
} from '../../src/lib/daemon-client.js';

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), 'think-daemon-entry-test-'));
}

function writeManifest(dir: string, name: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
}

describe('resolveDaemonEntryFromDir', () => {
  let root: string;

  beforeEach(() => {
    root = makeFixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves entry when called from the bundled dist/ layout (thisDir = dist/)', () => {
    // <root>/package.json (@openthink/think)
    // <root>/dist/<bundled file lives here>
    writeManifest(root, '@openthink/think');
    const distDir = join(root, 'dist');
    mkdirSync(distDir);

    expect(resolveDaemonEntryFromDir(distDir)).toBe(join(root, 'dist', 'daemon', 'index.js'));
  });

  it('resolves entry when called from the unbundled dev layout (thisDir = src/lib/)', () => {
    // <root>/package.json (@openthink/think)
    // <root>/src/lib/<source file lives here>
    writeManifest(root, '@openthink/think');
    const srcLib = join(root, 'src', 'lib');
    mkdirSync(srcLib, { recursive: true });

    expect(resolveDaemonEntryFromDir(srcLib)).toBe(join(root, 'dist', 'daemon', 'index.js'));
  });

  it('skips a non-matching package.json when monorepo workspace root sits above', () => {
    // <root>/package.json (some workspace name — must NOT match)
    // <root>/packages/cli/package.json (@openthink/think — should match)
    // <root>/packages/cli/dist/<bundled file>
    writeManifest(root, '@some/workspace');
    const cli = join(root, 'packages', 'cli');
    mkdirSync(cli, { recursive: true });
    writeManifest(cli, '@openthink/think');
    const distDir = join(cli, 'dist');
    mkdirSync(distDir);

    expect(resolveDaemonEntryFromDir(distDir)).toBe(join(cli, 'dist', 'daemon', 'index.js'));
  });

  it('throws a clear error when no @openthink/think manifest is found within walk depth', () => {
    // No package.json at any candidate level — install corrupted.
    const orphan = join(root, 'orphan', 'dir');
    mkdirSync(orphan, { recursive: true });

    expect(() => resolveDaemonEntryFromDir(orphan)).toThrow(/could not locate @openthink\/think package root/);
  });

  it('tolerates an unreadable / non-JSON package.json and keeps walking', () => {
    // <root>/package.json: garbage (not JSON) — should be skipped, not crash
    // <root>/packages/cli/package.json (@openthink/think — match here)
    writeFileSync(join(root, 'package.json'), 'not json at all');
    const cli = join(root, 'packages', 'cli');
    mkdirSync(cli, { recursive: true });
    writeManifest(cli, '@openthink/think');
    const distDir = join(cli, 'dist');
    mkdirSync(distDir);

    expect(resolveDaemonEntryFromDir(distDir)).toBe(join(cli, 'dist', 'daemon', 'index.js'));
  });
});

describe('getDaemonEntryPath', () => {
  it('returns a path ending in dist/daemon/index.js under @openthink/think', () => {
    // Smoke test: in this test runtime, the resolver finds packages/cli/package.json
    // and returns its dist/daemon/index.js.
    const entry = getDaemonEntryPath();
    expect(entry).toMatch(/dist[\\/]daemon[\\/]index\.js$/);
    expect(entry).toContain('packages');
  });
});

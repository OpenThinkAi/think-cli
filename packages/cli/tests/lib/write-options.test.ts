/**
 * Tests for the shared write-options module — AGT-296
 *
 * Verifies:
 *  1. addWriteOptions adds --topic (repeatable) and --cortex to a command
 *  2. extractWriteOpts returns topics array when --topic given, undefined when not
 *  3. extractWriteOpts returns cortex when --cortex given, undefined when not
 *  4. Multiple --topic flags all reach the topics array (AC #6)
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { addWriteOptions, extractWriteOpts } from '../../src/lib/write-options.js';

function makeProgram(): Command {
  const prog = new Command();
  prog.exitOverride(); // prevent process.exit in tests
  const sub = addWriteOptions(new Command('write-test').argument('<msg>', 'message'));
  prog.addCommand(sub);
  return prog;
}

describe('addWriteOptions — option definition', () => {
  it('adds --topic option to the command', () => {
    const cmd = addWriteOptions(new Command('test'));
    const topicOpt = cmd.options.find(o => o.long === '--topic');
    expect(topicOpt).toBeDefined();
  });

  it('adds --cortex option to the command', () => {
    const cmd = addWriteOptions(new Command('test'));
    const cortexOpt = cmd.options.find(o => o.long === '--cortex');
    expect(cortexOpt).toBeDefined();
  });

  it('--topic accumulates into an array via concat reducer', async () => {
    const prog = makeProgram();
    let capturedOpts: { topic: string[]; cortex?: string } | undefined;
    prog.commands[0].action(function (this: Command, _msg: string, opts: { topic: string[]; cortex?: string }) {
      capturedOpts = opts;
    });
    await prog.parseAsync(['node', 'think', 'write-test', 'hello', '--topic', 'auth', '--topic', 'jwt']);
    expect(capturedOpts?.topic).toEqual(['auth', 'jwt']);
  });

  it('--topic defaults to empty array when not provided', async () => {
    const prog = makeProgram();
    let capturedOpts: { topic: string[] } | undefined;
    prog.commands[0].action(function (_msg: string, opts: { topic: string[] }) {
      capturedOpts = opts;
    });
    await prog.parseAsync(['node', 'think', 'write-test', 'hello']);
    expect(capturedOpts?.topic).toEqual([]);
  });

  it('--cortex captures the provided value', async () => {
    const prog = makeProgram();
    let capturedOpts: { topic: string[]; cortex?: string } | undefined;
    prog.commands[0].action(function (_msg: string, opts: { topic: string[]; cortex?: string }) {
      capturedOpts = opts;
    });
    await prog.parseAsync(['node', 'think', 'write-test', 'hello', '--cortex', 'fx-tracker']);
    expect(capturedOpts?.cortex).toBe('fx-tracker');
  });
});

describe('extractWriteOpts', () => {
  it('returns topics array when topics are provided', () => {
    const result = extractWriteOpts({ topic: ['auth', 'jwt'], cortex: undefined });
    expect(result.topics).toEqual(['auth', 'jwt']);
  });

  it('returns undefined for topics when no --topic given', () => {
    const result = extractWriteOpts({ topic: [], cortex: undefined });
    expect(result.topics).toBeUndefined();
  });

  it('returns cortex when provided', () => {
    const result = extractWriteOpts({ topic: [], cortex: 'fx-tracker' });
    expect(result.cortex).toBe('fx-tracker');
  });

  it('returns undefined for cortex when not provided', () => {
    const result = extractWriteOpts({ topic: [], cortex: undefined });
    expect(result.cortex).toBeUndefined();
  });

  it('multiple topics all reach the topics array (AC #6)', () => {
    const result = extractWriteOpts({ topic: ['auth', 'jwt', 'session'], cortex: undefined });
    expect(result.topics).toHaveLength(3);
    expect(result.topics).toContain('auth');
    expect(result.topics).toContain('jwt');
    expect(result.topics).toContain('session');
  });
});

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';

// #96: tests/setup/color-env.ts pins FORCE_COLOR=0 before any test module
// loads, so exact-string output assertions do not depend on the caller's
// shell colour env (e.g. FORCE_COLOR=3 exported by agent shells).
describe('suite colour env (#96)', () => {
  it('pins FORCE_COLOR=0 for every worker', () => {
    expect(process.env.FORCE_COLOR).toBe('0');
  });

  it('leaves chalk emitting plain text', () => {
    expect(chalk.level).toBe(0);
    expect(chalk.red('plain')).toBe('plain');
  });
});

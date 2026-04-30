import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('test runner smoke', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });

  it('has node:sqlite available', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(42);
    const row = db.prepare('SELECT x FROM t').get() as { x: number };
    expect(row.x).toBe(42);
    db.close();
  });
});

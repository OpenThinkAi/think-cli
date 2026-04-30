import { Hono } from 'hono';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { isValidCortexName } from '../lib/cortex-name.js';

const createCortexSchema = z.object({
  name: z.string().min(1).max(64),
});

export const cortex = new Hono();

cortex.get('/v1/cortex', async (c) => {
  const result = await getPool().query<{ name: string }>(
    'SELECT name FROM cortexes ORDER BY name ASC',
  );
  return c.json({ cortexes: result.rows.map(r => r.name) });
});

cortex.post('/v1/cortex', async (c) => {
  const parsed = createCortexSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
  }
  const { name } = parsed.data;

  if (!isValidCortexName(name)) {
    return c.json({ error: 'invalid cortex name (use a-z, A-Z, 0-9, _, -)' }, 400);
  }

  await getPool().query(
    'INSERT INTO cortexes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [name],
  );
  return c.json({ name }, 201);
});

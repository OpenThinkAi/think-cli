import { Hono } from 'hono';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { isValidCortexName, CORTEX_NAME_ERROR } from '../lib/cortex-name.js';

const createCortexSchema = z.object({
  name: z.string(),
});

export const cortex = new Hono();

cortex.get('/v1/cortexes', async (c) => {
  const result = await getPool().query<{ name: string }>(
    'SELECT name FROM cortexes ORDER BY name ASC',
  );
  return c.json({ cortexes: result.rows.map(r => r.name) });
});

cortex.post('/v1/cortexes', async (c) => {
  const parsed = createCortexSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'body must be {"name": <string>}' }, 400);
  }

  if (!isValidCortexName(parsed.data.name)) {
    return c.json({ error: CORTEX_NAME_ERROR }, 400);
  }
  const { name } = parsed.data;

  const result = await getPool().query(
    'INSERT INTO cortexes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [name],
  );
  // 201 only when a row was actually created. 200 on idempotent no-op so
  // clients can distinguish "I made it" from "it was already there."
  return c.json({ name }, (result.rowCount ?? 0) > 0 ? 201 : 200);
});

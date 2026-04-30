import { createApp } from '../../src/app.js';

const TEST_TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
process.env.THINK_TOKEN = TEST_TOKEN;

const app = createApp();

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  token?: string | null;
}

/**
 * Tiny client that hits the Hono app directly via `app.fetch` — no port,
 * no TCP, no flakes. Bearer token is auto-attached unless `token: null`
 * is passed.
 */
export async function request<T = unknown>(opts: RequestOptions): Promise<{
  status: number;
  body: T;
}> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TEST_TOKEN : opts.token;
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await app.fetch(
    new Request(`http://test.local${opts.path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: res.status, body: body as T };
}

export { TEST_TOKEN };

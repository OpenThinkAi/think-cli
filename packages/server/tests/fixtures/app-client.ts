import { createApp } from '../../src/app.js';

const app = createApp();

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
}

/**
 * Tiny client that hits the Hono app directly via `app.fetch` — no port,
 * no TCP, no flakes. The 0.2.x server has no authed routes; this client
 * does not attach an Authorization header. AGT-027 re-introduces the auth
 * seam and this fixture grows a `token` option again.
 */
export async function request<T = unknown>(opts: RequestOptions): Promise<{
  status: number;
  body: T;
}> {
  const headers: Record<string, string> = {};
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

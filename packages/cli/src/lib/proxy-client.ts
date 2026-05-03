/**
 * HTTP client for the `think serve` proxy. One small wrapper over `fetch`
 * with bearer auth and a consistent error shape so the subscribe commands
 * don't each rebuild the same retry/parse logic.
 *
 * Errors throw `ProxyError` with `status` and `detail` (the parsed `error`
 * field from the JSON body when present). Network/parse failures surface
 * as `ProxyError` with `status: 0`.
 */

export class ProxyError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  constructor(message: string, opts: { status: number; detail?: string }) {
    super(message);
    this.name = 'ProxyError';
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export interface ProxyConfig {
  proxyUrl: string;
  token: string;
}

export interface SubscriptionRecord {
  id: string;
  kind: string;
  pattern: string;
  created_at: string;
  last_polled_at: string | null;
}

export interface EventRecord {
  id: string;
  subscription_id: string;
  payload: unknown;
  server_seq: number;
  created_at: string;
}

export interface EventsPage {
  events: EventRecord[];
  next_since: number | null;
}

function trimUrl(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

async function call<T>(cfg: ProxyConfig, method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const url = `${trimUrl(cfg.proxyUrl)}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ProxyError(
      `network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { status: 0 },
    );
  }

  if (resp.status === 204) return { status: 204, data: null };

  let data: unknown = null;
  const text = await resp.text();
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body on error is salvageable as a plain string.
      if (!resp.ok) {
        throw new ProxyError(`proxy returned ${resp.status} with non-JSON body: ${text.slice(0, 200)}`, {
          status: resp.status,
        });
      }
      throw new ProxyError(`proxy returned ${resp.status} with non-JSON body`, { status: resp.status });
    }
  }

  if (!resp.ok) {
    const errBody = data as { error?: string; detail?: unknown } | null;
    const detail = errBody && typeof errBody.detail === 'string' ? errBody.detail : undefined;
    const errLabel = errBody && typeof errBody.error === 'string' ? errBody.error : `HTTP ${resp.status}`;
    throw new ProxyError(detail ? `${errLabel}: ${detail}` : errLabel, { status: resp.status, detail });
  }

  return { status: resp.status, data: data as T };
}

export async function createSubscription(cfg: ProxyConfig, kind: string, pattern: string): Promise<SubscriptionRecord> {
  const { data } = await call<{ subscription: SubscriptionRecord }>(cfg, 'POST', '/v1/subscriptions', { kind, pattern });
  if (!data) throw new ProxyError('proxy returned empty body for POST /v1/subscriptions', { status: 0 });
  return data.subscription;
}

export async function listSubscriptions(cfg: ProxyConfig): Promise<SubscriptionRecord[]> {
  const { data } = await call<{ subscriptions: SubscriptionRecord[] }>(cfg, 'GET', '/v1/subscriptions');
  if (!data) throw new ProxyError('proxy returned empty body for GET /v1/subscriptions', { status: 0 });
  return data.subscriptions;
}

export async function deleteSubscription(cfg: ProxyConfig, id: string): Promise<void> {
  await call<null>(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`);
}

export async function setCredential(cfg: ProxyConfig, id: string, credential: string): Promise<void> {
  await call<null>(cfg, 'PUT', `/v1/subscriptions/${encodeURIComponent(id)}/credential`, { credential });
}

export async function testCredential(cfg: ProxyConfig, id: string): Promise<{ ok: boolean; detail?: string }> {
  const { data } = await call<{ ok: boolean; detail?: string }>(
    cfg,
    'POST',
    `/v1/subscriptions/${encodeURIComponent(id)}/credential/test`,
  );
  if (!data) throw new ProxyError('proxy returned empty body for credential test', { status: 0 });
  return data;
}

export async function getEvents(cfg: ProxyConfig, subscriptionId: string, since: number, limit = 1000): Promise<EventsPage> {
  const qs = new URLSearchParams({
    subscription_id: subscriptionId,
    since: String(since),
    limit: String(limit),
  });
  const { data } = await call<EventsPage>(cfg, 'GET', `/v1/events?${qs.toString()}`);
  if (!data) throw new ProxyError('proxy returned empty body for GET /v1/events', { status: 0 });
  return data;
}

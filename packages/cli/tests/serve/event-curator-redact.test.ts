/**
 * AGT-2337 — the terminal-event curator redacts the event payload before
 * the LLM sees it: the baseline PII strip always, then the subscription's
 * stored redact selectors (set via PUT /v1/subscriptions/:id/redact).
 */
import { describe, it, expect } from 'vitest';
import { createTestClient } from './fixtures/app-client.js';
import { processTerminalEvent, selectUncuratedEvents } from '../../src/serve/event-curator.js';
import type { TerminalEventInput } from '../../src/lib/curator.js';

async function setup(payload: unknown, selectors?: string[]) {
  const client = createTestClient();
  const created = await client.request<{ subscription: { id: string } }>({
    method: 'POST',
    path: '/v1/subscriptions',
    body: { kind: 'github', pattern: 'org/repo' },
  });
  const subId = created.body.subscription.id;
  if (selectors) {
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/redact`,
      body: { selectors },
    });
    expect(r.status).toBe(200);
  }
  client.db
    .prepare(
      'INSERT INTO events (id, subscription_id, payload_json, episode_key, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('evt-1', subId, typeof payload === 'string' ? payload : JSON.stringify(payload), 'evt-1', new Date().toISOString());
  const [event] = selectUncuratedEvents(client.db, { subscriptionId: subId });
  return { client, event: event! };
}

async function curatedInput(payload: unknown, selectors?: string[]): Promise<TerminalEventInput> {
  const { client, event } = await setup(payload, selectors);
  let seen: TerminalEventInput | undefined;
  await processTerminalEvent({
    db: client.db,
    event,
    peerId: 'proxy-test',
    cortexName: 'team',
    curate: async ({ event: input }) => {
      seen = input;
      return { memories: [] };
    },
    writeMemories: () => ({ ids: [] }),
  });
  expect(seen).toBeDefined();
  return seen!;
}

describe('event curator redaction (AGT-2337)', () => {
  const payload = {
    title: 'Fix the parser',
    body: 'keep me',
    user: { login: 'octo', email: 'octo@example.com', location: 'Denver' },
    headers: { 'x-real-ip': '10.0.0.1' },
    commenter_email: 'c@example.com',
  };

  it('strips baseline PII fields even with no selectors configured', async () => {
    const input = await curatedInput(payload);
    expect(input.payload).not.toContain('octo@example.com');
    expect(input.payload).not.toContain('c@example.com');
    expect(input.payload).not.toContain('10.0.0.1');
    expect(input.payload).toContain('keep me');
    expect(input.payload).toContain('Denver');
    expect(input.title).toBe('Fix the parser');
  });

  it('applies the subscription selectors after the baseline strip', async () => {
    const input = await curatedInput(payload, ['$.user.location', 'body']);
    expect(input.payload).not.toContain('Denver');
    expect(input.payload).not.toContain('keep me');
    expect(input.payload).toContain('octo');
  });

  it('passes a non-JSON payload through unchanged', async () => {
    const input = await curatedInput('plain transcript text');
    expect(input.payload).toBe('plain transcript text');
  });
});

describe('PUT /v1/subscriptions/:id/redact', () => {
  it('stores selectors, and an empty list clears them', async () => {
    const client = createTestClient();
    const created = await client.request<{ subscription: { id: string } }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'github', pattern: 'org/repo' },
    });
    const id = created.body.subscription.id;
    const read = () =>
      (client.db.prepare('SELECT redact_selectors FROM subscriptions WHERE id = ?').get(id) as {
        redact_selectors: string | null;
      }).redact_selectors;

    const set = await client.request<{ redact_selectors: string[] }>({
      method: 'PUT',
      path: `/v1/subscriptions/${id}/redact`,
      body: { selectors: ['$.user.email'] },
    });
    expect(set.status).toBe(200);
    expect(set.body.redact_selectors).toEqual(['$.user.email']);
    expect(JSON.parse(read()!)).toEqual(['$.user.email']);

    const cleared = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${id}/redact`,
      body: { selectors: [] },
    });
    expect(cleared.status).toBe(200);
    expect(read()).toBeNull();
  });

  it('rejects unsupported selector syntax with 400', async () => {
    const client = createTestClient();
    const created = await client.request<{ subscription: { id: string } }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'github', pattern: 'org/repo' },
    });
    for (const bad of [['$..email'], ['$.items[0]'], ['$'], 'not-an-array']) {
      const r = await client.request({
        method: 'PUT',
        path: `/v1/subscriptions/${created.body.subscription.id}/redact`,
        body: { selectors: bad },
      });
      expect(r.status).toBe(400);
    }
  });

  it('404s for an unknown subscription', async () => {
    const client = createTestClient();
    const r = await client.request({
      method: 'PUT',
      path: '/v1/subscriptions/nope/redact',
      body: { selectors: ['$.a'] },
    });
    expect(r.status).toBe(404);
  });
});

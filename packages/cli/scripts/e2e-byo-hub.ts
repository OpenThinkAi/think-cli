/**
 * e2e-byo-hub — the repeatable BYO-hub dogfood check (AGT-574).
 *
 * Proves the whole open-core cortex-sync stack end-to-end on the BUILT
 * artifact (`dist/index.js`), with real processes and real HTTP — no vitest,
 * no in-memory `app.fetch` shortcut:
 *
 *   1. Boots ONE self-hosted hub: `think serve` with a static `THINK_TOKEN`
 *      (AGT-571 store + AGT-572 routes). No think-hub, no Postgres.
 *   2. Creates TWO isolated peers (separate `THINK_HOME` dirs with distinct
 *      peerIds — this simulates two accounts/machines) whose config points
 *      the AGT-573 hub SyncAdapter at that hub (cortex.hub.url + .token).
 *   3. Peer A adds a memory and `cortex sync`s it up; peer B syncs it down
 *      (and pushes its own back); a final A sync converges both.
 *   4. Asserts BOTH peers `think recall` BOTH memories (FTS path via
 *      THINK_NO_EMBED=1 — offline + deterministic), with identical
 *      content-derived ids on both sides.
 *   5. Asserts the hub actually mediated: an authenticated pull straight from
 *      the wire shows both lines, and an unauthenticated pull is a 401.
 *
 * Usage (from packages/cli, after `bun run build` / `npm run build`):
 *   npx tsx scripts/e2e-byo-hub.ts        # or: bun run e2e:hub
 *
 * Exit 0 = every assertion passed. On failure the temp dir is kept and its
 * path printed so the hub sqlite + both peer homes can be inspected.
 * See `docs/byo-hub-dogfood.md` (repo root) for the runbook, including how
 * to run the same flow across two real machines/accounts.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..');
const DIST_CLI = path.join(CLI_ROOT, 'dist', 'index.js');

// The check runs the built artifact under plain `node` (the shipped runtime;
// `bin.think` → dist/index.js). Deliberately NOT process.execPath — this
// script may itself be running under bun/tsx.
const NODE = 'node';

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

let failures = 0;

function step(msg: string): void {
  console.log(`\n== ${msg}`);
}

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`   ok: ${msg}`);
  } else {
    failures += 1;
    console.error(`   FAIL: ${msg}`);
  }
}

function fatal(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

// Base env for every spawned process: inherit PATH etc., but strip every
// THINK_* knob so a developer's own think setup can't leak into the check.
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('THINK_')) continue;
    if (k === 'NODE_ENV') continue; // dev-mode boot (no production gate)
    env[k] = v;
  }
  return { ...env, ...extra };
}

interface RunResult {
  status: number;
  output: string; // stdout + stderr combined
}

/** Run one `think <args>` invocation as the given peer (THINK_HOME). */
function think(peerHome: string, args: string[]): RunResult {
  const res = spawnSync(NODE, [DIST_CLI, ...args], {
    env: cleanEnv({
      THINK_HOME: peerHome,
      // FTS-only recall: offline, deterministic, no daemon/model spawn.
      THINK_NO_EMBED: '1',
    }),
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error) fatal(`spawn failed for think ${args.join(' ')}: ${res.error.message}`);
  return { status: res.status ?? -1, output };
}

/** The `✓ Pulled X, pushed Y` summary line of a sync run (for diagnostics). */
function syncSummary(output: string): string {
  return output.split('\n').find((l) => l.includes('Pulled')) ?? output.trim().split('\n').pop() ?? '';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('could not allocate a port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) fatal(`hub did not become healthy within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(DIST_CLI)) {
    fatal(`built artifact not found at ${DIST_CLI} — run \`bun run build\` (or npm run build) first`);
  }

  const baseDir = mkdtempSync(path.join(tmpdir(), 'think-byo-hub-e2e-'));
  const suffix = randomBytes(4).toString('hex');
  const cortex = `dogfood-${suffix}`;
  const token = `byo-hub-e2e-token-${randomBytes(8).toString('hex')}`;
  // FTS-friendly sentinels: single alphanumeric tokens, unique per run.
  const sentinelA = `sentinelalpha${suffix}`;
  const sentinelB = `sentinelbravo${suffix}`;

  let hub: ChildProcess | undefined;

  try {
    // -- 1. boot the self-hosted hub (`think serve`, static token) ----------
    const port = await freePort();
    const hubUrl = `http://127.0.0.1:${port}`;
    step(`booting self-hosted hub: think serve on ${hubUrl} (static THINK_TOKEN)`);

    const hubHome = path.join(baseDir, 'hub-home');
    mkdirSync(hubHome, { recursive: true });
    hub = spawn(NODE, [DIST_CLI, 'serve'], {
      cwd: baseDir,
      env: cleanEnv({
        THINK_HOME: hubHome,
        THINK_TOKEN: token,
        THINK_DB_PATH: path.join(baseDir, 'hub.sqlite'),
        PORT: String(port),
        // Explicit key so the dev fallback never writes ~/.openthink/vault.key.
        THINK_VAULT_KEY: randomBytes(32).toString('base64'),
        // Keep the connector scheduler quiet for the duration of the check.
        THINK_POLL_INTERVAL_SECONDS: '3600',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let hubLog = '';
    hub.stdout?.on('data', (d: Buffer) => (hubLog += d.toString()));
    hub.stderr?.on('data', (d: Buffer) => (hubLog += d.toString()));
    hub.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.error(`hub exited with code ${code}\n${hubLog}`);
      }
    });
    await waitForHealth(hubUrl);
    console.log('   hub is healthy');

    // -- 2. two isolated peers, each configured for the hub backend ---------
    step('creating two isolated peers (separate THINK_HOMEs, distinct peerIds)');
    const makePeer = (name: 'peer-a' | 'peer-b'): string => {
      const home = path.join(baseDir, name);
      mkdirSync(path.join(home, 'config'), { recursive: true });
      const config = {
        peerId: `${name}-${suffix}`,
        cortex: {
          active: cortex,
          author: name,
          // AGT-573: hub adapter is selected only when BOTH url+token are set.
          hub: { url: hubUrl, token },
        },
      };
      writeFileSync(path.join(home, 'config', 'config.json'), JSON.stringify(config, null, 2) + '\n', {
        mode: 0o600,
      });
      return home;
    };
    const peerA = makePeer('peer-a');
    const peerB = makePeer('peer-b');
    console.log(`   peer homes under ${baseDir}`);

    // -- 3. A pushes; B pulls (and pushes back); A pulls — converge ---------
    step(`peer A: add memory "${sentinelA}" and sync through the hub`);
    const addA = think(peerA, ['memory', 'add', `dogfood memory from peer A ${sentinelA}`, '--no-push']);
    assert(addA.status === 0, `peer A memory add exits 0 (got ${addA.status})`);
    const syncA1 = think(peerA, ['cortex', 'sync']);
    assert(syncA1.status === 0 && !syncA1.output.includes('Error:'), 'peer A sync #1 is clean');
    assert(syncA1.output.includes('pushed 1'), `peer A sync #1 pushed 1 memory (got: ${syncSummary(syncA1.output)})`);

    step(`peer B: add memory "${sentinelB}", then sync (pull A's, push own)`);
    const addB = think(peerB, ['memory', 'add', `dogfood memory from peer B ${sentinelB}`, '--no-push']);
    assert(addB.status === 0, `peer B memory add exits 0 (got ${addB.status})`);
    const syncB1 = think(peerB, ['cortex', 'sync']);
    assert(syncB1.status === 0 && !syncB1.output.includes('Error:'), 'peer B sync #1 is clean');
    assert(syncB1.output.includes('Pulled 1'), `peer B pulled peer A's memory (got: ${syncSummary(syncB1.output)})`);
    assert(syncB1.output.includes('pushed 1'), 'peer B pushed its own memory');

    step('peer A: sync again to pull peer B\'s memory (convergence)');
    const syncA2 = think(peerA, ['cortex', 'sync']);
    assert(syncA2.status === 0 && !syncA2.output.includes('Error:'), 'peer A sync #2 is clean');
    assert(syncA2.output.includes('Pulled 1'), `peer A pulled peer B's memory (got: ${syncSummary(syncA2.output)})`);

    // -- 4. recall on both peers: each sees BOTH memories, no duplicates ----
    step('recall on both peers (FTS, offline) — cross-peer visibility, no duplicates');
    const recallJson = (home: string, query: string): Array<{ id: string; ts: string; content: string }> => {
      const res = think(home, ['recall', query, '--json', '--no-embed']);
      if (res.status !== 0) fatal(`recall "${query}" failed:\n${res.output}`);
      // --json emits a single JSON array line; ignore any note lines around it.
      const line = res.output.split('\n').find((l) => l.trimStart().startsWith('['));
      if (!line) fatal(`recall "${query}" produced no JSON array:\n${res.output}`);
      return JSON.parse(line) as Array<{ id: string; ts: string; content: string }>;
    };

    const aSeesB = recallJson(peerA, sentinelB);
    assert(
      aSeesB.some((e) => e.content.includes(sentinelB)),
      `peer A recalls peer B's memory (${sentinelB})`,
    );
    const bSeesA = recallJson(peerB, sentinelA);
    assert(
      bSeesA.some((e) => e.content.includes(sentinelA)),
      `peer B recalls peer A's memory (${sentinelA}) — AC2`,
    );
    const aSeesA = recallJson(peerA, sentinelA);
    const bSeesB = recallJson(peerB, sentinelB);
    assert(aSeesA.length > 0 && bSeesB.length > 0, 'each peer still recalls its own memory');

    // No duplicates: the hub stream echoes a peer's own lines back on pull,
    // and re-ingesting the echo would show up here as a second copy (the
    // AGT-574 self-echo guard in hub-adapter.ts is what keeps this at 1).
    const matches = (entries: Array<{ content: string }>, sentinel: string): number =>
      entries.filter((e) => e.content.includes(sentinel)).length;
    assert(matches(aSeesA, sentinelA) === 1, `peer A holds exactly one copy of its own memory (got ${matches(aSeesA, sentinelA)})`);
    assert(matches(bSeesB, sentinelB) === 1, `peer B holds exactly one copy of its own memory (got ${matches(bSeesB, sentinelB)})`);
    assert(matches(aSeesB, sentinelB) === 1, 'peer A holds exactly one copy of B\'s memory');
    assert(matches(bSeesA, sentinelA) === 1, 'peer B holds exactly one copy of A\'s memory');

    // Identity triple: B's copy of A's memory is the SAME memory (ts+content
    // match), not a lookalike. (Row ids legitimately differ across peers —
    // the author keeps its locally-assigned uuid while receivers materialize
    // the content-derived id, matching the fs/git adapters' model.)
    const origA = aSeesA.find((e) => e.content.includes(sentinelA));
    const copyA = bSeesA.find((e) => e.content.includes(sentinelA));
    assert(
      origA !== undefined && copyA !== undefined && origA.ts === copyA.ts && origA.content === copyA.content,
      "peer B's copy of A's memory matches on the (ts, content) identity",
    );

    // -- 5. the hub really mediated: wire-level pull + auth check -----------
    step('hub wire check: authenticated pull shows both lines; no token → 401');
    const pullUrl = `${hubUrl}/v1/cortex-sync/pull?cortex=${cortex}&cursor=0&limit=100`;
    const authed = await fetch(pullUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert(authed.status === 200, `authenticated pull is 200 (got ${authed.status})`);
    const body = (await authed.json()) as { lines: Array<{ content: string; origin_peer_id?: string }> };
    assert(body.lines.length === 2, `hub stores exactly the 2 pushed lines (got ${body.lines.length})`);
    assert(
      body.lines.some((l) => l.content.includes(sentinelA)) &&
        body.lines.some((l) => l.content.includes(sentinelB)),
      'hub holds one line per peer (both sentinels present)',
    );
    const unauthed = await fetch(pullUrl);
    assert(unauthed.status === 401, `pull without the static token is rejected 401 (got ${unauthed.status}) — AC3`);
  } finally {
    if (hub && hub.exitCode === null) {
      hub.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          hub?.kill('SIGKILL');
          resolve();
        }, 3000);
        hub?.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (failures === 0 && process.exitCode !== 1) {
      rmSync(baseDir, { recursive: true, force: true });
    } else {
      console.error(`\nkept ${baseDir} for inspection (hub.sqlite + peer homes)`);
    }
  }

  if (failures > 0) {
    console.error(`\nBYO-hub dogfood check FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\nBYO-hub dogfood check PASSED: two peers converged through a self-hosted `think serve` hub.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

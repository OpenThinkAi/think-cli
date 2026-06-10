/**
 * curate-eval — side-by-side curation comparison harness (dev script, not shipped).
 *
 * Runs the SAME assembled curation prompt through the local (oMLX/Qwen) and
 * Anthropic backends and prints a side-by-side report: validity, parsed counts,
 * latency, and the actual memory/event content for human judgment. Use it to
 * decide whether local-first curation is good enough to ship, ship as an
 * alpha/rc, or needs more road-testing.
 *
 * Usage:
 *   npx tsx scripts/curate-eval.ts                  # both backends, fixture engrams
 *   npx tsx scripts/curate-eval.ts --only local     # local only
 *   npx tsx scripts/curate-eval.ts --only anthropic # anthropic only
 *   npx tsx scripts/curate-eval.ts --from-db        # use real pending engrams (active cortex)
 *   npx tsx scripts/curate-eval.ts --runs 3         # repeat each backend N times (variance)
 *
 * Local endpoint resolution (first hit wins):
 *   THINK_LOCAL_ENDPOINT / THINK_LOCAL_MODEL   (think's own vars)
 *   QWEN_ENDPOINT       / QWEN_MODEL           (the team's oMLX convention)
 * Anthropic uses the gated Agent SDK path — needs THINK_LLM_CONSENT=1 and a
 * Claude subscription/key as usual.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleCurationPrompt,
  runCuration,
  runLocalTwoPassCuration,
  type CurationResult,
  type StructuredPrompt,
} from '../src/lib/curator.js';
import type { Engram } from '../src/db/engram-queries.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/lib/llm/client.js';
import { LocalLlmClient } from '../src/lib/llm/local.js';
import { AnthropicLlmClient } from '../src/lib/llm/anthropic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const only = flagValue('--only'); // 'local' | 'anthropic' | undefined
const fromDb = argv.includes('--from-db');
const runs = Math.max(1, Number.parseInt(flagValue('--runs') ?? '1', 10) || 1);

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// capturing client — wraps any LlmClient and records the raw response text so
// we can show what the model actually emitted, even when the parse fails.
// ---------------------------------------------------------------------------
class CapturingClient implements LlmClient {
  lastRaw = '';
  constructor(private readonly inner: LlmClient) {}
  get name(): string {
    return this.inner.name;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.inner.complete(req);
    this.lastRaw = res.text;
    return res;
  }
}

// ---------------------------------------------------------------------------
// engram loading
// ---------------------------------------------------------------------------
function loadFixtureEngrams(): Engram[] {
  const p = path.join(__dirname, 'fixtures', 'curate-sample-engrams.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Engram[];
}

async function loadDbEngrams(): Promise<Engram[]> {
  // Lazy import so the fixture path never touches the DB layer.
  const { getConfig } = await import('../src/lib/config.js');
  const { getPendingEngrams } = await import('../src/db/engram-queries.js');
  const cortex = getConfig().cortex?.active;
  if (!cortex) throw new Error('no active cortex configured (config.cortex.active) — cannot use --from-db');
  return getPendingEngrams(cortex);
}

// ---------------------------------------------------------------------------
// backend construction
// ---------------------------------------------------------------------------
function localClient(): CapturingClient | null {
  const endpoint = (process.env.THINK_LOCAL_ENDPOINT ?? process.env.QWEN_ENDPOINT ?? '').trim();
  const model = (process.env.THINK_LOCAL_MODEL ?? process.env.QWEN_MODEL ?? '').trim();
  const apiKey = (process.env.THINK_LOCAL_API_KEY ?? 'lm-studio').trim();
  if (!endpoint || !model) {
    console.error(
      'local backend not configured — set THINK_LOCAL_ENDPOINT/THINK_LOCAL_MODEL (or QWEN_ENDPOINT/QWEN_MODEL).',
    );
    return null;
  }
  console.error(`local backend: ${model} @ ${endpoint}`);
  return new CapturingClient(new LocalLlmClient({ endpoint, model, apiKey }));
}

function anthropicClient(): CapturingClient {
  return new CapturingClient(new AnthropicLlmClient());
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
interface RunResult {
  backend: string;
  ok: boolean;
  ms: number;
  error?: string;
  raw: string;
  result?: CurationResult;
}

async function runBackend(
  label: string,
  client: CapturingClient,
  prompt: StructuredPrompt & { tierASystemPrompt: string },
  twoPass: boolean,
): Promise<RunResult> {
  const start = performance.now();
  try {
    // Mirror production: local routes through the two-pass split, Anthropic
    // through the single combined pass.
    const result = twoPass
      ? await runLocalTwoPassCuration(prompt, [], client)
      : await runCuration(prompt, client);
    return { backend: label, ok: true, ms: performance.now() - start, raw: client.lastRaw, result };
  } catch (e) {
    return {
      backend: label,
      ok: false,
      ms: performance.now() - start,
      error: e instanceof Error ? e.message : String(e),
      raw: client.lastRaw,
    };
  }
}

function summarize(r: RunResult): string {
  if (!r.ok) return `  ✗ FAILED in ${r.ms.toFixed(0)}ms — ${r.error}`;
  const res = r.result!;
  const lines = [
    `  ✓ ${r.ms.toFixed(0)}ms — ${res.memories.length} memories, ${res.purgeIds.length} purges, ${res.longTermEvents.length} long-term events`,
  ];
  res.memories.forEach((m, i) => {
    lines.push(`    memory[${i}] (src=${m.source_ids.join(',') || '∅'}): ${m.content}`);
    if (m.decisions?.length) lines.push(`      decisions: ${m.decisions.join(' | ')}`);
  });
  if (res.purgeIds.length) lines.push(`    purge: ${res.purgeIds.join(', ')}`);
  res.longTermEvents.forEach((e, i) => {
    lines.push(`    event[${i}] kind=${e.kind} topics=${e.topics.join(',')}: ${e.title}`);
  });
  return lines.join('\n');
}

async function main(): Promise<void> {
  const engrams = fromDb ? await loadDbEngrams() : loadFixtureEngrams();
  console.error(`Loaded ${engrams.length} engrams (${fromDb ? 'live DB' : 'fixture'}).\n`);

  const prompt = assembleCurationPrompt({
    recentMemories: [],
    recentLongTermEvents: [],
    curatorMd: null,
    pendingEngrams: engrams,
    author: 'eval',
  });

  const backends: Array<{ label: string; make: () => CapturingClient | null }> = [];
  if (only !== 'anthropic') backends.push({ label: 'local', make: localClient });
  if (only !== 'local') backends.push({ label: 'anthropic', make: anthropicClient });

  const outDir = path.join(__dirname, 'eval-out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const allRuns: RunResult[] = [];

  for (const b of backends) {
    const client = b.make();
    if (!client) continue;
    console.error(`\n=== ${b.label} ${b.label === 'local' ? '(two-pass)' : '(combined)'} ===`);
    for (let i = 0; i < runs; i++) {
      const r = await runBackend(b.label, client, prompt, b.label === 'local');
      allRuns.push(r);
      console.error(runs > 1 ? `[run ${i + 1}/${runs}]` : '');
      console.error(summarize(r));
    }
  }

  const outPath = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ stamp, fromDb, runs, prompt, runs_out: allRuns }, null, 2));
  console.error(`\nArtifacts written to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

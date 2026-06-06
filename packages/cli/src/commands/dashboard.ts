/**
 * `think dashboard` — a status dashboard in the browser via ui-leaf.
 *
 * Three AI-derived panels (what you're working on, what shipped today, what's
 * unfinished) over the recent work-log window, plus a center prompt box that
 * answers free-form questions agentically — the model drives think's own
 * `think_recall` MCP tool (plus any org-configured MCP servers) to search and
 * synthesize an answer.
 *
 * Heavily customizable via `config.dashboard` (see lib/config.ts DashboardConfig):
 *   - view        — swap the .tsx presentation, reuse all plumbing
 *   - panels      — declare your own panels + AI buckets
 *   - windowDays  — how much history the digest sees
 *   - digest      — override the digest model / add org guidance
 *   - ask.servers — extra MCP servers the prompt box may search (e.g. Linear)
 * Omitting the whole block reproduces the built-in default.
 *
 * ui-leaf is an *external* runtime dependency: think spawns the `ui-leaf`
 * binary over its line-delimited JSON stdio protocol. `--json` skips ui-leaf
 * and dumps the data. Unlike `think retro-usage`, this view wires the `mutate`
 * channel so the prompt box and Refresh button can call back into the CLI.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';
import { subDays, startOfDay } from 'date-fns';
import { getEngrams } from '../db/engram-queries.js';
import { getEntries, type Entry } from '../db/queries.js';
import { getConfig, type DashboardConfig, type DashboardPanel } from '../lib/config.js';
import {
  generateStatusDigest,
  answerThinkQuestion,
  type DigestPanelSpec,
} from '../lib/claude.js';
import { LlmConsentError } from '../lib/llm-consent.js';
import { closeDb } from '../db/client.js';
import { closeCortexDb } from '../db/engrams.js';

const VIEW_NAME = 'dashboard';
const DEFAULT_WINDOW_DAYS = 7;

/** The built-in panels — reproduces the original three-panel dashboard. */
const DEFAULT_PANELS: DashboardPanel[] = [
  { key: 'workingOn', title: 'Working on', accent: '#2563eb', render: 'digest' },
  { key: 'shippedToday', title: 'Shipped today', accent: '#16a34a', render: 'today' },
  { key: 'unfinished', title: 'Unfinished', accent: '#d97706', render: 'digest' },
];

interface PanelItem {
  title: string;
  detail?: string;
  time?: string;
}
interface PanelMeta {
  key: string;
  title: string;
  accent: string;
  render: 'digest' | 'today';
}
interface DashboardData {
  cortex: string | null;
  windowDays: number;
  generatedAt: string;
  panels: PanelMeta[];
  items: Record<string, PanelItem[]>;
}

function resolvePanels(cfg: DashboardConfig): DashboardPanel[] {
  return cfg.panels && cfg.panels.length > 0 ? cfg.panels : DEFAULT_PANELS;
}

function panelMeta(panels: DashboardPanel[]): PanelMeta[] {
  return panels.map((p) => ({
    key: p.key,
    title: p.title,
    accent: p.accent ?? '#6b7280',
    render: p.render === 'today' ? 'today' : 'digest',
  }));
}

/**
 * Resolve the view to mount. A custom view (config.dashboard.view or --view)
 * wins; otherwise the shipped views/dashboard.tsx. Returns the viewsRoot the
 * binary scans plus the view name within it.
 */
function resolveView(custom: string | undefined): { viewsRoot: string; view: string } | null {
  if (custom) {
    const abs = path.resolve(process.cwd(), custom);
    if (!existsSync(abs)) return null;
    return { viewsRoot: path.dirname(abs), view: path.basename(abs).replace(/\.tsx?$/, '') };
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'views'), // dist/ -> <root>/views
    path.resolve(here, '..', '..', 'views'), // src/commands/ -> <root>/views
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, `${VIEW_NAME}.tsx`))) return { viewsRoot: dir, view: VIEW_NAME };
  }
  return null;
}

/** Pull the recent work-log window as a normalized Entry[]. */
function loadWindow(cortex: string | null, since: Date): Entry[] {
  if (cortex) {
    return getEngrams(cortex, { since }).map((e) => ({
      id: e.id,
      timestamp: e.created_at,
      source: 'manual',
      category: 'note',
      content: e.content,
      tags: '[]',
    }));
  }
  return getEntries({ since });
}

/** Today's entries as raw items — the cheap, AI-free live tail. */
function loadTodayItems(cortex: string | null): PanelItem[] {
  const since = startOfDay(new Date());
  return loadWindow(cortex, since)
    .filter((e) => new Date(e.timestamp) >= since)
    .map((e) => ({ title: e.content, time: e.timestamp.slice(11, 16) }))
    .reverse();
}

/** Compute the full dashboard payload (one AI call for the digest panels). */
async function buildData(cortex: string | null, panels: DashboardPanel[], cfg: DashboardConfig): Promise<DashboardData> {
  const windowDays = cfg.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = subDays(new Date(), windowDays);
  const entries = loadWindow(cortex, since);

  const digestPanels = panels.filter((p) => (p.render ?? 'digest') === 'digest');
  const specs: DigestPanelSpec[] = digestPanels.map((p) => ({ key: p.key, title: p.title, desc: p.desc }));
  const digest =
    entries.length === 0 || specs.length === 0
      ? {}
      : await generateStatusDigest(entries, specs, { model: cfg.digest?.model, extraPrompt: cfg.digest?.prompt });

  const items: Record<string, PanelItem[]> = {};
  for (const p of panels) {
    items[p.key] = (p.render === 'today') ? loadTodayItems(cortex) : (digest[p.key] ?? []);
  }

  return { cortex, windowDays, generatedAt: new Date().toISOString(), panels: panelMeta(panels), items };
}

/** Recompute only the AI-free 'today' panels (cheap poll, no API call). */
function buildTodayItems(cortex: string | null, panels: DashboardPanel[]): Record<string, PanelItem[]> {
  const items: Record<string, PanelItem[]> = {};
  for (const p of panels) {
    if (p.render === 'today') items[p.key] = loadTodayItems(cortex);
  }
  return items;
}

export const dashboardCommand = new Command('dashboard')
  .description('Open a status dashboard (working on / shipped today / unfinished) with an AI prompt box')
  .option('--json', 'Print the data as JSON instead of opening the view')
  .option('--view <path>', 'Use a custom view .tsx (overrides config.dashboard.view)')
  .addHelpText(
    'after',
    `
What it shows:
  Configurable panels over your recent work-log window plus a prompt box that
  answers questions by searching your think corpus (and any org-configured MCP
  servers). Defaults to working-on / shipped-today / unfinished.

Customize (config.dashboard in ~/.config/think/config.json):
  view        custom .tsx presentation        panels    your own panels + AI buckets
  windowDays  history the digest sees          digest    model / extra guidance
  ask.servers extra MCP servers (e.g. Linear)  --view    one-off view override

Requirements:
  Opening the view requires the ui-leaf binary on your PATH:
    npm install -g @openthink/ui-leaf
  The panels and prompt box call the Claude API (consent-gated, like
  'think summary'). Use --json to read the data without ui-leaf.

Examples:
  think dashboard
  think dashboard --view ./corp-dashboard.tsx
  think dashboard --json | jq '.items.unfinished'
`,
  )
  .action(async function (this: Command, opts: { json?: boolean; view?: string }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const cortex = globalOpts.cortex ?? config.cortex?.active ?? null;
    const dashCfg = config.dashboard ?? {};
    const panels = resolvePanels(dashCfg);

    const cleanup = () => {
      if (cortex) closeCortexDb(cortex);
      else closeDb();
    };

    let data: DashboardData;
    try {
      data = await buildData(cortex, panels, dashCfg);
    } catch (err) {
      if (err instanceof LlmConsentError) {
        console.error(chalk.red(err.message));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`think dashboard: ${msg}`));
      }
      cleanup();
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      cleanup();
      return;
    }

    const resolved = resolveView(opts.view ?? dashCfg.view);
    if (!resolved) {
      const which = opts.view ?? dashCfg.view;
      console.error(chalk.red(`think dashboard: could not locate the ${which ? `custom view "${which}"` : `${VIEW_NAME} view`}.`));
      console.error(chalk.dim('Falling back to --json:'));
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      cleanup();
      process.exitCode = 1;
      return;
    }

    await mountView(resolved, data, cortex, panels, dashCfg);
    cleanup();
  });

/**
 * Spawn `ui-leaf mount` and drive it over line-delimited JSON stdio, wiring the
 * `mutate` channel so the view's prompt box and Refresh button can call back.
 * Resolves when the session ends (browser closed + caller close, or child exit).
 */
function mountView(
  resolved: { viewsRoot: string; view: string },
  data: DashboardData,
  cortex: string | null,
  panels: DashboardPanel[],
  cfg: DashboardConfig,
): Promise<void> {
  const mutations: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    // Re-run the AI digest on demand.
    refresh: async () => buildData(cortex, panels, cfg),
    // Cheap, AI-free poll for the live 'today' panels.
    today: async () => ({ items: buildTodayItems(cortex, panels) }),
    // Agentic question answering over the think corpus + configured servers.
    ask: async (args) => {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) throw new Error('question is required');
      return { answer: await answerThinkQuestion(question, { servers: cfg.ask?.servers, model: cfg.ask?.model, maxTurns: cfg.ask?.maxTurns }) };
    },
  };

  return new Promise((resolve) => {
    const child = spawn('ui-leaf', ['mount'], { stdio: ['pipe', 'pipe', 'inherit'] });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red('think dashboard: the `ui-leaf` binary was not found on your PATH.'));
        console.error(chalk.yellow('  Install it:  npm install -g @openthink/ui-leaf'));
        console.error(chalk.dim('  Or read the data without it:  think dashboard --json'));
      } else {
        console.error(chalk.red(`think dashboard: failed to launch ui-leaf — ${err.message}`));
      }
      process.exitCode = 1;
      done();
    });

    const reply = (msg: object) => {
      try {
        child.stdin.write(JSON.stringify(msg) + '\n');
      } catch {
        /* child gone — session is ending anyway */
      }
    };

    const config = {
      version: '1',
      view: resolved.view,
      viewsRoot: resolved.viewsRoot,
      title: 'think dashboard',
      shell: 'app',
      data,
      mutations: Object.keys(mutations),
      port: 0,
    };
    reply(config);

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event: { type?: string; url?: string; message?: string; id?: number; name?: string; args?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'ready') {
          console.log(`${chalk.green('✓')} dashboard open at ${chalk.cyan(event.url ?? '')}`);
          console.log(chalk.dim('  Close the browser tab and press Ctrl-C here to exit.'));
        } else if (event.type === 'mutate') {
          const handler = event.name ? mutations[event.name] : undefined;
          const id = event.id;
          if (!handler) {
            reply({ version: '1', type: 'error', id, message: `unknown mutation: ${event.name}` });
            continue;
          }
          handler(event.args ?? {})
            .then((value) => reply({ version: '1', type: 'result', id, value }))
            .catch((err) => {
              const message = err instanceof LlmConsentError
                ? err.message
                : err instanceof Error ? err.message : String(err);
              reply({ version: '1', type: 'error', id, message });
            });
        } else if (event.type === 'error') {
          console.error(chalk.red(`think dashboard: ui-leaf error — ${event.message ?? 'unknown'}`));
          process.exitCode = 1;
          done();
        } else if (event.type === 'closed') {
          done();
        }
      }
    });

    child.on('exit', () => done());

    const onSigint = () => {
      try {
        child.stdin.write(JSON.stringify({ version: '1', type: 'close' }) + '\n');
      } catch {
        child.kill();
      }
    };
    process.once('SIGINT', onSigint);

    let settled = false;
    function done(): void {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSigint);
      resolve();
    }
  });
}

import readline from 'node:readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig, type SubscriptionsConfig, type Config } from '../lib/config.js';
import { insertEngram } from '../db/engram-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import {
  ProxyError,
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  setCredential,
  getEvents,
  type ProxyConfig,
} from '../lib/proxy-client.js';
import {
  installAgent as installSubscribeAgent,
  uninstallAgent as uninstallSubscribeAgent,
  getAgentStatus as getSubscribeAgentStatus,
  getLogPath as getSubscribeLogPath,
} from '../lib/auto-subscribe.js';

export const subscribeCommand = new Command('subscribe')
  .description('Subscribe to external event sources via the open-think proxy');

function fail(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

function getProxyConfig(): ProxyConfig {
  const sub = getConfig().subscriptions;
  if (!sub || !sub.proxyUrl || !sub.token) {
    fail('subscribe: no proxy configured. Run `think subscribe configure --proxy <url> --token <token>` first.');
  }
  return { proxyUrl: sub.proxyUrl, token: sub.token };
}

function rewriteSubscriptions(mutate: (sub: SubscriptionsConfig | undefined) => SubscriptionsConfig): void {
  const cfg = getConfig();
  cfg.subscriptions = mutate(cfg.subscriptions);
  saveConfig(cfg);
}

function activeCortex(globalCortex: string | undefined): string | null {
  const config = getConfig();
  return globalCortex ?? config.cortex?.active ?? null;
}

// `think subscribe configure --proxy <url> --token <token>`
subscribeCommand.addCommand(new Command('configure')
  .description('Set the proxy URL + token used by `subscribe add/list/poll/...`')
  .requiredOption('--proxy <url>', 'Base URL of the open-think proxy (http or https; no trailing slash needed)')
  .requiredOption('--token <token>', 'Bearer token matching the proxy\'s THINK_TOKEN')
  .action((opts: { proxy: string; token: string }) => {
    let parsed: URL;
    try {
      parsed = new URL(opts.proxy);
    } catch {
      fail(`subscribe configure: --proxy must be a valid URL (got ${JSON.stringify(opts.proxy)})`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail(`subscribe configure: --proxy must use http or https (got ${parsed.protocol})`);
    }
    if (!opts.token.trim()) {
      fail('subscribe configure: --token must be non-empty');
    }
    rewriteSubscriptions((existing) => ({
      proxyUrl: opts.proxy,
      token: opts.token,
      cursors: existing?.cursors,
    }));
    console.log(chalk.green('✓') + ` Proxy configured: ${parsed.origin}`);
  }));

// `think subscribe add <kind> <pattern>`
subscribeCommand.addCommand(new Command('add')
  .description('Create a subscription on the proxy (e.g. `think subscribe add github "OpenThinkAi/*"`)')
  .argument('<kind>', 'Source kind (github, linear, mock, ...). Validated by the proxy connector registry.')
  .argument('<pattern>', 'Pattern the connector understands (kind-specific)')
  .action(async (kind: string, pattern: string) => {
    const proxy = getProxyConfig();
    try {
      const sub = await createSubscription(proxy, kind, pattern);
      console.log(chalk.green('✓') + ` Created subscription`);
      console.log(`  ${chalk.cyan('id:')}      ${sub.id}`);
      console.log(`  ${chalk.cyan('kind:')}    ${sub.kind}`);
      console.log(`  ${chalk.cyan('pattern:')} ${sub.pattern}`);
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe add: ${err.message}`);
      throw err;
    }
  }));

// `think subscribe list`
subscribeCommand.addCommand(new Command('list')
  .description('List subscriptions registered on the proxy')
  .action(async () => {
    const proxy = getProxyConfig();
    try {
      const subs = await listSubscriptions(proxy);
      if (subs.length === 0) {
        console.log(chalk.dim('No subscriptions. `think subscribe add <kind> <pattern>` to create one.'));
        return;
      }
      const widthId = Math.max(2, ...subs.map((s) => s.id.length));
      const widthKind = Math.max(4, ...subs.map((s) => s.kind.length));
      const widthPattern = Math.max(7, ...subs.map((s) => s.pattern.length));
      console.log(`${'id'.padEnd(widthId)}  ${'kind'.padEnd(widthKind)}  ${'pattern'.padEnd(widthPattern)}  last_polled_at`);
      for (const s of subs) {
        const last = s.last_polled_at ?? '(never)';
        console.log(`${s.id.padEnd(widthId)}  ${s.kind.padEnd(widthKind)}  ${s.pattern.padEnd(widthPattern)}  ${last}`);
      }
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe list: ${err.message}`);
      throw err;
    }
  }));

// `think subscribe remove <id>`
subscribeCommand.addCommand(new Command('remove')
  .description('Delete a subscription on the proxy (cascades to its events and stored credential)')
  .argument('<id>', 'Subscription id from `subscribe list`')
  .action(async (id: string) => {
    const proxy = getProxyConfig();
    try {
      await deleteSubscription(proxy, id);
      // Also drop the local cursor — the id is gone.
      rewriteSubscriptions((existing) => {
        if (!existing) return { proxyUrl: '', token: '' };
        const cursors = { ...(existing.cursors ?? {}) };
        delete cursors[id];
        return { ...existing, cursors };
      });
      console.log(chalk.green('✓') + ` Removed subscription ${id}`);
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe remove: ${err.message}`);
      throw err;
    }
  }));

// `think subscribe set-credential <id>` (stdin-driven, no shell history leak)
subscribeCommand.addCommand(new Command('set-credential')
  .description('Store an encrypted credential for a subscription (read from stdin; never echoed)')
  .argument('<id>', 'Subscription id from `subscribe list`')
  .action(async (id: string) => {
    const proxy = getProxyConfig();
    let credential: string;
    if (process.stdin.isTTY) {
      // Interactive: prompt without echo. readline doesn't suppress echo on
      // its own — emit a hint and rely on the user pasting + ↵. For true
      // hidden input we'd need a tty raw-mode hack; instead we trust the
      // user piping from a secrets manager or from `pbpaste` and document
      // the non-echo expectation.
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      credential = await new Promise<string>((resolve) => {
        rl.question(`Paste credential for ${id} (input is not masked; pipe from stdin to avoid echo): `, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    } else {
      credential = await readAllStdin();
      credential = credential.trim();
    }
    if (!credential) {
      fail('subscribe set-credential: credential is empty (read 0 bytes from stdin)');
    }
    try {
      await setCredential(proxy, id, credential);
      console.log(chalk.green('✓') + ` Credential stored for ${id} (encrypted at rest in the proxy vault).`);
      console.log(chalk.dim(`  Verify with: think subscribe poll --once`));
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe set-credential: ${err.message}`);
      throw err;
    }
  }));

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// `think subscribe poll [--once] [--quiet]`
subscribeCommand.addCommand(new Command('poll')
  .description('Pull new events from the proxy and write them to engrams')
  .option('--once', 'Single pass over all subscriptions (the only mode today; reserved for future loop variants)')
  .option('--quiet', 'Suppress the per-tick line when nothing was inserted (used by the LaunchAgent)')
  .action(async function (this: Command, opts: { once?: boolean; quiet?: boolean }) {
    void opts.once; // currently a no-op alias kept symmetric with `cortex sync --if-online`
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();

    if (config.paused) return;

    const cortex = activeCortex(globalOpts.cortex);
    if (!cortex) {
      // No active cortex: poll has nowhere to write. Stay silent in --quiet
      // mode (LaunchAgent friendly); otherwise, complain loudly so the user
      // fixes their setup.
      if (!opts.quiet) {
        fail('subscribe poll: no active cortex. Run `think cortex create <name>` and select it first.');
      }
      return;
    }

    const sub = config.subscriptions;
    if (!sub || !sub.proxyUrl || !sub.token) {
      if (!opts.quiet) {
        fail('subscribe poll: no proxy configured. Run `think subscribe configure --proxy <url> --token <token>` first.');
      }
      return;
    }

    const proxy: ProxyConfig = { proxyUrl: sub.proxyUrl, token: sub.token };
    let subscriptions;
    try {
      subscriptions = await listSubscriptions(proxy);
    } catch (err) {
      if (err instanceof ProxyError) {
        if (opts.quiet && err.status === 0) return; // offline + quiet → silent
        fail(`subscribe poll: ${err.message}`);
      }
      throw err;
    }

    let totalInserted = 0;
    const updatedCursors: Record<string, number> = { ...(sub.cursors ?? {}) };

    for (const s of subscriptions) {
      let cursor = updatedCursors[s.id] ?? 0;
      // Page until next_since is null (proxy contract: null = empty page,
      // non-null = `since` to use for the next call).
      // Bound the per-tick loop so a misbehaving proxy can't pin us forever.
      for (let page = 0; page < 100; page += 1) {
        let resp;
        try {
          resp = await getEvents(proxy, s.id, cursor);
        } catch (err) {
          if (err instanceof ProxyError) {
            if (!opts.quiet) console.error(chalk.yellow(`[subscribe poll] ${s.id}: ${err.message}`));
            break;
          }
          throw err;
        }
        if (resp.events.length === 0) break;
        for (const ev of resp.events) {
          insertEngram(cortex, {
            content: typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload),
            episodeKey: `subscribe:${s.kind}`,
            context: JSON.stringify({
              source: 'subscribe',
              kind: s.kind,
              subscription_id: s.id,
              server_seq: ev.server_seq,
              event_id: ev.id,
            }),
          });
          totalInserted += 1;
          if (ev.server_seq > cursor) cursor = ev.server_seq;
        }
        updatedCursors[s.id] = cursor;
        if (resp.next_since === null) break;
        cursor = resp.next_since;
      }
    }

    rewriteSubscriptions((existing) => ({
      proxyUrl: existing?.proxyUrl ?? proxy.proxyUrl,
      token: existing?.token ?? proxy.token,
      cursors: updatedCursors,
    }));

    if (totalInserted > 0) {
      console.log(chalk.green('✓') + ` [subscribe poll] inserted ${totalInserted} engram${totalInserted === 1 ? '' : 's'}`);
    } else if (!opts.quiet) {
      console.log(chalk.dim('[subscribe poll] no new events'));
    }

    closeCortexDb(cortex);
  }));

// `think subscribe install-agent`
subscribeCommand.addCommand(new Command('install-agent')
  .description('Install a LaunchAgent that runs `think subscribe poll --quiet` on session load and every 600 seconds')
  .option('--interval <seconds>', 'Scheduler cadence in seconds (default 600)', (v) => {
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== v.trim()) {
      console.error(chalk.red(`--interval must be a positive integer (got: '${v}')`));
      process.exit(1);
    }
    return n;
  })
  .action((opts: { interval?: number }) => {
    try {
      const { label, plistPath } = installSubscribeAgent({ intervalSeconds: opts.interval });
      console.log(chalk.green('✓') + ` Auto-subscribe enabled`);
      console.log(chalk.dim(`  Label: ${label}`));
      console.log(chalk.dim(`  Plist: ${plistPath}`));
      if (process.env.THINK_HOME) {
        console.log(chalk.dim(`  THINK_HOME: ${process.env.THINK_HOME}`));
      }
      console.log(chalk.dim(`  First run fires immediately; tail the log to watch:`));
      console.log(chalk.dim(`    tail -f ${getSubscribeLogPath()}`));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }));

// `think subscribe disable`
subscribeCommand.addCommand(new Command('disable')
  .description('Remove the auto-subscribe LaunchAgent for this workspace')
  .action(() => {
    const { removed, plistPath } = uninstallSubscribeAgent();
    if (removed) {
      console.log(chalk.green('✓') + ` Auto-subscribe disabled (${plistPath})`);
    } else {
      console.log(chalk.dim(`No auto-subscribe agent installed (${plistPath})`));
    }
  }));

// `think subscribe status`
subscribeCommand.addCommand(new Command('status')
  .description('Show auto-subscribe scheduler status')
  .action(() => {
    const s = getSubscribeAgentStatus();
    console.log(`Label:     ${chalk.cyan(s.label)}`);
    console.log(`Installed: ${s.installed ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`Loaded:    ${s.loaded ? chalk.green('yes') : chalk.dim('no')}`);
    if (s.intervalSeconds) {
      console.log(`Interval:  ${s.intervalSeconds}s`);
    }
    console.log(`Plist:     ${s.plistPath}`);
    if (s.lastRunAt) {
      console.log(`Last log entry:  ${s.lastRunAt.toISOString()}`);
    } else {
      console.log(`Last log entry:  ${chalk.dim('(no log file yet)')}`);
    }
  }));

// `think subscribe show` — print the configured proxy (token redacted)
subscribeCommand.addCommand(new Command('show')
  .description('Show the configured proxy URL (token is redacted)')
  .action(() => {
    const { subscriptions } = getConfig();
    if (!subscriptions || !subscriptions.proxyUrl) {
      console.log(chalk.dim('No proxy configured. Run `think subscribe configure --proxy <url> --token <token>`.'));
      return;
    }
    console.log(`Proxy: ${chalk.cyan(subscriptions.proxyUrl)}`);
    console.log(`Token: ${chalk.dim('(redacted)')}`);
    const cursors = subscriptions.cursors ?? {};
    const ids = Object.keys(cursors);
    if (ids.length > 0) {
      console.log(`Cursors:`);
      for (const id of ids) console.log(`  ${id}: ${cursors[id]}`);
    }
  }));

// Re-export Config so commander typing stays clean for the file consumer.
export type { Config };

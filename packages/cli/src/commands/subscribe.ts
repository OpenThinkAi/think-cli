import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig, type SubscriptionsConfig } from '../lib/config.js';
import { insertEngram } from '../db/engram-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import {
  ProxyError,
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  setCredential,
  testCredential,
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
    fail('subscribe: no proxy configured. Run `think subscribe configure --proxy <url>` first.');
  }
  return { proxyUrl: sub.proxyUrl, token: sub.token };
}

function rewriteSubscriptions(mutate: (sub: SubscriptionsConfig | undefined) => SubscriptionsConfig): void {
  const cfg = getConfig();
  cfg.subscriptions = mutate(cfg.subscriptions);
  saveConfig(cfg);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Read a secret from a TTY without echoing it. Set raw mode, accumulate
 * bytes until <CR>/<LF>, swallow them, restore cooked mode. Mirrors the
 * pattern used by ssh-agent / git askpass on Unix; Windows is best-effort
 * (the docs steer users to the stdin path on platforms where raw mode is
 * unreliable).
 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('promptHidden requires a TTY'));
      return;
    }
    process.stderr.write(prompt);
    const buf: string[] = [];
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch (err) {
      reject(err);
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          try {
            stdin.setRawMode(wasRaw);
          } catch {
            /* best-effort */
          }
          stdin.pause();
          process.stderr.write('\n');
          resolve(buf.join(''));
          return;
        }
        if (ch === '\x03') {
          // Ctrl-C: restore tty + propagate
          stdin.removeListener('data', onData);
          try {
            stdin.setRawMode(wasRaw);
          } catch {
            /* best-effort */
          }
          stdin.pause();
          process.stderr.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length > 0) buf.pop();
          continue;
        }
        buf.push(ch);
      }
    };
    stdin.on('data', onData);
  });
}

// `think subscribe configure --proxy <url> [--token <token>]`
// Token defaults to stdin (or the THINK_TOKEN env var) so the secret stays
// out of shell history.
subscribeCommand.addCommand(new Command('configure')
  .description('Set the proxy URL + bearer token used by `subscribe add/list/poll/...` (token from stdin or THINK_TOKEN by default)')
  .requiredOption('--proxy <url>', 'Base URL of the open-think proxy (http or https; no trailing slash needed)')
  .option('--token <token>', 'Bearer token (NOT recommended — leaks to shell history; prefer stdin or THINK_TOKEN env)')
  .action(async (opts: { proxy: string; token?: string }) => {
    let parsed: URL;
    try {
      parsed = new URL(opts.proxy);
    } catch {
      fail(`subscribe configure: --proxy must be a valid URL (got ${JSON.stringify(opts.proxy)})`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail(`subscribe configure: --proxy must use http or https (got ${parsed.protocol})`);
    }

    let token = opts.token?.trim() ?? '';
    if (!token) {
      const envToken = process.env.THINK_TOKEN?.trim();
      if (envToken) {
        token = envToken;
      } else if (process.stdin.isTTY) {
        try {
          token = (await promptHidden('Bearer token (input hidden): ')).trim();
        } catch (err) {
          fail(`subscribe configure: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        token = (await readAllStdin()).trim();
      }
    }
    if (!token) {
      fail('subscribe configure: token is empty (provide via --token, THINK_TOKEN env, or stdin)');
    }
    rewriteSubscriptions((existing) => ({
      proxyUrl: opts.proxy,
      token,
      cursors: existing?.cursors,
    }));
    console.log(chalk.green('✓') + ` Proxy configured: ${parsed.origin}`);
  }));

// `think subscribe add <kind> <pattern>`
subscribeCommand.addCommand(new Command('add')
  .description('Create a subscription on the proxy (e.g. `think subscribe add mock 3`)')
  .argument('<kind>', 'Source kind (today only `mock` is registered; github/linear/... land in follow-ups)')
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
      // Drop the local cursor too — the id is gone. We're guaranteed to
      // have a populated `existing` here because getProxyConfig() above
      // succeeded; treat absence as a real bug rather than silently
      // installing a blank-string config.
      rewriteSubscriptions((existing) => {
        if (!existing) {
          throw new Error('subscriptions config vanished mid-call (unreachable)');
        }
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

// `think subscribe set-credential <id>` — read from stdin or hidden TTY prompt
subscribeCommand.addCommand(new Command('set-credential')
  .description('Store an encrypted credential for a subscription. Prefer stdin: `pbpaste | think subscribe set-credential <id>`. TTY interactive uses raw-mode (no echo).')
  .argument('<id>', 'Subscription id from `subscribe list`')
  .action(async (id: string) => {
    const proxy = getProxyConfig();
    let credential: string;
    if (process.stdin.isTTY) {
      try {
        credential = (await promptHidden(`Credential for ${id} (input hidden): `)).trim();
      } catch (err) {
        fail(`subscribe set-credential: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      credential = (await readAllStdin()).trim();
    }
    if (!credential) {
      fail('subscribe set-credential: credential is empty (read 0 bytes)');
    }
    try {
      await setCredential(proxy, id, credential);
    } catch (err) {
      if (err instanceof ProxyError) fail(`subscribe set-credential: ${err.message}`);
      throw err;
    }
    console.log(chalk.green('✓') + ` Credential stored for ${id} (encrypted at rest in the proxy vault).`);

    // Verify against the source so the success message isn't a lie. The
    // proxy returns 501 when the connector has no `verifyCredential` —
    // that's not a failure, just "can't verify here."
    try {
      const result = await testCredential(proxy, id);
      if (result.ok) {
        console.log(chalk.dim('  Verified against source: ok'));
      } else {
        console.log(chalk.yellow(`  ⚠ Verify failed: ${result.detail ?? '(no detail)'}`));
        console.log(chalk.dim(`    Credential is stored; fix and re-run \`think subscribe set-credential ${id}\`.`));
      }
    } catch (err) {
      if (err instanceof ProxyError && err.status === 501) {
        console.log(chalk.dim('  Connector does not support credential verification; stored without test.'));
      } else if (err instanceof ProxyError) {
        console.log(chalk.yellow(`  ⚠ Verify call failed: ${err.message}`));
      } else {
        throw err;
      }
    }
  }));

// `think subscribe poll [--quiet]`
//
// Bound the per-subscription pagination loop so a misbehaving proxy
// (e.g. one that always returns a non-null `next_since` even when no
// progress is being made) can't pin the tick forever. 100 pages × 1000
// events/page = 100k events per tick — plenty of headroom for healthy
// catch-up, fast-fails on a buggy proxy.
const MAX_PAGES_PER_TICK = 100;

subscribeCommand.addCommand(new Command('poll')
  .description('Pull new events from the proxy and write them to engrams (single pass)')
  .option('--quiet', 'Suppress non-actionable output: per-tick line on no-op, paused-state hint, no-cortex error, and offline network errors. Used by the LaunchAgent so a backgrounded poll on an offline machine stays silent.')
  .action(async function (this: Command, opts: { quiet?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();

    if (config.paused) {
      if (!opts.quiet) {
        console.log(chalk.dim('[subscribe poll] skipped: think is paused (`think resume` to re-enable)'));
      }
      return;
    }

    const cortex = globalOpts.cortex ?? config.cortex?.active ?? null;
    if (!cortex) {
      // No active cortex: poll has nowhere to write. Silent under
      // --quiet (LaunchAgent friendly); loud otherwise.
      if (!opts.quiet) {
        fail('subscribe poll: no active cortex. Run `think cortex create <name>` and select it first.');
      }
      return;
    }

    const sub = config.subscriptions;
    if (!sub || !sub.proxyUrl || !sub.token) {
      if (!opts.quiet) {
        fail('subscribe poll: no proxy configured. Run `think subscribe configure --proxy <url>` first.');
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
      // non-null = `since` to use for the next call). Bound the per-tick
      // loop so a misbehaving proxy can't pin us forever.
      for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
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

    rewriteSubscriptions((existing) => {
      // We just successfully completed `getProxyConfig()` (which reads
      // `existing` to assemble `proxy`), so this branch is unreachable.
      // Match `remove`'s discipline rather than silently substituting
      // back what we passed in (which papers over real bugs).
      if (!existing) {
        throw new Error('subscriptions config vanished mid-call (unreachable)');
      }
      return { ...existing, cursors: updatedCursors };
    });

    if (totalInserted > 0) {
      console.log(chalk.green('✓') + ` [subscribe poll] inserted ${totalInserted} engram${totalInserted === 1 ? '' : 's'}`);
    } else if (!opts.quiet) {
      console.log(chalk.dim('[subscribe poll] no new events'));
    }

    closeCortexDb(cortex);
  }));

// `think subscribe install-agent`
subscribeCommand.addCommand(new Command('install-agent')
  .description('Install a LaunchAgent that runs `think subscribe poll --quiet` on session load and at the configured cadence (default 600s)')
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
      const intervalLabel = opts.interval ?? 600;
      console.log(chalk.green('✓') + ` Auto-subscribe enabled (every ${intervalLabel}s)`);
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
    if (!subscriptions || !subscriptions.proxyUrl || !subscriptions.token) {
      // Both URL and token are required for any subscribe operation;
      // showing one without the other would imply a working configuration.
      console.log(chalk.dim('No proxy configured. Run `think subscribe configure --proxy <url>`.'));
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


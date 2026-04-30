import { createLaunchAgent } from './launch-agent.js';

// Sync is meant to feel near-realtime. Combined with RunAtLoad: true, the
// agent fires once on launchd load (login or `auto-sync enable`) and then
// every 60s. The `--if-online` precondition keeps the no-op cost low when
// offline. Diverges from auto-curate's RunAtLoad: false intentionally —
// freshly-logged-in machines should catch up on missed memories without
// waiting for the first tick.
const agent = createLaunchAgent({
  labelPrefix: 'ai.openthink.sync',
  commandArgs: ['cortex', 'sync', '--if-online'],
  runAtLoad: true,
  defaultIntervalSeconds: 60,
  logFileName: 'auto-sync.log',
});

export type { AgentStatus, InstallOptions } from './launch-agent.js';
export const getAgentLabel = agent.getAgentLabel;
export const getPlistPath = agent.getPlistPath;
export const getLogPath = agent.getLogPath;
export const installAgent = agent.installAgent;
export const uninstallAgent = agent.uninstallAgent;
export const getAgentStatus = agent.getAgentStatus;

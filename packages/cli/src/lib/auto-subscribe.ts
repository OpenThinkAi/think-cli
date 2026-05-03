import { createLaunchAgent } from './launch-agent.js';

// Auto-subscribe mirrors auto-sync's RunAtLoad: true so a freshly-logged-in
// machine catches up on missed events without waiting for the first tick.
// Default 600s (10 min) matches the proxy's own scheduler cadence
// (`THINK_POLL_INTERVAL_SECONDS` default), keeping client-side round-trip
// latency bounded by ~2× the server's interval without hammering.
const agent = createLaunchAgent({
  labelPrefix: 'ai.openthink.subscribe',
  commandArgs: ['subscribe', 'poll', '--quiet'],
  runAtLoad: true,
  defaultIntervalSeconds: 600,
  logFileName: 'auto-subscribe.log',
});

export type { AgentStatus, InstallOptions } from './launch-agent.js';
export const getAgentLabel = agent.getAgentLabel;
export const getPlistPath = agent.getPlistPath;
export const getLogPath = agent.getLogPath;
export const installAgent = agent.installAgent;
export const uninstallAgent = agent.uninstallAgent;
export const getAgentStatus = agent.getAgentStatus;

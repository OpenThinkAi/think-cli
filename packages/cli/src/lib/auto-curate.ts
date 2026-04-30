import { createLaunchAgent } from './launch-agent.js';

const agent = createLaunchAgent({
  labelPrefix: 'ai.openthink.curate',
  commandArgs: ['curate', '--if-idle'],
  runAtLoad: false,
  defaultIntervalSeconds: 300,
  logFileName: 'auto-curate.log',
});

export type { AgentStatus, InstallOptions } from './launch-agent.js';
export const getAgentLabel = agent.getAgentLabel;
export const getPlistPath = agent.getPlistPath;
export const getLogPath = agent.getLogPath;
export const installAgent = agent.installAgent;
export const uninstallAgent = agent.uninstallAgent;
export const getAgentStatus = agent.getAgentStatus;

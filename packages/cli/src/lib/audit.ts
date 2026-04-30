import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/client.js';

export interface AuditEntry {
  timestamp: string;
  type: 'export' | 'import' | 'network-send' | 'network-receive';
  peer: string;
  host?: string;
  file?: string;
  entryIds: string[];
  count: number;
}

function auditLogPath(): string {
  return path.join(getDataDir(), 'sync-audit.log');
}

export function logAudit(entry: AuditEntry): void {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(auditLogPath(), line, 'utf-8');
}

export function readAuditLog(): AuditEntry[] {
  const logPath = auditLogPath();
  if (!fs.existsSync(logPath)) return [];

  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line) as AuditEntry);
}

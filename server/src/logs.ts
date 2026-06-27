import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './config.js';
import { bus } from './bus.js';
import type { LogEntry } from './types.js';

fs.mkdirSync(LOGS_DIR, { recursive: true });

const file = (agentId: string) => path.join(LOGS_DIR, `${agentId.replace(/[^\w-]/g, '_')}.jsonl`);

export function appendLog(agentId: string, kind: LogEntry['kind'], text: string): void {
  const entry: LogEntry = { ts: Date.now(), kind, text };
  fs.appendFileSync(file(agentId), JSON.stringify(entry) + '\n');
  bus.broadcast({ type: 'log', agentId, entry });
}

export function readLogs(agentId: string, limit = 200): LogEntry[] {
  try {
    const lines = fs.readFileSync(file(agentId), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
}

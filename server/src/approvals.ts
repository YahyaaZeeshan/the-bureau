import crypto from 'node:crypto';
import { bus } from './bus.js';
import { appendLog } from './logs.js';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/** Ask the user (via websocket toast) to approve a sensitive tool call. Resolves false on deny or 5min timeout. */
export function requestApproval(agentId: string, tool: string, summary: string, detail?: string): Promise<boolean> {
  const id = crypto.randomUUID();
  appendLog(agentId, 'approval', `requested: ${tool} — ${summary}`);
  bus.broadcast({ type: 'approval.request', id, agentId, tool, summary, detail });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      appendLog(agentId, 'approval', `timed out: ${tool}`);
      bus.broadcast({ type: 'approval.resolved', id, approved: false });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
  });
}

export function resolveApproval(id: string, approved: boolean): void {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  bus.broadcast({ type: 'approval.resolved', id, approved });
  p.resolve(approved);
}

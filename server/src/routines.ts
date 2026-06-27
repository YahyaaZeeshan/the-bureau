/**
 * Routines: scheduled work for agents ("every morning, summarize Jira movement").
 * Fired work runs slowly in the background; results arrive as deliverables the
 * boss approves or rejects in the Inbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { runtime } from './agents.js';
import { appendLog } from './logs.js';
import { bus } from './bus.js';

export interface Routine {
  id: string;
  agentId: string;
  name: string;
  /** what to do each run */
  prompt: string;
  /** 'daily' fires at timeOfDay; 'interval' fires every intervalMinutes */
  schedule: 'daily' | 'interval';
  timeOfDay?: string; // "09:00" local
  intervalMinutes?: number;
  enabled: boolean;
  lastRun?: number;
}

const FILE = path.join(DATA_DIR, 'routines.json');

let routines: Routine[] = [];
try {
  routines = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  /* none yet */
}

const save = () => {
  fs.writeFileSync(FILE, JSON.stringify(routines, null, 2));
  bus.broadcast({ type: 'routines.changed' });
};

export const listRoutines = (): Routine[] => routines;

export function upsertRoutine(r: Partial<Routine> & { agentId: string; name: string; prompt: string }): Routine {
  const existing = r.id ? routines.find((x) => x.id === r.id) : undefined;
  if (existing) {
    Object.assign(existing, r);
    save();
    return existing;
  }
  const created: Routine = {
    id: crypto.randomUUID().slice(0, 8),
    schedule: 'daily',
    timeOfDay: '09:00',
    intervalMinutes: 240,
    enabled: true,
    ...r,
  };
  routines.push(created);
  save();
  return created;
}

export function deleteRoutine(id: string): void {
  routines = routines.filter((r) => r.id !== id);
  save();
}

export function runRoutineNow(id: string): void {
  const r = routines.find((x) => x.id === id);
  if (r) fire(r);
}

function fire(r: Routine): void {
  r.lastRun = Date.now();
  save();
  appendLog(r.agentId, 'system', `routine fired: ${r.name}`);
  void runtime
    .send(
      r.agentId,
      `[SCHEDULED ROUTINE "${r.name}" — background work, the boss is not waiting in chat.]\n${r.prompt}\n\n[Work it properly with your tools, then submit the result with submit_deliverable(title, content) so the boss can review it in his Inbox. Markdown content. Do NOT just reply in chat.]`,
      { from: 'routine', tier: 'light' }, // background digests run on the cheap model
    )
    .catch(() => undefined);
}

/** minute tick: fire due routines */
function tick(): void {
  const now = new Date();
  for (const r of routines) {
    if (!r.enabled) continue;
    if (r.schedule === 'interval') {
      const every = (r.intervalMinutes ?? 240) * 60_000;
      if (!r.lastRun || now.getTime() - r.lastRun >= every) fire(r);
    } else {
      const [h, m] = (r.timeOfDay ?? '09:00').split(':').map(Number);
      const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
      const fired = r.lastRun && r.lastRun >= todayAt;
      if (now.getTime() >= todayAt && !fired) fire(r);
    }
  }
}

export function startScheduler(): void {
  setInterval(tick, 60_000);
}

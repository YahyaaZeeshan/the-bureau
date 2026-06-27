import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { kbWrite } from './kb.js';
import { appendLog } from './logs.js';
import { bus } from './bus.js';

export interface Deliverable {
  id: string;
  agentId: string;
  title: string;
  content: string;
  ts: number;
  status: 'pending' | 'approved' | 'rejected';
  feedback?: string;
}

const DIR = path.join(DATA_DIR, 'deliverables');
fs.mkdirSync(DIR, { recursive: true });

const file = (id: string) => path.join(DIR, `${id}.json`);

export function submitDeliverable(agentId: string, title: string, content: string): Deliverable {
  const d: Deliverable = { id: crypto.randomUUID().slice(0, 8), agentId, title, content, ts: Date.now(), status: 'pending' };
  fs.writeFileSync(file(d.id), JSON.stringify(d, null, 2));
  appendLog(agentId, 'system', `deliverable submitted: "${title}" (${d.id}) — awaiting boss review`);
  bus.broadcast({ type: 'deliverables.changed' });
  return d;
}

export function listDeliverables(): Deliverable[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Deliverable)
    .sort((a, b) => b.ts - a.ts);
}

export function reviewDeliverable(id: string, approved: boolean, feedback?: string): Deliverable {
  const d = JSON.parse(fs.readFileSync(file(id), 'utf8')) as Deliverable;
  d.status = approved ? 'approved' : 'rejected';
  d.feedback = feedback;
  fs.writeFileSync(file(id), JSON.stringify(d, null, 2));
  if (approved) {
    const slug = d.title.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || d.id;
    kbWrite(`reports/${new Date(d.ts).toISOString().slice(0, 10)}-${slug}.md`, `# ${d.title}\n\n_by ${d.agentId}, approved ${new Date().toISOString().slice(0, 10)}_\n\n${d.content}`);
  }
  appendLog(d.agentId, 'system', `deliverable "${d.title}" ${d.status}${feedback ? ` — boss feedback: ${feedback}` : ''}`);
  bus.broadcast({ type: 'deliverables.changed' });
  return d;
}

export function deleteDeliverable(id: string): void {
  fs.rmSync(file(id));
  bus.broadcast({ type: 'deliverables.changed' });
}

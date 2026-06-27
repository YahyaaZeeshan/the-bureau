import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DRAFTS_DIR } from './config.js';

fs.mkdirSync(DRAFTS_DIR, { recursive: true });

export interface Draft {
  id: string;
  to: string;
  subject: string;
  body: string;
  by: string;
  ts: number;
  status: 'draft' | 'sent';
}

const file = (id: string) => path.join(DRAFTS_DIR, `${id}.json`);

export function saveDraft(by: string, to: string, subject: string, body: string): Draft {
  const draft: Draft = { id: crypto.randomUUID().slice(0, 8), to, subject, body, by, ts: Date.now(), status: 'draft' };
  fs.writeFileSync(file(draft.id), JSON.stringify(draft, null, 2));
  return draft;
}

export function getDraft(id: string): Draft {
  return JSON.parse(fs.readFileSync(file(id), 'utf8')) as Draft;
}

export function listDrafts(): Draft[] {
  return fs
    .readdirSync(DRAFTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8')) as Draft)
    .sort((a, b) => b.ts - a.ts);
}

export function markSent(id: string): void {
  const d = getDraft(id);
  d.status = 'sent';
  fs.writeFileSync(file(id), JSON.stringify(d, null, 2));
}

export function deleteDraft(id: string): void {
  fs.rmSync(file(id));
}

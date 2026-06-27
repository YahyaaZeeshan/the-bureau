import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './config.js';

fs.mkdirSync(MEMORY_DIR, { recursive: true });

const file = (agentId: string) => path.join(MEMORY_DIR, `${agentId.replace(/[^\w-]/g, '_')}.md`);

/**
 * Two-part memory to keep the per-turn prompt small while preserving signal:
 *   - CONSOLIDATED: a dense, durable summary the agent rebuilds at "end of day".
 *   - RECENT: raw lessons since the last consolidation (deduped, capped).
 * End-of-day folds RECENT into a fresh CONSOLIDATED and clears RECENT, so memory
 * stays compact instead of growing forever.
 */
const C_START = '<!--C-->';
const C_END = '<!--/C-->';
const MAX_RECENT = 20;

interface Mem {
  consolidated: string;
  recent: string[];
}

function parse(agentId: string): Mem {
  let raw = '';
  try {
    raw = fs.readFileSync(file(agentId), 'utf8');
  } catch {
    return { consolidated: '', recent: [] };
  }
  let consolidated = '';
  let rest = raw;
  const ci = raw.indexOf(C_START);
  const ce = raw.indexOf(C_END);
  if (ci >= 0 && ce > ci) {
    consolidated = raw.slice(ci + C_START.length, ce).trim();
    rest = raw.slice(ce + C_END.length);
  }
  const recent = rest.split('\n').map((l) => l.trim()).filter(Boolean);
  return { consolidated, recent };
}

function writeMem(agentId: string, m: Mem): void {
  const head = m.consolidated ? `${C_START}\n${m.consolidated.trim()}\n${C_END}\n` : '';
  fs.writeFileSync(file(agentId), head + m.recent.join('\n') + (m.recent.length ? '\n' : ''));
}

const lessonOf = (line: string) => line.replace(/^- \[\d{4}-\d{2}-\d{2}\]\s*/, '').trim().toLowerCase();

/** Text injected into the system prompt — full consolidated + a capped recent tail. */
export function readMemory(agentId: string, maxChars = 1500): string {
  const { consolidated, recent } = parse(agentId);
  const parts: string[] = [];
  if (consolidated) parts.push('Summary so far:\n' + consolidated);
  if (recent.length) {
    const budget = Math.max(300, maxChars - consolidated.length - 40);
    let recentText = recent.join('\n');
    if (recentText.length > budget) recentText = recentText.slice(-budget);
    parts.push('Recent notes:\n' + recentText);
  }
  return parts.join('\n\n');
}

export function appendMemory(agentId: string, lesson: string): void {
  const clean = lesson.trim();
  if (!clean) return;
  const m = parse(agentId);
  const key = clean.toLowerCase();
  if (m.recent.some((l) => lessonOf(l) === key)) return; // dedup
  if (m.consolidated.toLowerCase().includes(key)) return; // already summarized
  m.recent.push(`- [${new Date().toISOString().slice(0, 10)}] ${clean}`);
  if (m.recent.length > MAX_RECENT) m.recent = m.recent.slice(-MAX_RECENT);
  writeMem(agentId, m);
  // Auto-consolidate when recent entries pile up
  if (m.recent.length >= 15) {
    void autoConsolidate(agentId).catch(() => {});
  }
}

let _consolidating = new Set<string>();

/** Auto-consolidate memory via Groq when recent entries get long. */
async function autoConsolidate(agentId: string): Promise<void> {
  if (_consolidating.has(agentId)) return;
  _consolidating.add(agentId);
  try {
    const { groqChat } = await import('./integrations.js');
    const m = parse(agentId);
    if (m.recent.length < 12) return;
    const input = [
      m.consolidated ? `Previous summary:\n${m.consolidated}\n\n` : '',
      `New entries:\n${m.recent.join('\n')}`,
    ].join('');
    const summary = await groqChat(
      `${input}\n\n---\nConsolidate into a dense summary organized by topic (project knowledge, skills learned, team relationships, preferences/corrections). Keep only what's useful for future work. Max 15 bullets. Drop duplicates and tea-break small talk.`,
      'You consolidate an AI agent\'s working memory into a dense, useful summary. Output only the summary bullets.',
      { maxTokens: 600, temperature: 0.2 },
    );
    if (summary && summary.length > 50) {
      consolidateMemory(agentId, summary);
    }
  } finally {
    _consolidating.delete(agentId);
  }
}

/** Raw material for an end-of-day consolidation prompt. */
export function memoryForConsolidation(agentId: string): Mem {
  return parse(agentId);
}

/** Replace the consolidated block with a fresh dense summary and clear recent notes. */
export function consolidateMemory(agentId: string, summary: string): void {
  writeMem(agentId, { consolidated: summary.trim(), recent: [] });
}

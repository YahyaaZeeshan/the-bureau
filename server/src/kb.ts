import fs from 'node:fs';
import path from 'node:path';
import { parseOfficeAsync } from 'officeparser';
import { KB_DIR } from './config.js';
import { bus } from './bus.js';

fs.mkdirSync(KB_DIR, { recursive: true });

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.html', '.yaml', '.yml']);
/** Binary office/document formats we can extract text from via officeparser. */
const DOC_EXT = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods']);

/** Cache extracted text by file path + mtime so big PDFs/Docs aren't re-parsed each read. */
const extractCache = new Map<string, { mtime: number; text: string }>();

/** Extract plain text from a Word/PDF/PowerPoint/Excel/OpenDocument file. */
async function extractDoc(name: string): Promise<string> {
  const p = kbPath(name);
  const mtime = fs.statSync(p).mtimeMs;
  const hit = extractCache.get(p);
  if (hit && hit.mtime === mtime) return hit.text;
  let text: string;
  try {
    text = String(await parseOfficeAsync(p));
    if (!text || !text.trim()) text = `[${path.extname(name)} file with no extractable text — it may be scanned images or empty]`;
  } catch (e) {
    text = `[could not read ${name}: ${e instanceof Error ? e.message : String(e)}]`;
  }
  extractCache.set(p, { mtime, text });
  return text;
}

export const isReadable = (name: string): boolean => {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXT.has(ext) || DOC_EXT.has(ext);
};
const META_FILE = path.join(KB_DIR, '.kbmeta.json');

/** Per-file metadata. audience 'all' = everyone; array = only those agent ids (+ boss always). */
export interface KbMeta {
  audience: 'all' | string[];
  summary?: string;
  tags?: string[];
  by?: string;
  ts?: number;
}

function readMeta(): Record<string, KbMeta> {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeMeta(m: Record<string, KbMeta>): void {
  fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2));
}

export function getMeta(name: string): KbMeta {
  return readMeta()[name] ?? { audience: 'all' };
}

export function setMeta(name: string, patch: Partial<KbMeta>): void {
  const m = readMeta();
  m[name] = { ...{ audience: 'all' as const }, ...m[name], ...patch };
  writeMeta(m);
  bus.broadcast({ type: 'kb.changed' });
}

function deleteMeta(name: string): void {
  const m = readMeta();
  delete m[name];
  writeMeta(m);
}

/** Boss (agentId undefined) sees all. Agents see 'all' files or ones naming them. */
export function visibleTo(name: string, agentId?: string): boolean {
  if (!agentId) return true;
  const a = getMeta(name).audience;
  return a === 'all' || a.includes(agentId);
}

/** Resolve a KB filename safely inside KB_DIR (blocks path traversal). */
export function kbPath(name: string): string {
  const p = path.resolve(KB_DIR, name);
  if (!p.startsWith(path.resolve(KB_DIR))) throw new Error('invalid knowledge base path');
  return p;
}

export interface KbEntry {
  name: string;
  size: number;
  mtime: number;
  audience: 'all' | string[];
  summary?: string;
  tags?: string[];
}

/** List files. If agentId given, only those visible to that agent. */
export function kbList(agentId?: string): KbEntry[] {
  const meta = readMeta();
  const out: KbEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, prefix + e.name + '/');
      else {
        const name = prefix + e.name;
        if (agentId && !visibleTo(name, agentId)) continue;
        const st = fs.statSync(full);
        const m = meta[name] ?? { audience: 'all' as const };
        out.push({ name, size: st.size, mtime: st.mtimeMs, audience: m.audience, summary: m.summary, tags: m.tags });
      }
    }
  };
  walk(KB_DIR, '');
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function kbRead(name: string, agentId?: string): Promise<string> {
  if (agentId && !visibleTo(name, agentId)) throw new Error(`Not shared with you: ${name}`);
  const p = kbPath(name);
  const ext = path.extname(p).toLowerCase();
  let text: string;
  if (TEXT_EXT.has(ext)) text = fs.readFileSync(p, 'utf8');
  else if (DOC_EXT.has(ext)) text = await extractDoc(name);
  else return `[binary file: ${name} — ${fs.statSync(p).size} bytes, no text to extract]`;
  // Hard cap kbRead output: agents should call kb_find first (semantic, ~525 tokens
  // for 3 relevant chunks). A full kb_read used to allow 60K chars (~15K tokens) of
  // a single doc into the prompt — now capped at 12K. If they truly need the whole
  // doc, they can request it in pieces or summarize_text it.
  return text.length > 12_000 ? text.slice(0, 12_000) + '\n…[truncated — use kb_find for targeted passages or summarize_text on this output]' : text;
}

/** Read text of a file for analysis (text + Word/PDF/PPT/Excel). null = not extractable. */
export async function kbReadRaw(name: string, max = 30_000): Promise<string | null> {
  const ext = path.extname(name).toLowerCase();
  let text: string;
  if (TEXT_EXT.has(ext)) text = fs.readFileSync(kbPath(name), 'utf8');
  else if (DOC_EXT.has(ext)) text = await extractDoc(name);
  else return null;
  return text.slice(0, max);
}

export function kbWrite(name: string, content: string, meta?: Partial<KbMeta>): void {
  const p = kbPath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  if (meta) setMeta(name, { ts: Date.now(), ...meta });
  bus.broadcast({ type: 'kb.changed' });
}

export function kbWriteBinary(name: string, content: Buffer, meta?: Partial<KbMeta>): void {
  const p = kbPath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (meta) setMeta(name, { ts: Date.now(), ...meta });
  bus.broadcast({ type: 'kb.changed' });
}

export function kbDelete(name: string): void {
  fs.rmSync(kbPath(name));
  deleteMeta(name);
  bus.broadcast({ type: 'kb.changed' });
}

export function kbSearch(query: string, agentId?: string): { name: string; snippet: string }[] {
  const q = query.toLowerCase();
  const hits: { name: string; snippet: string }[] = [];
  for (const f of kbList(agentId)) {
    if (hits.length >= 20) break;
    const ext = path.extname(f.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      if (f.name.toLowerCase().includes(q)) hits.push({ name: f.name, snippet: '[filename match]' });
      continue;
    }
    try {
      const text = fs.readFileSync(kbPath(f.name), 'utf8');
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) hits.push({ name: f.name, snippet: text.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, ' ') });
      else if (f.name.toLowerCase().includes(q)) hits.push({ name: f.name, snippet: '[filename match]' });
    } catch {
      /* unreadable file — skip */
    }
  }
  return hits;
}

/** Short index for agent system prompts — only files visible to that agent. */
export function kbIndexText(agentId?: string, limit = 18): string {
  const all = kbList(agentId);
  if (!all.length) return '(knowledge base is empty / nothing shared with you yet)';
  const files = all.slice(0, limit);
  const lines = files.map((f) => `- ${f.name}${f.summary ? ' — ' + f.summary.slice(0, 90) : ''}`);
  if (all.length > limit) lines.push(`…and ${all.length - limit} more (use kb_search to find them)`);
  return lines.join('\n');
}

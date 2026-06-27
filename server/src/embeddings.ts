/**
 * Local semantic KB search — zero API cost.
 *
 * Embeds knowledge-base text into vectors with a small local model
 * (all-MiniLM-L6-v2 via @xenova/transformers, runs in-process, no network after
 * first model download). Agents can then pull the 2-3 most relevant CHUNKS for a
 * question instead of reading whole files — the real token saver as the KB grows.
 *
 * The vector index is cached to data/kb-embeddings.json and only re-embeds files
 * whose mtime changed, so repeated searches are cheap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { kbList, kbReadRaw } from './kb.js';

const INDEX_FILE = path.join(DATA_DIR, 'kb-embeddings.json');
const CHUNK = 700; // chars per chunk
const OVERLAP = 120;

interface Chunk { text: string; vec: number[] }
interface FileEntry { mtime: number; chunks: Chunk[] }
type Index = Record<string, FileEntry>;

// lazily-loaded embedding pipeline (downloads the model once, ~25MB)
let extractorPromise: Promise<any> | null = null;
async function extractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false; // pull from HF hub, cache locally
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
  }
  return extractorPromise;
}

async function embed(text: string): Promise<number[]> {
  const ext = await extractor();
  const out = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data as Float32Array);
}

function chunkText(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= CHUNK) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += CHUNK - OVERLAP) out.push(t.slice(i, i + CHUNK));
  return out;
}

const loadIndex = (): Index => { try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return {}; } };
const saveIndex = (idx: Index) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(INDEX_FILE, JSON.stringify(idx)); };

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; // vectors are pre-normalized
  return dot;
};

/** Embed any KB text files that are new or changed since last index. Returns the index. */
async function refreshIndex(agentId?: string): Promise<Index> {
  const idx = loadIndex();
  let dirty = false;
  for (const f of kbList(agentId)) {
    const cached = idx[f.name];
    if (cached && cached.mtime === f.mtime) continue;
    const raw = await kbReadRaw(f.name, 12_000).catch(() => null);
    if (raw == null) continue; // non-text / unreadable — skip
    const chunks: Chunk[] = [];
    for (const c of chunkText(raw)) chunks.push({ text: c, vec: await embed(c) });
    idx[f.name] = { mtime: f.mtime, chunks };
    dirty = true;
  }
  // drop entries for files that no longer exist / aren't visible
  const names = new Set(kbList().map((f) => f.name));
  for (const name of Object.keys(idx)) if (!names.has(name)) { delete idx[name]; dirty = true; }
  if (dirty) saveIndex(idx);
  return idx;
}

export interface SemanticHit { name: string; snippet: string; score: number }

/** Top-K most relevant KB chunks for a query, restricted to files visible to agentId. */
export async function semanticSearch(query: string, agentId?: string, topK = 3): Promise<SemanticHit[]> {
  const idx = await refreshIndex(agentId);
  const visible = new Set(kbList(agentId).map((f) => f.name));
  const qv = await embed(query);
  const scored: SemanticHit[] = [];
  for (const [name, entry] of Object.entries(idx)) {
    if (!visible.has(name)) continue;
    for (const ch of entry.chunks) scored.push({ name, snippet: ch.text, score: cosine(qv, ch.vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

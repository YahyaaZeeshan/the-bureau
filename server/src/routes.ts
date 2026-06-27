import express from 'express';
import { integrations } from './config.js';
import { runtime } from './agents.js';
import { kbList, kbRead, kbReadRaw, kbWrite, kbWriteBinary, kbDelete, getMeta, setMeta, kbPath } from './kb.js';
import { gruntComplete } from './integrations.js';
import { spotifyAuthUrl, spotifyExchangeCode } from './spotify.js';
import { listAgentDocs, readAgentDoc, writeAgentDoc, deleteAgentDoc } from './agentDocs.js';
import { readLogs, appendLog } from './logs.js';
import { appendMemory } from './memory.js';
import { listDrafts, getDraft, deleteDraft } from './drafts.js';
import { listDeliverables, reviewDeliverable, deleteDeliverable } from './deliverables.js';
import { listRoutines, upsertRoutine, deleteRoutine, runRoutineNow } from './routines.js';
import { ensureModels, transcodeToWav, transcribeWav, formatTranscript, modelsStatus, downloadStatus, type DiarizedSegment } from './sherpa.js';
import { bus } from './bus.js';
import fsSync from 'node:fs';
import pathMod from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Persona } from './types.js';

export const api = express.Router();

api.get('/health', (_req, res) => {
  res.json({ ok: true, integrations: integrations() });
});

// ── meeting: record → diarized transcript → notes doc ───────────────────
api.get('/meeting/status', (_req, res) => {
  res.json({ models: modelsStatus(), download: downloadStatus() });
});

/** Kick off model download proactively (so the user can pre-warm before recording). */
api.post('/meeting/download', (_req, res) => {
  res.json({ ok: true });
  void ensureModels((stage, got, total) => {
    bus.broadcast({ type: 'meeting.download', stage, got, total });
  }).catch((e) => bus.broadcast({ type: 'meeting.download', stage: `error: ${e instanceof Error ? e.message : String(e)}`, got: 0, total: 0 }));
});

/** Upload an audio blob (browser MediaRecorder output) → diarized transcript. */
api.post('/meeting/transcribe', express.raw({ limit: '300mb', type: '*/*' }), async (req, res) => {
  const tmpDir = pathMod.join(os.tmpdir(), 'pixel-office-meetings');
  fsSync.mkdirSync(tmpDir, { recursive: true });
  const id = crypto.randomUUID().slice(0, 8);
  const ext = (req.headers['content-type'] || '').includes('webm') ? '.webm' : (req.headers['content-type'] || '').includes('ogg') ? '.ogg' : '.bin';
  const inPath = pathMod.join(tmpDir, `${id}${ext}`);
  const wavPath = pathMod.join(tmpDir, `${id}.wav`);
  try {
    fsSync.writeFileSync(inPath, req.body as Buffer);
    bus.broadcast({ type: 'meeting.transcribing', stage: 'transcoding' });
    await transcodeToWav(inPath, wavPath);
    bus.broadcast({ type: 'meeting.transcribing', stage: 'transcribing' });
    const segments = await transcribeWav(wavPath);
    bus.broadcast({ type: 'meeting.transcribing', stage: 'done' });
    res.json({ id, segments, transcript: formatTranscript(segments), durationSec: segments.length ? Math.ceil(segments[segments.length - 1].end) : 0 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    bus.broadcast({ type: 'meeting.transcribing', stage: `error: ${message}` });
    res.status(500).json({ error: message });
  } finally {
    try { fsSync.rmSync(inPath, { force: true }); fsSync.rmSync(wavPath, { force: true }); } catch { /* ignore */ }
  }
});

/** Hand a transcript to Zola → she drafts the meeting notes doc (approval-gated). */
api.post('/meeting/notes', async (req, res) => {
  try {
    const { segments, topic } = req.body as { segments: DiarizedSegment[]; topic?: string };
    if (!Array.isArray(segments) || !segments.length) throw new Error('no segments');
    const transcript = formatTranscript(segments);
    const speakers = Array.from(new Set(segments.map((s) => s.speaker))).join(', ');
    const totalMin = Math.ceil((segments[segments.length - 1].end - segments[0].start) / 60);
    const filename = `meeting-${new Date().toISOString().slice(0, 10)}-${topic ? topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) : 'untitled'}`;
    const prompt = [
      `[The boss recorded a ${totalMin}-min meeting and asked you to draft the notes doc.]`,
      topic ? `Topic: ${topic}` : '',
      `Speakers detected: ${speakers}`,
      ``,
      `Use create_word_doc to produce a .docx named "${filename}" with this exact structure (markdown):`,
      `1. \`# Meeting Notes — <topic or auto-inferred title>\` plus a one-line date + duration.`,
      `2. \`## What was discussed\` — chronological narrative, grouped by topic shifts. Cite "[Speaker A]" / "[Speaker B]" when attribution matters. Be terse, factual, no filler.`,
      `3. \`## Action items\` — bullets. Where possible: \`- [owner] action — due by …\`. If owner is unclear, say "(unassigned)".`,
      `4. \`## Open questions\` — bullets, only if any genuine unresolved questions surfaced. Skip section if none.`,
      ``,
      `Raw transcript (timestamps for your reference; don't put them in the doc):`,
      transcript,
    ].filter(Boolean).join('\n');

    const reply = await runtime.send('notetaker', prompt, { from: 'meeting-notes' });
    res.json({ ok: true, reply, filename });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Spotify one-time authorization (for Zola's DJ controls) ──
// ── Agent docs (per-agent playbooks loaded into system prompts) ──
api.get('/agent-docs', (_req, res) => res.json(listAgentDocs()));
api.get('/agent-docs/file', (req, res) => {
  const name = String(req.query.name ?? '');
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json({ name, content: readAgentDoc(name) });
});
api.put('/agent-docs/file', (req, res) => {
  try {
    const { name, content } = req.body as { name: string; content: string };
    if (!name) throw new Error('name required');
    writeAgentDoc(name, content ?? '');
    // editing the playbook should reset that agent's session so the new prompt takes effect
    const m = name.match(/^([^_].*)\.md$/);
    if (m && runtime.personas.find((p) => p.id === m[1])) runtime.resetSession(m[1]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
api.delete('/agent-docs/file', (req, res) => {
  const name = String(req.query.name ?? '');
  deleteAgentDoc(name);
  res.json({ ok: true });
});

api.get('/spotify/login', (_req, res) => {
  try {
    res.redirect(spotifyAuthUrl());
  } catch (e) {
    res.status(400).send(e instanceof Error ? e.message : String(e));
  }
});

api.get('/spotify/callback', async (req, res) => {
  const code = String(req.query.code ?? '');
  if (!code) return res.status(400).send(`Spotify error: ${req.query.error ?? 'no code'}`);
  try {
    await spotifyExchangeCode(code);
    res.send('<h2>✅ Spotify linked.</h2><p>Zola can now play music. Close this tab.</p>');
  } catch (e) {
    res.status(400).send(`Spotify link failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// ── personas ───────────────────────────────────────────────
api.get('/personas', (_req, res) => res.json(runtime.personas));

api.post('/personas', (req, res) => {
  try {
    res.json(runtime.createPersona(req.body as Persona));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.delete('/personas/:id', (req, res) => {
  try {
    runtime.deletePersona(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.put('/personas/:id', (req, res) => {
  try {
    const body = req.body as Persona;
    if (body.id !== req.params.id) throw new Error('id mismatch');
    runtime.updatePersona(body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/personas/:id/reset-session', (req, res) => {
  runtime.resetSession(req.params.id);
  res.json({ ok: true });
});

// ── knowledge base ─────────────────────────────────────────
const parseAudience = (raw?: string): 'all' | string[] =>
  !raw || raw === 'all' ? 'all' : raw.split(',').map((s) => s.trim()).filter(Boolean);

api.get('/kb', (_req, res) => res.json(kbList()));

api.get('/kb/file', async (req, res) => {
  try {
    const name = String(req.query.name);
    res.json({ name, content: await kbRead(name), meta: getMeta(name) });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Download the raw bytes of a KB file (for .docx/.xlsx/.pptx/.pdf etc.). */
api.get('/kb/raw', (req, res) => {
  try {
    const name = String(req.query.name);
    res.download(kbPath(name), name.split('/').pop() || 'file');
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.put('/kb/file', (req, res) => {
  try {
    const { name, content, audience } = req.body as { name: string; content: string; audience?: string };
    kbWrite(name, content, audience !== undefined ? { audience: parseAudience(audience) } : undefined);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Set/replace a file's audience tag (+ optional summary/tags). */
api.put('/kb/audience', (req, res) => {
  try {
    const { name, audience, summary, tags } = req.body as { name: string; audience?: string; summary?: string; tags?: string[] };
    setMeta(name, { ...(audience !== undefined ? { audience: parseAudience(audience) } : {}), ...(summary !== undefined ? { summary } : {}), ...(tags !== undefined ? { tags } : {}) });
    res.json({ ok: true, meta: getMeta(name) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Analyze a text file with Groq: summary + suggested audience among the team. */
api.post('/kb/analyze', async (req, res) => {
  try {
    const { name } = req.body as { name: string };
    const raw = await kbReadRaw(name);
    if (raw === null) {
      res.json({ summary: '(this file type can’t be text-extracted — not analyzed)', suggested: 'all', tags: [] });
      return;
    }
    const roster = runtime.personas.map((p) => `${p.id} = ${p.name}, ${p.title}`).join('; ');
    const prompt = `A document named "${name}" was uploaded to a shared office knowledge base.\nTeam (id = role): ${roster}.\n\nDocument:\n${raw}\n\nReply ONLY as compact JSON: {"summary":"one or two sentences","tags":["kw1","kw2","kw3"],"suggested":"all" OR comma-separated agent ids who most need this}. Suggest "all" unless the doc is clearly only relevant to one or two roles.`;
    let parsed: { summary?: string; tags?: string[]; suggested?: string } = {};
    try {
      const out = await gruntComplete(prompt, 'You classify documents for a team knowledge base. Output strict JSON only.', { maxTokens: 500, temperature: 0.2 });
      parsed = JSON.parse(out.replace(/```json?|```/g, '').trim());
    } catch {
      parsed = { summary: raw.slice(0, 180).replace(/\s+/g, ' '), tags: [], suggested: 'all' };
    }
    res.json({ summary: parsed.summary ?? '', tags: parsed.tags ?? [], suggested: parsed.suggested ?? 'all' });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/kb/upload', express.raw({ limit: '50mb', type: '*/*' }), (req, res) => {
  try {
    const name = decodeURIComponent(String(req.query.name ?? ''));
    if (!name) throw new Error('name query param required');
    const audience = parseAudience(req.query.audience ? String(req.query.audience) : undefined);
    const by = req.query.by ? String(req.query.by) : 'boss';
    kbWriteBinary(name, req.body as Buffer, { audience, by, ts: Date.now() });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.delete('/kb/file', (req, res) => {
  try {
    kbDelete(String(req.query.name));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── ambient learning (watercooler knowledge sharing) ───────
api.post('/memory/:agentId', (req, res) => {
  try {
    const { lesson } = req.body as { lesson: string };
    if (!lesson?.trim()) throw new Error('lesson required');
    appendMemory(req.params.agentId, lesson.trim().slice(0, 300));
    appendLog(req.params.agentId, 'system', `watercooler learning: ${lesson.trim().slice(0, 200)}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── logs & drafts ──────────────────────────────────────────
api.get('/logs/:agentId', (req, res) => {
  res.json(readLogs(req.params.agentId, Number(req.query.limit ?? 200)));
});

api.get('/drafts', (_req, res) => res.json(listDrafts()));

api.get('/drafts/:id', (req, res) => {
  try {
    res.json(getDraft(req.params.id));
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

api.delete('/drafts/:id', (req, res) => {
  try {
    deleteDraft(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

// ── deliverables (boss inbox) ──────────────────────────────
api.get('/deliverables', (_req, res) => res.json(listDeliverables()));

api.post('/deliverables/:id/review', (req, res) => {
  try {
    const { approved, feedback } = req.body as { approved: boolean; feedback?: string };
    res.json(reviewDeliverable(req.params.id, approved, feedback));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.delete('/deliverables/:id', (req, res) => {
  try {
    deleteDeliverable(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

// ── routines (scheduled work) ──────────────────────────────
api.get('/routines', (_req, res) => res.json(listRoutines()));

api.put('/routines', (req, res) => {
  try {
    res.json(upsertRoutine(req.body));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/routines/:id/run', (req, res) => {
  runRoutineNow(req.params.id);
  res.json({ ok: true });
});

api.delete('/routines/:id', (req, res) => {
  deleteRoutine(req.params.id);
  res.json({ ok: true });
});

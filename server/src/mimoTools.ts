/**
 * MiMo tool registry — flat list of tools with Anthropic-format JSON schemas
 * and raw handler functions. Mirrors the surface of tools.ts (which used the
 * Claude Agent SDK MCP wrappers), but pure functions for use with mimoAgent.
 *
 * Toolset gating: each tool declares an optional `toolset` (jira / zoom / email
 * / scrape / hf / github / docs / spotify). When building the per-persona list
 * we include tools whose toolset is undefined (always-on) OR matches one of the
 * persona's declared toolsets AND its backing integration env is configured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env, WORKSPACES_DIR, ROOT } from './config.js';
import { readMemory } from './memory.js';
import {
  jiraFetch,
  adf,
  zoomFetch,
  zoomDownload,
  smartScrape,
  pageMarkdown,
  gruntComplete,
  hfFetch,
  ghFetch,
  sendEmail,
} from './integrations.js';
import { kbList, kbRead, kbWrite, kbDelete, kbSearch } from './kb.js';
import { semanticSearch } from './embeddings.js';
import { patchPlaybook, readAgentDoc, writeAgentDoc } from './agentDocs.js';
import { appendMemory } from './memory.js';
import { saveDraft, getDraft, listDrafts, markSent } from './drafts.js';
import { submitDeliverable } from './deliverables.js';
import { createWordDoc, createSpreadsheet, createPresentation } from './office.js';
import { compactText } from './compress.js';
import {
  spotifySearch, spotifyPlay, spotifyPause, spotifyResume, spotifyNext,
  spotifyPrevious, spotifySeek, spotifyVolume, spotifyNowPlaying,
  spotifyConfigured, spotifyLinked,
} from './spotify.js';
import type { Persona } from './types.js';
import type { MimoTool } from './mimoAgent.js';

/** Lookup context passed in by AgentRuntime for tools that need cross-agent state. */
export interface ToolsCtx {
  persona: Persona;
  /** roster getter — for team_roster + team_message lookups */
  roster: () => Persona[];
  /** send a message to another agent and get their reply (depth-limited) */
  sendToAgent: (targetId: string, fromId: string, message: string, depth: number) => Promise<string>;
  /** depth ref so team_message → team_message chains can be bounded */
  depthRef: { depth: number };
}

const S = (v: unknown) => String(v ?? '');
const N = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const workspace = (id: string) => path.join(WORKSPACES_DIR, id.replace(/[^\w-]/g, '_'));

/** Resolve a path inside the agent's workspace; throw if it escapes. */
function safeWorkspacePath(ws: string, requested: string): string {
  const resolved = path.resolve(ws, requested);
  const root = path.resolve(ws);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return resolved;
}

/** Recursive walk capped at 5000 files (workspace shouldn't be that big). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < 5000) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push(full);
      } else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/** Convert a glob with `*` and `**` into a regex. Anchored. */
function globToRegex(glob: string): RegExp {
  // Escape regex metachars except * and ?, then translate.
  let re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  re = re.replace(/\*\*\/?/g, '<DOUBLESTAR>').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/<DOUBLESTAR>/g, '(?:.*/)?');
  return new RegExp('^' + re + '$');
}

/** Path to the project-local agent-reach venv (where yt-dlp lives). */
const REACH_VENV_BIN = path.join(ROOT, 'vendor', 'agent-reach-venv', 'Scripts');
const YT_DLP_BIN = path.join(REACH_VENV_BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

/** Universal URL reader via Jina Reader — handles tweets, articles, GitHub,
 *  LinkedIn public, Reddit, etc. better than raw HTML strip. Free, no key. */
async function jinaRead(url: string): Promise<string> {
  const r = await fetch('https://r.jina.ai/' + url, {
    headers: { 'User-Agent': 'PixelOffice/1.0', 'X-Return-Format': 'markdown' },
  });
  if (!r.ok) throw new Error(`Jina Reader HTTP ${r.status}`);
  return r.text();
}

/** Pull a YouTube transcript via yt-dlp. Auto-generated subs if no human ones. */
async function ytTranscript(url: string, agentWorkspace: string): Promise<string> {
  const { spawnSync } = await import('node:child_process');
  if (!fs.existsSync(YT_DLP_BIN)) throw new Error('yt-dlp not installed. Run: vendor/agent-reach-venv/Scripts/pip install yt-dlp');
  // Tell yt-dlp to write English VTT subs (or auto-generated) into a temp prefix
  // inside the agent's workspace and not download the video.
  const prefix = path.join(agentWorkspace, `_yt_${Date.now()}`);
  const args = ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-lang', 'en.*', '--sub-format', 'vtt', '--no-warnings', '--no-playlist', '-o', prefix + '.%(ext)s', url];
  const r = spawnSync(YT_DLP_BIN, args, { encoding: 'utf8', timeout: 90_000 });
  if (r.status !== 0) throw new Error(`yt-dlp failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  // Find any .vtt file matching our prefix and read it.
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  let vtt = '';
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.endsWith('.vtt'));
    if (hit) {
      vtt = fs.readFileSync(path.join(dir, hit), 'utf8');
      fs.rmSync(path.join(dir, hit));
    }
  } catch { /* leave empty */ }
  if (!vtt) return '(no transcript available — video may have subs disabled)';
  // Strip VTT headers + timestamps, dedup repeated lines, return plain text.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of vtt.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trim();
    if (!line || /^(WEBVTT|Kind:|Language:|NOTE)/.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join(' ');
}

/** DuckDuckGo HTML search — free, no API key. Returns [{title, url, snippet}]. */
async function duckduckgoSearch(query: string, max = 5): Promise<{ title: string; url: string; snippet: string }[]> {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PixelOffice/1.0)' },
  });
  if (!r.ok) throw new Error(`web search HTTP ${r.status}`);
  const html = await r.text();
  // Lightweight parse: each result is wrapped in a div with class "result". Pull
  // anchor href + title + snippet without bringing in a real HTML parser.
  const out: { title: string; url: string; snippet: string }[] = [];
  const reBlock = /<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  const reAnchor = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const reSnippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;
  while ((m = reBlock.exec(html)) && out.length < max) {
    const block = m[0];
    const a = reAnchor.exec(block);
    const sn = reSnippet.exec(block);
    if (!a) continue;
    let url = a[1];
    // DDG wraps real URLs in a redirect: /l/?uddg=ENCODED_URL
    const urlMatch = url.match(/uddg=([^&]+)/);
    if (urlMatch) url = decodeURIComponent(urlMatch[1]);
    out.push({ title: strip(a[2]), url, snippet: sn ? strip(sn[1]) : '' });
  }
  return out;
}

/** Anthropic input_schema = JSON Schema object. */
type Schema = Record<string, unknown>;
const obj = (props: Record<string, Schema>, required: string[] = []): Schema =>
  ({ type: 'object', properties: props, required });
const str = (description?: string): Schema => description ? { type: 'string', description } : { type: 'string' };
const num = (): Schema => ({ type: 'number' });
const arr = (items: Schema = { type: 'string' }): Schema => ({ type: 'array', items });

// ── tool definitions ─────────────────────────────────────────────────────
// Each tool: name, description, input_schema, optional toolset gate, handler.

function build(ctx: ToolsCtx): (MimoTool & { toolset?: string })[] {
  const agentId = ctx.persona.id;
  return [
    // ── kb (always-on) ──
    { name: 'kb_list', description: 'List knowledge base files shared with you', input_schema: obj({}),
      run: async () => JSON.stringify(kbList(agentId).slice(0, 40)) },
    { name: 'kb_read', description: 'Read a knowledge base file (text, Word, PDF, PowerPoint, Excel). Use kb_find FIRST for targeted passages — only kb_read whole files when you actually need them.',
      input_schema: obj({ name: str() }, ['name']),
      run: async (a) => compactText(await kbRead(S(a.name), agentId)) },
    { name: 'kb_search', description: 'Keyword search the knowledge base',
      input_schema: obj({ query: str() }, ['query']),
      run: async (a) => JSON.stringify(kbSearch(S(a.query), agentId)) },
    { name: 'kb_find', description: 'SEMANTIC search the knowledge base — returns 2-3 most relevant passages (not whole files). Prefer this over kb_read for questions.',
      input_schema: obj({ query: str(), topK: num() }, ['query']),
      run: async (a) => {
        try {
          const hits = await semanticSearch(S(a.query), agentId, N(a.topK, 3));
          if (!hits.length) return 'No relevant passages. Try kb_search.';
          return hits.map((h) => `### ${h.name} (relevance ${h.score.toFixed(2)})\n${h.snippet}`).join('\n\n');
        } catch (e) {
          return `(semantic search unavailable: ${e instanceof Error ? e.message : String(e)} — falling back to keyword)\n` + JSON.stringify(kbSearch(S(a.query), agentId));
        }
      } },
    { name: 'kb_write', description: 'Create or overwrite a knowledge base document (requires approval). audience: "all" or comma-separated agent ids.',
      input_schema: obj({ name: str(), content: str(), audience: str() }, ['name', 'content']),
      sensitive: true,
      run: async (a) => {
        const audience = !a.audience || S(a.audience).trim() === 'all' ? 'all' : S(a.audience).split(',').map((s) => s.trim()).filter(Boolean);
        kbWrite(S(a.name), S(a.content), { audience, by: agentId, ts: Date.now() });
        return `Saved ${S(a.name)}`;
      } },
    { name: 'kb_delete', description: 'Delete a knowledge base file (requires approval)',
      input_schema: obj({ name: str() }, ['name']),
      sensitive: true, run: async (a) => { kbDelete(S(a.name)); return `Deleted ${S(a.name)}`; } },

    // ── docs (offload bulk text) ──
    { name: 'summarize_text', description: 'Offload bulk text work to a fast free model: summarize, condense, extract, classify. Use BEFORE pulling large content into your own context.',
      input_schema: obj({ text: str(), instruction: str() }, ['text', 'instruction']),
      run: async (a) => gruntComplete(
        `${S(a.text)}\n\n---\nTask: ${S(a.instruction)}\nBe precise; never invent facts.`,
        'You condense and extract from text. Output only the result.',
        { maxTokens: 1200, temperature: 0.2 },
      ) },

    // ── deliverables / memory / playbook ──
    { name: 'submit_deliverable', description: 'Submit a finished report/document/finding to the boss for review in the Inbox',
      input_schema: obj({ title: str(), content: str() }, ['title', 'content']),
      run: async (a) => { const d = submitDeliverable(agentId, S(a.title), S(a.content)); return `Submitted "${S(a.title)}" (${d.id}) to the boss's Inbox`; } },
    { name: 'remember', description: 'Save a durable lesson/preference you learned, so future conversations improve',
      input_schema: obj({ lesson: str() }, ['lesson']),
      run: async (a) => { appendMemory(agentId, S(a.lesson)); return 'Remembered.'; } },
    { name: 'read_playbook', description: 'Read your own playbook (your role document)', input_schema: obj({}),
      run: async () => readAgentDoc(`${agentId}.md`) || '(playbook empty)' },
    { name: 'update_playbook', description: 'Add a dated note to your playbook (append) or replace it whole. Use append for lessons learned, replace for full rewrites.',
      input_schema: obj({ append: str(), replace: str() }),
      run: async (a) => patchPlaybook(agentId, { append: a.append ? S(a.append) : undefined, replace: a.replace !== undefined ? S(a.replace) : undefined }) },

    // ── team (always-on) ──
    { name: 'team_roster', description: 'List your coworkers and their specialties', input_schema: obj({}),
      run: async () => JSON.stringify(ctx.roster().filter((p) => p.id !== agentId).map((p) => ({ id: p.id, name: p.name, title: p.title }))) },
    { name: 'team_message', description: 'Send a message to a coworker agent and get their reply. Use ids from team_roster.',
      input_schema: obj({ targetId: str(), message: str() }, ['targetId', 'message']),
      run: async (a) => {
        if (a.targetId === agentId) return 'ERROR: that is you';
        if (ctx.depthRef.depth >= 2) return 'ERROR: conversation chain too deep — summarize and report to the boss';
        try { return await ctx.sendToAgent(S(a.targetId), agentId, S(a.message), ctx.depthRef.depth + 1); }
        catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      } },

    // ── jira ──
    { name: 'jira_projects', description: 'List visible Jira projects', input_schema: obj({}), toolset: 'jira',
      run: async () => { const d = await jiraFetch('GET', '/project/search?maxResults=50'); return JSON.stringify((d.values ?? []).map((p: any) => ({ key: p.key, name: p.name }))); } },
    { name: 'jira_search', description: 'Search Jira issues with JQL', toolset: 'jira',
      input_schema: obj({ jql: str(), maxResults: num() }, ['jql']),
      run: async (a) => {
        const d = await jiraFetch('POST', '/search/jql', { jql: S(a.jql), maxResults: N(a.maxResults, 25), fields: ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated'] });
        return JSON.stringify({ total: d.total, issues: (d.issues ?? []).map((i: any) => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, assignee: i.fields?.assignee?.displayName ?? null, priority: i.fields?.priority?.name, type: i.fields?.issuetype?.name })) });
      } },
    { name: 'jira_get', description: 'Get full detail of one Jira issue', toolset: 'jira',
      input_schema: obj({ key: str() }, ['key']),
      run: async (a) => { const i = await jiraFetch('GET', `/issue/${S(a.key)}`); return JSON.stringify({ key: i.key, summary: i.fields?.summary, description: JSON.stringify(i.fields?.description)?.slice(0, 2000), status: i.fields?.status?.name, assignee: i.fields?.assignee?.displayName, labels: i.fields?.labels }); } },
    { name: 'jira_create', description: 'Create a Jira issue (requires approval)', toolset: 'jira',
      input_schema: obj({ projectKey: str(), summary: str(), description: str(), issueType: str() }, ['projectKey', 'summary']),
      sensitive: true,
      run: async (a) => { const d = await jiraFetch('POST', '/issue', { fields: { project: { key: S(a.projectKey) }, summary: S(a.summary), ...(a.description ? { description: adf(S(a.description)) } : {}), issuetype: { name: S(a.issueType) || 'Task' } } }); return `Created ${d.key}`; } },
    { name: 'jira_update', description: 'Update Jira issue summary/description/labels (requires approval)', toolset: 'jira',
      input_schema: obj({ key: str(), summary: str(), description: str(), labels: arr() }, ['key']),
      sensitive: true,
      run: async (a) => { const fields: any = {}; if (a.summary) fields.summary = S(a.summary); if (a.description) fields.description = adf(S(a.description)); if (Array.isArray(a.labels)) fields.labels = a.labels; await jiraFetch('PUT', `/issue/${S(a.key)}`, { fields }); return `Updated ${S(a.key)}`; } },
    { name: 'jira_delete', description: 'Delete a Jira issue (requires approval)', toolset: 'jira',
      input_schema: obj({ key: str() }, ['key']),
      sensitive: true, run: async (a) => { await jiraFetch('DELETE', `/issue/${S(a.key)}`); return `Deleted ${S(a.key)}`; } },
    { name: 'jira_transition', description: 'Move a Jira issue to another status (requires approval)', toolset: 'jira',
      input_schema: obj({ key: str(), transition: str() }, ['key', 'transition']),
      sensitive: true,
      run: async (a) => { const d = await jiraFetch('GET', `/issue/${S(a.key)}/transitions`); const t = (d.transitions ?? []).find((x: any) => x.name.toLowerCase() === S(a.transition).toLowerCase()); if (!t) return `No transition "${S(a.transition)}". Available: ${(d.transitions ?? []).map((x: any) => x.name).join(', ')}`; await jiraFetch('POST', `/issue/${S(a.key)}/transitions`, { transition: { id: t.id } }); return `${S(a.key)} → ${t.name}`; } },
    { name: 'jira_comment', description: 'Comment on a Jira issue (requires approval)', toolset: 'jira',
      input_schema: obj({ key: str(), body: str() }, ['key', 'body']),
      sensitive: true, run: async (a) => { await jiraFetch('POST', `/issue/${S(a.key)}/comment`, { body: adf(S(a.body)) }); return `Commented on ${S(a.key)}`; } },

    // ── zoom ──
    { name: 'zoom_list_recordings', description: 'List Zoom cloud recordings (YYYY-MM-DD; default last 30 days)', toolset: 'zoom',
      input_schema: obj({ from: str(), to: str() }),
      run: async (a) => { const to = S(a.to) || new Date().toISOString().slice(0, 10); const from = S(a.from) || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10); const d = await zoomFetch(`/users/me/recordings?from=${from}&to=${to}&page_size=30`); return JSON.stringify((d.meetings ?? []).map((m: any) => ({ id: m.id, topic: m.topic, start: m.start_time }))); } },
    { name: 'zoom_get_transcript', description: 'Download the transcript of a recorded meeting', toolset: 'zoom',
      input_schema: obj({ meetingId: str() }, ['meetingId']),
      run: async (a) => { const d = await zoomFetch(`/meetings/${encodeURIComponent(S(a.meetingId))}/recordings`); const t = (d.recording_files ?? []).find((f: any) => f.file_type === 'TRANSCRIPT'); if (!t) return 'No transcript on that recording.'; const vtt = await zoomDownload(t.download_url); return vtt.length > 24_000 ? vtt.slice(0, 24_000) + '\n…[truncated — pass through summarize_text for action items]' : vtt; } },
    { name: 'zoom_upcoming_meetings', description: 'List upcoming Zoom meetings', toolset: 'zoom', input_schema: obj({}),
      run: async () => { const d = await zoomFetch('/users/me/meetings?type=upcoming&page_size=20'); return JSON.stringify((d.meetings ?? []).map((m: any) => ({ id: m.id, topic: m.topic, start: m.start_time }))); } },

    // ── scrape ──
    { name: 'scrape_page', description: 'Extract structured info from a webpage. Fetches locally + free model extracts only the asked-for fields (no raw HTML in your context).', toolset: 'scrape',
      input_schema: obj({ url: str(), prompt: str('what to extract') }, ['url', 'prompt']),
      run: async (a) => { const r = await smartScrape(S(a.url), S(a.prompt)); return typeof r === 'string' ? compactText(r) : JSON.stringify(r); } },
    { name: 'markdownify', description: 'Convert a webpage to clean readable text', toolset: 'scrape',
      input_schema: obj({ url: str() }, ['url']),
      run: async (a) => compactText(await pageMarkdown(S(a.url))) },

    // ── email ──
    { name: 'email_save_draft', description: 'Save a personalized email draft for the boss to review', toolset: 'email',
      input_schema: obj({ to: str(), subject: str(), body: str() }, ['to', 'subject', 'body']),
      run: async (a) => { const d = saveDraft(agentId, S(a.to), S(a.subject), S(a.body)); return `Draft saved id ${d.id}; ask the boss to review, then email_send.`; } },
    { name: 'email_list_drafts', description: 'List saved email drafts', toolset: 'email', input_schema: obj({}),
      run: async () => JSON.stringify(listDrafts().map((d) => ({ id: d.id, to: d.to, subject: d.subject, status: d.status }))) },
    { name: 'email_send', description: 'Send a saved draft by id (requires approval)', toolset: 'email',
      input_schema: obj({ draftId: str() }, ['draftId']),
      sensitive: true, run: async (a) => { const d = getDraft(S(a.draftId)); const msgId = await sendEmail(d.to, d.subject, d.body); markSent(S(a.draftId)); return `Sent to ${d.to} (${msgId})`; } },

    // ── hugging face ──
    { name: 'hf_search_models', description: 'Search Hugging Face models (optional pipeline task filter)', toolset: 'hf',
      input_schema: obj({ query: str(), task: str(), limit: num() }, ['query']),
      run: async (a) => { const params = new URLSearchParams({ search: S(a.query), limit: String(N(a.limit, 10)), sort: 'downloads' }); if (a.task) params.set('pipeline_tag', S(a.task)); const d = await hfFetch(`/models?${params}`); return JSON.stringify((d as any[]).map((m) => ({ id: m.modelId ?? m.id, downloads: m.downloads, task: m.pipeline_tag }))); } },
    { name: 'hf_search_spaces', description: 'Search Hugging Face Spaces', toolset: 'hf',
      input_schema: obj({ query: str(), limit: num() }, ['query']),
      run: async (a) => { const d = await hfFetch(`/spaces?search=${encodeURIComponent(S(a.query))}&limit=${N(a.limit, 10)}&sort=likes`); return JSON.stringify((d as any[]).map((s) => ({ id: s.id, likes: s.likes, url: `https://huggingface.co/spaces/${s.id}` }))); } },
    { name: 'hf_model_info', description: 'Get details of one Hugging Face model', toolset: 'hf',
      input_schema: obj({ id: str() }, ['id']),
      run: async (a) => { const m = await hfFetch(`/models/${S(a.id)}`); return JSON.stringify({ id: m.id, task: m.pipeline_tag, downloads: m.downloads, tags: (m.tags ?? []).slice(0, 20) }); } },

    // ── github ──
    { name: 'gh_search_repos', description: 'Search GitHub repositories', toolset: 'github',
      input_schema: obj({ query: str(), limit: num() }, ['query']),
      run: async (a) => { const d = await ghFetch(`/search/repositories?q=${encodeURIComponent(S(a.query))}&per_page=${N(a.limit, 8)}&sort=stars`); return JSON.stringify((d.items ?? []).map((r: any) => ({ full_name: r.full_name, stars: r.stargazers_count, desc: r.description, url: r.html_url }))); } },
    { name: 'gh_readme', description: 'Fetch the README of a repo (owner/name)', toolset: 'github',
      input_schema: obj({ repo: str() }, ['repo']),
      run: async (a) => { const d = await ghFetch(`/repos/${S(a.repo)}/readme`); return compactText(Buffer.from(d.content ?? '', 'base64').toString('utf8')); } },
    { name: 'gh_clone', description: 'Clone a GitHub repo into your workspace (requires approval)', toolset: 'github',
      input_schema: obj({ repoUrl: str() }, ['repoUrl']),
      sensitive: true,
      run: async (a) => { const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile); const name = S(a.repoUrl).split('/').pop()?.replace(/\.git$/, '') ?? 'repo'; await run('git', ['clone', '--depth', '1', S(a.repoUrl), name], { cwd: workspace(agentId) }); return `Cloned into workspace/${name}`; } },

    // ── docs (office docs) ──
    { name: 'create_word_doc', description: 'Create a Word .docx from markdown (requires approval). Opens in MS Word + Google Docs.', toolset: 'docs',
      input_schema: obj({ name: str(), markdown: str(), audience: str() }, ['name', 'markdown']),
      sensitive: true,
      run: async (a) => { const audience = !a.audience || S(a.audience).trim() === 'all' ? 'all' : S(a.audience).split(',').map((s) => s.trim()).filter(Boolean); const p = await createWordDoc(S(a.name), S(a.markdown), { audience, by: agentId, ts: Date.now() }); return `Created ${p}`; } },
    { name: 'create_spreadsheet', description: 'Create an Excel .xlsx (requires approval). sheets:[{name,headers,rows}]', toolset: 'docs',
      input_schema: obj({ name: str(), sheets: arr({ type: 'object' }), audience: str() }, ['name', 'sheets']),
      sensitive: true,
      run: async (a) => { const audience = !a.audience || S(a.audience).trim() === 'all' ? 'all' : S(a.audience).split(',').map((s) => s.trim()).filter(Boolean); const p = await createSpreadsheet(S(a.name), a.sheets as any, { audience, by: agentId, ts: Date.now() }); return `Created ${p}`; } },
    { name: 'create_presentation', description: 'Create a PowerPoint .pptx (requires approval). slides:[{title,bullets}]', toolset: 'docs',
      input_schema: obj({ name: str(), slides: arr({ type: 'object' }), audience: str() }, ['name', 'slides']),
      sensitive: true,
      run: async (a) => { const audience = !a.audience || S(a.audience).trim() === 'all' ? 'all' : S(a.audience).split(',').map((s) => s.trim()).filter(Boolean); const p = await createPresentation(S(a.name), a.slides as any, { audience, by: agentId, ts: Date.now() }); return `Created ${p}`; } },

    // ── spotify ──
    { name: 'spotify_search', description: 'Search Spotify for tracks/playlists/albums', toolset: 'spotify',
      input_schema: obj({ query: str(), type: str(), limit: num() }, ['query']),
      run: async (a) => JSON.stringify(await spotifySearch(S(a.query), (S(a.type) || 'track') as any, N(a.limit, 5))) },
    { name: 'spotify_play', description: 'Play a track/playlist/album. Give a spotify uri OR a search query (plays top hit). Music control is non-sensitive — use freely to set the office mood.', toolset: 'spotify',
      input_schema: obj({ uri: str(), query: str() }),
      run: async (a) => spotifyPlay({ uri: a.uri ? S(a.uri) : undefined, query: a.query ? S(a.query) : undefined }) },
    { name: 'spotify_pause', description: 'Pause playback', toolset: 'spotify', input_schema: obj({}), run: () => spotifyPause() },
    { name: 'spotify_resume', description: 'Resume playback', toolset: 'spotify', input_schema: obj({}), run: () => spotifyResume() },
    { name: 'spotify_next', description: 'Skip to next song', toolset: 'spotify', input_schema: obj({}), run: () => spotifyNext() },
    { name: 'spotify_previous', description: 'Previous song', toolset: 'spotify', input_schema: obj({}), run: () => spotifyPrevious() },
    { name: 'spotify_seek', description: 'Seek within current song. ms (absolute) OR fraction 0-1 (e.g. 0.5 = halfway).', toolset: 'spotify',
      input_schema: obj({ ms: num(), fraction: num() }),
      run: async (a) => spotifySeek({ ms: a.ms !== undefined ? N(a.ms, 0) : undefined, fraction: a.fraction !== undefined ? N(a.fraction, 0) : undefined }) },
    { name: 'spotify_volume', description: 'Set volume 0-100', toolset: 'spotify',
      input_schema: obj({ percent: num() }, ['percent']),
      run: async (a) => spotifyVolume(N(a.percent, 50)) },
    { name: 'spotify_now_playing', description: 'What is currently playing', toolset: 'spotify', input_schema: obj({}), run: () => spotifyNowPlaying() },

    // ── workspace tools (file ops + shell, scoped to YOUR workspace) ──
    { name: 'Read', description: 'Read a file in your workspace', toolset: 'bash',
      input_schema: obj({ file_path: str('relative path inside your workspace') }, ['file_path']),
      run: async (a) => {
        const ws = workspace(agentId);
        const p = safeWorkspacePath(ws, S(a.file_path));
        try {
          const text = fs.readFileSync(p, 'utf8');
          return text.length > 24_000 ? text.slice(0, 24_000) + '\n…[truncated to 24K chars]' : text;
        } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      } },
    { name: 'Write', description: 'Create or overwrite a file in your workspace (requires approval)', toolset: 'bash',
      input_schema: obj({ file_path: str(), content: str() }, ['file_path', 'content']),
      sensitive: true,
      run: async (a) => {
        const p = safeWorkspacePath(workspace(agentId), S(a.file_path));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, S(a.content));
        return `Wrote ${S(a.file_path)} (${S(a.content).length} chars)`;
      } },
    { name: 'Edit', description: 'Replace exact old_string with new_string in a workspace file (requires approval)', toolset: 'bash',
      input_schema: obj({ file_path: str(), old_string: str(), new_string: str() }, ['file_path', 'old_string', 'new_string']),
      sensitive: true,
      run: async (a) => {
        const p = safeWorkspacePath(workspace(agentId), S(a.file_path));
        let text = fs.readFileSync(p, 'utf8');
        const old = S(a.old_string);
        if (!text.includes(old)) return `ERROR: old_string not found in ${S(a.file_path)}`;
        const idx = text.indexOf(old);
        const second = text.indexOf(old, idx + 1);
        if (second >= 0) return `ERROR: old_string appears more than once in ${S(a.file_path)} — provide more surrounding context to make it unique`;
        text = text.replace(old, S(a.new_string));
        fs.writeFileSync(p, text);
        return `Edited ${S(a.file_path)}`;
      } },
    { name: 'Glob', description: 'Find files in your workspace matching a glob pattern (e.g. "**/*.py")', toolset: 'bash',
      input_schema: obj({ pattern: str() }, ['pattern']),
      run: async (a) => {
        const ws = workspace(agentId);
        const all = walkFiles(ws);
        const re = globToRegex(S(a.pattern));
        const hits = all.map((f) => path.relative(ws, f).replace(/\\/g, '/')).filter((rel) => re.test(rel));
        return JSON.stringify(hits.slice(0, 200));
      } },
    { name: 'Grep', description: 'Search workspace files for a regex pattern. Returns up to 30 hits.', toolset: 'bash',
      input_schema: obj({ pattern: str('regex'), path: str('optional subdir or file'), glob: str('optional filename glob filter') }, ['pattern']),
      run: async (a) => {
        const ws = workspace(agentId);
        const root = a.path ? safeWorkspacePath(ws, S(a.path)) : ws;
        const files = fs.statSync(root).isFile() ? [root] : walkFiles(root);
        const re = new RegExp(S(a.pattern), 'mi');
        const fileFilter = a.glob ? globToRegex(S(a.glob)) : null;
        const hits: { file: string; line: number; text: string }[] = [];
        for (const f of files) {
          const rel = path.relative(ws, f).replace(/\\/g, '/');
          if (fileFilter && !fileFilter.test(rel)) continue;
          let content = '';
          try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && hits.length < 30; i++) {
            if (re.test(lines[i])) hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 200) });
          }
          if (hits.length >= 30) break;
        }
        return JSON.stringify(hits);
      } },
    { name: 'Bash', description: 'Run a shell command in your workspace (requires approval). Output capped 8K chars, 60s timeout.', toolset: 'bash',
      input_schema: obj({ command: str() }, ['command']),
      sensitive: true,
      run: async (a) => {
        const { spawnSync } = await import('node:child_process');
        const r = spawnSync(S(a.command), { shell: true, cwd: workspace(agentId), timeout: 60_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
        const out = (r.stdout || '') + (r.stderr ? '\n--- stderr ---\n' + r.stderr : '');
        const trimmed = out.length > 8000 ? out.slice(0, 8000) + '\n…[truncated]' : out;
        return trimmed || `(no output, exit ${r.status})`;
      } },

    // ── web tools ──
    { name: 'WebFetch', description: 'Fetch a URL and return readable text (no JS rendering). Use for reading articles, docs, READMEs, etc.', toolset: 'web',
      input_schema: obj({ url: str() }, ['url']),
      run: async (a) => compactText(await pageMarkdown(S(a.url))) },
    { name: 'WebSearch', description: 'Search the web (DuckDuckGo, no API key). Returns top 5 results with title, url, snippet.', toolset: 'web',
      input_schema: obj({ query: str(), limit: num() }, ['query']),
      run: async (a) => {
        try { return JSON.stringify(await duckduckgoSearch(S(a.query), N(a.limit, 5))); }
        catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      } },

    // ── reach (Agent-Reach wrappers — universal reader + YouTube transcripts) ──
    { name: 'reach_read', description: 'Universal URL reader via Jina Reader — handles tweets, articles, GitHub READMEs, LinkedIn public pages, Reddit threads, etc. as clean markdown. Use this INSTEAD of WebFetch for tweets/Reddit/social.', toolset: 'reach',
      input_schema: obj({ url: str() }, ['url']),
      run: async (a) => {
        try {
          const md = await jinaRead(S(a.url));
          return compactText(md);
        } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      } },
    { name: 'reach_youtube_transcript', description: 'Extract the spoken transcript from a YouTube video (auto-captions or human-provided). Returns plain text. Use BEFORE summarize_text to ingest a video into a summary.', toolset: 'reach',
      input_schema: obj({ url: str() }, ['url']),
      run: async (a) => {
        try {
          const text = await ytTranscript(S(a.url), workspace(agentId));
          return text.length > 24_000 ? text.slice(0, 24_000) + '\n…[truncated — pass to summarize_text]' : text;
        } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      } },

    // ── project context (always-on) ──
    { name: 'project_context', description: 'Read the shared company/project context document. Contains company info, current priorities, team structure.',
      input_schema: obj({}),
      run: async () => readAgentDoc('_project.md') || '(no project context doc yet — ask the boss)' },
    { name: 'update_project_context', description: 'Append a note to the shared project context (e.g. new priority, new decision). All agents see this.',
      input_schema: obj({ note: str() }, ['note']),
      sensitive: true,
      run: async (a) => {
        const cur = readAgentDoc('_project.md');
        const stamp = new Date().toISOString().slice(0, 10);
        const next = `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}\n## Update ${stamp}\n${S(a.note).trim()}\n`;
        writeAgentDoc('_project.md', next);
        return 'Project context updated. All agents will see this.';
      } },

    // ── cross-agent context (always-on, so they can brief each other) ──
    { name: 'coworker_memory', description: 'Read a coworker\'s recent memory/lessons. Use BEFORE messaging them with a task so you have shared context.',
      input_schema: obj({ coworkerId: str() }, ['coworkerId']),
      run: async (a) => {
        const id = S(a.coworkerId);
        const target = ctx.roster().find((p) => p.id === id);
        if (!target) return `ERROR: no coworker with id "${id}". Use team_roster.`;
        const mem = readMemory(id, 1500);
        return mem || `(${target.name} has no recorded memory yet)`;
      } },
    { name: 'coworker_playbook', description: 'Read a coworker\'s playbook (their role document — skills, workflow, hard rules).',
      input_schema: obj({ coworkerId: str() }, ['coworkerId']),
      run: async (a) => {
        const id = S(a.coworkerId);
        const target = ctx.roster().find((p) => p.id === id);
        if (!target) return `ERROR: no coworker with id "${id}". Use team_roster.`;
        const pb = readAgentDoc(`${id}.md`);
        return pb || `(${target.name} has no playbook yet)`;
      } },
  ];
}

/** Build the live tool list for a persona, applying toolset + integration gating. */
export function buildTools(ctx: ToolsCtx): MimoTool[] {
  const all = build(ctx);
  const owned = new Set(ctx.persona.toolsets);
  const jiraOK = !!(env.jira.baseUrl && env.jira.email && env.jira.token);
  const zoomOK = !!(env.zoom.accountId && env.zoom.clientId && env.zoom.clientSecret);
  const emailOK = !!(env.smtp.host && env.smtp.user && env.smtp.pass);
  const spotifyOK = spotifyConfigured() && spotifyLinked();
  const gateBy = (ts?: string): boolean => {
    if (!ts) return true;
    if (!owned.has(ts)) return false;
    if (ts === 'jira') return jiraOK;
    if (ts === 'zoom') return zoomOK;
    if (ts === 'email') return emailOK;
    if (ts === 'spotify') return spotifyOK;
    if (ts === 'reach') {
      // reach_read uses just fetch (Jina Reader, no install). reach_youtube_transcript
      // needs yt-dlp in the project venv — gate on its presence so we don't expose
      // a tool that will always error.
      return fs.existsSync(YT_DLP_BIN) || true; // reach_read always usable
    }
    return true; // scrape, web, hf, github, docs, bash always live
  };
  return all.filter((t) => gateBy((t as any).toolset)).map(({ toolset: _, ...t }: any) => t);
}

/** Bare tool names (for the approval label lookup in agents.ts). */
export const SENSITIVE_BARE = new Set<string>([
  'kb_write', 'kb_delete',
  'jira_create', 'jira_update', 'jira_delete', 'jira_transition', 'jira_comment',
  'email_send', 'gh_clone',
  'create_word_doc', 'create_spreadsheet', 'create_presentation',
  'update_project_context',
  // workspace tools — shell + file mutation need approval
  'Write', 'Edit', 'Bash',
]);

/** Bare → "mcp__" name map so we can reuse approvalSummary/Detail labels from tools.ts. */
export const APPROVAL_LABEL_NAME: Record<string, string> = {
  kb_write: 'mcp__kb__kb_write',
  kb_delete: 'mcp__kb__kb_delete',
  jira_create: 'mcp__jira__jira_create',
  jira_update: 'mcp__jira__jira_update',
  jira_delete: 'mcp__jira__jira_delete',
  jira_transition: 'mcp__jira__jira_transition',
  jira_comment: 'mcp__jira__jira_comment',
  email_send: 'mcp__email__email_send',
  gh_clone: 'mcp__github__gh_clone',
  create_word_doc: 'mcp__docs__create_word_doc',
  create_spreadsheet: 'mcp__docs__create_spreadsheet',
  create_presentation: 'mcp__docs__create_presentation',
  // workspace tools map to themselves — tools.ts already has labels for them
  Write: 'Write',
  Edit: 'Edit',
  Bash: 'Bash',
};

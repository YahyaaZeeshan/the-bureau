#!/usr/bin/env node
/**
 * Stdio MCP bridge — exposes pixel-office's READ-ONLY tools to opencode so the
 * fallback path keeps real tool access when Claude is down.
 *
 * Spawned as a child process by opencode (registered in its config). Imports the
 * existing tool implementations directly so they share .env credentials, the KB,
 * the embedding index, etc.
 *
 * Sensitive writes (kb_write, jira_create, email_send, gh_clone, docs_create)
 * are deliberately omitted — they require approval gating from the main server's
 * WebSocket. Fallback agents are told to defer writes to "ask the boss to retry
 * when Claude is back".
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { kbList, kbRead, kbSearch } from './kb.js';
import { semanticSearch } from './embeddings.js';
import {
  jiraFetch,
  smartScrape,
  pageMarkdown,
  hfFetch,
  ghFetch,
  zoomFetch,
  gruntComplete,
} from './integrations.js';
import { spotifySearch, spotifyNowPlaying } from './spotify.js';
import { compactText } from './compress.js';

const S = (v: unknown): string => String(v ?? '');
const N = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

const TOOLS: Tool[] = [
  // ── knowledge base (read-only) ──
  { name: 'kb_list', description: 'List knowledge base files', inputSchema: { type: 'object', properties: {} } },
  { name: 'kb_read', description: 'Read a knowledge base file by name', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'kb_search', description: 'Keyword search the knowledge base', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'kb_find', description: 'Semantic search — returns the 2-3 most relevant passages. Prefer this over kb_read.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' } }, required: ['query'] } },
  // ── jira (read-only) ──
  { name: 'jira_projects', description: 'List visible Jira projects', inputSchema: { type: 'object', properties: {} } },
  { name: 'jira_search', description: 'Search Jira issues with JQL', inputSchema: { type: 'object', properties: { jql: { type: 'string' }, maxResults: { type: 'number' } }, required: ['jql'] } },
  { name: 'jira_get', description: 'Get full detail of one Jira issue', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  // ── web ──
  { name: 'scrape_page', description: 'Extract structured info from a webpage', inputSchema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } }, required: ['url', 'prompt'] } },
  { name: 'markdownify', description: 'Convert a webpage to clean readable text/markdown', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  // ── grunt ──
  { name: 'summarize_text', description: 'Cheap bulk text work: summarize, extract, classify, condense', inputSchema: { type: 'object', properties: { text: { type: 'string' }, instruction: { type: 'string' } }, required: ['text', 'instruction'] } },
  // ── hf ──
  { name: 'hf_search_models', description: 'Search Hugging Face models', inputSchema: { type: 'object', properties: { query: { type: 'string' }, task: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'hf_search_spaces', description: 'Search Hugging Face Spaces', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'hf_model_info', description: 'Details of one Hugging Face model', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  // ── github ──
  { name: 'gh_search_repos', description: 'Search GitHub repositories', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'gh_readme', description: 'Fetch the README of a repo (owner/name)', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] } },
  // ── zoom ──
  { name: 'zoom_list_recordings', description: 'List Zoom cloud recordings (YYYY-MM-DD)', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'zoom_upcoming_meetings', description: 'List upcoming Zoom meetings', inputSchema: { type: 'object', properties: {} } },
  // ── spotify ──
  { name: 'spotify_search', description: 'Search Spotify (tracks/playlists/albums)', inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'spotify_now_playing', description: 'What is currently playing on Spotify', inputSchema: { type: 'object', properties: {} } },
];

type Handler = (args: Record<string, unknown>) => Promise<string>;

const HANDLERS: Record<string, Handler> = {
  kb_list: async () => JSON.stringify(kbList().slice(0, 60)),
  kb_read: async (a) => compactText(await kbRead(S(a.name))),
  kb_search: async (a) => JSON.stringify(kbSearch(S(a.query))),
  kb_find: async (a) => {
    const hits = await semanticSearch(S(a.query), undefined, N(a.topK, 3));
    if (!hits.length) return 'No relevant passages found.';
    return hits.map((h) => `### ${h.name} (score ${h.score.toFixed(2)})\n${h.snippet}`).join('\n\n');
  },
  jira_projects: async () => {
    const d = await jiraFetch('GET', '/project/search?maxResults=50');
    return JSON.stringify((d.values ?? []).map((p: any) => ({ key: p.key, name: p.name })));
  },
  jira_search: async (a) => {
    const d = await jiraFetch('POST', '/search/jql', { jql: S(a.jql), maxResults: N(a.maxResults, 25), fields: ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated'] });
    return JSON.stringify({ total: d.total, issues: (d.issues ?? []).map((i: any) => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, assignee: i.fields?.assignee?.displayName ?? null, priority: i.fields?.priority?.name, type: i.fields?.issuetype?.name })) });
  },
  jira_get: async (a) => {
    const i = await jiraFetch('GET', `/issue/${S(a.key)}`);
    return JSON.stringify({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, assignee: i.fields?.assignee?.displayName, labels: i.fields?.labels });
  },
  scrape_page: async (a) => {
    const r = await smartScrape(S(a.url), S(a.prompt));
    return typeof r === 'string' ? compactText(r) : JSON.stringify(r);
  },
  markdownify: async (a) => compactText(await pageMarkdown(S(a.url))),
  summarize_text: async (a) => await gruntComplete(
    `${S(a.text)}\n\n---\nTask: ${S(a.instruction)}\nBe precise; never invent facts.`,
    'You condense and extract from text. Output only the result.',
    { maxTokens: 1200, temperature: 0.2 },
  ),
  hf_search_models: async (a) => {
    const params = new URLSearchParams({ search: S(a.query), limit: String(N(a.limit, 10)), sort: 'downloads' });
    if (a.task) params.set('pipeline_tag', S(a.task));
    const d = await hfFetch(`/models?${params}`);
    return JSON.stringify((d as any[]).map((m) => ({ id: m.modelId ?? m.id, downloads: m.downloads, task: m.pipeline_tag })));
  },
  hf_search_spaces: async (a) => {
    const d = await hfFetch(`/spaces?search=${encodeURIComponent(S(a.query))}&limit=${N(a.limit, 10)}&sort=likes`);
    return JSON.stringify((d as any[]).map((s) => ({ id: s.id, likes: s.likes, url: `https://huggingface.co/spaces/${s.id}` })));
  },
  hf_model_info: async (a) => {
    const m = await hfFetch(`/models/${S(a.id)}`);
    return JSON.stringify({ id: m.id, task: m.pipeline_tag, downloads: m.downloads, tags: (m.tags ?? []).slice(0, 20) });
  },
  gh_search_repos: async (a) => {
    const d = await ghFetch(`/search/repositories?q=${encodeURIComponent(S(a.query))}&per_page=${N(a.limit, 8)}&sort=stars`);
    return JSON.stringify((d.items ?? []).map((r: any) => ({ full_name: r.full_name, stars: r.stargazers_count, desc: r.description, url: r.html_url })));
  },
  gh_readme: async (a) => {
    const d = await ghFetch(`/repos/${S(a.repo)}/readme`);
    return compactText(Buffer.from(d.content ?? '', 'base64').toString('utf8'));
  },
  zoom_list_recordings: async (a) => {
    const to = S(a.to) || new Date().toISOString().slice(0, 10);
    const from = S(a.from) || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const d = await zoomFetch(`/users/me/recordings?from=${from}&to=${to}&page_size=30`);
    return JSON.stringify((d.meetings ?? []).map((m: any) => ({ id: m.id, topic: m.topic, start: m.start_time })));
  },
  zoom_upcoming_meetings: async () => {
    const d = await zoomFetch('/users/me/meetings?type=upcoming&page_size=20');
    return JSON.stringify((d.meetings ?? []).map((m: any) => ({ id: m.id, topic: m.topic, start: m.start_time })));
  },
  spotify_search: async (a) => JSON.stringify(await spotifySearch(S(a.query), (S(a.type) || 'track') as 'track' | 'playlist' | 'album', N(a.limit, 5))),
  spotify_now_playing: async () => await spotifyNowPlaying(),
};

const server = new Server({ name: 'pixel-office-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  try {
    const out = await handler((req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: out.slice(0, 12_000) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

void server.connect(new StdioServerTransport());

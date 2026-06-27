import nodemailer from 'nodemailer';
import { env } from './config.js';
import { getSettings } from './settings.js';

const json = (r: Response) => {
  if (!r.ok) return r.text().then((t) => Promise.reject(new Error(`HTTP ${r.status}: ${t.slice(0, 500)}`)));
  return r.json();
};

// ── Jira (REST v3, basic auth) ─────────────────────────────
const jiraHeaders = () => ({
  Authorization: 'Basic ' + Buffer.from(`${env.jira.email}:${env.jira.token}`).toString('base64'),
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

export function jiraConfigured(): void {
  if (!env.jira.baseUrl || !env.jira.email || !env.jira.token)
    throw new Error('Jira not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env');
}

export async function jiraFetch(method: string, apiPath: string, body?: unknown): Promise<any> {
  jiraConfigured();
  const r = await fetch(`${env.jira.baseUrl}/rest/api/3${apiPath}`, {
    method,
    headers: jiraHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return { ok: true };
  return json(r);
}

/** Plain text → minimal Atlassian Document Format. */
export const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split('\n\n').map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p || ' ' }] })),
});

// ── Zoom (server-to-server OAuth) ──────────────────────────
let zoomToken: { token: string; exp: number } | null = null;

export async function zoomAccessToken(): Promise<string> {
  if (!env.zoom.accountId || !env.zoom.clientId || !env.zoom.clientSecret)
    throw new Error('Zoom not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in .env');
  if (zoomToken && Date.now() < zoomToken.exp - 60_000) return zoomToken.token;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${env.zoom.accountId}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${env.zoom.clientId}:${env.zoom.clientSecret}`).toString('base64'),
    },
  });
  const data = (await json(r)) as { access_token: string; expires_in: number };
  zoomToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return zoomToken.token;
}

export async function zoomFetch(apiPath: string): Promise<any> {
  const token = await zoomAccessToken();
  const r = await fetch(`https://api.zoom.us/v2${apiPath}`, { headers: { Authorization: `Bearer ${token}` } });
  return json(r);
}

export async function zoomDownload(url: string): Promise<string> {
  const token = await zoomAccessToken();
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + `access_token=${token}`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Zoom download failed: HTTP ${r.status}`);
  return r.text();
}

/** Fetch a page and reduce it to readable text (no JS rendering — static HTML only). */
export async function fetchPageText(url: string, maxChars = 28_000): Promise<string> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pixel-office-research' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  const html = await r.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;|&\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return text.slice(0, maxChars);
}

/** Smart scrape: fetch the page LOCALLY (no JS), strip to text, hand only the
 *  cleaned text to the free grunt model for field extraction. The LLM never
 *  ingests raw HTML — keeps cost ~zero and avoids the ScrapeGraphAI SaaS. */
export async function smartScrape(url: string, prompt: string): Promise<unknown> {
  const text = await fetchPageText(url);
  return gruntComplete(
    `Page content of ${url}:\n\n${text}\n\n---\nExtraction task: ${prompt}\nReturn only the extracted information, structured and concise. If the page lacks the information, say what is missing.`,
    'You extract structured information from webpage text. Be precise; never invent facts not present in the text.',
    { maxTokens: 1200, temperature: 0.2 },
  );
}

/** Reduce a URL to readable text. Local fetch only — no third-party SaaS. */
export async function pageMarkdown(url: string): Promise<string> {
  return fetchPageText(url, 40_000);
}

// ── Groq (OpenAI-compatible, fast open-source models) ──────
export async function groqChat(
  userPrompt: string,
  system?: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number },
): Promise<string> {
  const { getSettings } = await import('./settings.js');
  const key = getSettings().groqKey || env.groqKey;
  if (!key) throw new Error('Groq not configured. Add GROQ_API_KEY in .env or Settings.');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts?.model || env.groqModel,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: userPrompt }],
      max_tokens: opts?.maxTokens ?? 400,
      temperature: opts?.temperature ?? 0.8,
    }),
  });
  const data = (await json(r)) as any;
  return data.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}

/**
 * Grunt-work router: mechanical/bulk text (summaries, extraction, classification,
 * boilerplate drafts) → opencode hosted free models (mimo / deepseek-v4-flash).
 * Falls back to Groq if opencode is unavailable. Keeps grunt OFF Claude's
 * expensive context for $0.
 */
export async function gruntComplete(prompt: string, system?: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
  try {
    const { opencodeChat, opencodeAvailable } = await import('./opencode.js');
    if (opencodeAvailable) return await opencodeChat(prompt, system);
  } catch { /* opencode unavailable or failed — fall through to groq */ }
  return groqChat(prompt, system, opts);
}

// ── Hugging Face ───────────────────────────────────────────
export async function hfFetch(apiPath: string): Promise<any> {
  const headers: Record<string, string> = env.hfToken ? { Authorization: `Bearer ${env.hfToken}` } : {};
  const r = await fetch(`https://huggingface.co/api${apiPath}`, { headers });
  return json(r);
}

// ── GitHub ─────────────────────────────────────────────────
export async function ghFetch(apiPath: string): Promise<any> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pixel-office',
  };
  if (env.githubToken) headers.Authorization = `Bearer ${env.githubToken}`;
  const r = await fetch(`https://api.github.com${apiPath}`, { headers });
  return json(r);
}

// ── Email (SMTP) ───────────────────────────────────────────
export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  if (!env.smtp.host || !env.smtp.user || !env.smtp.pass)
    throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
  const transport = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });
  const info = await transport.sendMail({ from: env.smtp.from, to, subject, text: body });
  return info.messageId;
}

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });

export const PORT = Number(process.env.SERVER_PORT || 4317);

export const DATA_DIR = path.join(ROOT, 'data');
export const KB_DIR = path.join(ROOT, 'knowledge-base');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

export const env = {
  groqKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  jira: {
    baseUrl: (process.env.JIRA_BASE_URL || '').replace(/\/$/, ''),
    email: process.env.JIRA_EMAIL || '',
    token: process.env.JIRA_API_TOKEN || '',
  },
  zoom: {
    accountId: process.env.ZOOM_ACCOUNT_ID || '',
    clientId: process.env.ZOOM_CLIENT_ID || '',
    clientSecret: process.env.ZOOM_CLIENT_SECRET || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || '',
  },
  hfToken: process.env.HF_TOKEN || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${process.env.SERVER_PORT || 4317}/api/spotify/callback`,
  },
};

import { spawnSync } from 'node:child_process';
const _opencodeBin = process.env.OPENCODE_BIN || 'opencode';
export const opencodeDetected = (() => {
  try {
    const r = spawnSync(_opencodeBin, ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
    return r.status === 0;
  } catch { return false; }
})();

let _getSettings: (() => { provider: { apiKey: string }; groqKey: string }) | null = null;
export const integrations = () => {
  if (!_getSettings) {
    // Lazy resolve to break circular dependency (settings.ts imports DATA_DIR from here)
    try { _getSettings = (globalThis as any).__pixelSettings; } catch {}
  }
  const s = _getSettings?.();
  return {
    llm: !!(s?.provider?.apiKey),
    opencode: opencodeDetected,
    jira: !!(env.jira.baseUrl && env.jira.email && env.jira.token),
    zoom: !!(env.zoom.accountId && env.zoom.clientId && env.zoom.clientSecret),
    scrape: true,
    groq: !!(s?.groqKey || env.groqKey),
    email: !!(env.smtp.host && env.smtp.user && env.smtp.pass),
    huggingface: true,
    github: true,
    spotify: !!env.spotify.clientId && fs.existsSync(path.join(DATA_DIR, 'spotify.json')),
  };
};

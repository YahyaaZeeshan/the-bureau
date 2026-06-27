/**
 * opencode integration — replaces paid DeepSeek API for grunt work AND is the
 * fallback engine when Claude fails or hits its quota.
 *
 * Boots `opencode serve` as a headless background process at app startup, keeps it
 * alive for the lifetime of the office, and chats with it over its session HTTP
 * API. Uses opencode's free hosted models (mimo-v2.5-free primary,
 * deepseek-v4-flash-free secondary) — no auth, no per-call cost.
 */
import { spawn, type ChildProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { bus } from './bus.js';

const PORT = Number(process.env.OPENCODE_PORT || 4399);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const BIN = process.env.OPENCODE_BIN || 'opencode';

const PRIMARY = process.env.OPENCODE_MODEL || 'mimo-v2.5-free';
const SECONDARY = process.env.OPENCODE_MODEL_SECONDARY || 'deepseek-v4-flash-free';

let proc: ChildProcess | null = null;
let ready = false;
let readyPromise: Promise<void> | null = null;

/** Detect the opencode CLI once at boot. */
function detectOpencode(): boolean {
  try {
    const r = spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
    return r.status === 0;
  } catch {
    return false;
  }
}
export const opencodeAvailable = detectOpencode();

/**
 * Write an opencode.json into the pixel-office root so `opencode serve` (which we
 * spawn with cwd=ROOT) picks up our stdio MCP bridge. The bridge exposes our
 * read-only tools (kb_*, jira_search, scrape_*, etc.) — gives opencode fallback
 * real tool access without bypassing approval (sensitive writes stay out).
 */
function writeOpencodeConfig(): void {
  // Run the compiled bridge with the same tsx runtime we use for the server.
  const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const bridgeSrc = path.join(ROOT, 'server', 'src', 'mcp-bridge.ts');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'pixel-office': {
        type: 'local',
        command: ['npx', tsxBin, bridgeSrc],
        enabled: true,
      },
    },
  };
  fs.writeFileSync(path.join(ROOT, 'opencode.json'), JSON.stringify(config, null, 2));
}

/** Spawn `opencode serve` once and wait until the API answers. Idempotent. */
export async function startOpencodeServer(): Promise<void> {
  if (!opencodeAvailable) throw new Error('opencode CLI not installed (npm i -g opencode-ai)');
  if (ready) return;
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    writeOpencodeConfig();
    proc = spawn(BIN, ['serve', '--port', String(PORT), '--hostname', HOST], {
      cwd: ROOT, // run from pixel-office root so opencode reads our opencode.json
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    });
    proc.stdout?.on('data', () => { /* keep buffers drained */ });
    proc.stderr?.on('data', () => { /* same */ });
    proc.on('exit', () => {
      ready = false;
      proc = null;
    });
    // Poll the API until it answers (~15s budget).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) { ready = true; bus.broadcast({ type: 'opencode.ready' as never }); return; }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('opencode serve did not become ready in 15s');
  })();
  return readyPromise;
}

export function stopOpencodeServer(): void {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    proc = null;
    ready = false;
  }
}

/** Create a fresh session. */
async function createSession(): Promise<string> {
  const r = await fetch(`${BASE}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`opencode /session HTTP ${r.status}`);
  const d = (await r.json()) as { id: string };
  return d.id;
}

interface MessagePart { type: string; text?: string }
interface MessageResponse { info: { finish?: string }; parts: MessagePart[] }

/** Send one user message to opencode and return the assistant's text. */
async function sendOne(sessionId: string, model: string, prompt: string, system?: string): Promise<string> {
  const full = system ? `${system}\n\n---\n${prompt}` : prompt;
  const r = await fetch(`${BASE}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: { providerID: 'opencode', modelID: model },
      parts: [{ type: 'text', text: full }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`opencode message HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = (await r.json()) as MessageResponse;
  // The assistant's reply lives in parts where type==='text'. Take the LAST one
  // (steps may emit intermediate reasoning/text parts).
  const text = d.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
    .map((p) => p.text as string)
    .join('\n')
    .trim();
  return text || '(no response)';
}

/** Chat completion via opencode's session API. Primary model, secondary on failure. */
export async function opencodeChat(prompt: string, system?: string, opts?: { model?: string }): Promise<string> {
  if (!opencodeAvailable) throw new Error('opencode not installed');
  if (!ready) await startOpencodeServer();
  const tryModel = async (model: string) => {
    const sid = await createSession();
    return sendOne(sid, model, prompt, system);
  };
  try {
    return await tryModel(opts?.model || PRIMARY);
  } catch (e) {
    // primary failed (rate limit / model down) — try the secondary free model once
    try { return await tryModel(SECONDARY); }
    catch { throw e; }
  }
}

export function opencodeReady(): boolean { return ready; }
export const opencodeModels = { primary: PRIMARY, secondary: SECONDARY };

import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT, integrations } from './config.js';
import { api } from './routes.js';
import { runtime } from './agents.js';
import { resolveApproval } from './approvals.js';
import { getSettings, updateSettings } from './settings.js';
import { startScheduler } from './routines.js';
import { currentMeeting, startMeeting, meetingSay, endMeeting } from './meetings.js';
import { startBreak, endBreak } from './breakroom.js';
import { bus } from './bus.js';
import { appendLog } from './logs.js';
import type { ClientMsg, ServerMsg } from './types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', api);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (ws: WebSocket, msg: ServerMsg) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

bus.subscribe((msg) => {
  for (const client of wss.clients) send(client as WebSocket, msg);
});

// Heartbeat: ping every 25s and drop dead sockets. Keeps the WS alive through
// the Vite dev proxy during long agent runs, and frees zombie connections.
const alive = new WeakMap<WebSocket, boolean>();
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as WebSocket;
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 25_000);
wss.on('close', () => clearInterval(heartbeat));

// ── Browser-tied lifecycle: shut the server down when no browser tab is
// connected, so it isn't left running in the background. Only arms after the
// first browser has connected (so it stays up while the first page loads), and
// uses a grace window so a page reload doesn't kill it.
const IDLE_SHUTDOWN_MS = 45_000;
let everConnected = false;
let idleTimer: NodeJS.Timeout | null = null;
const liveClients = () => [...wss.clients].filter((c) => (c as WebSocket).readyState === WebSocket.OPEN).length;
function armIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (liveClients() === 0) {
      console.log('🛑 No browser connected — shutting down the office server.');
      endBreak();
      endMeeting();
      process.exit(0);
    }
  }, IDLE_SHUTDOWN_MS);
}

wss.on('connection', (ws) => {
  everConnected = true;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  ws.on('close', () => {
    if (everConnected) armIdleShutdown();
  });
  send(ws, {
    type: 'hello',
    personas: runtime.personas,
    meeting: currentMeeting(),
    integrations: integrations(),
    statuses: runtime.personas.map((p) => ({
      agentId: p.id,
      status: runtime.isBusy(p.id) ? ('thinking' as const) : ('idle' as const),
    })),
    settings: getSettings(),
  });

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'chat': {
          bus.broadcast({ type: 'agent.message', agentId: msg.agentId, role: 'user', text: msg.text, ts: Date.now() });
          void runtime.send(msg.agentId, msg.text);
          break;
        }
        case 'approval.response':
          resolveApproval(msg.id, msg.approved);
          break;
        case 'meeting.start':
          startMeeting(msg.attendees);
          break;
        case 'meeting.say':
          void meetingSay(msg.text).catch((e) => {
            bus.broadcast({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          });
          break;
        case 'meeting.end':
          endMeeting();
          break;
        case 'break.start':
          startBreak();
          break;
        case 'break.end':
          endBreak();
          break;
        case 'settings.update':
          updateSettings(msg.patch);
          break;
      }
    } catch (e) {
      send(ws, { type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  });
});

server.listen(PORT, () => {
  const flags = Object.entries(integrations())
    .map(([k, v]) => `${v ? '✓' : '✗'} ${k}`)
    .join('  ');
  console.log(`\n🕵️ the-bureau server → http://localhost:${PORT}  (ws: /ws)`);
  console.log(`   integrations: ${flags}`);
  console.log(`   characters: ${runtime.personas.map((p) => `${p.emoji} ${p.name}`).join('  ')}\n`);
  for (const p of runtime.personas) appendLog(p.id, 'system', 'office opened — server started');
  startScheduler();
  // Boot the opencode serve subprocess in the background. Don't block startup —
  // grunt + fallback calls trigger a warm-up if it's not ready yet.
  void import('./opencode.js').then(({ opencodeAvailable, startOpencodeServer }) => {
    if (!opencodeAvailable) return;
    startOpencodeServer().then(() => console.log('   opencode serve ready')).catch((e) => console.log(`   opencode serve failed: ${e.message}`));
  });
});

process.on('SIGTERM', () => import('./opencode.js').then((m) => m.stopOpencodeServer()).catch(() => undefined));
process.on('SIGINT', () => { import('./opencode.js').then((m) => m.stopOpencodeServer()).finally(() => process.exit(0)); });

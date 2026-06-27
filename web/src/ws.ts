import { useStore } from './state.js';

let ws: WebSocket | null = null;
let engineHooks: {
  setStatus?: (id: string, status: string, tool?: string) => void;
  say?: (id: string, text: string) => void;
  setMode?: (mode: 'work' | 'break' | 'meeting', attendees?: string[]) => void;
} = {};

export function registerEngineHooks(hooks: typeof engineHooks): void {
  engineHooks = hooks;
}

export function wsSend(msg: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function connectWs(): void {
  // guard against double-connect (React StrictMode mounts effects twice in dev)
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const st = useStore.getState();

  ws.onopen = () => useStore.getState().set({ connected: true });
  ws.onclose = () => {
    useStore.getState().set({ connected: false });
    setTimeout(connectWs, 2000);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const s = useStore.getState();
    switch (msg.type) {
      case 'hello': {
        s.set({ personas: msg.personas, integrations: msg.integrations, meeting: msg.meeting, settings: msg.settings ?? s.settings });
        if (msg.meeting?.active) {
          s.set({ mode: 'meeting' });
          engineHooks.setMode?.('meeting', msg.meeting.attendees);
        }
        for (const st2 of msg.statuses) s.setStatus(st2.agentId, st2.status, st2.tool);
        break;
      }
      case 'agent.status':
        s.setStatus(msg.agentId, msg.status, msg.tool);
        engineHooks.setStatus?.(msg.agentId, msg.status, msg.tool);
        break;
      case 'agent.message':
        s.addChat({ agentId: msg.agentId, role: msg.role, text: msg.text, ts: msg.ts });
        if (msg.role === 'agent') engineHooks.say?.(msg.agentId, msg.text);
        break;
      case 'office.say':
        // ambient/break-room speech bubble — bubble only, doesn't touch chat history
        engineHooks.say?.(msg.agentId, msg.text);
        break;
      case 'approval.request':
        s.addApproval({ id: msg.id, agentId: msg.agentId, tool: msg.tool, summary: msg.summary, detail: msg.detail });
        break;
      case 'approval.resolved':
        s.removeApproval(msg.id);
        break;
      case 'log':
        s.addLog(msg.agentId, msg.entry);
        break;
      case 'kb.changed':
        s.set({ kbVersion: s.kbVersion + 1 });
        break;
      case 'personas.changed':
        s.set({ personas: msg.personas });
        break;
      case 'meeting.state': {
        s.set({ meeting: msg.meeting });
        if (msg.meeting?.active && s.mode !== 'meeting') {
          s.set({ mode: 'meeting' });
          engineHooks.setMode?.('meeting', msg.meeting.attendees);
        } else if (!msg.meeting && s.mode === 'meeting') {
          s.set({ mode: 'work' });
          engineHooks.setMode?.('work');
        }
        break;
      }
      case 'settings':
        if (msg.settings) s.set({ settings: msg.settings });
        break;
      case 'deliverables.changed':
        s.set({ deliverablesVersion: s.deliverablesVersion + 1 });
        break;
      case 'routines.changed':
        s.set({ routinesVersion: s.routinesVersion + 1 });
        break;
      case 'meeting.download':
      case 'meeting.transcribing':
        // Forward to ChatPanel via DOM CustomEvent (avoids adding to zustand store).
        window.dispatchEvent(new CustomEvent('pixel-office-bus', { detail: msg }));
        break;
      case 'error':
        console.error('[server]', msg.message);
        break;
    }
  };
  void st;
}

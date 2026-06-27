import { create } from 'zustand';

export interface Persona {
  id: string;
  name: string;
  title: string;
  emoji: string;
  sprite: number;
  prompt: string;
  toolsets: string[];
  model: string;
  /** extra MCP servers / connectors attached to this employee (Claude mcpServers shape) */
  mcp?: Record<string, unknown>;
}

export interface ChatMsg {
  agentId: string;
  role: 'agent' | 'user' | 'system';
  text: string;
  ts: number;
}

export interface Approval {
  id: string;
  agentId: string;
  tool: string;
  summary: string;
  detail?: string;
}

export interface Meeting {
  id: string;
  attendees: string[];
  transcript: { speaker: string; text: string; ts: number }[];
  active: boolean;
}

export interface LogEntry {
  ts: number;
  kind: string;
  text: string;
}

interface Store {
  connected: boolean;
  personas: Persona[];
  integrations: Record<string, boolean>;
  statuses: Record<string, { status: string; tool?: string }>;
  chats: Record<string, ChatMsg[]>;
  approvals: Approval[];
  meeting: Meeting | null;
  mode: 'work' | 'break' | 'meeting';
  settings: Record<string, any>;
  settingsOpen: boolean;
  uploadDialog: { name: string; agentId?: string; meeting?: boolean; audience?: 'all' | string[]; summary?: string; tags?: string[] } | null;
  meetingPicker: boolean;
  pendingCount: number;
  deliverablesVersion: number;
  routinesVersion: number;
  // ui
  selectedChar: string | null;
  charMenu: { id: string; x: number; y: number } | null;
  dockTab: 'chat' | 'meeting' | 'kb' | 'inbox' | 'routines' | 'logs' | 'drafts' | 'team';
  dockOpen: boolean;
  chatTarget: string;
  editingPersona: Persona | null;
  kbVersion: number;
  logLive: Record<string, LogEntry[]>;

  set: (partial: Partial<Store>) => void;
  addChat: (msg: ChatMsg) => void;
  setStatus: (agentId: string, status: string, tool?: string) => void;
  addApproval: (a: Approval) => void;
  removeApproval: (id: string) => void;
  addLog: (agentId: string, entry: LogEntry) => void;
}

export const useStore = create<Store>((set) => ({
  connected: false,
  personas: [],
  integrations: {},
  statuses: {},
  chats: {},
  approvals: [],
  meeting: null,
  mode: 'work',
  settings: { provider: { id: 'anthropic', name: 'Anthropic Claude', baseUrl: '', apiKey: '', model: 'claude-sonnet-4-20250514' }, groqKey: '', groqFallback: true, autoApprove: false, autonomousChat: false, chatterEngine: 'groq' },
  settingsOpen: false,
  uploadDialog: null,
  meetingPicker: false,
  pendingCount: 0,
  deliverablesVersion: 0,
  routinesVersion: 0,
  selectedChar: null,
  charMenu: null,
  dockTab: 'chat',
  dockOpen: false,
  chatTarget: 'pm',
  editingPersona: null,
  kbVersion: 0,
  logLive: {},

  set: (partial) => set(partial),
  addChat: (msg) =>
    set((s) => ({
      chats: { ...s.chats, [msg.agentId]: [...(s.chats[msg.agentId] ?? []), msg].slice(-200) },
    })),
  setStatus: (agentId, status, tool) =>
    set((s) => ({ statuses: { ...s.statuses, [agentId]: { status, tool } } })),
  addApproval: (a) => set((s) => ({ approvals: [...s.approvals, a] })),
  removeApproval: (id) => set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) })),
  addLog: (agentId, entry) =>
    set((s) => ({
      logLive: { ...s.logLive, [agentId]: [...(s.logLive[agentId] ?? []), entry].slice(-300) },
    })),
}));

export interface Persona {
  id: string;
  name: string;
  title: string;
  emoji: string;
  /** character sprite sheet index 0-5 */
  sprite: number;
  /** persona / behavior description, editable by user */
  prompt: string;
  /** toolset names this character may use (jira, zoom, scrape, email, hf, github, bash) */
  toolsets: string[];
  /** claude model alias */
  model: string;
  /**
   * Optional extra MCP servers for this character, same shape as Claude Code mcpServers config,
   * e.g. { "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" } }.
   * Edit in data/personas.json. Tools from these servers run through the approval gate's default-allow path.
   */
  mcp?: Record<string, unknown>;
}

export interface AgentStatus {
  agentId: string;
  status: 'idle' | 'thinking' | 'tool' | 'waiting';
  tool?: string;
  detail?: string;
}

export interface LogEntry {
  ts: number;
  kind: 'user' | 'agent' | 'tool' | 'system' | 'approval' | 'team';
  text: string;
}

export interface MeetingState {
  id: string;
  attendees: string[];
  transcript: { speaker: string; text: string; ts: number }[];
  active: boolean;
  /** rolling Groq-made summary of older turns, so agents get intent — not the raw O(N^2) backlog */
  digest?: string;
  /** transcript index up to which `digest` already covers (older turns are folded in) */
  digestUpto?: number;
}

/** server -> client */
export type ServerMsg =
  | { type: 'hello'; personas: Persona[]; meeting: MeetingState | null; integrations: Record<string, boolean>; statuses: AgentStatus[]; settings: any }
  | { type: 'settings'; settings: any }
  | { type: 'deliverables.changed' }
  | { type: 'routines.changed' }
  | { type: 'agent.status'; agentId: string; status: AgentStatus['status']; tool?: string }
  | { type: 'agent.message'; agentId: string; role: 'agent' | 'user' | 'system'; text: string; meetingId?: string; ts: number }
  | { type: 'approval.request'; id: string; agentId: string; tool: string; summary: string; detail?: string }
  | { type: 'approval.resolved'; id: string; approved: boolean }
  | { type: 'log'; agentId: string; entry: LogEntry }
  | { type: 'kb.changed' }
  | { type: 'agent-docs.changed' }
  | { type: 'personas.changed'; personas: Persona[] }
  | { type: 'meeting.state'; meeting: MeetingState | null }
  | { type: 'office.say'; agentId: string; text: string }
  | { type: 'meeting.download'; stage: string; got: number; total: number }
  | { type: 'meeting.transcribing'; stage: string }
  | { type: 'error'; message: string };

/** client -> server */
export type ClientMsg =
  | { type: 'chat'; agentId: string; text: string }
  | { type: 'approval.response'; id: string; approved: boolean }
  | { type: 'meeting.start'; attendees: string[] }
  | { type: 'meeting.say'; text: string }
  | { type: 'meeting.end' }
  | { type: 'break.start' }
  | { type: 'break.end' }
  | { type: 'settings.update'; patch: Record<string, unknown> };

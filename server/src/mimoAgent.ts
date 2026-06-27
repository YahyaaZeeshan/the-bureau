/**
 * Agent runtime — Anthropic SDK agent loop supporting multiple LLM providers.
 *
 * Providers that speak the Anthropic Messages API (Anthropic, MiMo, OpenRouter)
 * work directly. The provider config (baseUrl, apiKey, model) comes from
 * OfficeSettings.provider, set in the Settings UI.
 *
 * Agent loop:
 *   1. Send a /v1/messages call with system + messages + tools.
 *   2. If the model returns text only → done.
 *   3. If the model returns tool_use blocks → execute each handler, append the
 *      tool_result, loop until the model stops or maxTurns is hit.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { getSettings } from './settings.js';

const SESSIONS_FILE = path.join(DATA_DIR, 'mimo-sessions.json');

export interface MimoTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  sensitive?: boolean;
  run: (input: any) => Promise<string>;
}

export interface ApprovalCtx {
  toolName: string;
  input: Record<string, unknown>;
}

export interface RunAgentOpts {
  agentId: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  tools: MimoTool[];
  history?: Anthropic.MessageParam[];
  maxTurns?: number;
  abort?: AbortSignal;
  approve?: (ctx: ApprovalCtx) => Promise<boolean>;
  onStatus?: (status: 'thinking' | 'tool', tool?: string) => void;
  onTool?: (tool: string, input: any, result: string) => void;
}

export interface RunAgentResult {
  text: string;
  history: Anthropic.MessageParam[];
  turns: number;
  truncated: boolean;
}

let _client: Anthropic | null = null;
let _clientFingerprint = '';

function client(): Anthropic {
  const p = getSettings().provider;
  const fp = `${p.baseUrl}|${p.apiKey}`;
  if (_client && _clientFingerprint === fp) return _client;
  if (!p.apiKey) {
    throw new Error(`No API key configured. Open Settings (⚙) and add your ${p.name || 'LLM'} API key.`);
  }
  _client = new Anthropic({
    ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
    apiKey: p.apiKey,
  });
  _clientFingerprint = fp;
  return _client;
}

function extractText(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const { agentId, model, systemPrompt, prompt, tools, abort, approve, onStatus, onTool } = opts;
  const maxTurns = opts.maxTurns ?? 16;
  const messages: Anthropic.MessageParam[] = [...(opts.history ?? []), { role: 'user', content: prompt }];
  const toolDefs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
  const handlers = new Map(tools.map((t) => [t.name, t]));

  let truncated = false;
  let finalText = '';
  let turn = 0;

  while (turn < maxTurns) {
    if (abort?.aborted) throw new Error('aborted');
    turn++;
    onStatus?.('thinking');
    const res = await client().messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
    }, { signal: abort });

    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'tool_use') {
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const partialText = extractText(res.content);
      if (partialText) finalText = partialText;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const handler = handlers.get(use.name);
        if (!handler) {
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: `ERROR: unknown tool ${use.name}`, is_error: true });
          continue;
        }
        const input = (use.input ?? {}) as Record<string, unknown>;
        if (handler.sensitive && approve && !(await approve({ toolName: use.name, input }))) {
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: 'The boss declined this action. Do not retry; explain and ask what they want instead.' });
          continue;
        }
        onStatus?.('tool', use.name);
        let result: string;
        try {
          result = await handler.run(input);
        } catch (e) {
          result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        }
        onTool?.(use.name, input, result);
        if (result.length > 8000) result = result.slice(0, 8000) + '\n…[truncated to 8000 chars]';
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    finalText = extractText(res.content) || finalText;
    if (res.stop_reason === 'max_tokens' && !finalText) truncated = true;
    return { text: finalText || '(no response)', history: messages, turns: turn, truncated };
  }

  return { text: finalText || '(hit step limit)', history: messages, turns: turn, truncated: true };
}

// ── session persistence ──────────────────────────────────────────────────
type SessionStore = Record<string, Anthropic.MessageParam[]>;

function loadAll(): SessionStore {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveAll(s: SessionStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s));
}

export function loadSession(agentId: string): Anthropic.MessageParam[] {
  return loadAll()[agentId] ?? [];
}
export function saveSession(agentId: string, history: Anthropic.MessageParam[]): void {
  const all = loadAll();
  all[agentId] = history;
  saveAll(all);
}
export function clearSession(agentId: string): void {
  const all = loadAll();
  delete all[agentId];
  saveAll(all);
}

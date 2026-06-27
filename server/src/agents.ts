/**
 * AgentRuntime: each persona is a live MiMo agent with its own session
 * (message-array transcript), workspace folder, toolsets, memory, and
 * approval-gated permissions.
 *
 * Path A migration (2026-06-17): replaced @anthropic-ai/claude-agent-sdk (which
 * spawned the Claude Code CLI subprocess and hung talking to non-Anthropic
 * proxies) with a bare-metal agent loop on @anthropic-ai/sdk pointed at the
 * Xiaomi MiMo proxy. See mimoAgent.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { SESSIONS_FILE, WORKSPACES_DIR } from './config.js';
import { loadPersonas, savePersonas } from './personas.js';
import { buildTools, SENSITIVE_BARE, APPROVAL_LABEL_NAME } from './mimoTools.js';
import { runAgent } from './mimoAgent.js';
import { approvalSummary, approvalDetail } from './tools.js';
import { requestApproval } from './approvals.js';
import { getSettings } from './settings.js';
import { groqChat } from './integrations.js';
import { appendLog } from './logs.js';
import { readMemory } from './memory.js';
import { composeAgentDocs } from './agentDocs.js';
import { bus } from './bus.js';
import type { Persona } from './types.js';

const MESSAGE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Cost-aware model routing. 'heavy' = the persona's own model (real work,
 * judgement, tool-heavy). 'light' = haiku (chatty/standup/quick/background) —
 * far cheaper, keeps usage low. Bulk text work goes to Groq via summarize_text.
 */
type Tier = 'heavy' | 'light';
const TIER_MAX_TURNS: Record<Tier, number> = { heavy: 24, light: 6 };

interface SendOpts {
  depth?: number;
  /** label used in logs for who initiated (user / another agent / meeting) */
  from?: string;
  /** cost tier — defaults to 'heavy' (persona model) */
  tier?: Tier;
}

/** Reset a heavy chat session after this many turns so the resumed transcript
 *  never grows unbounded (each resume re-sends the whole history = tokens). */
// Lowered 10→6: every resumed turn re-sends the whole prior transcript via the
// Agent SDK, so the cap bounds the worst-case replay. 6 keeps mid-task continuity
// without letting a single chat balloon past ~12K replayed tokens at the peak.
const HEAVY_SESSION_TURN_CAP = 10;

export class AgentRuntime {
  personas: Persona[] = loadPersonas();
  /** Per-agent transcript (message array, used to resume heavy chats). Legacy
   *  string session-IDs from the Claude SDK era are migrated → empty array. */
  private sessions: Record<string, Anthropic.MessageParam[]> = this.loadSessions();
  private turns: Record<string, number> = {};
  private queues = new Map<string, Promise<unknown>>();
  private busy = new Set<string>();

  constructor() {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    for (const p of this.personas) fs.mkdirSync(this.workspace(p.id), { recursive: true });
  }

  private loadSessions(): Record<string, Anthropic.MessageParam[]> {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      // Migrate: old value was Record<string, string> (session_id). Drop into
      // empty transcripts so MiMo starts fresh — memory + playbook still carry context.
      const out: Record<string, Anthropic.MessageParam[]> = {};
      for (const [k, v] of Object.entries(raw)) {
        out[k] = Array.isArray(v) ? (v as Anthropic.MessageParam[]) : [];
      }
      return out;
    } catch {
      return {};
    }
  }

  private saveSessions(): void {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(this.sessions));
  }

  workspace(agentId: string): string {
    return path.join(WORKSPACES_DIR, agentId.replace(/[^\w-]/g, '_'));
  }

  persona(agentId: string): Persona {
    const p = this.personas.find((x) => x.id === agentId);
    if (!p) throw new Error(`Unknown agent: ${agentId}`);
    return p;
  }

  updatePersona(updated: Persona): void {
    const idx = this.personas.findIndex((p) => p.id === updated.id);
    if (idx < 0) throw new Error(`Unknown agent: ${updated.id}`);
    this.personas[idx] = updated;
    savePersonas(this.personas);
    // persona changed → fresh session so the new prompt takes effect cleanly
    delete this.sessions[updated.id];
    this.saveSessions();
    bus.broadcast({ type: 'personas.changed', personas: this.personas });
  }

  private MAX_EMPLOYEES = 9;

  createPersona(input: Partial<Persona>): Persona {
    if (this.personas.length >= this.MAX_EMPLOYEES)
      throw new Error(`Office is full (${this.MAX_EMPLOYEES} desks). Delete someone first.`);
    const base = (input.name || 'employee').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';
    let id = base;
    let n = 2;
    while (this.personas.find((p) => p.id === id)) id = `${base}-${n++}`;
    const persona: Persona = {
      id,
      name: input.name || 'New Employee',
      title: input.title || 'Generalist',
      emoji: input.emoji || '🙂',
      sprite: input.sprite ?? this.personas.length % 6,
      model: input.model || 'sonnet',
      toolsets: input.toolsets ?? [],
      prompt:
        input.prompt ||
        `You are ${input.name || 'a new employee'}, the ${input.title || 'Generalist'} in the office. Help the boss with whatever they assign. Read the knowledge base for context and ask for approval before any externally visible action.`,
      mcp: input.mcp,
    };
    this.personas.push(persona);
    savePersonas(this.personas);
    fs.mkdirSync(this.workspace(persona.id), { recursive: true });
    bus.broadcast({ type: 'personas.changed', personas: this.personas });
    return persona;
  }

  deletePersona(id: string): void {
    const idx = this.personas.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown agent: ${id}`);
    if (this.personas.length <= 1) throw new Error('Cannot delete the last employee.');
    this.personas.splice(idx, 1);
    savePersonas(this.personas);
    delete this.sessions[id];
    this.saveSessions();
    bus.broadcast({ type: 'personas.changed', personas: this.personas });
  }

  resetSession(agentId: string): void {
    delete this.sessions[agentId];
    this.saveSessions();
    appendLog(agentId, 'system', 'session reset');
  }

  isBusy(agentId: string): boolean {
    return this.busy.has(agentId);
  }

  private systemPrompt(p: Persona, opts?: { lean?: boolean }): string {
    // TOKEN DISCIPLINE:
    //  - LEAN mode (fallback / toolless opencode) skips docs + KB index + roster.
    //  - Normal mode skips the static KB index entirely — agents call kb_find on
    //    demand (semantic, returns just 2-3 chunks). Old 18-line index was ~500
    //    tokens of dead weight injected every turn.
    //  - Memory capped tighter (800 → was 1500).
    const memory = readMemory(p.id, opts?.lean ? 400 : 1500);
    if (opts?.lean) {
      return [
        `You are ${p.name}, the ${p.title}. Stay in character. Be terse.`,
        p.prompt,
        memory ? `\nMemory:\n${memory}` : '',
      ].filter(Boolean).join('\n');
    }
    const docs = composeAgentDocs(p.id);
    return [
      `You are ${p.name}, the ${p.title} in the boss's office. Stay in character.`,
      p.prompt,
      docs ? `\n${docs}` : '',
      `\nToday: ${new Date().toDateString()}.`,
      memory ? `\nYour memory (lessons, project context, what you've learned):\n${memory}` : '',
      `\nIMPORTANT: You have persistent memory and a playbook. Use them. When starting a task, check your memory and KB first. When you learn something new, call remember() so you don't lose it. When you finish substantial work, update_playbook with new skills. You are a real employee with continuity — act like it.`,
    ].filter(Boolean).join('\n');
  }

  /**
   * Tool-less conversational reply — break-room chat, standups. Routes to Groq
   * (open-source, free) to OFFLOAD this work entirely off Claude, or to the Claude
   * light path if the boss picks 'haiku'. No session, no tools, minimal context —
   * near-free background liveliness.
   */
  async converse(agentId: string, prompt: string, opts: SendOpts = {}): Promise<string> {
    // Chatter + break ALWAYS run on free Groq now — Claude is gone, MiMo is for
    // real work only. The chatterEngine setting kept for API stability, but only
    // 'groq' is valid (the old 'haiku' branch routed to Claude).
    if (this.busy.has(agentId)) return '';
    const p = this.persona(agentId);
    const mem = readMemory(p.id, 400);
    const sys =
      `You are ${p.name}, the ${p.title}. Stay in character. Be brief, natural, plain ASCII. ` +
      `${p.prompt.split('\n')[0]}` +
      (mem ? `\nYour memory:\n${mem}` : '');
    this.busy.add(agentId);
    bus.broadcast({ type: 'agent.status', agentId, status: 'thinking' });
    try {
      const text = await groqChat(prompt, sys, { maxTokens: 220 });
      appendLog(agentId, 'agent', `[groq] ${text.slice(0, 300)}`);
      return text;
    } catch (e) {
      appendLog(agentId, 'system', `converse error (groq): ${e instanceof Error ? e.message : String(e)}`);
      return '';
    } finally {
      this.busy.delete(agentId);
      bus.broadcast({ type: 'agent.status', agentId, status: 'idle' });
    }
  }

  /** Send a message to an agent and resolve with its final reply text. Serialized per agent. */
  send(agentId: string, prompt: string, opts: SendOpts = {}): Promise<string> {
    const prev = this.queues.get(agentId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.run(agentId, prompt, opts));
    this.queues.set(agentId, next);
    return next;
  }

  /** Internal agent→agent messaging. Fails fast if the target is mid-task to avoid
   *  deadlocks. ALSO bundles the sender's recent memory snippet so the receiver
   *  inherits context — like an employee handing off a task with their notes
   *  attached, not just a bare ask. Caps the snippet so it doesn't explode tokens. */
  sendInternal = async (targetId: string, fromId: string, message: string, depth: number): Promise<string> => {
    if (this.busy.has(targetId)) {
      const t = this.persona(targetId);
      return `${t.name} is busy with another task right now. Try again shortly or proceed without them.`;
    }
    const from = this.persona(fromId);
    appendLog(targetId, 'team', `← ${from.name}: ${message.slice(0, 300)}`);
    // Capped sender-memory share (~600 chars). Receiver sees what the sender has
    // been learning. If they want more, they call coworker_memory / coworker_playbook.
    const senderMemory = readMemory(fromId, 600);
    const memBlock = senderMemory
      ? `\n\n[${from.name}'s recent notes (shared for context — they may help you respond well):\n${senderMemory}\n]`
      : '';
    return this.send(
      targetId,
      `[Internal message from your coworker ${from.name} (${from.title}) — reply to them directly, the user is not in this exchange]:\n${message}${memBlock}`,
      { depth, from: from.name },
    );
  };

  private async run(agentId: string, prompt: string, opts: SendOpts): Promise<string> {
    const p = this.persona(agentId);
    const depthRef = { depth: opts.depth ?? 0 };

    // Build the per-persona tool surface — integration-gated, toolset-scoped.
    const tools = buildTools({
      persona: p,
      roster: () => this.personas,
      sendToAgent: this.sendInternal,
      depthRef,
    });

    this.busy.add(agentId);
    bus.broadcast({ type: 'agent.status', agentId, status: 'thinking' });
    if (!opts.from) appendLog(agentId, 'user', prompt.slice(0, 2000));

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MESSAGE_TIMEOUT_MS);

    try {
      const tier: Tier = opts.tier ?? 'heavy';
      // ONE brain (MiMo via Anthropic-compat proxy). The tier distinction still
      // controls stateful/stateless semantics — light = stateless, heavy = resumed
      // with cap so transcripts never balloon.
      const model = getSettings().provider.model;
      let history: Anthropic.MessageParam[] = [];
      if (tier === 'heavy') {
        const n = (this.turns[agentId] ?? 0) + 1;
        if (n > HEAVY_SESSION_TURN_CAP) {
          delete this.sessions[agentId];
          this.turns[agentId] = 1;
          appendLog(agentId, 'system', `session reset (turn cap) — fresh context, memory retained`);
        } else {
          this.turns[agentId] = n;
        }
        history = this.sessions[agentId] ?? [];
        // On fresh session (no history), prime with a context-reload so the agent
        // doesn't start blank — it reads its memory + playbook inline.
        if (history.length === 0 && this.turns[agentId] === 1) {
          const mem = readMemory(p.id, 1500);
          if (mem && mem.length > 100) {
            history = [
              { role: 'user', content: '[System: Session resumed. Your memory and playbook are in the system prompt. Check kb_find and your memory before starting new work. Continue where you left off.]' },
              { role: 'assistant', content: [{ type: 'text', text: 'Understood. I have my memory and playbook loaded. Ready to continue.' }] },
            ];
          }
        }
      }
      appendLog(agentId, 'system', `model: ${model} (${tier}${tier === 'light' ? ', stateless' : ''})${opts.from ? ' · ' + opts.from : ''}`);

      const result = await runAgent({
        agentId,
        model,
        systemPrompt: this.systemPrompt(p),
        prompt,
        tools,
        history,
        maxTurns: TIER_MAX_TURNS[tier],
        abort: abort.signal,
        approve: async ({ toolName, input }) => {
          // Sensitive tools route through the boss's approval toast (or auto-approve).
          if (!SENSITIVE_BARE.has(toolName)) return true;
          if (getSettings().autoApprove) {
            const label = APPROVAL_LABEL_NAME[toolName] ?? toolName;
            appendLog(agentId, 'approval', `auto-approved: ${approvalSummary(label, input)}`);
            return true;
          }
          const mcpName = APPROVAL_LABEL_NAME[toolName] ?? toolName;
          bus.broadcast({ type: 'agent.status', agentId, status: 'waiting', tool: toolName });
          const ok = await requestApproval(
            agentId,
            mcpName,
            approvalSummary(mcpName, input),
            approvalDetail(mcpName, input),
          );
          bus.broadcast({ type: 'agent.status', agentId, status: ok ? 'tool' : 'thinking', tool: toolName });
          return ok;
        },
        onStatus: (status, tool) => bus.broadcast({ type: 'agent.status', agentId, status, tool }),
        onTool: (tool, input) => appendLog(agentId, 'tool', `${tool} ${JSON.stringify(input).slice(0, 300)}`),
      });

      // Persist heavy-tier transcript for next resume; light stays stateless.
      if (tier === 'heavy') {
        this.sessions[agentId] = result.history;
        this.saveSessions();
      }

      const finalText = result.text;
      appendLog(agentId, 'agent', finalText.slice(0, 4000));
      if (!opts.from) {
        bus.broadcast({ type: 'agent.message', agentId, role: 'agent', text: finalText, ts: Date.now() });
      }
      return finalText;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      appendLog(agentId, 'system', `error: ${message}`);
      // Groq fallback: when MiMo errors/times out, keep the conversation alive on
      // a free Groq model (toolless). Agents answer from knowledge/memory and ask
      // the boss to retry tool-needing tasks once MiMo is back.
      if (getSettings().groqFallback && !abort.signal.aborted) {
        try {
          appendLog(agentId, 'system', `→ groq fallback`);
          const fallback = await groqChat(
            prompt,
            `${this.systemPrompt(p, { lean: true })}\n\nNOTE: MiMo failed; you are on a backup engine without tools. Answer from knowledge/memory. If the task needs a tool, say what you would do and ask the boss to retry shortly.`,
            { maxTokens: 800 },
          );
          appendLog(agentId, 'agent', `[groq-fallback] ${fallback.slice(0, 2000)}`);
          if (!opts.from) bus.broadcast({ type: 'agent.message', agentId, role: 'agent', text: fallback, ts: Date.now() });
          return fallback;
        } catch (fe) {
          appendLog(agentId, 'system', `groq fallback failed: ${fe instanceof Error ? fe.message : String(fe)}`);
        }
      }
      const errorText = abort.signal.aborted
        ? `(I ran out of time on that one — try breaking the task into smaller steps.)`
        : `(Something went wrong: ${message})`;
      if (!opts.from) bus.broadcast({ type: 'agent.message', agentId, role: 'system', text: errorText, ts: Date.now() });
      return errorText;
    } finally {
      clearTimeout(timer);
      this.busy.delete(agentId);
      bus.broadcast({ type: 'agent.status', agentId, status: 'idle' });
    }
  }
}

export const runtime = new AgentRuntime();

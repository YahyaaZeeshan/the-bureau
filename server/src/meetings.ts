import crypto from 'node:crypto';
import { runtime } from './agents.js';
import { bus } from './bus.js';
import { appendLog } from './logs.js';
import { groqChat } from './integrations.js';
import type { MeetingState } from './types.js';

let meeting: MeetingState | null = null;

export function currentMeeting(): MeetingState | null {
  return meeting;
}

// ── token control: a routing/state-manager layer over the transcript ──────────
// Naive meetings re-broadcast the whole chronological transcript to every speaker
// (Priya→Marco→Dex…), so each turn re-sends every prior turn — O(N^2) tokens.
// Instead we feed each responder a compact context: a rolling Groq-made DIGEST of
// older turns plus the last few turns verbatim (each capped). Full transcript is
// still kept for the UI; only what the LLM ingests is shrunk.

const RAW_TAIL = 6; // how many most-recent turns to pass verbatim
const LINE_CAP = 240; // per-turn char cap in the verbatim tail
const FOLD_EVERY = 8; // once this many turns sit beyond the tail, fold them into the digest

const capLine = (t: { speaker: string; text: string }) =>
  `${t.speaker}: ${t.text.length > LINE_CAP ? t.text.slice(0, LINE_CAP) + '…' : t.text}`;

/** Fold older (beyond-the-tail) turns into the rolling digest with a cheap Groq call. */
async function foldDigest(m: MeetingState): Promise<void> {
  const upto = m.transcript.length - RAW_TAIL;
  const from = m.digestUpto ?? 0;
  if (upto - from < FOLD_EVERY) return;
  const chunk = m.transcript.slice(from, upto).map((t) => `${t.speaker}: ${t.text}`).join('\n');
  try {
    const digest = await groqChat(
      `${m.digest ? `Running summary:\n${m.digest}\n\n` : ''}New discussion:\n${chunk}\n\n---\nUpdate the running summary of this meeting in <=8 terse bullets: decisions made, open questions, action items with owners. Keep only what future speakers need.`,
      'You maintain a tight meeting summary. Output only the bullets.',
      { maxTokens: 400, temperature: 0.2 },
    );
    m.digest = digest;
    m.digestUpto = upto;
  } catch {
    // Groq down — fall back to just advancing the pointer so we don't refold forever;
    // the verbatim tail still carries recent context.
    m.digestUpto = upto;
  }
}

/** Compact context handed to a responder: digest of old turns + capped recent turns. */
function meetingContext(m: MeetingState): string {
  const tail = m.transcript.slice(Math.max(m.digestUpto ?? 0, m.transcript.length - RAW_TAIL));
  return [
    m.digest ? `Earlier in this meeting (summary):\n${m.digest}` : '',
    tail.length ? `Recent turns:\n${tail.map(capLine).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function startMeeting(attendees: string[]): MeetingState {
  meeting = { id: crypto.randomUUID().slice(0, 8), attendees, transcript: [], active: true };
  for (const a of attendees) appendLog(a, 'system', `joined meeting ${meeting.id}`);
  bus.broadcast({ type: 'meeting.state', meeting });
  void standupRound(meeting);
  return meeting;
}

/**
 * Opening standup: each attendee shares what they're working on, fresh learnings,
 * blockers, and one decision-support insight for the boss. Uses send() (heavy tier
 * with tools) so agents can actually look up Jira, KB, etc. for real data.
 */
async function standupRound(m: MeetingState): Promise<void> {
  for (const agentId of m.attendees) {
    if (!m.active) return;
    const p = runtime.personas.find((x) => x.id === agentId);
    if (!p) continue;
    const ctx = meetingContext(m);
    const reply = await runtime.send(
      agentId,
      `[MEETING ${m.id} — opening standup. ${ctx ? ctx + '\n\n' : ''}Give your standup as ${p.name}. USE YOUR TOOLS to pull real data — check Jira for ticket status, check KB for recent docs, check your memory. Then report max 4 short bullets: (1) current state of your area with real numbers/ticket keys, (2) anything new you discovered worth sharing, (3) blockers or missing credentials, (4) one actionable recommendation for the boss. Don't repeat what coworkers already said. Be specific — names, numbers, ticket keys, dates.]`,
      { from: 'meeting', tier: 'heavy' },
    );
    if (!m.active) return;
    m.transcript.push({ speaker: p.name, text: reply, ts: Date.now() });
    bus.broadcast({ type: 'meeting.state', meeting: m });
    bus.broadcast({ type: 'agent.message', agentId, role: 'agent', text: reply, meetingId: m.id, ts: Date.now() });
  }
}

/**
 * User speaks in the meeting. Each attendee responds in turn, seeing the
 * transcript so far (including coworkers' replies earlier in the round).
 */
/** Which attendees does this text @-mention (by name), excluding the speaker? */
function mentionedAttendees(text: string, excludeId: string): string[] {
  const t = text.toLowerCase();
  return meeting!.attendees.filter((id) => {
    if (id === excludeId) return false;
    const p = runtime.personas.find((x) => x.id === id);
    return p && t.includes('@' + p.name.toLowerCase());
  });
}

const CONVERGED = /\b(nothing to add|no further|all set|we'?re done|task (is )?(complete|done)|done here)\b/i;

export async function meetingSay(text: string): Promise<void> {
  if (!meeting?.active) throw new Error('No active meeting');
  const m = meeting;
  m.transcript.push({ speaker: 'You', text, ts: Date.now() });
  bus.broadcast({ type: 'meeting.state', meeting: m });

  // Address a single attendee with @name to skip the round-robin
  const direct = m.attendees.find((id) => {
    const p = runtime.personas.find((x) => x.id === id);
    return p && text.toLowerCase().includes('@' + p.name.toLowerCase());
  });

  // Turn queue: start with the addressed agent (or everyone), then let agents pull
  // each other in by @-mentioning, so they collaborate until the task is done.
  // A turn budget caps total agent turns per message → bounded tokens, no infinite loop.
  const queue: string[] = direct ? [direct] : [...m.attendees];
  const budget = direct ? 8 : Math.min(20, m.attendees.length * 3 + 4);
  let turns = 0;

  while (queue.length && turns < budget && m.active) {
    const agentId = queue.shift()!;
    const p = runtime.personas.find((x) => x.id === agentId);
    if (!p) continue;
    turns++;
    await foldDigest(m);
    const ctx = meetingContext(m);
    bus.broadcast({ type: 'agent.status', agentId, status: 'thinking' });
    const reply = await runtime.send(
      agentId,
      `[MEETING ${m.id} — you are in the meeting room with the boss${m.attendees.length > 1 ? ' and coworkers' : ''}.]\n${ctx}\n\n[Respond as ${p.name}. IMPORTANT RULES FOR MEETINGS:
1. USE YOUR TOOLS actively — search Jira, check KB, web search, create docs. Meetings produce OUTPUT, not just talk.
2. When assigned a task, START it now with tools. Don't just acknowledge — do the work or at least the first step.
3. To pull a coworker in, @mention them by name (e.g. @Priya). They'll respond next.
4. When collaborating: read coworker memory/playbook first, then message them with context.
5. Produce documents (create_word_doc, submit_deliverable) for substantial findings.
6. Reference real data: ticket keys, URLs, specific numbers. Never vague hand-waving.
7. Get boss's approval before externally-visible actions.
8. When done: say "done" or "nothing to add". Don't pad.
Be concise but substantive.]`,
      { from: 'meeting', tier: 'heavy' },
    );
    if (!m.active) break;
    m.transcript.push({ speaker: p.name, text: reply, ts: Date.now() });
    bus.broadcast({ type: 'meeting.state', meeting: m });
    bus.broadcast({ type: 'agent.message', agentId, role: 'agent', text: reply, meetingId: m.id, ts: Date.now() });

    // If this agent pulled coworkers in (and isn't signalling completion), enqueue them.
    if (!CONVERGED.test(reply)) {
      for (const mid of mentionedAttendees(reply, agentId)) {
        if (!queue.includes(mid)) queue.push(mid);
      }
    }
  }
}

export function endMeeting(): void {
  if (!meeting) return;
  const m = meeting;
  m.active = false;
  for (const a of m.attendees) appendLog(a, 'system', `meeting ${m.id} ended`);
  bus.broadcast({ type: 'meeting.state', meeting: null });
  meeting = null;
  // Auto-generate meeting notes + action items via the notetaker (Zola) or first attendee
  void generateMeetingNotes(m);
}

/** After a meeting ends, have the notetaker (or first attendee) produce a meeting notes document. */
async function generateMeetingNotes(m: MeetingState): Promise<void> {
  if (m.transcript.length < 3) return; // too short to summarize
  const noteTaker = m.attendees.includes('notetaker') ? 'notetaker' : m.attendees[0];
  if (!noteTaker) return;
  const fullTranscript = m.transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n\n');
  const capped = fullTranscript.length > 12000 ? fullTranscript.slice(-12000) : fullTranscript;
  try {
    await runtime.send(
      noteTaker,
      `[MEETING ${m.id} JUST ENDED. Here is the full transcript:\n\n${capped}\n\n` +
      `CREATE A MEETING NOTES DOCUMENT using create_word_doc with this structure:\n` +
      `# Meeting Notes — ${new Date().toLocaleDateString()}\n` +
      `## Key Decisions\n(what was decided)\n` +
      `## Action Items\n(who | what | due date if mentioned)\n` +
      `## Discussion Summary\n(3-5 bullet points of what was discussed)\n` +
      `## Open Questions\n(unresolved items)\n\n` +
      `Also remember() the key decisions and action items so you retain them for future sessions. ` +
      `Name the doc "meeting-notes-${m.id}.docx".]`,
      { from: 'meeting-summary', tier: 'heavy' },
    );
  } catch (e) {
    appendLog(noteTaker, 'system', `meeting notes generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

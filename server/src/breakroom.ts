/**
 * Break-room conversations: while the office is on break, pairs of employees
 * have real (LLM) chats — sometimes sharing a useful thing they learned, sometimes
 * just casual talk. Runs on the cheap 'light' model, spaced out and capped so it
 * stays inexpensive. Lines surface as speech bubbles via 'office.say'.
 */
import { runtime } from './agents.js';
import { bus } from './bus.js';
import { appendLog } from './logs.js';
import { appendMemory } from './memory.js';

let active = false;
let timer: NodeJS.Timeout | null = null;
let exchanges = 0;
const MAX_EXCHANGES = 8; // after this they settle into canned ambient chatter

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shuffle = <T>(a: T[]): T[] => a.sort(() => Math.random() - 0.5);

export function isBreak(): boolean {
  return active;
}

export function startBreak(): void {
  if (active) return;
  // Break chatter runs on free Groq (forced in converse), so it's allowed regardless
  // of the autonomousChat toggle — no Claude spend. Skipped only if Groq isn't
  // configured (converse will throw and the catch keeps the break visual-only).
  active = true;
  exchanges = 0;
  schedule(9000); // let them walk to the break room first
}

export function endBreak(): void {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runExchange, ms);
}

async function runExchange(): Promise<void> {
  if (!active) return;
  if (exchanges >= MAX_EXCHANGES) return; // done for this break
  const free = shuffle(runtime.personas.map((p) => p.id).filter((id) => !runtime.isBusy(id)));
  if (free.length < 2) {
    schedule(30_000);
    return;
  }
  const [aId, bId] = free;
  const a = runtime.persona(aId);
  const b = runtime.persona(bId);
  const casual = Math.random() < 0.5;
  exchanges++;

  try {
    const aPrompt = casual
      ? `[BREAK ROOM — you're relaxing with your coworker ${b.name}. Open a light, NON-work chat in ONE short sentence (weekend, food, a hobby, something fun you saw). Just the line, in character.]`
      : `[BREAK ROOM — chatting with ${b.name} over coffee. Share ONE genuinely useful thing from YOUR work that ${b.name} might benefit from — a tip, a tool, a lesson. One or two friendly sentences. Just the line.]`;
    const aLine = await runtime.converse(aId, aPrompt, { from: 'break' });
    if (!aLine) { schedule(30_000); return; }
    if (!active) return;
    bus.broadcast({ type: 'office.say', agentId: aId, text: aLine });
    appendLog(aId, 'team', `break → ${b.name}: ${aLine.slice(0, 200)}`);

    await wait(4000);
    if (!active) return;

    const bPrompt = `[BREAK ROOM — your coworker ${a.name} just said to you: "${aLine}". Reply naturally in ONE or two sentences. If they shared something useful, say what you took from it.]`;
    const bLine = await runtime.converse(bId, bPrompt, { from: 'break' });
    if (!bLine) return;
    if (!active) return;
    bus.broadcast({ type: 'office.say', agentId: bId, text: bLine });
    appendLog(bId, 'team', `break ← ${a.name}: ${bLine.slice(0, 200)}`);

    // a knowledge exchange sometimes sticks as a real lesson for the listener
    if (!casual && Math.random() < 0.6) {
      appendMemory(bId, `Break-room tip from ${a.name}: ${aLine.slice(0, 180)}`);
    }
  } catch {
    /* one failed exchange shouldn't stop the break */
  }
  schedule(35_000 + Math.random() * 25_000); // next pair in ~35–60s
}

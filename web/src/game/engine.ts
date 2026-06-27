import { TILE, type Character, type Seat } from './types.js';
import { getDeskSeats, setDeskCount, meetingSeats, playerMeetingSeat, breakSpots, playerSpawn, isWalkable } from './map.js';
import { findPath } from './path.js';

export type OfficeMode = 'work' | 'break' | 'meeting';

export interface PersonaLite {
  id: string;
  name: string;
  title: string;
  emoji: string;
  sprite: number;
}

const WALK_SPEED = 56; // px/s

// ════════════════ dialogue pools ════════════════

/** muttering while working at the desk */
const WORK_MUTTER: Record<string, string[]> = {
  generic: [
    'Focus mode: ON 🎯', 'Almost done with my notes…', 'Deep work hours 💪', 'Inbox zero, here I come',
    'This keyboard is so clicky, love it', 'One more task, then tea', 'Where did I put that doc…',
    'Okay, that\'s clever. Saving that.', 'Hmm, let me double-check that', 'Today is a shipping day 🚀',
  ],
  pm: [
    'Sprint board looking cleaner today 📋', 'Three tickets stalled… chasing them', 'Standup notes done ✅',
    'QA queue needs eyes 👀', 'Rebalancing load across the team…', 'Release notes draft brewing',
    'That ticket is 26 days stale. Unacceptable.', 'Velocity chart trending up 📈', 'Retro action items: logged',
  ],
  researcher: [
    'Found an interesting competitor move 🔎', 'Market data never sleeps', 'Scraping something juicy…',
    'Trend lines look wild this week 📈', 'Adding sources to the brief…', 'This TAM estimate seems off…',
    'Cross-checking three sources 🧐', 'Competitor changed pricing again!',
  ],
  builder: [
    'This model runs in-browser, nice 🛠️', 'HF leaderboard check…', 'Demo idea: pose estimation 👀',
    'transformers.js keeps surprising me', 'Prototype almost compiles…', 'ONNX export worked first try?!',
    'WebGPU makes this 4x faster 🔥', '20 lines of code, full demo. Beautiful.',
  ],
  outreach: [
    'Found a perfectly aligned lab ✉️', 'Grant deadline radar: scanning…', 'Personalizing the pitch…',
    'This professor would LOVE our product', 'Pipeline doc updated 📑', 'Grant call closes next month — noted',
    'Their last paper is so relevant to us', 'Draft #3 reads much warmer now',
  ],
  notetaker: [
    'Action items from Wednesday logged 🎙️', 'Boss, your todo list is current ✅', 'Agenda drafted for next sync',
    'Catching up on meeting notes…', 'Decisions → documented 📝', 'ND sync is tomorrow — prep time',
    'Two follow-ups still open from Monday', 'Calendar tetris, my favorite game 📅',
  ],
};

/** quick desk-to-desk exchanges */
const PAIR_CHAT: [string, string][] = [
  ['Got a sec to compare notes?', 'Always — what are you seeing?'],
  ['The boss is going to like this one', 'Ship it to the inbox then!'],
  ['Any blockers on your side?', 'Nothing major — cruising 👍'],
  ['Did you read the new KB doc?', 'Yep — already using it'],
  ['Your last report was sharp', 'Thanks! Feedback made it better'],
  ['Deadline pressure?', 'Pressure makes diamonds 💎'],
  ['How\'s your queue looking?', 'Two down, one to go'],
  ['Need a second pair of eyes?', 'In ten minutes? You\'re the best'],
];

/** tea-time talk — unrelated-but-enriching; optional lesson gets remembered */
const TEA_TALK: { q: string; r: string; lesson?: string }[] = [
  { q: 'Did you see the new open-source model drop?', r: 'Beat the closed ones on half the benchmarks 🤯', lesson: 'Open-source models are closing the gap fast — re-evaluate build-vs-buy assumptions regularly.' },
  { q: 'Everyone\'s talking about agentic workflows now', r: 'Right? Single prompts are so 2024', lesson: 'Industry is shifting from single prompts to multi-step agentic workflows.' },
  { q: 'On-device AI is getting scary good', r: 'Phones running 7B models… wild times', lesson: 'On-device inference is becoming viable — relevant for robotics latency questions.' },
  { q: 'Robotics funding is heating up again', r: 'Humanoids everywhere in the news', lesson: 'Robotics investment cycle is hot — good timing for grant applications.' },
  { q: 'I read multimodal models now handle video natively', r: 'Pose estimation basically for free now', lesson: 'Modern multimodal models handle video/pose natively — could simplify our demos.' },
  { q: 'EU AI Act enforcement started, you know', r: 'Compliance is becoming a feature', lesson: 'AI regulation (EU AI Act) is now enforced — academic partners care about compliance.' },
  { q: 'Tried that pomodoro thing yet?', r: '25 minutes on, 5 off. Life-changing ☕', lesson: 'Focused time-boxing improves output quality — batch deep work.' },
  { q: 'Best tea in this office?', r: 'Green, obviously. Fight me 🍵' },
  { q: 'Weekend plans?', r: 'Sleep. Glorious sleep 😴' },
  { q: 'If you weren\'t in this job, what would you do?', r: 'Open a tiny bakery. No tickets, just bread 🥖' },
  { q: 'The office plants are thriving', r: 'Zola waters them. Don\'t tell anyone 🌱' },
  { q: 'Saw a paper on sim-to-real transfer', r: 'Gap is shrinking every quarter', lesson: 'Sim-to-real transfer is improving — simulator testing gains value.' },
];

/** substantive knowledge sharing — listener (and speaker) learn */
const KNOWLEDGE_SHARE: { q: string; r: string; lesson: string }[] = [
  { q: 'Pro tip: always check ticket history before escalating', r: 'Saved me twice this week already', lesson: 'Check ticket history before escalating — context prevents noise.' },
  { q: 'Scrape the sitemap first, then the pages', r: 'So much faster than crawling blind', lesson: 'When scraping: sitemap first, then targeted pages — faster and politer.' },
  { q: 'HF model cards list known failure modes', r: 'Reading those saves demo embarrassment', lesson: 'Read HF model cards for failure modes before demoing a model.' },
  { q: 'Grant reviewers skim — first paragraph wins', r: 'Same with cold emails honestly', lesson: 'Grant/outreach writing: the first paragraph decides — front-load alignment.' },
  { q: 'I tag every meeting decision with an owner', r: 'Stealing that for my notes', lesson: 'Tag every decision with an owner + due date — accountability sticks.' },
  { q: 'GitHub stars lie; check commit recency', r: 'Dead repos with 10k stars everywhere', lesson: 'Judge repos by commit recency and issues, not stars.' },
  { q: 'Jira JQL "updated >= -24h" is my morning ritual', r: 'Better than scrolling the whole board', lesson: 'JQL `updated >= -24h` gives instant daily movement view.' },
  { q: 'Groq for bulk summaries, Claude for judgment', r: 'Right tool, right job 💸', lesson: 'Route bulk text work to cheap models; reserve strong models for judgment calls.' },
];

/** solo activity bubbles, by activity kind */
const ACTIVITY_LINES: Record<string, string[]> = {
  read: [
    '📖 "Designing Machine Learning Systems"… good chapter', '📖 This book on robot HRI is gold',
    '📖 Highlighting half the page, oops', '📖 Note to self: cite this in the next brief',
    '📖 Reading about grant strategy… useful', '📖 One chapter a day keeps stagnation away',
  ],
  webfind: [
    '🌐 Ooh, this benchmark is relevant to us…', '🌐 Saving this article for the team',
    '🌐 New gait-analysis dataset just dropped!', '🌐 This blog post explains it perfectly',
    '🌐 Bookmarked — knowledge base material', '🌐 Wait, this changes our assumptions…',
  ],
  ghfind: [
    '🐙 This repo could save Dex a week…', '🐙 MIT licensed AND maintained? Rare.',
    '🐙 1.2k stars, fresh commits — promising', '🐙 Forking this for later 🍴',
    '🐙 Their pose pipeline looks reusable', '🐙 Issue tracker is healthy. Good sign.',
  ],
  focus: [
    '🤫 Focus block — do not disturb', '🤫 Whiteboard time', '🤫 Thinking through the hard problem…',
    '🤫 Quiet room, loud thoughts', '🤫 Sketching the plan…',
  ],
  coffee: [
    '☕ Best part of the day', '🍵 Tea o\'clock', '☕ Refill number three…', '☕ Mmm, fresh brew',
  ],
  walk: ['Stretching the legs 🚶', 'Tea time ☕', 'Quick break, brain needs it', 'Be right back…', 'Off to the quiet room 🤫', 'Bookshelf calls 📚'],
  water: [
    '🪴 You thirsty, little guy?', '💧 Watering the office plants', '🌱 Grow grow grow',
    '🪴 Someone has to keep these alive', '💧 A bit of green keeps the mind fresh', '🌿 Looking healthy today',
  ],
  eat: [
    '🍱 Lunch break, earned it', '🍜 Mmm, noodles', '🥗 Fuel for the afternoon',
    '🍕 Pizza Friday? I hope so', '🍱 Eating at my desk again 😅', '🥪 Quick bite then back to it',
  ],
  snack: [
    '🍪 Just one cookie… or three', '🍎 Healthy choice today', '🍫 Brain needs sugar',
    '🥨 Snack run!', '🍩 Don\'t judge me', '🍌 Potassium boost ⚡',
  ],
};

/** discoveries occasionally become permanent memory */
const DISCOVERY_LESSONS: Record<string, string[]> = {
  read: [
    'From reading: write docs for the reader\'s next action, not for completeness.',
    'From reading: HRI research says users forgive errors when the robot acknowledges them.',
  ],
  webfind: [
    'Found online: new public gait/pose datasets appear monthly — check before collecting our own.',
    'Found online: WebGPU adoption makes browser demos viable for heavier models.',
  ],
  ghfind: [
    'GitHub find: healthy repos = recent commits + responsive issues; stars are vanity.',
    'GitHub find: several maintained pose-estimation repos exist — shortlist before building from scratch.',
  ],
};

// ════════════════ activity spots ════════════════

const READ_SPOTS: Seat[] = [
  { c: 9, r: 1, facing: 'up' },  // office bookshelf
  { c: 10, r: 1, facing: 'up' },
  { c: 20, r: 12, facing: 'down' }, // sofa reading
];

// Walkable tiles next to office plants — agent stands here facing the plant to water it.
const WATER_SPOTS: Seat[] = [
  { c: 2, r: 6, facing: 'left' },   // PLANT at (1,6)
  { c: 2, r: 15, facing: 'left' },  // LARGE_PLANT at (1,15)
  { c: 15, r: 6, facing: 'right' }, // CACTUS at (16,6)
];

// Spots where someone grabs a bite (break tables + desks-ish).
const EAT_SPOTS: Seat[] = [
  { c: 23, r: 14, facing: 'up' },   // coffee table
  { c: 26, r: 13, facing: 'up' },   // small table
  { c: 25, r: 12, facing: 'left' },
];

interface Activity {
  kind: 'coffee' | 'focus' | 'read' | 'wander' | 'water' | 'eat' | 'snack';
  until: number; // performance.now() deadline
  arrived: boolean;
  nextLine: number;
  flavor?: 'read' | 'webfind' | 'ghfind';
}

export class Engine {
  chars: Character[] = [];
  mode: OfficeMode = 'work';
  meetingAttendees: string[] = [];
  private chatterTimer = 8;
  private activityTimer = 20;
  private activities = new Map<string, Activity>();
  private homes = new Map<string, Seat>();
  private lastLearn = new Map<string, number>();

  init(personas: PersonaLite[]): void {
    setDeskCount(personas.length);
    const seats = getDeskSeats();
    this.chars = [
      this.makeChar({ id: 'you', name: 'You', title: 'The Boss', emoji: '👑', sprite: 5 }, playerSpawn, true),
      ...personas.map((p, i) => {
        const seat = seats[i % seats.length];
        this.homes.set(p.id, seat);
        const ch = this.makeChar(p, seat, false);
        ch.state = 'sit';
        ch.facing = seat.facing;
        return ch;
      }),
    ];
  }

  private static AGENT_COLORS = ['#4fc3f7', '#ab47bc', '#66bb6a', '#ff7043', '#ffd54f', '#ef5350', '#26c6da', '#7e57c2'];
  private makeChar(p: PersonaLite, seat: Seat, isPlayer: boolean): Character {
    const idx = this.chars.filter(c => !c.isPlayer).length;
    return {
      id: isPlayer ? 'you' : p.id,
      name: p.name,
      title: p.title,
      emoji: p.emoji,
      sprite: p.sprite,
      isPlayer,
      x: seat.c * TILE,
      y: seat.r * TILE,
      facing: seat.facing,
      state: isPlayer ? 'idle' : 'sit',
      path: [],
      animTime: 0,
      status: 'idle',
      color: isPlayer ? '#ffd700' : Engine.AGENT_COLORS[idx % Engine.AGENT_COLORS.length],
      wanderCooldown: 3 + Math.random() * 6,
    };
  }

  syncPersonas(personas: PersonaLite[]): void {
    if (!this.chars.find((c) => c.isPlayer)) {
      this.chars.unshift(this.makeChar({ id: 'you', name: 'You', title: 'The Boss', emoji: '👑', sprite: 5 }, playerSpawn, true));
    }
    // remove employees that were deleted
    const liveIds = new Set(personas.map((p) => p.id));
    for (const ch of this.chars.filter((c) => !c.isPlayer && !liveIds.has(c.id))) {
      this.chars = this.chars.filter((c) => c !== ch);
      this.homes.delete(ch.id);
      this.activities.delete(ch.id);
    }
    // grow/shrink desks to match headcount, then reassign homes by index
    setDeskCount(personas.length);
    const seats = getDeskSeats();
    for (const [i, p] of personas.entries()) {
      const seat = seats[i % seats.length];
      this.homes.set(p.id, seat);
      const ch = this.chars.find((c) => c.id === p.id);
      if (ch) {
        ch.name = p.name;
        ch.title = p.title;
        ch.emoji = p.emoji;
        ch.sprite = p.sprite;
        // if idle at a desk, nudge to the (possibly new) home seat
        if (!ch.path.length && this.mode === 'work' && ch.status === 'idle') this.goTo(ch, seat, true);
      } else {
        const nc = this.makeChar(p, seat, false);
        nc.state = 'walk';
        this.chars.push(nc);
        this.goTo(nc, seat, true);
        this.say(p.id, `Hi everyone, I'm ${p.name}! 👋`);
      }
    }
  }

  byId(id: string): Character | undefined {
    return this.chars.find((c) => c.id === id);
  }

  tileOf(ch: Character): { c: number; r: number } {
    return { c: Math.round(ch.x / TILE), r: Math.round(ch.y / TILE) };
  }

  home(id: string): Seat {
    return this.homes.get(id) ?? getDeskSeats()[0];
  }

  goTo(ch: Character, seat: Seat, sit: boolean): void {
    const from = this.tileOf(ch);
    const path = findPath(from, { c: seat.c, r: seat.r });
    if (!path) return;
    ch.path = path;
    ch.goal = { ...seat, sit };
    ch.state = path.length ? 'walk' : sit ? 'sit' : 'idle';
    if (!path.length) ch.facing = seat.facing;
  }

  /** boss command: send any character to a tile (player or selected employee) */
  commandMove(id: string, c: number, r: number): void {
    const ch = this.byId(id);
    if (!ch || !isWalkable(c, r)) return;
    this.activities.delete(id);
    this.goTo(ch, { c, r, facing: ch.facing }, false);
  }

  movePlayerTo(c: number, r: number): void {
    this.commandMove('you', c, r);
  }

  setMode(mode: OfficeMode, meetingAttendees: string[] = []): void {
    this.mode = mode;
    this.meetingAttendees = meetingAttendees;
    this.activities.clear();
    const agents = this.chars.filter((c) => !c.isPlayer);
    if (mode === 'work') {
      agents.forEach((ch) => this.goTo(ch, this.home(ch.id), true));
    } else if (mode === 'break') {
      agents.forEach((ch, i) => this.goTo(ch, breakSpots[i % breakSpots.length], true));
    } else {
      let seatIdx = 0;
      for (const ch of agents) {
        if (meetingAttendees.includes(ch.id)) this.goTo(ch, meetingSeats[seatIdx++ % meetingSeats.length], true);
        else this.goTo(ch, this.home(ch.id), true);
      }
      const player = this.byId('you');
      if (player) this.goTo(player, playerMeetingSeat, true);
    }
  }

  setStatus(id: string, status: Character['status'], tool?: string): void {
    const ch = this.byId(id);
    if (!ch) return;
    ch.status = status;
    ch.statusTool = tool;
    // real work arrived → drop leisure, hurry back to the desk
    if (status !== 'idle' && this.activities.has(id) && this.mode === 'work') {
      this.activities.delete(id);
      this.say(id, 'Work calls! Back to my desk 🏃');
      this.goTo(ch, this.home(id), true);
    }
  }

  say(id: string, text: string): void {
    const ch = this.byId(id);
    if (!ch) return;
    ch.bubble = { text: text.length > 90 ? text.slice(0, 90) + '…' : text, until: performance.now() + 6000 };
  }

  /** persist a small ambient learning into the agent's server-side memory (rate-limited, ~20min) */
  private learn(id: string, lesson: string): void {
    const last = this.lastLearn.get(id) ?? 0;
    if (performance.now() - last < 20 * 60_000) return;
    this.lastLearn.set(id, performance.now());
    void fetch(`/api/memory/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lesson }),
    }).catch(() => undefined);
  }

  private idleAgents(): Character[] {
    return this.chars.filter((c) => !c.isPlayer && c.status === 'idle' && !c.path.length);
  }

  // ── ambient chatter ──
  private ambientChatter(): void {
    if (this.mode === 'meeting') return;
    const idle = this.idleAgents().filter((c) => !c.bubble);
    if (!idle.length) return;
    const roll = Math.random();
    if (idle.length >= 2 && roll < 0.22) {
      // substantive knowledge share — both sides learn
      const [a, b] = idle.sort(() => Math.random() - 0.5);
      const k = KNOWLEDGE_SHARE[Math.floor(Math.random() * KNOWLEDGE_SHARE.length)];
      this.say(a.id, k.q);
      setTimeout(() => {
        this.say(b.id, k.r);
        this.learn(b.id, `Learned from ${a.name}: ${k.lesson}`);
        if (Math.random() < 0.4) this.learn(a.id, `Shared with ${b.name}: ${k.lesson}`);
      }, 2800);
    } else if (idle.length >= 2 && roll < 0.38) {
      // getting to know a coworker (chatter only — not worth persisting to memory)
      const [a, b] = idle.sort(() => Math.random() - 0.5);
      this.say(a.id, `So ${b.name}, what's on your plate?`);
      setTimeout(() => this.say(b.id, `${b.title} things — busy week! And you?`), 2800);
    } else if (idle.length >= 2 && roll < 0.55) {
      const [a, b] = idle.sort(() => Math.random() - 0.5);
      const [q, r] = PAIR_CHAT[Math.floor(Math.random() * PAIR_CHAT.length)];
      this.say(a.id, q);
      setTimeout(() => this.say(b.id, r), 2600);
    } else {
      const ch = idle[Math.floor(Math.random() * idle.length)];
      const act = this.activities.get(ch.id);
      const pool = act
        ? ACTIVITY_LINES[act.flavor ?? act.kind] ?? ACTIVITY_LINES.walk
        : [...(WORK_MUTTER[ch.id] ?? []), ...WORK_MUTTER.generic];
      this.say(ch.id, pool[Math.floor(Math.random() * pool.length)]);
    }
  }

  // ── autonomous office activities ──
  private maybeStartActivity(): void {
    if (this.mode !== 'work') return;
    const candidates = this.idleAgents().filter((c) => !this.activities.has(c.id));
    if (!candidates.length) return;
    const ch = candidates[Math.floor(Math.random() * candidates.length)];
    const now = performance.now();
    const roll = Math.random();
    const start = (a: Activity, spot: Seat, sit: boolean, walkLine?: string) => {
      this.activities.set(ch.id, a);
      if (walkLine) this.say(ch.id, walkLine);
      this.goTo(ch, spot, sit);
    };
    if (roll < 0.26) {
      // coffee / tea — maybe bring a buddy
      const spotPool = breakSpots.slice();
      const spot = spotPool[Math.floor(Math.random() * spotPool.length)];
      start({ kind: 'coffee', until: now + (30 + Math.random() * 25) * 1000, arrived: false, nextLine: 0 }, spot, true, ACTIVITY_LINES.walk[1]);
      const buddy = this.idleAgents().find((c) => c.id !== ch.id && !this.activities.has(c.id));
      if (buddy && Math.random() < 0.6) {
        const spot2 = spotPool.filter((s) => s !== spot)[Math.floor(Math.random() * (spotPool.length - 1))];
        this.activities.set(buddy.id, { kind: 'coffee', until: now + (30 + Math.random() * 25) * 1000, arrived: false, nextLine: 0 });
        this.say(buddy.id, 'Tea run? I\'m in ☕');
        this.goTo(buddy, spot2, true);
        // tea talk once both settle
        setTimeout(() => {
          const t = TEA_TALK[Math.floor(Math.random() * TEA_TALK.length)];
          this.say(ch.id, t.q);
          setTimeout(() => {
            this.say(buddy.id, t.r);
            if (t.lesson) {
              this.learn(ch.id, `Tea-break chat with ${buddy.name}: ${t.lesson}`);
              this.learn(buddy.id, `Tea-break chat with ${ch.name}: ${t.lesson}`);
            }
          }, 3000);
        }, 9000);
      }
    } else if (roll < 0.42) {
      // focus session in the meeting room
      const spot = meetingSeats[Math.floor(Math.random() * meetingSeats.length)];
      start({ kind: 'focus', until: now + (45 + Math.random() * 30) * 1000, arrived: false, nextLine: 0 }, spot, true, ACTIVITY_LINES.walk[4]);
    } else if (roll < 0.58) {
      // reading / browsing discovery
      const spot = READ_SPOTS[Math.floor(Math.random() * READ_SPOTS.length)];
      const flavors: Activity['flavor'][] = ['read', 'webfind', 'ghfind'];
      const flavor = flavors[Math.floor(Math.random() * flavors.length)]!;
      start({ kind: 'read', until: now + (30 + Math.random() * 20) * 1000, arrived: false, nextLine: 0, flavor }, spot, spot.facing === 'down', ACTIVITY_LINES.walk[5]);
    } else if (roll < 0.70) {
      // water the office plants 🪴
      const spot = WATER_SPOTS[Math.floor(Math.random() * WATER_SPOTS.length)];
      start({ kind: 'water', until: now + (12 + Math.random() * 10) * 1000, arrived: false, nextLine: 0 }, spot, false, '🪴 Watering the plants');
    } else if (roll < 0.82) {
      // grab a bite — eat or snack
      const spot = EAT_SPOTS[Math.floor(Math.random() * EAT_SPOTS.length)];
      const kind = Math.random() < 0.5 ? 'eat' : 'snack';
      start({ kind, until: now + (20 + Math.random() * 15) * 1000, arrived: false, nextLine: 0 }, spot, true, kind === 'eat' ? '🍱 Lunch time' : '🍪 Snack run');
    } else {
      // little wander
      const t = this.tileOf(ch);
      for (let tries = 0; tries < 8; tries++) {
        const c = t.c + Math.floor(Math.random() * 9) - 4;
        const r = t.r + Math.floor(Math.random() * 9) - 4;
        if (isWalkable(c, r)) {
          start({ kind: 'wander', until: now + (10 + Math.random() * 10) * 1000, arrived: false, nextLine: 0 }, { c, r, facing: ch.facing }, false, ACTIVITY_LINES.walk[0]);
          break;
        }
      }
    }
  }

  private tickActivities(): void {
    const now = performance.now();
    for (const [id, act] of this.activities) {
      const ch = this.byId(id);
      if (!ch) {
        this.activities.delete(id);
        continue;
      }
      if (!act.arrived && !ch.path?.length) {
        act.arrived = true;
        act.nextLine = now + 3000;
      }
      if (act.arrived && now >= act.nextLine && !ch.bubble && Math.random() < 0.6) {
        act.nextLine = now + 11_000 + Math.random() * 8000;
        const pool = ACTIVITY_LINES[act.flavor ?? act.kind] ?? ACTIVITY_LINES.walk;
        this.say(id, pool[Math.floor(Math.random() * pool.length)]);
        // discoveries sometimes stick as memory
        if (act.flavor && Math.random() < 0.3) {
          const lessons = DISCOVERY_LESSONS[act.flavor];
          this.learn(id, lessons[Math.floor(Math.random() * lessons.length)]);
        }
      }
      if (now >= act.until) {
        this.activities.delete(id);
        if (this.mode === 'work' && ch.status === 'idle') {
          if (Math.random() < 0.4) this.say(id, 'Back to work 💼');
          this.goTo(ch, this.home(id), true);
        }
      }
    }
  }

  update(dt: number): void {
    this.chatterTimer -= dt;
    if (this.chatterTimer <= 0) {
      this.chatterTimer = 11 + Math.random() * 14;
      this.ambientChatter();
    }
    this.activityTimer -= dt;
    if (this.activityTimer <= 0) {
      this.activityTimer = 30 + Math.random() * 45;
      this.maybeStartActivity();
    }
    this.tickActivities();

    for (const ch of this.chars) {
      ch.animTime += dt;
      if (ch.bubble && performance.now() > ch.bubble.until) ch.bubble = undefined;

      if (ch.path.length) {
        ch.state = 'walk';
        const next = ch.path[0];
        const tx = next.c * TILE;
        const ty = next.r * TILE;
        const dx = tx - ch.x;
        const dy = ty - ch.y;
        const dist = Math.hypot(dx, dy);
        const step = WALK_SPEED * dt;
        if (Math.abs(dx) > Math.abs(dy)) ch.facing = dx > 0 ? 'right' : 'left';
        else if (dy !== 0) ch.facing = dy > 0 ? 'down' : 'up';
        if (dist <= step) {
          ch.x = tx;
          ch.y = ty;
          ch.path.shift();
          if (!ch.path.length) {
            if (ch.goal) {
              ch.facing = ch.goal.facing;
              ch.state = ch.goal.sit ? 'sit' : 'idle';
              ch.goal = undefined;
            } else ch.state = 'idle';
          }
        } else {
          ch.x += (dx / dist) * step;
          ch.y += (dy / dist) * step;
        }
      } else if (!ch.isPlayer && this.mode === 'break' && ch.state !== 'walk') {
        ch.wanderCooldown -= dt;
        if (ch.wanderCooldown <= 0) {
          ch.wanderCooldown = 4 + Math.random() * 8;
          if (ch.state !== 'sit' && Math.random() < 0.7) {
            const t = this.tileOf(ch);
            const c = t.c + Math.floor(Math.random() * 5) - 2;
            const r = t.r + Math.floor(Math.random() * 5) - 2;
            if (isWalkable(c, r) && c >= 19 && r >= 11) this.goTo(ch, { c, r, facing: ch.facing }, false);
          }
        }
      }
    }
  }

  /** character whose body covers this world pixel (topmost = highest y) */
  hitTest(wx: number, wy: number): Character | null {
    let best: Character | null = null;
    for (const ch of this.chars) {
      const cx = ch.x + TILE / 2;
      if (Math.abs(wx - cx) <= 8 && wy >= ch.y - 8 && wy <= ch.y + TILE) {
        if (!best || ch.y > best.y) best = ch;
      }
    }
    return best;
  }
}

import { TILE, type Character } from './types.js';
import { COLS, ROWS, isWall, floorZone, getFurniture, worldW, worldH } from './map.js';
import { tinted, type GameAssets } from './assets.js';
import type { Engine } from './engine.js';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

const WALL_COLOR = '#6a6a8e';

/** friendly activity text for the bubble above a busy character's head */
const TOOL_VERBS: Record<string, string> = {
  jira_search: 'checking Jira…', jira_get: 'reading a ticket…', jira_projects: 'listing projects…',
  jira_create: 'creating a ticket…', jira_update: 'updating a ticket…', jira_delete: 'deleting a ticket…',
  jira_transition: 'moving a ticket…', jira_comment: 'commenting on Jira…',
  kb_read: 'reading the docs…', kb_list: 'browsing the docs…', kb_search: 'searching the docs…',
  kb_write: 'writing a doc…', kb_delete: 'deleting a doc…', kb_find: 'searching the knowledge base…',
  scrape_page: 'scraping a website…', markdownify: 'reading a website…',
  WebSearch: 'googling…', WebFetch: 'browsing the web…',
  email_save_draft: 'drafting an email…', email_send: 'sending an email…', email_list_drafts: 'checking drafts…',
  hf_search_models: 'scouting Hugging Face…', hf_search_spaces: 'scouting HF Spaces…', hf_model_info: 'reading a model card…',
  gh_search_repos: 'searching GitHub…', gh_readme: 'reading a README…', gh_clone: 'cloning a repo…',
  zoom_list_recordings: 'checking Zoom…', zoom_get_transcript: 'fetching a transcript…', zoom_upcoming_meetings: 'checking calendar…',
  team_message: 'talking to a coworker…', team_roster: 'checking the roster…',
  summarize_text: 'crunching text…', remember: 'taking a note to self…',
  spotify_play: 'putting on a track 🎵', spotify_search: 'browsing Spotify…', spotify_pause: 'pausing the music…',
  spotify_resume: 'resuming the track…', spotify_next: 'skipping a song…', spotify_previous: 'rewinding a song…',
  spotify_seek: 'scrubbing the track…', spotify_volume: 'adjusting volume 🔊', spotify_now_playing: 'checking the playlist…',
  Bash: 'running commands…', Write: 'writing code…', Edit: 'editing code…',
  Read: 'reading files…', Glob: 'looking through files…', Grep: 'searching code…',
};
function activityText(ch: Character): string | null {
  if (ch.isPlayer) return null;
  if (ch.status === 'waiting') return 'needs your approval!';
  if (ch.status === 'tool') return TOOL_VERBS[ch.statusTool ?? ''] ?? `using ${ch.statusTool}…`;
  if (ch.status === 'thinking') return 'thinking…';
  return null;
}
const FRAME = { walk: [0, 1, 2, 1], type: [3, 4], read: [5, 6], idle: 1 };
const DIR_ROW: Record<string, number> = { down: 0, up: 1, right: 2, left: 2 };

function charFrame(ch: Character): { frame: number; row: number; flip: boolean } {
  const row = DIR_ROW[ch.facing];
  const flip = ch.facing === 'left';
  if (ch.state === 'walk') {
    const f = FRAME.walk[Math.floor(ch.animTime / 0.15) % 4];
    return { frame: f, row, flip };
  }
  if (ch.state === 'sit' && (ch.status === 'tool' || ch.status === 'thinking')) {
    const seq = ch.status === 'tool' ? FRAME.type : FRAME.read;
    return { frame: seq[Math.floor(ch.animTime / 0.3) % 2], row, flip };
  }
  return { frame: FRAME.idle, row, flip };
}

export function render(
  ctx: CanvasRenderingContext2D,
  assets: GameAssets,
  engine: Engine,
  cam: Camera,
  hoveredId: string | null,
  selectedId: string | null,
): void {
  const { canvas } = ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#14141f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);

  // ── floor ──
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (isWall(c, r)) continue;
      const z = floorZone(c, r);
      const img = assets.floors[z.pattern];
      ctx.drawImage(tinted(img, 0, 0, TILE, TILE, z.color, 'floor' + z.pattern), c * TILE, r * TILE);
    }
  }

  // ── entities (walls + furniture + characters), z-sorted ──
  interface Entity {
    zY: number;
    draw: () => void;
  }
  const entities: Entity[] = [];

  // walls (auto-tile bitmask: N=1 E=2 S=4 W=8 → 4x4 grid of 16x32 pieces)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isWall(c, r)) continue;
      let mask = 0;
      if (r > 0 && isWall(c, r - 1)) mask |= 1;
      if (c < COLS - 1 && isWall(c + 1, r)) mask |= 2;
      if (r < ROWS - 1 && isWall(c, r + 1)) mask |= 4;
      if (c > 0 && isWall(c - 1, r)) mask |= 8;
      const sx = (mask % 4) * 16;
      const sy = Math.floor(mask / 4) * 32;
      entities.push({
        zY: (r + 1) * TILE,
        draw: () =>
          ctx.drawImage(tinted(assets.walls, sx, sy, 16, 32, WALL_COLOR, 'wall' + mask), c * TILE, (r + 1) * TILE - 32),
      });
    }
  }

  // furniture
  const pcFrame = Math.floor(performance.now() / 400) % 3;
  for (const f of getFurniture()) {
    const assetId = f.anim ? f.anim[pcFrame] : f.asset;
    const entry = assets.catalog[assetId];
    const img = assets.furnitureImg.get(assetId);
    if (!entry || !img) continue;
    const x = f.col * TILE;
    const y = (f.row + 1) * TILE - entry.h;
    entities.push({
      zY: (f.row + 1) * TILE + (f.zBias ?? 0),
      draw: () => {
        if (f.flip) {
          ctx.save();
          ctx.translate(x + entry.w, y);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0);
          ctx.restore();
        } else ctx.drawImage(img, x, y);
      },
    });
  }

  // characters
  for (const ch of engine.chars) {
    const sheet = assets.characters[ch.sprite % assets.characters.length];
    const { frame, row, flip } = charFrame(ch);
    const sitOffset = ch.state === 'sit' ? 4 : 0;
    const dx = ch.x;
    const dy = ch.y - 8 + sitOffset;
    entities.push({
      zY: ch.y + TILE + 0.5,
      draw: () => {
        // colored glow ring under each agent
        if (!ch.isPlayer || hoveredId === ch.id || selectedId === ch.id) {
          const glowColor = selectedId === ch.id ? 'rgba(120,180,255,0.55)' : hoveredId === ch.id ? 'rgba(255,255,255,0.35)' : ch.color + '40';
          ctx.fillStyle = glowColor;
          ctx.beginPath();
          ctx.ellipse(ch.x + 8, ch.y + 15 + sitOffset, 8, 4, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.save();
        if (flip) {
          ctx.translate(dx + TILE, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(sheet, frame * 16, row * 32 + 8, 16, 24, 0, 0, 16, 24);
        } else {
          ctx.drawImage(sheet, frame * 16, row * 32 + 8, 16, 24, dx, dy, 16, 24);
        }
        ctx.restore();
      },
    });
  }

  entities.sort((a, b) => a.zY - b.zY);
  for (const e of entities) e.draw();

  // ── screen-space overlays (labels, status, bubbles) ──
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const toScreen = (wx: number, wy: number) => ({ x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y });

  for (const ch of engine.chars) {
    const p = toScreen(ch.x + 8, ch.y - 8 + (ch.state === 'sit' ? 4 : 0));
    // name label
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    const label = ch.isPlayer ? 'You' : ch.name;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(p.x - tw / 2 - 3, p.y - 14, tw + 6, 13);
    ctx.fillStyle = ch.color;
    ctx.fillText(label, p.x, p.y - 4);
    // activity chip — always tells you what the agent is doing right now
    const activity = activityText(ch);
    if (activity) {
      const icon = ch.status === 'waiting' ? '✋ ' : ch.status === 'tool' ? '⚙ ' : '💭 ';
      const label2 = icon + activity;
      ctx.font = '10.5px monospace';
      const w = ctx.measureText(label2).width;
      const bx = p.x - w / 2 - 5;
      const by = p.y - 31;
      ctx.fillStyle = ch.status === 'waiting' ? 'rgba(90,60,10,0.92)' : 'rgba(20,30,50,0.88)';
      ctx.strokeStyle = ch.status === 'waiting' ? '#ffb347' : '#4f9cf7';
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, w + 10, 15);
      ctx.strokeRect(bx, by, w + 10, 15);
      ctx.fillStyle = ch.status === 'waiting' ? '#ffd9a0' : '#cfe6ff';
      ctx.fillText(label2, p.x, p.y - 20);
    }
  }

  // speech bubbles last (on top)
  for (const ch of engine.chars) {
    if (!ch.bubble) continue;
    const p = toScreen(ch.x + 8, ch.y - 10);
    ctx.font = '11px sans-serif';
    const words = ch.bubble.text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      if (ctx.measureText(line + ' ' + w).width > 170) {
        lines.push(line.trim());
        line = w;
      } else line += ' ' + w;
    }
    if (line.trim()) lines.push(line.trim());
    const bw = Math.min(184, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14);
    const bh = lines.length * 13 + 10;
    const bx = Math.min(Math.max(p.x - bw / 2, 4), ctx.canvas.width - bw - 4);
    const by = p.y - 28 - bh;
    ctx.fillStyle = '#1e1e2e';
    ctx.strokeStyle = '#8888aa';
    ctx.lineWidth = 1.5;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#e8e8f0';
    ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 16 + i * 13));
  }
}

export function fitCamera(canvas: HTMLCanvasElement): Camera {
  const zoom = Math.max(2, Math.min(6, Math.floor(Math.min(canvas.width / worldW, (canvas.height - 20) / worldH))));
  return {
    zoom,
    x: Math.floor((canvas.width - worldW * zoom) / 2),
    y: Math.floor((canvas.height - worldH * zoom) / 2) + 8 * zoom,
  };
}

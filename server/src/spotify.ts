/**
 * Spotify integration (Zola = office DJ). Uses the Authorization Code flow:
 * the boss authorizes once (/api/spotify/login), we store the refresh token in
 * data/spotify.json, and mint short-lived access tokens from it as needed.
 *
 * NOTE: playback control (play/pause/seek/volume) needs Spotify Premium AND an
 * active device (the Spotify app open somewhere). Search works without playback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env, DATA_DIR } from './config.js';
import { bus } from './bus.js';

// ── music reactions (employee excitement on playback events) ──────────────
// When something happens on Spotify (play, pause, skip, volume) we want the
// office to FEEL alive: Zola announces, one or two random coworkers react with
// a short bubble. All lines are original short office dialogue — no lyrics,
// no song quotes, no copyrighted material.
const REACT_AGENTS = ['pm', 'researcher', 'builder', 'outreach'];

const COWORKER_LINES: Record<string, string[]> = {
  play: ['🎶 Banger', 'Oh I like this one', 'Nice pick Zola', '🎧 Volume me up', 'This is the vibe', 'Office energy +10', 'Yes please', 'Mood unlocked'],
  pause: ['Aww just getting into it', 'Why\'d it stop?', 'Bring it back', 'Hey that was good'],
  resume: ['Back on 🎶', 'Yes please', '🎧 Round two', 'There we go'],
  next: ['Skip skip', 'Nooo I liked that', 'Let\'s see what\'s next', 'Better pick incoming', 'Onto the next'],
  previous: ['Wait I want to hear that again', '🔁 Replay yes', 'This one again, good call'],
  volume_up: ['Louder!', 'Yes 🔊', 'Now we\'re talking'],
  volume_down: ['Thanks, can think now', 'Better', 'Phew my ears'],
  seek: ['🎶 Jumping around', 'Where are we now?'],
};

const ZOLA_LINES: Record<string, (label?: string) => string> = {
  play: (l) => l ? `🎧 Now spinning: ${l}` : '🎧 Putting something on',
  pause: () => '⏸ Pausing for now',
  resume: () => '▶ Back at it 🎶',
  next: () => '⏭ Next one coming',
  previous: () => '⏮ Rewinding',
  volume_up: () => '🔊 Cranking it',
  volume_down: () => '🔉 Bringing it down',
  seek: () => '⏩ Skipping ahead',
};

/** Broadcast Zola's announcement + a couple of timed coworker reactions. */
function announceMusic(action: keyof typeof COWORKER_LINES, label?: string): void {
  const zolaLine = ZOLA_LINES[action]?.(label);
  if (zolaLine) bus.broadcast({ type: 'office.say', agentId: 'notetaker', text: zolaLine });
  const pool = COWORKER_LINES[action];
  if (!pool?.length) return;
  // Pick 1-2 random coworkers, stagger them so it doesn't read like a chorus.
  const shuffled = [...REACT_AGENTS].sort(() => Math.random() - 0.5);
  const count = action === 'play' || action === 'resume' ? 2 : 1;
  shuffled.slice(0, count).forEach((id, i) => {
    const line = pool[Math.floor(Math.random() * pool.length)];
    setTimeout(() => bus.broadcast({ type: 'office.say', agentId: id, text: line }), 1400 + i * 1700);
  });
}

const TOKEN_FILE = path.join(DATA_DIR, 'spotify.json');
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

interface Store { refreshToken: string }
let access: { token: string; exp: number } | null = null;

function loadStore(): Store | null {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveStore(s: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(s, null, 2));
}

export function spotifyConfigured(): boolean {
  return !!(env.spotify.clientId && env.spotify.clientSecret);
}
export function spotifyLinked(): boolean {
  return !!loadStore()?.refreshToken;
}

const basicAuth = () => 'Basic ' + Buffer.from(`${env.spotify.clientId}:${env.spotify.clientSecret}`).toString('base64');

/** Step 1: URL the boss visits to authorize. */
export function spotifyAuthUrl(): string {
  if (!spotifyConfigured()) throw new Error('Spotify not configured (SPOTIFY_CLIENT_ID/SECRET in .env)');
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env.spotify.clientId,
    scope: SCOPES,
    redirect_uri: env.spotify.redirectUri,
  });
  return `https://accounts.spotify.com/authorize?${p}`;
}

/** Step 2: exchange the callback code for a refresh token and persist it. */
export async function spotifyExchangeCode(code: string): Promise<void> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.spotify.redirectUri }),
  });
  if (!r.ok) throw new Error(`Spotify token exchange failed: ${await r.text()}`);
  const d = (await r.json()) as { refresh_token: string; access_token: string; expires_in: number };
  saveStore({ refreshToken: d.refresh_token });
  access = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
}

async function accessToken(): Promise<string> {
  if (access && Date.now() < access.exp - 30_000) return access.token;
  const store = loadStore();
  if (!store?.refreshToken) throw new Error('Spotify not linked. Open /api/spotify/login once to authorize.');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.refreshToken }),
  });
  if (!r.ok) throw new Error(`Spotify refresh failed: ${await r.text()}`);
  const d = (await r.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  if (d.refresh_token) saveStore({ refreshToken: d.refresh_token });
  access = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return access.token;
}

/** Spotify Web API call. Returns parsed JSON, or {} for empty 204 (playback ops). */
async function api(method: string, apiPath: string, body?: unknown): Promise<any> {
  const token = await accessToken();
  const r = await fetch(`https://api.spotify.com/v1${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 404) throw new Error('No active Spotify device. Open Spotify on a device and start playing once, then retry.');
    throw new Error(`Spotify HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

// ── playback controls ───────────────────────────────────────
export async function spotifySearch(query: string, type: 'track' | 'playlist' | 'album' = 'track', limit = 5): Promise<any> {
  const d = await api('GET', `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
  const items = d[type + 's']?.items ?? [];
  return items.map((it: any) => ({
    name: it.name,
    uri: it.uri,
    artist: (it.artists ?? []).map((a: any) => a.name).join(', ') || undefined,
    durationMs: it.duration_ms,
  }));
}

/** Play a specific uri (track/playlist/album), or search by text and play the top hit. */
export async function spotifyPlay(opts: { uri?: string; query?: string }): Promise<string> {
  let uri = opts.uri;
  let label = uri;
  if (!uri && opts.query) {
    const hits = await spotifySearch(opts.query, 'track', 1);
    if (!hits.length) return `No track found for "${opts.query}"`;
    uri = hits[0].uri;
    label = `${hits[0].name} — ${hits[0].artist}`;
  }
  if (!uri) throw new Error('Provide a uri or a query to play');
  const isTrack = uri.includes(':track:');
  await api('PUT', '/me/player/play', isTrack ? { uris: [uri] } : { context_uri: uri });
  announceMusic('play', label && label !== uri ? label : undefined);
  return `▶ Playing ${label}`;
}

export const spotifyPause = async () => { await api('PUT', '/me/player/pause'); announceMusic('pause'); return '⏸ Paused'; };
export const spotifyResume = async () => { await api('PUT', '/me/player/play'); announceMusic('resume'); return '▶ Resumed'; };
export const spotifyNext = async () => { await api('POST', '/me/player/next'); announceMusic('next'); return '⏭ Skipped to next'; };
export const spotifyPrevious = async () => { await api('POST', '/me/player/previous'); announceMusic('previous'); return '⏮ Previous track'; };

/** Seek to an absolute position (ms) or a fraction (0–1, e.g. 0.5 = halfway). */
export async function spotifySeek(opts: { ms?: number; fraction?: number }): Promise<string> {
  let ms = opts.ms;
  if (ms === undefined && opts.fraction !== undefined) {
    const cur = await api('GET', '/me/player/currently-playing');
    const dur = cur?.item?.duration_ms;
    if (!dur) return 'Nothing is playing to seek within.';
    ms = Math.floor(dur * Math.min(1, Math.max(0, opts.fraction)));
  }
  if (ms === undefined) throw new Error('Provide ms or fraction to seek');
  await api('PUT', `/me/player/seek?position_ms=${ms}`);
  announceMusic('seek');
  return `⏩ Seeked to ${(ms / 1000).toFixed(0)}s`;
}

export async function spotifyVolume(percent: number): Promise<string> {
  const v = Math.min(100, Math.max(0, Math.round(percent)));
  await api('PUT', `/me/player/volume?volume_percent=${v}`);
  // Up vs down — needs the previous volume to know which way. Cheapest path:
  // bucket the new percent. ≥60 = "louder" energy; ≤40 = "quieter" energy.
  // 41–59 is a neutral nudge; skip the reaction so the office doesn't twitch on every tiny tweak.
  if (v >= 60) announceMusic('volume_up');
  else if (v <= 40) announceMusic('volume_down');
  return `🔊 Volume ${v}%`;
}

export async function spotifyNowPlaying(): Promise<string> {
  const d = await api('GET', '/me/player/currently-playing');
  if (!d?.item) return 'Nothing playing right now.';
  const artist = (d.item.artists ?? []).map((a: any) => a.name).join(', ');
  return `${d.is_playing ? '▶' : '⏸'} ${d.item.name} — ${artist}`;
}

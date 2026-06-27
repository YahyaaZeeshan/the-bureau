import { TILE, type Seat } from './types.js';

export const COLS = 30;
export const ROWS = 18;

export interface MapFurniture {
  asset: string;
  col: number;
  /** bottom tile row of the sprite (drawn bottom-aligned, z-sorted here) */
  row: number;
  zBias?: number;
  flip?: boolean;
  /** blocked tile offsets [dc, dr] relative to (col, row) */
  blocked?: [number, number][];
  /** animation frames cycle (asset ids) */
  anim?: string[];
}

// ── walls ──────────────────────────────────────────────────
export const wallSet = new Set<string>();
const wall = (c: number, r: number) => wallSet.add(c + ',' + r);
for (let c = 0; c < COLS; c++) {
  wall(c, 0);
  wall(c, ROWS - 1);
}
for (let r = 0; r < ROWS; r++) {
  wall(0, r);
  wall(COLS - 1, r);
}
for (let r = 1; r <= 10; r++) wall(18, r); // office | meeting divider
for (let c = 19; c <= 28; c++) if (c !== 23 && c !== 24) wall(c, 10); // meeting south wall + door
export const isWall = (c: number, r: number) => wallSet.has(c + ',' + r);

// ── floor zones (pattern index + tint) ─────────────────────
export function floorZone(c: number, r: number): { pattern: number; color: string } {
  if (c >= 19 && r <= 10) return { pattern: 4, color: '#5a6e8c' }; // meeting room
  if (c >= 19 || (c >= 18 && r >= 11)) return { pattern: 6, color: '#5f7d5a' }; // break area
  return { pattern: 1, color: '#8c6e54' }; // open office
}

// ── desks (dynamic — one per employee) ─────────────────────
const PC_ANIM = ['PC_FRONT_ON_1', 'PC_FRONT_ON_2', 'PC_FRONT_ON_3'];
const deskBlocked: [number, number][] = [
  [0, 0], [1, 0], [2, 0],
  [0, -1], [1, -1], [2, -1],
];
/** desk cluster: surface row r+1, PC row r, chair row r+2 (agent sits facing up at col c+1) */
const deskCluster = (c: number, r: number): MapFurniture[] => [
  { asset: 'DESK_FRONT', col: c, row: r + 1, blocked: deskBlocked },
  { asset: 'PC_FRONT_ON_1', col: c + 1, row: r, anim: PC_ANIM },
  { asset: 'CUSHIONED_CHAIR_BACK', col: c + 1, row: r + 2, zBias: 2 },
];

/** 3×3 grid of desk slots in the open-office area (left→right, top→bottom). */
const DESK_COLS = [3, 8, 13];
const DESK_ROWS = [2, 8, 14];
const DESK_SLOTS: { c: number; r: number }[] = DESK_ROWS.flatMap((r) => DESK_COLS.map((c) => ({ c, r })));
export const MAX_DESKS = DESK_SLOTS.length;

let deskCount = 5;
/** Set how many desks exist (= number of employees). Rebuilds walkability. */
export function setDeskCount(n: number): void {
  deskCount = Math.max(1, Math.min(MAX_DESKS, n));
  rebuildBlocked();
}
export function getDeskCount(): number {
  return deskCount;
}

/** Desk furniture for the active desks. */
function deskFurniture(): MapFurniture[] {
  return DESK_SLOTS.slice(0, deskCount).flatMap((s) => deskCluster(s.c, s.r));
}

/** Seat at each active desk's chair (col c+1, row r+2), facing up. */
export function getDeskSeats(): Seat[] {
  return DESK_SLOTS.slice(0, deskCount).map((s) => ({ c: s.c + 1, r: s.r + 2, facing: 'up' as const }));
}

// ── static furniture (decor, meeting room, break area) ─────
const STATIC_FURNITURE: MapFurniture[] = [
  // office decor
  { asset: 'CLOCK', col: 5, row: 0 },
  { asset: 'BOOKSHELF', col: 9, row: 0 },
  { asset: 'LARGE_PAINTING', col: 15, row: 0 },
  { asset: 'LARGE_PLANT', col: 1, row: 15, blocked: [[0, 0], [1, 0]] },
  { asset: 'BIN', col: 16, row: 12, blocked: [[0, 0]] },
  { asset: 'CACTUS', col: 16, row: 6, blocked: [[0, 0]] },
  { asset: 'PLANT', col: 1, row: 6, blocked: [[0, 0]] },
  // meeting room
  { asset: 'TABLE_FRONT', col: 22, row: 6, blocked: [
    [0, 0], [1, 0], [2, 0],
    [0, -1], [1, -1], [2, -1],
    [0, -2], [1, -2], [2, -2],
    [0, -3], [1, -3], [2, -3],
  ] },
  { asset: 'WHITEBOARD', col: 21, row: 0 },
  { asset: 'CUSHIONED_CHAIR_SIDE', col: 21, row: 4, flip: true },
  { asset: 'CUSHIONED_CHAIR_SIDE', col: 21, row: 6, flip: true },
  { asset: 'CUSHIONED_CHAIR_SIDE', col: 25, row: 4 },
  { asset: 'CUSHIONED_CHAIR_SIDE', col: 25, row: 6 },
  { asset: 'CUSHIONED_CHAIR_FRONT', col: 23, row: 2, zBias: -2 },
  { asset: 'CUSHIONED_CHAIR_BACK', col: 23, row: 7, zBias: 2 },
  { asset: 'SMALL_PAINTING', col: 26, row: 0 },
  { asset: 'LARGE_PLANT', col: 27, row: 3, blocked: [[0, 0], [1, 0]] },
  // break area
  { asset: 'SOFA_FRONT', col: 20, row: 12, zBias: -2 },
  { asset: 'COFFEE_TABLE', col: 23, row: 13, blocked: [[0, 0], [1, 0], [0, -1], [1, -1]] },
  { asset: 'COFFEE', col: 27, row: 11, blocked: [[0, 0]] },
  { asset: 'SMALL_TABLE_FRONT', col: 26, row: 12, blocked: [[0, 0], [1, 0], [0, -1], [1, -1]] },
  { asset: 'LARGE_PLANT', col: 27, row: 16, blocked: [[0, 0], [1, 0]] },
  { asset: 'PLANT_2', col: 19, row: 16, blocked: [[0, 0]] },
  { asset: 'HANGING_PLANT', col: 25, row: 0 },
  { asset: 'SMALL_PAINTING_2', col: 21, row: 10 },
];

/** All furniture currently in the office (active desks + static). Used by the renderer. */
export function getFurniture(): MapFurniture[] {
  return [...deskFurniture(), ...STATIC_FURNITURE];
}

// ── walkability ────────────────────────────────────────────
const blockedSet = new Set<string>();
function rebuildBlocked(): void {
  blockedSet.clear();
  for (const f of getFurniture()) {
    for (const [dc, dr] of f.blocked ?? []) blockedSet.add(f.col + dc + ',' + (f.row + dr));
  }
}
rebuildBlocked();
export function isWalkable(c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return false;
  return !isWall(c, r) && !blockedSet.has(c + ',' + r);
}

export const meetingSeats: Seat[] = [
  { c: 21, r: 4, facing: 'right' },
  { c: 21, r: 6, facing: 'right' },
  { c: 25, r: 4, facing: 'left' },
  { c: 25, r: 6, facing: 'left' },
  { c: 23, r: 2, facing: 'down' },
];
export const playerMeetingSeat: Seat = { c: 23, r: 7, facing: 'up' };

export const breakSpots: Seat[] = [
  { c: 20, r: 12, facing: 'down' }, // sofa
  { c: 21, r: 12, facing: 'down' }, // sofa
  { c: 23, r: 14, facing: 'up' },
  { c: 25, r: 12, facing: 'left' },
  { c: 22, r: 11, facing: 'down' },
  { c: 26, r: 15, facing: 'up' },
];

export const playerSpawn: Seat = { c: 8, r: 13, facing: 'down' };

export const worldW = COLS * TILE;
export const worldH = ROWS * TILE;

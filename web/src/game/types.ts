export const TILE = 16;

export type Facing = 'down' | 'up' | 'left' | 'right';

export interface FurnitureItem {
  /** asset id from catalog.json, e.g. DESK_FRONT */
  asset: string;
  col: number;
  /** row of the BOTTOM tile of the sprite — sprite is drawn bottom-aligned here and z-sorted by it */
  row: number;
  /** explicit blocked tiles relative to (col,row-bottom): list of [dc, dr] offsets; omit = use footprint minus bg rows */
  flip?: boolean;
}

export interface Seat {
  c: number;
  r: number;
  facing: Facing;
}

export interface CharacterDef {
  id: string;
  deskSeat: Seat;
  meetingSeat: Seat;
  breakSpot: Seat;
}

export type CharState = 'idle' | 'walk' | 'sit';

export interface Character {
  id: string;
  name: string;
  title: string;
  emoji: string;
  sprite: number;
  isPlayer: boolean;
  /** pixel position (top-left of 16px tile cell) */
  x: number;
  y: number;
  facing: Facing;
  state: CharState;
  path: { c: number; r: number }[];
  /** where they are headed, with desired facing on arrival */
  goal?: Seat & { sit: boolean };
  animTime: number;
  /** server status drives animation when seated */
  status: 'idle' | 'thinking' | 'tool' | 'waiting';
  statusTool?: string;
  bubble?: { text: string; until: number };
  color: string;
  wanderCooldown: number;
}

export interface AssetEntry {
  file: string;
  w: number;
  h: number;
  fw: number;
  fh: number;
  bg: number;
}
export type Catalog = Record<string, AssetEntry>;

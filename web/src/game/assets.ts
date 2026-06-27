import type { Catalog } from './types.js';

export interface GameAssets {
  characters: HTMLImageElement[];
  floors: HTMLImageElement[];
  walls: HTMLImageElement;
  furnitureImg: Map<string, HTMLImageElement>;
  catalog: Catalog;
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load ' + src));
    img.src = src;
  });

export async function loadAssets(): Promise<GameAssets> {
  const catalog = (await (await fetch('/assets/catalog.json')).json()) as Catalog;
  const characters = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => loadImage(`/assets/characters/char_${i}.png`)));
  const floors = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => loadImage(`/assets/floors/floor_${i}.png`)));
  const walls = await loadImage('/assets/walls/wall_0.png');
  const furnitureImg = new Map<string, HTMLImageElement>();
  const ids = Object.keys(catalog);
  await Promise.all(
    ids.map(async (id) => {
      furnitureImg.set(id, await loadImage('/' + catalog[id].file));
    }),
  );
  return { characters, floors, walls, furnitureImg, catalog };
}

/** Tint a grayscale sprite region with a color (canvas 'color' composite), preserving alpha. */
const tintCache = new Map<string, HTMLCanvasElement>();
export function tinted(
  img: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  color: string,
  key: string,
): HTMLCanvasElement {
  const k = key + '|' + color;
  let c = tintCache.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.globalCompositeOperation = 'color';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, sw, sh);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  tintCache.set(k, c);
  return c;
}

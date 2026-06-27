import { COLS, ROWS, isWalkable } from './map.js';

/** BFS shortest path on the tile grid. Returns tile list excluding start, or null. */
export function findPath(
  from: { c: number; r: number },
  to: { c: number; r: number },
  extraAllow?: (c: number, r: number) => boolean,
): { c: number; r: number }[] | null {
  const ok = (c: number, r: number) => isWalkable(c, r) || (extraAllow?.(c, r) ?? false);
  if (!ok(to.c, to.r)) return null;
  if (from.c === to.c && from.r === to.r) return [];
  const key = (c: number, r: number) => c + r * COLS;
  const prev = new Map<number, number>();
  prev.set(key(from.c, from.r), -1);
  let frontier = [{ c: from.c, r: from.r }];
  const dirs = [
    [0, 1], [0, -1], [1, 0], [-1, 0],
  ];
  while (frontier.length) {
    const next: { c: number; r: number }[] = [];
    for (const cur of frontier) {
      for (const [dc, dr] of dirs) {
        const c = cur.c + dc;
        const r = cur.r + dr;
        if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
        const k = key(c, r);
        if (prev.has(k) || !ok(c, r)) continue;
        prev.set(k, key(cur.c, cur.r));
        if (c === to.c && r === to.r) {
          const path: { c: number; r: number }[] = [];
          let cursor = k;
          while (cursor !== key(from.c, from.r)) {
            path.unshift({ c: cursor % COLS, r: Math.floor(cursor / COLS) });
            cursor = prev.get(cursor)!;
          }
          return path;
        }
        next.push({ c, r });
      }
    }
    frontier = next;
  }
  return null;
}

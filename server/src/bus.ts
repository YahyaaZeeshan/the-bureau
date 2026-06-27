import type { ServerMsg } from './types.js';

type Listener = (msg: ServerMsg) => void;
const listeners = new Set<Listener>();

/** Tiny broadcast bus so modules can push to all websocket clients without importing ws code. */
export const bus = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  broadcast(msg: ServerMsg): void {
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch {
        /* listener errors must not break broadcast */
      }
    }
  },
};

import { useEffect, useRef } from 'react';
import { Engine } from './engine.js';
import { loadAssets, type GameAssets } from './assets.js';
import { render, fitCamera, type Camera } from './render.js';
import { TILE } from './types.js';
import { useStore } from '../state.js';
import { registerEngineHooks } from '../ws.js';

export const engine = new Engine();

export function OfficeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const personas = useStore((s) => s.personas);
  const initialized = useRef(false);

  // (re)sync characters with personas
  useEffect(() => {
    if (!personas.length) return;
    if (!initialized.current) {
      engine.init(personas);
      initialized.current = true;
    } else {
      engine.syncPersonas(personas);
    }
  }, [personas]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let assets: GameAssets | null = null;
    let cam: Camera = { x: 0, y: 0, zoom: 3 };
    let raf = 0;
    let last = performance.now();
    let hovered: string | null = null;
    let dragging = false;
    let dragStart = { x: 0, y: 0, camX: 0, camY: 0, moved: false };
    let disposed = false;

    const resize = () => {
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
      cam = fitCamera(canvas);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // dev/debug handle: world→screen lookup for characters
    (window as unknown as Record<string, unknown>).__office = {
      engine,
      charScreenPos: (id: string) => {
        const ch = engine.byId(id);
        if (!ch) return null;
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left + (ch.x + 8) * cam.zoom / devicePixelRatio + cam.x / devicePixelRatio,
          y: rect.top + (ch.y + 8) * cam.zoom / devicePixelRatio + cam.y / devicePixelRatio,
        };
      },
    };

    registerEngineHooks({
      setStatus: (id, status, tool) => engine.setStatus(id, status as never, tool),
      say: (id, text) => engine.say(id, text),
      setMode: (mode, attendees) => engine.setMode(mode, attendees ?? []),
    });

    loadAssets().then((a) => {
      assets = a;
    }).catch((e) => console.error(e));

    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * devicePixelRatio;
      const py = (e.clientY - rect.top) * devicePixelRatio;
      return { wx: (px - cam.x) / cam.zoom, wy: (py - cam.y) / cam.zoom, px, py };
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1 || e.button === 2 || e.shiftKey) {
        dragging = true;
        dragStart = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y, moved: false };
        e.preventDefault();
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (dragging) {
        cam.x = dragStart.camX + (e.clientX - dragStart.x) * devicePixelRatio;
        cam.y = dragStart.camY + (e.clientY - dragStart.y) * devicePixelRatio;
        if (Math.abs(e.clientX - dragStart.x) + Math.abs(e.clientY - dragStart.y) > 4) dragStart.moved = true;
        return;
      }
      const { wx, wy } = toWorld(e);
      hovered = engine.hitTest(wx, wy)?.id ?? null;
      canvas.style.cursor = hovered ? 'pointer' : 'default';
    };
    const onMouseUp = () => {
      dragging = false;
    };
    // single click: select character / command selected one to move / move player
    // double click on a character: open their menu card
    let pendingClick: ReturnType<typeof setTimeout> | null = null;
    const onClick = (e: MouseEvent) => {
      if (dragStart.moved) {
        dragStart.moved = false;
        return;
      }
      const { wx, wy } = toWorld(e);
      const hit = engine.hitTest(wx, wy);
      const s = useStore.getState();

      if (e.detail >= 2) {
        if (pendingClick) {
          clearTimeout(pendingClick);
          pendingClick = null;
        }
        if (hit) {
          s.set({
            selectedChar: hit.isPlayer ? null : hit.id,
            charMenu: { id: hit.id, x: e.clientX, y: e.clientY },
          });
        }
        return;
      }

      if (pendingClick) clearTimeout(pendingClick);
      pendingClick = setTimeout(() => {
        pendingClick = null;
        const st = useStore.getState();
        if (hit) {
          // select (player click clears selection)
          st.set({ charMenu: null, selectedChar: hit.isPlayer ? null : hit.id });
        } else {
          const c = Math.floor(wx / TILE);
          const r = Math.floor(wy / TILE);
          st.set({ charMenu: null });
          if (st.selectedChar) {
            engine.commandMove(st.selectedChar, c, r); // boss sends employee somewhere
          } else {
            engine.movePlayerTo(c, r);
          }
        }
      }, 220);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().set({ selectedChar: null, charMenu: null });
    };
    window.addEventListener('keydown', onKeyDown);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const newZoom = Math.min(8, Math.max(1, cam.zoom + dir));
      if (newZoom === cam.zoom) return;
      // zoom toward cursor
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * devicePixelRatio;
      const py = (e.clientY - rect.top) * devicePixelRatio;
      const wx = (px - cam.x) / cam.zoom;
      const wy = (py - cam.y) / cam.zoom;
      cam.zoom = newZoom;
      cam.x = px - wx * newZoom;
      cam.y = py - wy * newZoom;
    };
    const onContext = (e: Event) => e.preventDefault();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);

    let errorCount = 0;
    const loop = (now: number) => {
      if (disposed) return;
      // Guard: a single throw in update/render must never kill the animation
      // loop (that freezes characters, Break, Meeting — everything).
      try {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        engine.update(dt);
        if (assets) {
          render(ctx, assets, engine, cam, hovered, useStore.getState().selectedChar);
        } else {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#14141f';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#888';
          ctx.font = '16px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('loading office…', canvas.width / 2, canvas.height / 2);
        }
      } catch (err) {
        if (errorCount++ < 5) console.error('[office loop]', err);
        last = now; // avoid a huge dt spike on the next frame
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return <canvas ref={canvasRef} className="office-canvas" />;
}

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface TouchState {
  id: string;
  mode: 'drag' | 'swipe';
  dy: number;
  dx: number;
}

/**
 * Mobil (spillelister og køen): hold inne (300 ms) og dra for å flytte, sveip til venstre for å fjerne.
 * Radene merkes med `data-<attr>="<id>"`. Native lyttere (ikke passive), så siden ikke scroller under draget,
 * og klikket som kommer etter et drag/sveip svelges, så raden ikke spilles.
 */
export function useTouchReorder(
  listRef: RefObject<HTMLElement>,
  opts: {
    attr: string;
    onMove: (id: string, beforeId: string | null) => void;
    onSwipe: (id: string) => void;
    setDropBefore: (id: string | null | undefined) => void;
  },
  deps: unknown[] = []
): TouchState | null {
  const [touch, setTouch] = useState<TouchState | null>(null);
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const sel = `[data-${opts.attr}]`;
    const idOf = (n: HTMLElement) => n.getAttribute(`data-${cb.current.attr}`)!;
    let start: { x: number; y: number; id: string } | null = null;
    let timer = 0;
    let mode: 'drag' | 'swipe' | null = null;
    let moved = false;
    let before: string | null | undefined;
    let lastDx = 0;
    const rowAt = (y: number): string | null => {
      for (const li of Array.from(el.querySelectorAll<HTMLElement>(sel))) {
        const r = li.getBoundingClientRect();
        if (y < r.top + r.height / 2) return idOf(li);
      }
      return null;
    };
    const onStart = (e: TouchEvent) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>(sel);
      if (!li || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      start = { x: t.clientX, y: t.clientY, id: idOf(li) };
      mode = null;
      moved = false;
      before = undefined;
      lastDx = 0;
      timer = window.setTimeout(() => {
        if (!start || moved) return;
        mode = 'drag';
        navigator.vibrate?.(10);
        setTouch({ id: start.id, mode: 'drag', dy: 0, dx: 0 });
        cb.current.setDropBefore(undefined);
      }, 300);
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0]!;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (mode === 'drag') {
        e.preventDefault();
        before = rowAt(t.clientY);
        setTouch({ id: start.id, mode: 'drag', dy, dx: 0 });
        cb.current.setDropBefore(before);
        return;
      }
      if (mode === 'swipe') {
        e.preventDefault();
        lastDx = Math.min(0, dx);
        setTouch({ id: start.id, mode: 'swipe', dy: 0, dx: lastDx });
        return;
      }
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        moved = true;
        window.clearTimeout(timer);
        if (Math.abs(dx) > Math.abs(dy) * 1.5 && dx < 0) {
          mode = 'swipe';
          e.preventDefault();
        } else start = null; // vanlig scrolling
      }
    };
    const onEnd = () => {
      window.clearTimeout(timer);
      const s = start;
      start = null;
      if (!s || !mode) return;
      const m = mode;
      mode = null;
      if (m === 'swipe' && lastDx < -90) cb.current.onSwipe(s.id);
      if (m === 'drag' && before !== undefined && before !== s.id) cb.current.onMove(s.id, before);
      setTouch(null);
      cb.current.setDropBefore(undefined);
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRef, opts.attr, ...deps]);

  return touch;
}

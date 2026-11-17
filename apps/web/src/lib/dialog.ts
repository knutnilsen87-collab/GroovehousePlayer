import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/**
 * Del 27 pkt. 11: felles oppførsel for dialoger, ark og menyer.
 *  - Fokus flyttes inn (første felt/knapp, eller `[data-autofocus]`) og fanges der (Tab / Shift+Tab).
 *  - Escape lukker bare den øverste dialogen, uansett hvor i den fokus står.
 *  - Ved lukking går fokus tilbake til knappen som åpnet den.
 * Bruk: `const ref = useDialog<HTMLDivElement>(onClose)` og `<div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>`.
 * Elementet leses på nytt ved hvert tastetrykk, så dialoger som bytter rot-element (fullskjerm ↔ tekst) virker.
 */
const stack: Array<RefObject<HTMLElement | null>> = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusablesIn(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.closest('[inert]') && x.getClientRects().length > 0);
}

export function useDialog<T extends HTMLElement>(onClose: () => void, opts: { active?: boolean; autoFocus?: boolean } = {}) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const active = opts.active ?? true;
  const autoFocus = opts.autoFocus ?? true;
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    stack.push(ref);
    const top = () => stack[stack.length - 1] === ref;
    const el0 = ref.current;
    if (el0 && autoFocus && !el0.contains(document.activeElement)) {
      const first = el0.querySelector<HTMLElement>('[data-autofocus]') ?? focusablesIn(el0)[0] ?? el0;
      if (first === el0 && !el0.hasAttribute('tabindex')) el0.setAttribute('tabindex', '-1');
      first.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || !top()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab') {
        const list = focusablesIn(el);
        if (!list.length) {
          e.preventDefault();
          el.focus({ preventScroll: true });
          return;
        }
        const first = list[0]!;
        const last = list[list.length - 1]!;
        const cur = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (cur === first || !el.contains(cur))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (cur === last || !el.contains(cur))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Fokus som havner utenfor (klikk på bakgrunnen, skjermleser) hentes tilbake
    const onFocusIn = (e: FocusEvent) => {
      const el = ref.current;
      if (!el || !top()) return;
      const t = e.target as Node | null;
      if (t && !el.contains(t)) (focusablesIn(el)[0] ?? el).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** Piltaster i en meny eller liste med knapper (↑↓, Home, End). */
export function onMenuKeys(e: ReactKeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [role="menuitem"], [role="option"]')].filter((x) => x.getClientRects().length > 0);
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next]!.focus();
}

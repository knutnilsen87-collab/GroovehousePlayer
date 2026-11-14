/**
 * Køen (del 11): rene funksjoner, så spiller-storen og testene bruker samme logikk.
 * `index` peker alltid på låta som spilles; den følger med når elementer settes inn, flyttes eller fjernes.
 */
export interface QueueState<A> {
  queue: A[];
  index: number;
}

/** «Spill neste»: rett etter låta som spilles. */
export function insertNext<A>(s: QueueState<A>, items: A[]): QueueState<A> {
  if (!s.queue.length) return { queue: [...items], index: 0 };
  const q = s.queue.slice();
  q.splice(s.index + 1, 0, ...items);
  return { queue: q, index: s.index };
}

/** «Legg til i køen»: bakerst. */
export function enqueue<A>(s: QueueState<A>, items: A[]): QueueState<A> {
  return { queue: [...s.queue, ...items], index: s.queue.length ? s.index : 0 };
}

/** Fjern element i. Låta som spilles kan ikke fjernes her (bytt låt først). */
export function removeAt<A>(s: QueueState<A>, i: number): QueueState<A> {
  if (i < 0 || i >= s.queue.length || i === s.index) return s;
  const q = s.queue.slice();
  q.splice(i, 1);
  return { queue: q, index: i < s.index ? s.index - 1 : s.index };
}

/** Flytt element fra → til (til = plassen det skal ha etterpå). Låta som spilles beholder rollen sin. */
export function moveAt<A>(s: QueueState<A>, from: number, to: number): QueueState<A> {
  if (from === to || from < 0 || from >= s.queue.length) return s;
  const q = s.queue.slice();
  const [x] = q.splice(from, 1);
  const t = Math.max(0, Math.min(q.length, to));
  q.splice(t, 0, x!);
  let index = s.index;
  if (from === s.index) index = t;
  else if (from < s.index && t >= s.index) index -= 1;
  else if (from > s.index && t <= s.index) index += 1;
  return { queue: q, index };
}

/** Det som lagres mellom omstarter: hvilke versjoner, plassen og posisjonen. */
export interface StoredQueue {
  v: 1;
  items: Array<{ slug: string; variant: string | null; version: number }>;
  index: number;
  positionMs: number;
}

export function toStored(queue: Array<{ manifest: { slug: string; variant: string | null; version: number } }>, index: number, positionMs: number): StoredQueue {
  return { v: 1, items: queue.map((a) => ({ slug: a.manifest.slug, variant: a.manifest.variant, version: a.manifest.version })), index, positionMs: Math.round(positionMs) };
}

/** Gjenoppretter: elementer som ikke finnes lenger hoppes over, og plassen justeres. */
export function fromStored<A>(s: StoredQueue | null | undefined, find: (slug: string, variant: string | null, version: number) => A | undefined): (QueueState<A> & { positionMs: number }) | null {
  if (!s || s.v !== 1 || !Array.isArray(s.items) || !s.items.length) return null;
  const queue: A[] = [];
  let index = 0;
  let positionMs = 0;
  s.items.forEach((it, i) => {
    const a = find(it.slug, it.variant, it.version);
    if (!a) return;
    if (i === s.index) {
      index = queue.length;
      positionMs = s.positionMs;
    } else if (i < s.index) index = queue.length + 1;
    queue.push(a);
  });
  if (!queue.length) return null;
  return { queue, index: Math.min(index, queue.length - 1), positionMs };
}

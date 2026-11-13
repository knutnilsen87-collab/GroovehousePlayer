import type { ListenEvent } from './types';

export interface Coverage {
  /** Antall ganger hver bøtte er spilt. */
  plays: number[];
  /** Andel av låta som er hørt minst én gang, 0..1. */
  heardRatio: number;
  /** Siste posisjon lytteren var på før økten sluttet (ms), eller null. */
  stoppedAtMs: number | null;
  finished: boolean;
}

/**
 * Regner ut lyttedekning fra rå lyttehendelser (listen_events).
 * Avspilte intervaller: fra `play` (eller etter `seek`) til neste `pause`/`seek`/`ended`/`heartbeat`.
 * Heartbeats forlenger intervallet, så en økt som bare dør gir likevel riktig dekning.
 */
export function computeCoverage(events: ListenEvent[], durationMs: number, buckets = 48): Coverage {
  const plays = new Array<number>(buckets).fill(0);
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const intervals: Array<[number, number]> = [];

  let playingFrom: number | null = null;
  let lastPos: number | null = null;
  let finished = false;

  const close = (to: number) => {
    if (playingFrom !== null && to > playingFrom) intervals.push([playingFrom, Math.min(to, durationMs)]);
  };

  for (const e of sorted) {
    switch (e.event) {
      case 'play':
        if (playingFrom === null) playingFrom = e.positionMs;
        lastPos = e.positionMs;
        break;
      case 'heartbeat':
        if (playingFrom === null) playingFrom = e.positionMs;
        lastPos = e.positionMs;
        break;
      case 'pause':
        close(e.positionMs);
        playingFrom = null;
        lastPos = e.positionMs;
        break;
      case 'seek':
        close(e.positionMs);
        lastPos = e.toMs ?? e.positionMs;
        playingFrom = playingFrom !== null ? lastPos : null;
        break;
      case 'ended':
        close(durationMs);
        playingFrom = null;
        lastPos = durationMs;
        finished = true;
        break;
      case 'open':
        break;
    }
  }
  if (playingFrom !== null && lastPos !== null) close(lastPos);

  const bucketMs = durationMs / buckets;
  for (const [a, b] of intervals) {
    const first = Math.floor(a / bucketMs);
    const last = Math.min(buckets - 1, Math.ceil(b / bucketMs) - 1);
    for (let i = first; i <= last; i++) {
      const bStart = i * bucketMs;
      const bEnd = bStart + bucketMs;
      const overlap = Math.min(b, bEnd) - Math.max(a, bStart);
      if (overlap >= bucketMs * 0.5) plays[i] = (plays[i] ?? 0) + 1;
    }
  }

  const heard = plays.filter((p) => p > 0).length / buckets;
  return { plays, heardRatio: heard, stoppedAtMs: finished ? null : lastPos, finished };
}

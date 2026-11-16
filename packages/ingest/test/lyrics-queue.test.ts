import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLyricsQueue, hasWordTimes, sidecarText } from '../src/lyrics-queue';
import type { transcribeLyricsForSlug } from '../src/lyrics-sync';

/** Tekstkøen etter ingest. Python/Demucs/WhisperX byttes ut med en falsk kjøring. */
async function setup(auto = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gv-lq-'));
  const mediaDir = path.join(root, 'media');
  const dataDir = path.join(root, 'data');
  await mkdir(mediaDir, { recursive: true });
  const calls: Array<{ slug: string; text: string | null | undefined }> = [];
  let release: (() => void) | null = null;
  const run = (async (o) => {
    calls.push({ slug: o.slug, text: o.text });
    o.onStage?.('demucs');
    if (o.slug === 'treg') await new Promise<void>((r) => (release = r));
    if (o.slug === 'feil') throw new Error('Kunne ikke starte Python');
    const mode = o.text ? 'aligned' : 'auto';
    await o.lyricsStore.put(o.slug, 'lrc', '[00:01.00]<00:01.00>hei <00:01.50>du\n');
    await o.lyricsStore.setMeta(o.slug, { source: mode, approved: mode === 'aligned' });
    return { format: 'lrc', text: '', wordCount: 2, mode };
  }) as typeof transcribeLyricsForSlug;
  const q = createLyricsQueue({ mediaDir, dataDir, root, run, settings: () => ({ auto, model: 'large-v2', language: null }) });
  return { root, q, calls, release: () => release?.() };
}

describe('tekstkø etter ingest', () => {
  it('transkriberer låter uten tekst og merker dem «Auto – sjekk teksten» til de er godkjent', async () => {
    const { q, calls } = await setup();
    q.enqueue('ny-lat', { title: 'Ny låt' });
    await q.idle();
    expect(calls).toEqual([{ slug: 'ny-lat', text: null }]);
    const l = await q.store.get('ny-lat');
    expect(l?.meta).toMatchObject({ source: 'auto', approved: false });
    await q.store.approve('ny-lat');
    expect((await q.store.get('ny-lat'))?.meta?.approved).toBe(true);
    expect(q.status().jobs[0]).toMatchObject({ status: 'done', mode: 'auto', words: 2 });
  });

  it('bruker tekst limt inn i Studio – bare ordtider', async () => {
    const { q, calls } = await setup();
    await q.store.put('limt', 'txt', 'Hei du\nher er jeg');
    q.enqueue('limt', { reason: 'pasted' });
    await q.idle();
    expect(calls[0]!.text).toBe('Hei du\nher er jeg\n');
    expect((await q.store.get('limt'))?.meta).toMatchObject({ source: 'aligned', approved: true });
  });

  it('bruker .txt med samme navn som lydfila', async () => {
    const { root, q, calls } = await setup();
    const wav = path.join(root, 'eksport', 'Min Låt.wav');
    await mkdir(path.dirname(wav), { recursive: true });
    await writeFile(path.join(root, 'eksport', 'Min Låt.txt'), '﻿Linje en\nLinje to\n');
    expect(await sidecarText(wav)).toBe('Linje en\nLinje to');
    q.enqueue('min-lat', { audioFile: wav });
    await q.idle();
    expect(calls[0]!.text).toBe('Linje en\nLinje to');
  });

  it('hopper over låter som har ordtider fra før, og legger ikke inn noe når automatikken er av', async () => {
    const { q, calls } = await setup();
    await q.store.put('ferdig', 'lrc', '[00:01.00]<00:01.00>hei');
    q.enqueue('ferdig');
    await q.idle();
    expect(calls).toEqual([]);
    expect(q.status().jobs[0]).toMatchObject({ status: 'skipped' });

    const off = await setup(false);
    expect(off.q.enqueue('noe')).toBeNull();
    expect(off.q.enqueue('noe', { reason: 'pasted' })).toBeNull();
    // «Synkroniser nå» fra Studio virker også når automatikken er av
    expect(off.q.enqueue('noe', { reason: 'studio' })).not.toBeNull();
    await off.q.idle();
    expect(off.calls).toHaveLength(1);
  });

  it('én jobb om gangen, feil stopper ikke køen, og samme låt legges ikke inn to ganger', async () => {
    const { q, calls, release } = await setup();
    q.enqueue('treg');
    q.enqueue('feil');
    q.enqueue('feil');
    q.enqueue('siste');
    await new Promise((r) => setTimeout(r, 20));
    expect(q.status().jobs.map((j) => j.status)).toEqual(['running', 'waiting', 'waiting']);
    expect(q.status().jobs[0]!.stage).toBe('demucs');
    release();
    await q.idle();
    expect(calls.map((c) => c.slug)).toEqual(['treg', 'feil', 'siste']);
    const st = q.status().jobs;
    expect(st.find((j) => j.slug === 'feil')).toMatchObject({ status: 'failed', note: 'Kunne ikke starte Python' });
    expect(st.find((j) => j.slug === 'siste')?.status).toBe('done');
  });

  it('kjenner igjen ordtider i Enhanced LRC', () => {
    expect(hasWordTimes('[00:01.00]<00:01.00>hei')).toBe(true);
    expect(hasWordTimes('[00:01.00]hei')).toBe(false);
  });
});

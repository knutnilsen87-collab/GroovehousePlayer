import { describe, expect, it } from 'vitest';
import { cleanTitle, findSuno, parseFlatName, scrubSuno, titleCase } from '../src/titles';

const cfg = { remove: ['suno ai', 'suno', 'v4.5', 'v4', 'v5.5', 'v5', '(remastered)', 'final', 'master', 'bounce', 'export', 'stems'] };

describe('parseFlatName – filnavnene i REASONDONE', () => {
  it.each([
    ['Eyes on you.wav', 'eyes-on-you', 'Eyes On You'],
    ['Feel Good.wav', 'feel-good', 'Feel Good'],
    ['I see you.wav', 'i-see-you', 'I See You'],
    ['Late Night.wav', 'late-night', 'Late Night'],
    ['Push it.wav', 'push-it', 'Push It'],
    ['Terrace Heat.wav', 'terrace-heat', 'Terrace Heat'],
    ['That Feeling.wav', 'that-feeling', 'That Feeling'],
    ['Walkoff.wav', 'walkoff', 'Walkoff']
  ])('%s → %s / «%s»', (file, slug, title) => {
    const p = parseFlatName(file, cfg);
    expect(p).toMatchObject({ slug, variant: null, version: 1 });
    expect(p.clean.title).toBe(title);
    expect(p.clean.wasAllCaps).toBe(false);
  });

  it('versaler: vanlig tittel-format, flagget, ingen gjettet apostrof', () => {
    const p = parseFlatName('ILL KEEP IT REAL.wav', cfg);
    expect(p.slug).toBe('ill-keep-it-real');
    expect(p.clean.title).toBe('Ill Keep It Real');
    expect(p.clean.wasAllCaps).toBe(true);
  });

  it('Stems og (128BPM) fjernes, BPM blir hint', () => {
    const p = parseFlatName('Midnight Rendezvous Stems (128BPM).wav', cfg);
    expect(p.slug).toBe('midnight-rendezvous');
    expect(p.clean.title).toBe('Midnight Rendezvous');
    expect(p.clean.bpmHint).toBe(128);
  });

  it('variant og versjon tolkes som før', () => {
    expect(parseFlatName('Would You Run_v3.wav', cfg)).toMatchObject({ slug: 'would-you-run', variant: null, version: 3 });
    const x = parseFlatName('Would You Run__extended_v2.wav', cfg);
    expect(x).toMatchObject({ slug: 'would-you-run', variant: 'extended', version: 2 });
    expect(x.clean.title).toBe('Would You Run');
  });

  it('«suno v4» er ikke versjon 4 – bare _v4 er versjon', () => {
    const p = parseFlatName('Night Drive suno v4.wav', cfg);
    expect(p).toMatchObject({ slug: 'night-drive', version: 1 });
    expect(p.clean.removed).toEqual(expect.arrayContaining(['suno', 'v4']));
  });

  it('norske tegn og mellomrom', () => {
    const p = parseFlatName('Bølger  på   sjøen – final (1).wav', cfg);
    expect(p.slug).toBe('bolger-pa-sjoen');
    expect(p.clean.title).toBe('Bølger På Sjøen');
    const q = parseFlatName('ÆRLIG TALT__club mix.wav', cfg);
    expect(q).toMatchObject({ slug: 'aerlig-talt', variant: 'club-mix' });
    expect(q.clean.title).toBe('Ærlig Talt');
  });
});

describe('cleanTitle', () => {
  it.each([
    ['My Song (Suno AI) v4.5', 'My Song'],
    ['My Song - suno - v5.5', 'My Song'],
    ['Track 2026-11-03 bounce', 'Track'],
    ['Track 03.11.2026', 'Track'],
    ['Track 20261103 export', 'Track'],
    ['Song (remastered) (2)', 'Song'],
    ['Song MASTER FINAL', 'Song'],
    ['Song -- -- edit', 'Song - Edit'],
    ['Deep 124 bpm groove', 'Deep Groove'],
    ['Deep (126bpm)', 'Deep'],
    ['Mastermind', 'Mastermind'],
    ['Finale', 'Finale']
  ])('«%s» → «%s»', (raw, title) => {
    expect(cleanTitle(raw, cfg).title).toBe(title);
  });
  it('BPM-hint fra «128 BPM», «128bpm» og «(128BPM)»', () => {
    for (const s of ['A 128 BPM', 'A 128bpm', 'A (128BPM)']) expect(cleanTitle(s, cfg).bpmHint).toBe(128);
  });
  it('blir aldri tom', () => {
    expect(cleanTitle('Suno', cfg).title.length).toBeGreaterThan(0);
  });
});

describe('titleCase', () => {
  it('beholder stilisering inne i ord, endrer ikke apostrofer', () => {
    expect(titleCase('DJ set at the McCoy')).toBe('DJ Set At The McCoy');
    expect(titleCase("i'll keep it real")).toBe("I'll Keep It Real");
  });
});

describe('suno', () => {
  it('finner uansett store/små bokstaver', () => {
    expect(findSuno('Made with SUNO AI v4')).toEqual(['SUNO']);
    expect(findSuno('nothing here')).toEqual([]);
  });
  it('scrubSuno fjerner bare suno-delen', () => {
    expect(scrubSuno('Made with Suno AI v4.5')).toBe('Made with');
    expect(scrubSuno('WOULD YOU RUN (suno)')).toBe('WOULD YOU RUN');
  });
});

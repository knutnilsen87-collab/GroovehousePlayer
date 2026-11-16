import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetManifest } from '@gv/shared';
import type { DupeReport } from '../src/dupes';
import { applyMerge, planMerge, rebuildIndex, songTitle, titleCase, undoMerge } from '../src/merge';

/**
 * Sammenslåing på et lite, syntetisk bibliotek: «01. Song A» (umastret), LANDR-masteren av samme lyd,
 * «Song A» i kort versjon og en låt som ikke skal røres. Fingeravtrykkene er laget for hånd: samme mønster =
 * samme lyd (likhet 1), annet mønster = ulik lyd.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fp = (shift: number, windows = 30) => Buffer.from(Array.from({ length: windows }, (_, i) => Array.from({ length: 12 }, (_, k) => (k === (i * shift) % 12 ? 255 : 0))).flat()).toString('base64');

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'gv-merge-'));
  dirs.push(root);
  const media = path.join(root, 'media');
  const data = path.join(root, 'data');
  mkdirSync(path.join(data, 'lyrics'), { recursive: true });
  const units = [
    { slug: '01-song-a', title: '01. Song A', file: '01. Song A.wav', ms: 200_000, fp: fp(1), at: '2026-11-15T10:00:00Z' },
    { slug: 'landr-01-song-a-balanced-medium', title: 'LANDR-01. Song A-Balanced-Medium', file: 'LANDR-01. Song A-Balanced-Medium.wav', ms: 200_500, fp: fp(1), at: '2026-11-15T11:00:00Z' },
    { slug: 'song-a', title: 'Song A', file: 'Song A.mp3', ms: 100_000, fp: fp(5), at: '2026-11-15T12:00:00Z' },
    { slug: 'other', title: 'OTHER SONG', file: 'Other.wav', ms: 300_000, fp: fp(7), at: '2026-11-15T09:00:00Z' }
  ];
  const fps: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const u of units) {
    const dir = path.join(media, u.slug, 'main', 'v1001');
    mkdirSync(path.join(dir, 'hls'), { recursive: true });
    writeFileSync(path.join(dir, 'hls', 'index.m3u8'), `#EXTM3U ${u.slug}`);
    const m = { schema: 1, id: `id-${u.slug}`, slug: u.slug, variant: null, variantLabel: null, version: 1001, versionLabel: 'Umastret v1', kind: 'track', status: 'draft', title: u.title, durationMs: u.ms, masterSha256: u.slug, createdAt: u.at, files: { hls: 'hls/index.m3u8' }, markers: [] };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    fps[`${u.slug}::::v1001`] = { durationMs: u.ms, chroma: u.fp };
    sources[`${u.slug}::main::v1001`] = { fileName: u.file, relPath: null, sha256: u.slug, recordedAt: u.at };
  }
  writeFileSync(path.join(data, 'fingerprints.json'), JSON.stringify(fps));
  writeFileSync(path.join(data, 'sources.json'), JSON.stringify({ schema: 1, entries: sources }));
  writeFileSync(path.join(data, 'playlists.json'), JSON.stringify({ schema: 1, playlists: [{ id: 'p', name: 'Liste', kind: 'manual', entries: [{ id: 'e1', slug: 'song-a', variant: null, version: null }, { id: 'e2', slug: '01-song-a', variant: null, version: 1001 }] }] }));
  writeFileSync(path.join(data, 'favorites.json'), JSON.stringify({ slugs: ['song-a', 'other'] }));
  writeFileSync(path.join(data, 'listens.json'), JSON.stringify({ bySlug: { '01-song-a': { plays: 2, ms: 1000, lastAt: '2026-11-16T01:00:00Z' }, 'landr-01-song-a-balanced-medium': { plays: 3, ms: 500, lastAt: '2026-11-16T02:00:00Z' } } }));
  writeFileSync(path.join(data, 'lyrics', '01-song-a.lrc'), '[00:01.00]hei');
  writeFileSync(path.join(data, 'lyrics', '01-song-a.meta.json'), JSON.stringify({ source: 'manual', approved: true }));
  writeFileSync(path.join(data, 'lyrics', 'song-a.lrc'), '[00:01.00]auto');
  writeFileSync(path.join(data, 'lyrics', 'song-a.meta.json'), JSON.stringify({ source: 'auto', approved: false }));
  const dupes: DupeReport = { updatedAt: '', byKey: {}, retitles: [], groups: [{ id: 'g', links: [], members: ['01-song-a', 'landr-01-song-a-balanced-medium', 'song-a'].map((slug) => ({ slug, variant: null, version: 1001, title: '', fileName: null, suggestedTitle: '', status: 'draft' as const, durationMs: 0, landr: false })) }] };
  return { root, media, data, dupes };
}

/** Mappenavn som låt: «1Echo Groove låter__Love me.wav» og «…__x103.wav» som varianter av én slug, med én tekst. */
function addFolderSlug(media: string, data: string) {
  const fps = JSON.parse(readFileSync(path.join(data, 'fingerprints.json'), 'utf8'));
  const src = JSON.parse(readFileSync(path.join(data, 'sources.json'), 'utf8'));
  for (const [variant, file, shift] of [['love-me', '1Echo Groove låter__Love me.wav', 3], ['x103', '1Echo Groove låter__x103.wav', 11]] as const) {
    const dir = path.join(media, '1echo-groove-later', variant, 'v1001');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, id: variant, slug: '1echo-groove-later', variant, variantLabel: variant, version: 1001, versionLabel: 'Umastret v1', kind: 'track', status: 'draft', title: '1Echo Groove Låter', durationMs: 150_000, masterSha256: variant, createdAt: '2026-11-16T00:00:00Z', files: {}, markers: [] }));
    fps[`1echo-groove-later::${variant}::v1001`] = { durationMs: 150_000, chroma: fp(shift) };
    src.entries[`1echo-groove-later::${variant}::v1001`] = { fileName: file, relPath: null, sha256: variant, recordedAt: '' };
  }
  writeFileSync(path.join(data, 'fingerprints.json'), JSON.stringify(fps));
  writeFileSync(path.join(data, 'sources.json'), JSON.stringify(src));
  writeFileSync(path.join(data, 'lyrics', '1echo-groove-later.lrc'), '[00:01.00]hvem sin?');
  writeFileSync(path.join(data, 'lyrics', '1echo-groove-later.meta.json'), JSON.stringify({ source: 'auto' }));
}

const manifest = (media: string, rel: string) => JSON.parse(readFileSync(path.join(media, rel, 'manifest.json'), 'utf8')) as AssetManifest;

describe('sammenslåing av duplikater (angrebar)', () => {
  it('titler: vanlig format, mashup uten gjentakelse, variantord i parentes ut', () => {
    expect(titleCase('GOT SOMETHING TO SAY')).toBe('Got Something To Say');
    expect(titleCase('Get on the floor')).toBe('Get On The Floor');
    expect(titleCase('Dusk till Dawn')).toBe('Dusk Till Dawn');
    expect(titleCase('Don’t Stop')).toBe('Don’t Stop'); // apostrofen beholdes
    expect(songTitle('Trumpets After Midnight X 7. Trumpets After Midnight (Mashup)')).toBe('Trumpets After Midnight (Mashup)');
    expect(songTitle('We Want It Now (MAIN)')).toBe('We Want It Now');
    expect(songTitle('Taylor swift2')).toBe('Taylor swift2'); // arbeidstittel
  });

  it('samme lyd → versjoner med LANDR-master; kortere → «Kort»; referanser følger med; angring gir alt tilbake', async () => {
    const { media, data, dupes } = setup();
    await rebuildIndex(media);
    const before = { index: readFileSync(path.join(media, 'index.json'), 'utf8'), pl: readFileSync(path.join(data, 'playlists.json'), 'utf8'), lis: readFileSync(path.join(data, 'listens.json'), 'utf8') };

    const plan = await planMerge({ mediaDir: media, dataDir: data, dupes });
    expect(plan.counts.before.songs).toBe(4);
    expect(plan.counts.after.songs).toBe(2);
    const r = await applyMerge({ mediaDir: media, dataDir: data, plan });

    // Versjoner og variant
    expect(manifest(media, 'song-a/main/v1001')).toMatchObject({ title: 'Song A', status: 'draft', versionLabel: 'Umastret v1', mergedFrom: { slug: '01-song-a' } });
    expect(manifest(media, 'song-a/main/v1')).toMatchObject({ title: 'Song A', status: 'release', versionLabel: 'LANDR-master' });
    expect(manifest(media, 'song-a/kort/v1001')).toMatchObject({ variant: 'kort', variantLabel: 'Kort' });
    expect(manifest(media, 'other/main/v1001').title).toBe('Other Song');
    expect(existsSync(path.join(media, '01-song-a'))).toBe(false);
    expect(readFileSync(path.join(media, 'song-a/main/v1/hls/index.m3u8'), 'utf8')).toContain('landr-01-song-a'); // filene fulgte med
    const idx = JSON.parse(readFileSync(path.join(media, 'index.json'), 'utf8')) as { assets: Array<{ slug: string }> };
    expect(new Set(idx.assets.map((a) => a.slug))).toEqual(new Set(['song-a', 'other']));

    // Referanser
    const pl = JSON.parse(readFileSync(path.join(data, 'playlists.json'), 'utf8'));
    expect(pl.playlists[0].entries.map((e: { slug: string; variant: string | null; version: number | null }) => [e.slug, e.variant, e.version])).toEqual([
      ['song-a', 'kort', null],
      ['song-a', null, 1001]
    ]);
    expect(JSON.parse(readFileSync(path.join(data, 'listens.json'), 'utf8')).bySlug['song-a']).toMatchObject({ plays: 5, ms: 1500 });
    expect(JSON.parse(readFileSync(path.join(data, 'favorites.json'), 'utf8')).slugs).toEqual(['song-a', 'other']);
    // Teksten: den manuelle/godkjente vinner, den automatiske legges til side
    expect(readFileSync(path.join(data, 'lyrics', 'song-a.lrc'), 'utf8')).toContain('hei');
    expect(existsSync(path.join(data, 'lyrics', '01-song-a.lrc'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(path.join(data, 'sources.json'), 'utf8')).entries)).toContain('song-a::main::v1');

    // Angre
    await undoMerge({ mediaDir: media, dataDir: data, stamp: r.stamp });
    expect(readFileSync(path.join(media, 'index.json'), 'utf8')).toBe(before.index);
    expect(readFileSync(path.join(data, 'playlists.json'), 'utf8')).toBe(before.pl);
    expect(readFileSync(path.join(data, 'listens.json'), 'utf8')).toBe(before.lis);
    expect(manifest(media, '01-song-a/main/v1001').title).toBe('01. Song A');
    expect(manifest(media, 'landr-01-song-a-balanced-medium/main/v1001').status).toBe('draft');
    expect(readFileSync(path.join(data, 'lyrics', 'song-a.lrc'), 'utf8')).toContain('auto');
    expect(readFileSync(path.join(data, 'lyrics', '01-song-a.lrc'), 'utf8')).toContain('hei');
    expect(existsSync(path.join(media, 'song-a', 'kort'))).toBe(false);
  });

  it('mappenavn som låt deles opp: tittelen fra filnavnet, arbeidstittel merkes, teksten legges til side', async () => {
    const { media, data, dupes } = setup();
    addFolderSlug(media, data);
    await rebuildIndex(media);
    const plan = await planMerge({ mediaDir: media, dataDir: data, dupes });
    const r = await applyMerge({ mediaDir: media, dataDir: data, plan });
    expect(manifest(media, 'love-me/main/v1001')).toMatchObject({ title: 'Love Me', variant: null });
    expect(manifest(media, 'x103/main/v1001')).toMatchObject({ title: 'X103', titleNeedsReview: true });
    expect(existsSync(path.join(media, '1echo-groove-later'))).toBe(false);
    // Teksten hørte til én av dem – den følger ikke med noen (ny tekst lages i kø), men ligger i journalen
    expect(existsSync(path.join(data, 'lyrics', 'love-me.lrc'))).toBe(false);
    expect(existsSync(path.join(r.journalDir, 'lyrics', '1echo-groove-later.lrc'))).toBe(true);
    await undoMerge({ mediaDir: media, dataDir: data, stamp: r.stamp });
    expect(readFileSync(path.join(data, 'lyrics', '1echo-groove-later.lrc'), 'utf8')).toContain('hvem sin?');
    expect(manifest(media, '1echo-groove-later/love-me/v1001').title).toBe('1Echo Groove Låter');
  });
});

import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetManifest } from '@gv/shared';
import { createApiHandler } from '../src/api';
import { m3u, rekordboxLocation, rekordboxXml, type ResolvedItem } from '../src/sets';

/** Liten XML-parser for testen: sjekker at dokumentet er velformet og gir elementtreet. */
interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
}
function parseXml(xml: string): El {
  const body = xml.replace(/<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  const root: El = { name: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    if (m.index !== consumed) throw new Error(`ugyldig XML ved posisjon ${consumed}: «${body.slice(consumed, consumed + 40)}»`);
    consumed = re.lastIndex;
    if (m[5] !== undefined) {
      if (m[5].trim()) throw new Error(`uventet tekst: ${m[5].trim().slice(0, 40)}`);
      continue;
    }
    const [, close, name, rawAttrs, self] = m;
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`</${name}> lukker ${top?.name}`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs!.matchAll(/([\w:-]+)="([^"<]*)"/g)) {
      if (attrs[a[1]!] !== undefined) throw new Error(`dobbelt attributt ${a[1]}`);
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(a[2]!)) throw new Error(`ukodet & i ${a[1]}`);
      attrs[a[1]!] = a[2]!;
    }
    const el: El = { name: name!, attrs, children: [] };
    stack[stack.length - 1]!.children.push(el);
    if (!self) stack.push(el);
  }
  if (consumed !== body.length || stack.length !== 1) throw new Error('ikke velformet (uavsluttede elementer)');
  return root.children[0]!;
}
/** Skjema fra et dokument: element-sti → attributtnavn som alltid finnes. */
function schema(el: El, p = '', out = new Map<string, Set<string>>()) {
  const key = `${p}/${el.name}`;
  const have = new Set(Object.keys(el.attrs));
  out.set(key, out.has(key) ? new Set([...out.get(key)!].filter((a) => have.has(a))) : have);
  for (const c of el.children) schema(c, key, out);
  return out;
}

const manifest = (over: Partial<AssetManifest>): AssetManifest =>
  ({
    id: 'x',
    slug: 'night-drive',
    variant: null,
    variantLabel: null,
    version: 1,
    title: 'Night Drive',
    artist: 'Echo Groove',
    album: 'Night & Day',
    label: 'Groovehouse Records',
    durationMs: 372_000,
    sampleRate: 44100,
    bpm: 124,
    key: { name: 'A minor', camelot: '8A', confidence: 0.6 },
    markers: [{ kind: 'chapter', source: 'analysis', startMs: 25, label: 'Intro', confirmed: false }],
    ...over
  }) as AssetManifest;

describe('eksport av sett (del 17)', () => {
  const items: ResolvedItem[] = [
    { manifest: manifest({}), file: 'F:\\EchoGroove\\EchoAI\\REASONDONE\\Night Drive.wav', mixInMs: 32_000, mixOutMs: 340_000, bars: 16 },
    { manifest: manifest({ title: 'Blå "Time"', variantLabel: 'Extended', key: null, bpm: 126 }), file: 'F:\\prosjekter\\media\\bla-time\\extended\\v2\\master.flac', mixInMs: null, mixOutMs: null, bars: null }
  ];

  it('rekordbox XML er velformet og følger strukturen i et kjent eksempel', () => {
    const xml = rekordboxXml('Reise 60 min & mer', items);
    const ours = parseXml(xml);
    const ref = parseXml(readFileSync(path.join(__dirname, 'fixtures', 'rekordbox-example.xml'), 'utf8'));
    expect(ours.name).toBe('DJ_PLAYLISTS');
    expect(ours.attrs.Version).toBe('1.0.0');
    const refSchema = schema(ref);
    for (const [elPath, attrs] of schema(ours)) {
      expect(refSchema.has(elPath), `ukjent element ${elPath}`).toBe(true);
      // Alle attributter som alltid finnes i eksemplet, må også finnes hos oss
      for (const a of refSchema.get(elPath)!) if (elPath !== '/DJ_PLAYLISTS/PRODUCT') expect(attrs.has(a), `${elPath} mangler ${a}`).toBe(true);
    }
    const coll = ours.children.find((c) => c.name === 'COLLECTION')!;
    expect(coll.attrs.Entries).toBe('2');
    const t1 = coll.children[0]!;
    expect(t1.attrs).toMatchObject({ AverageBpm: '124.00', Tonality: 'Am', Kind: 'WAV File', TotalTime: '372', Location: 'file://localhost/F:/EchoGroove/EchoAI/REASONDONE/Night%20Drive.wav' });
    const marks = t1.children.filter((c) => c.name === 'POSITION_MARK');
    expect(marks.map((mk) => [mk.attrs.Num, mk.attrs.Start])).toEqual([
      ['-1', '32.000'],
      ['0', '32.000'],
      ['-1', '340.000'],
      ['1', '340.000']
    ]);
    expect(t1.children.find((c) => c.name === 'TEMPO')!.attrs.Inizio).toBe('0.025');
    expect(coll.children[1]!.attrs.Name).toBe('Blå "Time" (Extended)'.replace(/"/g, '&quot;'));
    expect(coll.children[1]!.attrs.Kind).toBe('FLAC File');
    const pl = ours.children.find((c) => c.name === 'PLAYLISTS')!.children[0]!.children[0]!;
    expect(pl.attrs).toMatchObject({ Name: 'Reise 60 min &amp; mer', Type: '1', Entries: '2' });
    expect(pl.children.map((c) => c.attrs.Key)).toEqual(['1', '2']);
  });

  it('filstier med æøå og mellomrom kodes slik rekordbox forventer', () => {
    expect(rekordboxLocation('F:\\Musikk\\Låt A & B.wav')).toBe('file://localhost/F:/Musikk/L%C3%A5t%20A%20%26%20B.wav');
  });

  it('M3U: #EXTM3U, varighet, «Artist - Tittel» og absolutte stier', () => {
    const t = m3u('Sett', items).split('\r\n');
    expect(t[0]).toBe('#EXTM3U');
    expect(t[2]).toBe('#EXTINF:372,Echo Groove - Night Drive');
    expect(t[3]).toBe(path.resolve('F:\\EchoGroove\\EchoAI\\REASONDONE\\Night Drive.wav'));
  });
});

describe('API for sett: eksport og læring', () => {
  let tmp: string;
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gv-sets-'));
    const media = path.join(tmp, 'media');
    const vdir = path.join(media, 'night-drive', 'main', 'v1');
    await mkdir(vdir, { recursive: true });
    await writeFile(path.join(vdir, 'manifest.json'), JSON.stringify(manifest({})));
    await writeFile(path.join(vdir, 'master.flac'), 'x');
    // Et innspilt sett med to kapitler som peker på låter (live-logg)
    const sdir = path.join(media, 'oslo', 'main', 'v1');
    await mkdir(sdir, { recursive: true });
    await writeFile(
      path.join(sdir, 'manifest.json'),
      JSON.stringify(manifest({ slug: 'oslo', kind: 'set', markers: [{ kind: 'chapter', source: 'live_log', startMs: 0, label: 'A', refSlug: 'night-drive', confirmed: true }, { kind: 'chapter', source: 'live_log', startMs: 60_000, label: 'B', refSlug: 'blue-fire', confirmed: true }] } as never))
    );
    await writeFile(path.join(media, 'index.json'), JSON.stringify({ schema: 1, assets: [{ slug: 'oslo', variant: null, version: 1, manifest: 'oslo/main/v1/manifest.json', title: 'Oslo', kind: 'set' }] }));
    const api = createApiHandler({ mediaDir: media, dataDir: path.join(tmp, 'data') });
    server = http.createServer((req, res) => void api(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await rm(tmp, { recursive: true, force: true });
  });
  const post = (p: string, body: unknown, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('eksport gir fil med riktig navn og type; master.flac når originalen ikke er kjent', async () => {
    const r = await post('/api/sets/export', { format: 'rekordbox', name: 'Reise', items: [{ slug: 'night-drive', variant: null, version: 1, mixInMs: 1000, mixOutMs: 300_000, bars: 16 }] });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/xml');
    expect(r.headers.get('content-disposition')).toContain('Reise.xml');
    expect(await r.text()).toContain('master.flac');
    const m = await post('/api/sets/export', { format: 'm3u', name: 'Reise', items: [{ slug: 'night-drive', variant: null, version: 1 }] });
    expect((await m.text()).startsWith('#EXTM3U')).toBe(true);
    expect((await post('/api/sets/export', { format: 'pdf', items: [] })).status).toBe(400);
    expect((await post('/api/sets/export', { format: 'm3u', items: [{ slug: 'finnes-ikke', variant: null, version: 1 }] })).status).toBe(400);
  });

  it('læring: hendelser lagres, overganger fra innspilte sett, tilbakestill', async () => {
    expect((await post('/api/sets/learn', { event: { type: 'replace', before: { harmonic: 1, tempo: 0, mix: 0, lufs: 0 }, after: { harmonic: 0, tempo: 0, mix: 0, lufs: 0 } } })).status).toBe(200);
    expect((await post('/api/sets/learn', { event: { type: 'hack' } })).status).toBe(400);
    const g = (await (await fetch(`${base}/api/sets/learn`)).json()) as { events: unknown[]; knownPairs: string[] };
    expect(g.events).toHaveLength(1);
    expect(g.knownPairs).toEqual(['night-drive→blue-fire']);
    await post('/api/sets/learn', {}, 'DELETE');
    expect(((await (await fetch(`${base}/api/sets/learn`)).json()) as { events: unknown[] }).events).toHaveLength(0);
  });
});

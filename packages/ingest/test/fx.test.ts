import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, type AssetManifest } from '@gv/shared';
import { addIdea, deleteIdea, readIdeas, readPresets, savePreset } from '../src/fx-store';
import { m3u, rekordboxXml } from '../src/sets';

/** Del 18: lageret for presets og idéer, og eksport med navngitte cues. */
const known = new Set(BUILT_IN_PRESETS.map((p) => p.id));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gv-fx-'));

describe('idéer: rask lagring uten dialog, med angre', () => {
  it('lagrer og angrer', async () => {
    const dir = tmp();
    const idea = await addIdea(dir, { from: 'blue-fire', to: 'night-drive', preset: 'echo-out' }, known);
    expect(idea).toMatchObject({ from: 'blue-fire', to: 'night-drive', preset: 'echo-out' });
    expect(await readIdeas(dir)).toHaveLength(1);
    expect(await deleteIdea(dir, idea.id)).toBe(true);
    expect(await readIdeas(dir)).toHaveLength(0);
  });
  it('«ut av denne» uten neste låt, og avviser ukjent preset', async () => {
    const dir = tmp();
    expect((await addIdea(dir, { from: 'blue-fire', to: null, preset: 'reverb-wash' }, known)).to).toBeNull();
    await expect(addIdea(dir, { from: 'blue-fire', preset: 'finnes-ikke' }, known)).rejects.toThrow(/ukjent preset/);
    await expect(addIdea(dir, { from: '../x', preset: 'echo-out' }, known)).rejects.toThrow(/ugyldig/);
  });
});

describe('egne presets overlever omstart (lagres i data/fx-presets.json)', () => {
  it('lagres, leses på nytt og kan ikke overskrive ferdige', async () => {
    const dir = tmp();
    await savePreset(dir, { id: 'min-echo', name: 'Min echo', color: '#FF00AA', bars: 8, steps: [{ bar: -4, deck: 'A', text: 'Echo 1/2' }] });
    expect((await readPresets(dir)).map((p) => p.id)).toEqual(['min-echo']);
    await expect(savePreset(dir, { ...BUILT_IN_PRESETS[0] })).rejects.toThrow(/ferdig preset/);
  });
});

describe('eksport', () => {
  const manifest = { title: 'Blue Fire', artist: 'Echo Groove', album: null, label: null, durationMs: 300_000, sampleRate: 44100, bpm: 124, key: null, markers: [], variantLabel: null } as unknown as AssetManifest;
  it('rekordbox: stegene som navngitte memory cues og mikspunktet som hot cue i presetets farge', () => {
    const xml = rekordboxXml('Sett', [
      { manifest, file: 'F:/a.wav', mixInMs: 0, mixOutMs: 180_000, bars: 16, fxOut: { name: 'Echo out', color: '#FF5FD0' }, fxCues: [{ atMs: 172_000, name: 'Echo out · Echo/delay på A' }] }
    ]);
    expect(xml).toContain('Name="Echo out · Echo/delay på A" Type="0" Start="172.000" Num="-1"');
    expect(xml).toMatch(/Name="Echo out" Type="0" Start="180\.000" Num="1" Red="255" Green="95" Blue="208"/);
  });
  it('M3U: presetnavnet som kommentar før låta', () => {
    const text = m3u('Sett', [{ manifest, file: 'F:/a.wav', mixInMs: 0, mixOutMs: null, bars: null, fxIn: 'Bass swap 16' }]);
    expect(text).toContain('# Overgang inn: Bass swap 16\r\n#EXTINF');
  });
});

import { describe, expect, it } from 'vitest';
import { readyMessage, toastScript } from '../src/notify';

describe('Windows-varsel ved ny bounce (del 1 pkt. 8)', () => {
  it('«Would You Run (Extended) er klar – 125 BPM · 8A»', () => {
    expect(readyMessage({ title: 'Would You Run', variantLabel: 'Extended', bpm: 124.6, key: { camelot: '8A' } as never })).toEqual({ title: 'Groovehouse Vault', body: 'Would You Run (Extended) er klar – 125 BPM · 8A' });
    expect(readyMessage({ title: 'Skisse', variantLabel: null, bpm: null, key: null })).toEqual({ title: 'Groovehouse Vault', body: 'Skisse er klar' });
  });
  it('teksten går base64-kodet til PowerShell (ingen injeksjon), og XML-tegn escapes', () => {
    const s = toastScript('Groovehouse Vault', `'; Remove-Item C:\ -Recurse; '<b>&`, 'GroovehouseRecords.Vault');
    expect(s).not.toContain('Remove-Item');
    const b64 = s.match(/FromBase64String\('([^']+)'\)/)![1]!;
    const xml = Buffer.from(b64, 'base64').toString('utf8');
    expect(xml).toContain('&apos;; Remove-Item C:\ -Recurse; &apos;&lt;b&gt;&amp;');
    expect(s).toContain("CreateToastNotifier('GroovehouseRecords.Vault')");
  });
});

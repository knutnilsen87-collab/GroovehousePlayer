import { describe, expect, it } from 'vitest';
import { checkFolder } from '../src/folder-check';

/** Del 27 pkt. 2: «Mappe utilgjengelig» med sti, årsak og konkret løsning. */
const fake = (existing: string[], opts: { file?: string[]; throwCode?: string } = {}) => ({
  exists: (p: string) => existing.some((e) => e.toLowerCase() === p.toLowerCase()) || (opts.file ?? []).includes(p),
  isDir: (p: string) => !(opts.file ?? []).includes(p),
  list: () => {
    if (opts.throwCode) throw Object.assign(new Error('x'), { code: opts.throwCode });
  }
});

describe('checkFolder', () => {
  it('ingen mappe valgt', () => {
    expect(checkFolder(null).state).toBe('unset');
  });
  it.runIf(process.platform === 'win32')('disken er ikke tilkoblet', () => {
    const r = checkFolder('F:\\EchoGroove\\REASONDONE', fake(['C:\\']));
    expect(r.state).toBe('missing-drive');
    expect(r.reason).toMatch(/Disken F: er ikke tilkoblet/);
    expect(r.fix).toMatch(/Prøv igjen/);
  });
  it.runIf(process.platform === 'win32')('mappa finnes ikke: viser nærmeste mappe som finnes', () => {
    const r = checkFolder('F:\\EchoGroove\\REASONDONE', fake(['F:\\', 'F:\\EchoGroove']));
    expect(r.state).toBe('missing');
    expect(r.reason).toContain('F:\\EchoGroove\\REASONDONE');
    expect(r.fix).toContain('F:\\EchoGroove finnes');
  });
  it.runIf(process.platform === 'win32')('låst av en annen prosess og ingen tilgang', () => {
    expect(checkFolder('F:\\A', fake(['F:\\', 'F:\\A'], { throwCode: 'EBUSY' })).state).toBe('locked');
    const d = checkFolder('F:\\A', fake(['F:\\', 'F:\\A'], { throwCode: 'EPERM' }));
    expect(d.state).toBe('denied');
    expect(d.fix).toMatch(/annen prosess/);
  });
  it.runIf(process.platform === 'win32')('en fil i stedet for mappe, og ok', () => {
    expect(checkFolder('F:\\a.wav', fake(['F:\\'], { file: ['F:\\a.wav'] })).state).toBe('not-dir');
    expect(checkFolder('F:\\A', fake(['F:\\', 'F:\\A'])).state).toBe('ok');
  });
});

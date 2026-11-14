import { describe, expect, it } from 'vitest';
import { cloudSyncWarning, detectCloudSync, type SyncProbe } from '../src/cloudsync';

const probe = (files: string[], env: Record<string, string> = {}, reads: Record<string, string> = {}): SyncProbe => ({
  exists: (p) => files.some((f) => f.toLowerCase() === p.toLowerCase()),
  read: (p) => reads[p] ?? null,
  env
});
const ROOT = 'F:\\prosjekter_MAIN\\GroovehousePlayer';

describe('advarsel om synkronisert skymappe', () => {
  it('Google Drive: .tmp.driveupload i en overordnet mappe', () => {
    const s = detectCloudSync(ROOT, probe(['F:\\prosjekter_MAIN\\.tmp.driveupload']));
    expect(s).toMatchObject({ provider: 'Google Drive', syncRoot: 'F:\\prosjekter_MAIN' });
    const w = cloudSyncWarning(s!, ROOT);
    for (const n of ['node_modules', 'media', 'data', '.env']) expect(w).toContain(`${ROOT}\\${n}`);
  });
  it('OneDrive via miljøvariabel, Dropbox via info.json, iCloud i profilen', () => {
    expect(detectCloudSync('C:\\Users\\k\\OneDrive\\kode\\gv', probe([], { OneDrive: 'C:\\Users\\k\\OneDrive' }))?.provider).toBe('OneDrive');
    expect(detectCloudSync('D:\\Dropbox\\gv', probe([], { APPDATA: 'C:\\AD' }, { 'C:\\AD\\Dropbox\\info.json': JSON.stringify({ personal: { path: 'D:\\Dropbox' } }) }))?.provider).toBe('Dropbox');
    expect(detectCloudSync('C:\\Users\\k\\iCloudDrive\\gv', probe([], { USERPROFILE: 'C:\\Users\\k' }))?.provider).toBe('iCloud');
  });
  it('ingen falsk alarm: lignende navn og vanlige mapper', () => {
    expect(detectCloudSync(ROOT, probe([]))).toBeNull();
    expect(detectCloudSync('C:\\Users\\k\\OneDriveBackup\\gv', probe([], { OneDrive: 'C:\\Users\\k\\OneDrive' }))).toBeNull();
    expect(detectCloudSync('C:\\Users\\k\\Boxes\\gv', probe([], { USERPROFILE: 'C:\\Users\\k' }))).toBeNull();
  });
});

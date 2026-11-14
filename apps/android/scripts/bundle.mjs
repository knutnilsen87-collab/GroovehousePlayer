/**
 * Del 15: web-bunten til Android-appen.
 *
 *   node apps/android/scripts/bundle.mjs   (kjøres automatisk etter «vite build» i apps/web)
 *
 * Zipper apps/web/dist til data/app/bundle/<versjon>.zip, skriver versjonen inn i dist/gv-bundle.json
 * (appen leser den for å vite hvilken bunt den kjører), og oppdaterer data/app/manifest.json.
 * Uendret innhold gir ingen ny versjon. minNative følger regelen i packages/shared/src/appupdate.ts.
 * Alt ligger i data/ (gitignored) og serveres bare til egne enheter med token (/api/app/...).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..', '..');
const DIST = path.join(ROOT, 'apps', 'web', 'dist');
export const APP_DIR = path.join(ROOT, 'data', 'app');
const KEEP = 3;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const walk = (d, base = d) =>
  readdirSync(d)
    .sort()
    .flatMap((f) => {
      const p = path.join(d, f);
      return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p).replace(/\\/g, '/')];
    });

/** Samme regel som bundleVersionAt i shared (ÅÅÅÅMMDDttmmss, UTC). */
export const versionAt = (d) => Number(d.toISOString().replace(/\D/g, '').slice(0, 14));
/** Samme regel som minNativeFor i shared. */
export const minNativeFor = (apk, nativeHash) => (!apk ? 1 : apk.nativeHash === nativeHash ? apk.versionCode : apk.versionCode + 1);

export function readManifest(appDir = APP_DIR) {
  try {
    return JSON.parse(readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
  } catch {
    return { schema: 1, bundle: null, apk: null };
  }
}
export function writeManifest(m, appDir = APP_DIR) {
  const file = path.join(appDir, 'manifest.json');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

/**
 * Hash av den native delen: Kotlin-kode, manifest, ressurser (unntatt web-bunten i assets),
 * Gradle-filer og Capacitor-pluginene i package.json. Endres den, trengs ny APK.
 */
export function nativeHash() {
  const g = path.join(ROOT, 'apps', 'android', 'android');
  const h = createHash('sha256');
  const add = (abs) => {
    h.update(path.relative(ROOT, abs).replace(/\\/g, '/'));
    // Tekstfiler uten hensyn til linjeskift (git kan sjekke ut med CRLF), binærfiler som de er
    h.update(/\.(kt|java|xml|gradle|json|properties)$/.test(abs) ? readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') : readFileSync(abs));
  };
  for (const dir of [path.join(g, 'app', 'src', 'main', 'java'), path.join(g, 'app', 'src', 'main', 'res')]) if (existsSync(dir)) for (const f of walk(dir)) add(path.join(dir, f));
  for (const f of ['app/src/main/AndroidManifest.xml', 'app/build.gradle', 'build.gradle', 'variables.gradle', 'capacitor.settings.gradle', 'app/capacitor.build.gradle']) {
    const p = path.join(g, f);
    if (existsSync(p)) h.update(f).update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'apps', 'android', 'package.json'), 'utf8'));
  h.update(JSON.stringify({ ...pkg.dependencies }));
  return h.digest('hex');
}

/** Minimal zip (deflate) – ingen avhengigheter. */
export function zipFiles(dir, files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of files) {
    const data = readFileSync(path.join(dir, name));
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8-navn
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); // tid/dato 0 → stabilt innhold
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Lager (eller gjenbruker) bunten for dagens dist/. Returnerer bunt-info. */
export function makeBundle({ now = new Date(), log = console.log, dist = DIST, appDir = APP_DIR, native = nativeHash } = {}) {
  const DIST = dist;
  const APP_DIR = appDir;
  if (!existsSync(path.join(DIST, 'index.html'))) throw new Error('apps/web/dist mangler – bygg web-appen først');
  const files = walk(DIST).filter((f) => f !== 'gv-bundle.json');
  const content = createHash('sha256');
  for (const f of files) content.update(f).update(readFileSync(path.join(DIST, f)));
  const contentHash = content.digest('hex');
  const m = readManifest(APP_DIR);
  const nh = native();
  const minNative = minNativeFor(m.apk, nh);
  if (m.bundle && m.bundle.contentHash === contentHash && existsSync(path.join(APP_DIR, 'bundle', m.bundle.file))) {
    writeFileSync(path.join(DIST, 'gv-bundle.json'), JSON.stringify({ version: m.bundle.version }) + '\n');
    if (m.bundle.minNative !== minNative) {
      m.bundle.minNative = minNative;
      writeManifest(m, APP_DIR);
    }
    log(`✓ Web-bunt uendret (${m.bundle.version}, krever app ≥ ${minNative})`);
    return m.bundle;
  }
  const version = Math.max(versionAt(now), (m.bundle?.version ?? 0) + 1);
  writeFileSync(path.join(DIST, 'gv-bundle.json'), JSON.stringify({ version }) + '\n');
  const zip = zipFiles(DIST, [...files, 'gv-bundle.json']);
  const dir = path.join(APP_DIR, 'bundle');
  mkdirSync(dir, { recursive: true });
  const file = `${version}.zip`;
  writeFileSync(path.join(dir, `${file}.tmp`), zip);
  renameSync(path.join(dir, `${file}.tmp`), path.join(dir, file));
  m.bundle = { version, sha256: sha256(zip), size: zip.length, minNative, file, builtAt: now.toISOString(), contentHash };
  writeManifest(m, APP_DIR);
  // Behold de siste få
  const old = readdirSync(dir).filter((f) => /^\d+\.zip$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) rmSync(path.join(dir, f), { force: true });
  log(`✓ Web-bunt ${version} (${(zip.length / 1e6).toFixed(1)} MB, krever app ≥ ${minNative}) → data/app/bundle/${file}`);
  return m.bundle;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    makeBundle();
  } catch (e) {
    console.error(`✗ Web-bunt: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

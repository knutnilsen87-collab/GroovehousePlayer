/**
 * pnpm android:build   – bygger web-appen, synker Capacitor, legger inn ikoner og lager en signert APK
 *                        i dist/android/. Keystore: %APPDATA%\GroovehouseVault\android\release.jks,
 *                        passord i Windows Credential Manager. Lages første gang (ta backup!).
 * pnpm android:install – installerer siste APK på telefonen via adb (USB-feilsøking må være på).
 * pnpm android:release – del 15: web-bunt til data/app/bundle, ny APK til data/app/apk bare hvis den
 *                        native koden er endret, og data/app/manifest.json. Appen henter selv derfra.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credRead, credWrite } from '../../server/src/credstore';
import { nextVersionCode } from '../../../packages/shared/src/appupdate';
// @ts-expect-error – ren JS-modul uten typer (kjøres også direkte av web-bygget)
import { APP_DIR, makeBundle, nativeHash, readManifest, writeManifest } from './bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const androidDir = path.join(root, 'apps', 'android');
const gradleDir = path.join(androidDir, 'android');
const sdk = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const keyDir = path.join(process.env.APPDATA ?? '', 'GroovehouseVault', 'android');
const keystore = path.join(keyDir, 'release.jks');
const outDir = path.join(root, 'dist', 'android');
const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.1.0';

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, stdio: opts.quiet ? 'pipe' : 'inherit', shell: process.platform === 'win32' && (/\.(bat|cmd)$/i.test(cmd) || ['pnpm', 'npx', 'git'].includes(cmd)), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} feilet${opts.quiet ? `: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}` : ''}`);
  return r.stdout ?? '';
}

/** Keystore og passord: lages én gang. Samme nøkkel må brukes for alle oppdateringer. */
function ensureKeystore(): string {
  let pw = credRead('android-keystore');
  if (existsSync(keystore) && pw) return pw;
  if (existsSync(keystore) && !pw) throw new Error(`Keystoren finnes (${keystore}), men passordet mangler i Credential Manager. Ikke lag en ny – da må appen avinstalleres. Legg passordet tilbake (GroovehouseVault/android-keystore).`);
  mkdirSync(keyDir, { recursive: true });
  pw = randomBytes(24).toString('base64url');
  credWrite('android-keystore', pw);
  const keytool = path.join(process.env.JAVA_HOME ?? '', 'bin', 'keytool.exe');
  run(existsSync(keytool) ? keytool : 'keytool', ['-genkeypair', '-keystore', keystore, '-alias', 'groovehouse-vault', '-keyalg', 'RSA', '-keysize', '4096', '-validity', '36500', '-dname', 'CN=Groovehouse Vault, O=Groovehouse Records, C=NO', '-storepass:env', 'GV_KS_PW', '-keypass:env', 'GV_KS_PW'], { env: { GV_KS_PW: pw }, quiet: true });
  console.log(`✓ Ny keystore: ${keystore}\n  ! TA BACKUP av denne fila (og passordet i Credential Manager → GroovehouseVault/android-keystore). Uten dem kan appen ikke oppdateres.`);
  return pw;
}

/** Tailscale-adressen skal aldri ligge i appen (den legges inn på telefonen). */
function assertNoAddress(dirs: string[]) {
  const localCfg = path.join(root, 'groovehouse.local.json');
  const hosts = existsSync(localCfg) ? ((JSON.parse(readFileSync(localCfg, 'utf8')) as { allowedHosts?: string[] }).allowedHosts ?? []) : [];
  const needles = hosts.flatMap((h) => [h, h.split('.')[1] ?? h]).filter((n) => n && n.length > 4);
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
  for (const file of dirs.filter(existsSync).flatMap(walk)) {
    if (!/\.(js|html|json|css|map|txt|xml)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const hit = needles.find((n) => text.includes(n));
    if (hit) throw new Error(`Vault-adressen (eller tailnet-navnet) finnes i ${path.relative(root, file)} – bygget stoppes.`);
  }
  console.log('✓ Ingen Vault-adresse i web-bygget eller appens ressurser');
}

function build() {
  console.log('── Web-app');
  run('pnpm', ['--filter', './apps/web', 'build']);
  console.log('── Capacitor sync');
  run('npx', ['cap', 'sync', 'android'], { cwd: androidDir });
  run('node', [path.join(here, 'icons.mjs')]);
  assertNoAddress([path.join(root, 'apps', 'web', 'dist'), path.join(gradleDir, 'app', 'src', 'main', 'assets'), path.join(gradleDir, 'app', 'src', 'main', 'res')]);
  const pw = ensureKeystore();
  // Del 15: versionCode går aldri ned (teller i %LOCALAPPDATA%, maks av teller + 1 og antall commits)
  const counterFile = path.join(process.env.LOCALAPPDATA ?? '', 'GroovehouseVault', 'android', 'build-counter');
  const commits = Number(run('git', ['rev-list', '--count', 'HEAD'], { quiet: true }).trim()) || 1;
  const counter = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8').trim()) : null;
  const code = String(nextVersionCode(counter, commits));
  mkdirSync(path.dirname(counterFile), { recursive: true });
  writeFileSync(counterFile, code + '\n');
  console.log(`── Gradle assembleRelease (versjon ${version}, kode ${code})`);
  run(path.join(gradleDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', '--console=plain', '-q'], {
    cwd: gradleDir,
    env: { ANDROID_HOME: sdk, GV_KEYSTORE: keystore, GV_KEYSTORE_PASSWORD: pw, GV_VERSION_CODE: code }
  });
  const apk = path.join(gradleDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!existsSync(apk)) throw new Error('Fant ikke app-release.apk etter bygget');
  mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `groovehouse-vault-${version}.apk`);
  copyFileSync(apk, target);
  copyFileSync(apk, path.join(outDir, 'groovehouse-vault.apk'));
  // Sjekk signaturen
  const apksigner = path.join(sdk, 'build-tools', readdirSync(path.join(sdk, 'build-tools')).sort().pop()!, 'apksigner.bat');
  const v = run(apksigner, ['verify', '--print-certs', target], { quiet: true });
  console.log(`✓ Signert APK: ${path.relative(root, target)} (${(statSync(target).size / 1e6).toFixed(1)} MB)\n  ${v.split('\n').find((l) => l.includes('certificate DN')) ?? ''}`);
  return { file: target, versionCode: Number(code) };
}

/**
 * Del 15: publiser til appen. Web-bunten lages alltid (av web-bygget). Ny APK bare når den native
 * koden er endret siden forrige APK (eller det ikke finnes noen), og legges i data/app/apk/.
 */
function release(force = false) {
  console.log('── Web-app og bunt');
  run('pnpm', ['--filter', './apps/web', 'build']);
  const m = readManifest();
  const nh = nativeHash();
  const apkOk = m.apk && m.apk.nativeHash === nh && existsSync(path.join(APP_DIR, 'apk', m.apk.file));
  if (apkOk && !force) {
    console.log(`✓ Native kode uendret – ingen ny APK (siste: ${m.apk.versionName} / ${m.apk.versionCode})`);
  } else {
    console.log(force ? '── Ny APK (tvunget)' : m.apk ? '── Native kode er endret – bygger ny APK' : '── Første APK med oppdatereren');
    const built = build();
    const dir = path.join(APP_DIR, 'apk');
    mkdirSync(dir, { recursive: true });
    const file = `groovehouse-vault-${built.versionCode}.apk`;
    copyFileSync(built.file, path.join(dir, file));
    for (const f of readdirSync(dir)) if (f !== file && f.endsWith('.apk')) rmSync(path.join(dir, f), { force: true });
    const buf = readFileSync(path.join(dir, file));
    const notes = run('git', ['log', '-1', '--format=%s'], { quiet: true }).trim();
    const latest = readManifest();
    latest.apk = { versionCode: built.versionCode, versionName: version, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, notes, file, nativeHash: nativeHash(), builtAt: new Date().toISOString() };
    writeManifest(latest);
    console.log(`✓ APK ${built.versionCode} lagt ut for appen (data/app/apk/${file})`);
  }
  // minNative regnes på nytt mot (eventuelt ny) APK
  makeBundle();
}

function install() {
  const adb = path.join(sdk, 'platform-tools', 'adb.exe');
  const apk = path.join(outDir, 'groovehouse-vault.apk');
  if (!existsSync(apk)) throw new Error('Ingen APK ennå – kjør «pnpm android:build» først.');
  const devices = run(adb, ['devices'], { quiet: true })
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!devices.length) {
    console.log(
      'Fant ingen telefon. Slik slår du på USB-feilsøking på Samsung S22:\n' +
        '  1. Innstillinger → Om telefonen → Programvareinformasjon → trykk 7 ganger på «Versjonsnummer»\n' +
        '  2. Innstillinger → Utvikleralternativer → slå på «USB-feilsøking»\n' +
        '  3. Koble til med USB-kabel og trykk «Tillat» på telefonen\n' +
        `Eller installer manuelt: kopier ${path.relative(root, apk)} til telefonen og åpne den.`
    );
    process.exitCode = 1;
    return;
  }
  if (devices.some((d) => d.endsWith('unauthorized'))) {
    console.log('Telefonen er koblet til, men ikke godkjent: trykk «Tillat» i dialogen om USB-feilsøking på telefonen, og kjør igjen.');
    process.exitCode = 1;
    return;
  }
  run(adb, ['install', '-r', apk]);
  console.log(
    '✓ Installert. Tips for Samsung: Innstillinger → Apper → Groovehouse Vault → Batteri → «Ubegrenset»,\n' +
      '  ellers kan Samsung stoppe avspillingen i bakgrunnen.'
  );
}

const cmd = process.argv[2];
try {
  if (cmd === 'build') build();
  else if (cmd === 'install') install();
  else if (cmd === 'release') release(process.argv.includes('--apk'));
  else if (cmd === 'bundle') makeBundle();
  else throw new Error('Bruk: android build | android install | android release [--apk] | android bundle');
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

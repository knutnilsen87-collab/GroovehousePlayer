// Legger Groovehouse-ikonene fra assets/brand/Android inn i Android-prosjektet (kjøres av android:build).
// - Adaptivt ikon (forgrunn = merket, bakgrunn = #07080B) + monokromt lag (Android 13 «tema-ikoner»)
// - Varselikon: hvitt med alfa (Android krever det), laget av det monokrome laget
// - Mørk oppstartsskjerm (#07080B) i stedet for Capacitors standardbilde
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const brand = path.join(root, 'assets', 'brand', 'Android', 'res');
const res = path.join(here, '..', 'android', 'app', 'src', 'main', 'res');
// sharp ligger i ingest-pakken (brukes allerede til cover)
const sharp = createRequire(path.join(root, 'packages', 'ingest', 'package.json'))('sharp');

// 1. Fjern Capacitors standardikoner og oppstartsbilder
for (const d of readdirSync(res)) {
  const dir = path.join(res, d);
  if (/^drawable-(land|port)-/.test(d)) rmSync(dir, { recursive: true, force: true });
  for (const f of ['ic_launcher_foreground.png', 'ic_launcher_foreground.xml', 'ic_launcher_background.xml', 'splash.png']) {
    if (existsSync(path.join(dir, f))) rmSync(path.join(dir, f));
  }
}
rmSync(path.join(res, 'values', 'ic_launcher_background.xml'), { force: true });

// 2. Merkets ikoner (mipmap-*) og lagene til det adaptive ikonet (432 px = 108 dp i xxxhdpi)
for (const d of readdirSync(brand)) {
  if (d.startsWith('mipmap')) cpSync(path.join(brand, d), path.join(res, d), { recursive: true });
}
mkdirSync(path.join(res, 'drawable-xxxhdpi'), { recursive: true });
for (const f of ['ic_launcher_background.png', 'ic_launcher_foreground.png', 'ic_launcher_monochrome.png']) {
  cpSync(path.join(brand, 'drawable', f), path.join(res, 'drawable-xxxhdpi', f));
}

// 3. Varselikon: midten av det monokrome laget (trygg sone 72/108), hvitt med alfa, alle tettheter
const sizes = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
const mono = path.join(brand, 'drawable', 'ic_launcher_monochrome.png');
const crop = Math.round((432 * 72) / 108);
const off = Math.round((432 - crop) / 2);
for (const [dpi, px] of Object.entries(sizes)) {
  const dir = path.join(res, `drawable-${dpi}`);
  mkdirSync(dir, { recursive: true });
  const alpha = await sharp(mono).extract({ left: off, top: off, width: crop, height: crop }).resize(px, px).extractChannel('alpha').toBuffer();
  await sharp({ create: { width: px, height: px, channels: 3, background: '#ffffff' } })
    .joinChannel(alpha)
    .png()
    .toFile(path.join(dir, 'ic_stat_vault.png'));
}

// 4. Mørk oppstart
mkdirSync(path.join(res, 'drawable'), { recursive: true });
writeFileSync(
  path.join(res, 'drawable', 'splash.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<!-- Groovehouse: mørk oppstart (#07080B), ingen Capacitor-logo -->\n<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n    <solid android:color="#07080B" />\n</shape>\n'
);
console.log('✓ Ikoner, varselikon og mørk oppstart lagt inn');

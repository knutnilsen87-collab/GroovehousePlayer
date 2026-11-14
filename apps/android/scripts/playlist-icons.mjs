// Lager webp-versjoner av spilleliste-ikonene (assets/brand/Playlists/PNG_512px) til web-appen:
// <id>.webp (512 px) og <id>_160.webp (lister og ark). Kjør: node apps/android/scripts/playlist-icons.mjs
import { readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sharp = createRequire(path.join(root, 'packages/ingest/package.json'))('sharp');
const src = path.join(root, 'assets/brand/Playlists/PNG_512px');
const out = path.join(root, 'apps/web/public/playlist-icons');
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src).filter((x) => x.endsWith('.png'))) {
  const id = f.replace(/\.png$/, '');
  await sharp(path.join(src, f)).resize(512, 512).webp({ quality: 82, alphaQuality: 90 }).toFile(path.join(out, `${id}.webp`));
  await sharp(path.join(src, f)).resize(160, 160).webp({ quality: 85, alphaQuality: 90 }).toFile(path.join(out, `${id}_160.webp`));
  console.log('✓', id);
}

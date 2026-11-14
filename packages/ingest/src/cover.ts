import path from 'node:path';
import sharp from 'sharp';
import { Vibrant } from 'node-vibrant/node';
import { choosePalette, GOLD_FALLBACK, type ColorCandidate, type Palette, type PaletteOptions } from '@gv/shared';

export interface CoverResult {
  cover: string;
  coverThumb: string;
  palette: Palette;
}

/** Normaliserer coveret (1200 px + 300 px thumb) og henter palett med kontrastlås. */
export async function processCover(input: string, outDir: string, opts: PaletteOptions = {}): Promise<CoverResult> {
  const big = path.join(outDir, 'cover.jpg');
  const thumb = path.join(outDir, 'cover_300.jpg');
  const img = sharp(input).rotate();
  await img.clone().resize(1200, 1200, { fit: 'cover' }).jpeg({ quality: 88, mozjpeg: true }).toFile(big);
  await img.clone().resize(300, 300, { fit: 'cover' }).jpeg({ quality: 82, mozjpeg: true }).toFile(thumb);
  return { cover: 'cover.jpg', coverThumb: 'cover_300.jpg', palette: await paletteFrom(big, opts) };
}

export async function paletteFrom(imagePath: string, opts: PaletteOptions = {}): Promise<Palette> {
  const swatches = await Vibrant.from(imagePath).quality(3).getPalette();
  const list = Object.values(swatches).filter((s): s is NonNullable<typeof s> => !!s);
  const total = list.reduce((a, s) => a + s.population, 0) || 1;
  const candidates: ColorCandidate[] = list.map((s) => ({ hex: s.hex, population: s.population / total }));
  return candidates.length ? choosePalette(candidates, opts) : { ...GOLD_FALLBACK };
}

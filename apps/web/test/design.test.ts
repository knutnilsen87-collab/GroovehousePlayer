import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Del 14 (låst av Knut 2026-11-14): coveret styrer alle farger, gull bare i logoen.
 * Ingen komponent skal hardkode gull eller cyan; aksenter går via --accent/--accent-2/--glow.
 */
const SRC = path.resolve(__dirname, '../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, '/');
/** Logoen (og ingenting annet) får bruke gull. */
const LOGO = new Set(['components/Brand.tsx']);

describe('designregel: gull bare i logoen (del 14)', () => {
  const all = files(SRC);

  it('ingen gull-klasser eller gull-hex utenfor logoen', () => {
    const bad: string[] = [];
    for (const f of all) {
      if (LOGO.has(rel(f))) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\b(bg|text|border|ring|from|to|via|fill|stroke|outline|shadow)-gold\b|#F0C030|#F0DC6A|#B06000|240,\s*192,\s*48|\bchampagne\b/i.test(line)) bad.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('ingen hardkodet cyan i komponentene (cyan i referansen kommer fra et blått cover)', () => {
    const bad = all.filter((f) => /#(00[cdef][0-9a-f]{3}|0ff|00ffff|22d3ee|06b6d4)\b/i.test(readFileSync(f, 'utf8'))).map(rel);
    expect(bad).toEqual([]);
  });

  it('skriften er selvhostet (ingen CDN)', () => {
    const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)|api\.fontshare/);
    const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');
    expect(css).toMatch(/url\('\/fonts\/Satoshi-Variable\.woff2'\)/);
    expect(css).toMatch(/url\('\/fonts\/JetBrainsMono-Regular\.woff2'\)/);
  });
});

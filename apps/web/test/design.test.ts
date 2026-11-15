import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Del 14 (låst av Knut 2026-11-14, oppdatert til grønn 2026-11-15): coveret styrer alle farger, gull bare i logoen.
 * Fargeløse cover og «ingen låt valgt» bruker standardfargen grønn (#06B211 / #14E177) (FALLBACK_PALETTE),
 * ikke gull. Ingen komponent skal hardkode gull eller cyan; aksenter går via --accent/--accent-2/--glow.
 */
const REPO = path.resolve(__dirname, '../../..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === 'node_modules' || n === 'dist' || n === 'test') return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|mjs)$/.test(n) ? [p] : [];
  });
const rel = (p: string) => path.relative(REPO, p).replace(/\\/g, '/');
const SOURCES = ['apps/web/src', 'apps/server/src', 'packages/shared/src', 'packages/ingest/src'].flatMap((d) => files(path.join(REPO, d)));
/** Logoen (og ingenting annet) får bruke gull. */
const LOGO = new Set(['apps/web/src/components/Brand.tsx']);
const GOLD = /\b(bg|text|border|ring|from|to|via|fill|stroke|outline|shadow)-gold\b|#F0C030|#F0DC6A|#B06000|240,\s*192,\s*48|\bchampagne\b|GOLD_FALLBACK|goldFallback/i;

describe('designregel: gull bare i logoen, cyan som standard (del 14)', () => {
  it('ingen gull utenfor logoen – i web, server, shared og ingest', () => {
    const bad: string[] = [];
    for (const f of SOURCES) {
      if (LOGO.has(rel(f))) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Lesing av den gamle konfignøkkelen (goldFallback → colorFallback) er lov i config.ts
          if (rel(f) === 'packages/ingest/src/config.ts' && /goldFallback/.test(line) && !/#F0C030/i.test(line)) return;
          if (GOLD.test(line)) bad.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('standardfargen er grønn (#06B211), og bare definert som token', () => {
    const theme = readFileSync(path.join(REPO, 'packages/shared/src/theme.ts'), 'utf8');
    expect(theme).toMatch(/FALLBACK_PALETTE[^]*primary: '#06B211'/);
    const css = readFileSync(path.join(REPO, 'apps/web/src/index.css'), 'utf8');
    expect(css).toMatch(/:root \{[^}]*--accent: #06b211;/);
  });

  it('ingen hardkodet cyan i komponentene (cyan kommer fra coveret eller standardtokenet)', () => {
    const TOKENS = new Set(['packages/shared/src/theme.ts', 'apps/web/src/index.css', 'apps/server/src/lan.ts', 'packages/ingest/src/share.ts']);
    const bad = SOURCES.filter((f) => f.includes(`${path.sep}web${path.sep}`) && !TOKENS.has(rel(f)) && /#(00[cdef][0-9a-f]{3}|01e6fc|0ff|00ffff|22d3ee|06b6d4)\b/i.test(readFileSync(f, 'utf8'))).map(rel);
    expect(bad).toEqual([]);
  });

  it('skriften er selvhostet (ingen CDN)', () => {
    const html = readFileSync(path.join(REPO, 'apps/web/index.html'), 'utf8');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)|api\.fontshare/);
    const css = readFileSync(path.join(REPO, 'apps/web/src/index.css'), 'utf8');
    expect(css).toMatch(/url\('\/fonts\/Satoshi-Variable\.woff2'\)/);
    expect(css).toMatch(/url\('\/fonts\/JetBrainsMono-Regular\.woff2'\)/);
  });
});

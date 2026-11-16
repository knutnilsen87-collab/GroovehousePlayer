import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BUILT_IN_PRESETS, validatePreset, type FxIdea, type FxPreset } from '@gv/shared';
import { writeJsonAtomic } from './markers-file';

/**
 * Del 18: egne overgangs-presets (data/fx-presets.json) og overgangsidéer (data/fx-ideas.json).
 * Idéer lagres med ett trykk uten dialog; «Angre» sletter dem igjen.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
const BUILT = new Set(BUILT_IN_PRESETS.map((p) => p.id));

async function readJson<T>(file: string, dflt: T): Promise<T> {
  if (!existsSync(file)) return dflt;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return dflt;
  }
}

export async function readPresets(dataDir: string): Promise<FxPreset[]> {
  const raw = await readJson<{ presets?: unknown[] }>(path.join(dataDir, 'fx-presets.json'), {});
  return (raw.presets ?? []).flatMap((p) => {
    try {
      return [validatePreset(p)];
    } catch {
      return [];
    }
  });
}
export async function savePreset(dataDir: string, input: unknown): Promise<FxPreset[]> {
  const p = validatePreset(input);
  if (BUILT.has(p.id)) throw new Error('id-en tilhører en ferdig preset – dupliser i stedet');
  const list = (await readPresets(dataDir)).filter((x) => x.id !== p.id);
  list.push(p);
  await writeJsonAtomic(path.join(dataDir, 'fx-presets.json'), { presets: list });
  return list;
}
export async function deletePreset(dataDir: string, id: string): Promise<FxPreset[]> {
  const list = (await readPresets(dataDir)).filter((x) => x.id !== id);
  await writeJsonAtomic(path.join(dataDir, 'fx-presets.json'), { presets: list });
  return list;
}

export async function readIdeas(dataDir: string): Promise<FxIdea[]> {
  return (await readJson<{ ideas?: FxIdea[] }>(path.join(dataDir, 'fx-ideas.json'), {})).ideas ?? [];
}
export async function addIdea(dataDir: string, input: unknown, knownPresets: Set<string>): Promise<FxIdea> {
  const o = (input ?? {}) as Record<string, unknown>;
  const from = String(o.from ?? '');
  const to = o.to == null || o.to === '' ? null : String(o.to);
  const preset = String(o.preset ?? '');
  if (!SLUG.test(from) || (to !== null && !SLUG.test(to))) throw new Error('ugyldig låt');
  if (!knownPresets.has(preset)) throw new Error('ukjent preset');
  const idea: FxIdea = { id: randomUUID(), from, to, preset, at: new Date().toISOString() };
  if (typeof o.note === 'string' && o.note.trim()) idea.note = o.note.trim().slice(0, 200);
  const ideas = await readIdeas(dataDir);
  ideas.push(idea);
  await writeJsonAtomic(path.join(dataDir, 'fx-ideas.json'), { ideas: ideas.slice(-2000) });
  return idea;
}
export async function deleteIdea(dataDir: string, id: string): Promise<boolean> {
  const ideas = await readIdeas(dataDir);
  const next = ideas.filter((i) => i.id !== id);
  if (next.length === ideas.length) return false;
  await writeJsonAtomic(path.join(dataDir, 'fx-ideas.json'), { ideas: next });
  return true;
}

type Send = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage, max?: number) => Promise<unknown>;

/**
 * GET    /api/fx                → { presets (egne), ideas }
 * PUT    /api/fx/presets/:id    · DELETE /api/fx/presets/:id
 * POST   /api/fx/ideas          { from, to|null, preset, note? } → { idea }
 * DELETE /api/fx/ideas/:id      (Angre)
 */
export async function handleFx(dataDir: string, url: URL, req: IncomingMessage, res: ServerResponse, send: Send, readBody: ReadBody): Promise<void> {
  try {
    const json = () => {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('krever application/json'), { status: 415 });
      return readBody(req, 50_000);
    };
    if (url.pathname === '/api/fx' && req.method === 'GET') return send(res, 200, { presets: await readPresets(dataDir), ideas: await readIdeas(dataDir) });
    const pm = url.pathname.match(/^\/api\/fx\/presets\/([a-z0-9][a-z0-9-]{1,40})$/);
    if (pm && req.method === 'PUT') {
      const body = (await json()) as Record<string, unknown>;
      if (body.id !== pm[1]) return send(res, 400, { error: 'id i adressen og presetet må være like' });
      return send(res, 200, { presets: await savePreset(dataDir, body) });
    }
    if (pm && req.method === 'DELETE') return send(res, 200, { presets: await deletePreset(dataDir, pm[1]!) });
    if (url.pathname === '/api/fx/ideas' && req.method === 'POST') {
      const known = new Set([...BUILT, ...(await readPresets(dataDir)).map((p) => p.id)]);
      return send(res, 200, { idea: await addIdea(dataDir, await json(), known) });
    }
    const im = url.pathname.match(/^\/api\/fx\/ideas\/([0-9a-f-]{36})$/);
    if (im && req.method === 'DELETE') return (await deleteIdea(dataDir, im[1]!)) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'finnes ikke' });
    return send(res, 404, { error: 'ukjent' });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    return send(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}

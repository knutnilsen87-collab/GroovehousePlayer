import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SkinError, validateSkin, type Skin } from '@gv/shared';
import { writeJsonAtomic } from './markers-file';

/**
 * Del 19: egne skins i data/skins/<id>.json, og valgfritt «samme skin på alle enheter» i data/skins/_shared.json.
 * Valget av skin lagres ellers per enhet (i klienten), så PC og telefon kan ha ulike skins.
 */
const SHARED = '_shared.json';
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

export interface SkinsState {
  custom: Skin[];
  /** Skin-id som alle enheter som følger «samme på alle» skal bruke, eller null. */
  shared: string | null;
}

export async function readSkins(dir: string): Promise<SkinsState> {
  const custom: Skin[] = [];
  let shared: string | null = null;
  if (!existsSync(dir)) return { custom, shared };
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as unknown;
      if (f === SHARED) {
        const id = (raw as { id?: unknown }).id;
        shared = typeof id === 'string' && ID.test(id) ? id : null;
      } else custom.push(validateSkin(raw));
    } catch {
      /* ødelagt fil: hoppes over, resten virker */
    }
  }
  custom.sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  return { custom, shared };
}

export async function saveSkin(dir: string, input: unknown, builtInIds: ReadonlySet<string>): Promise<Skin> {
  const skin = validateSkin(input);
  if (builtInIds.has(skin.id)) throw new SkinError('id-en tilhører et ferdig skin – dupliser i stedet');
  await writeJsonAtomic(path.join(dir, `${skin.id}.json`), skin);
  return skin;
}

export async function deleteSkin(dir: string, id: string): Promise<void> {
  if (!ID.test(id)) throw new SkinError('ugyldig id');
  await rm(path.join(dir, `${id}.json`), { force: true });
  const st = await readSkins(dir);
  if (st.shared === id) await rm(path.join(dir, SHARED), { force: true });
}

export async function setSharedSkin(dir: string, id: string | null): Promise<void> {
  if (id === null) return void (await rm(path.join(dir, SHARED), { force: true }));
  if (!ID.test(id)) throw new SkinError('ugyldig id');
  await writeJsonAtomic(path.join(dir, SHARED), { id, updatedAt: new Date().toISOString() });
}

type Send = (res: ServerResponse, status: number, body: unknown) => void;
type ReadJson = (req: IncomingMessage, max?: number) => Promise<unknown>;

/**
 * GET    /api/skins               → { custom, shared }
 * PUT    /api/skins/custom/:id    → lagre eget skin
 * DELETE /api/skins/custom/:id
 * PUT    /api/skins/shared        { id: string | null }
 */
export async function handleSkins(dir: string, builtInIds: ReadonlySet<string>, url: URL, req: IncomingMessage, res: ServerResponse, send: Send, readJson: ReadJson): Promise<void> {
  try {
    if (url.pathname === '/api/skins') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, await readSkins(dir));
    }
    const json = () => {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new SkinError('krever application/json'), { status: 415 });
      return readJson(req, 50_000);
    };
    if (url.pathname === '/api/skins/shared') {
      if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
      const body = (await json()) as { id?: unknown };
      await setSharedSkin(dir, typeof body.id === 'string' ? body.id : null);
      return send(res, 200, await readSkins(dir));
    }
    const m = url.pathname.match(/^\/api\/skins\/custom\/([a-z0-9][a-z0-9-]{1,40})$/);
    if (!m) return send(res, 404, { error: 'ukjent' });
    if (req.method === 'DELETE') {
      await deleteSkin(dir, m[1]!);
      return send(res, 200, await readSkins(dir));
    }
    if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
    const body = (await json()) as Record<string, unknown>;
    if (body.id !== m[1]) return send(res, 400, { error: 'id i adressen og skinnet må være like' });
    const skin = await saveSkin(dir, body, builtInIds);
    return send(res, 200, { skin, ...(await readSkins(dir)) });
  } catch (err) {
    if (err instanceof SkinError) return send(res, (err as SkinError & { status?: number }).status ?? 400, { error: err.message });
    throw err;
  }
}

/** Echo Groove-ordmerket (PNG/SVG med gjennomsiktig bakgrunn) i assets/brand/echo-groove/, hvis det finnes. */
export async function findBrandLogo(root: string, brand: string): Promise<string | null> {
  if (!/^[a-z0-9-]{1,40}$/.test(brand)) return null;
  const dir = path.join(root, 'assets', 'brand', brand);
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter((f) => /\.(svg|png)$/i.test(f)).sort((a, b) => (a.toLowerCase().endsWith('.svg') ? -1 : 0) - (b.toLowerCase().endsWith('.svg') ? -1 : 0));
  return files.length ? path.join(dir, files[0]!) : null;
}

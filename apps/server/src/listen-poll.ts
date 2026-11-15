import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Del 13: PC-en spør lytter-tjenesten om åpne «be om ny tilgang» og varsler én gang per id.
 * Kalles bare når LISTEN_ADMIN_URL er satt. Feil skal fanges av kalleren.
 */
export interface AccessAsk {
  id: string;
  name: string;
  dropId: string;
}

export function loadSeenIds(file: string): Set<string> {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return new Set(Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveSeenIds(file: string, seen: Set<string>): void {
  writeFileSync(file, JSON.stringify([...seen]));
}

export async function pollAccessRequests(opts: {
  baseUrl: string;
  token: string;
  seen: Set<string>;
  notify: (title: string, body: string) => void;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const r = await fetchImpl(`${base}/admin/access-requests`, { headers: { authorization: `Bearer ${opts.token}` } });
  if (!r.ok) throw new Error(`access-requests ${r.status}`);
  const data = (await r.json()) as { requests?: AccessAsk[] };
  let n = 0;
  for (const ask of data.requests ?? []) {
    if (!ask?.id || opts.seen.has(ask.id)) continue;
    opts.seen.add(ask.id);
    opts.notify('Groovehouse Vault', `${ask.name || 'Noen'} ber om ny lyttelenke.`);
    n++;
  }
  return n;
}

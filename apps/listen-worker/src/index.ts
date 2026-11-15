import { handleListenRequest, ListenStore, MemoryBlobs, type BlobStore } from '@gv/shared';

interface D1 {
  prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } };
}
interface R2 {
  put(key: string, body: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
}

export interface Env {
  ADMIN_TOKEN: string;
  SIGNING_SECRET: string;
  LISTEN_ORIGIN?: string;
  DB?: D1;
  BUCKET?: R2;
}

const memory = new ListenStore();
const memoryBlobs = new MemoryBlobs();

function r2(bucket: R2): BlobStore {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { body: new Uint8Array(await obj.arrayBuffer()), contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream' };
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async keys() {
      const listed = await bucket.list();
      return listed.objects.map((o) => o.key);
    }
  };
}

async function load(db: D1): Promise<ListenStore> {
  const row = await db.prepare('select doc from listen_doc where id = 1').bind().first<{ doc: string }>();
  return row?.doc ? ListenStore.fromJSON(row.doc) : new ListenStore();
}

async function save(db: D1, store: ListenStore) {
  await db.prepare('insert into listen_doc (id, doc) values (1, ?) on conflict(id) do update set doc = excluded.doc').bind(JSON.stringify(store)).run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = env.DB ? await load(env.DB) : memory;
    const blobs = env.BUCKET ? r2(env.BUCKET) : memoryBlobs;
    const res = await handleListenRequest(req, store, blobs, {
      adminToken: env.ADMIN_TOKEN,
      signingSecret: env.SIGNING_SECRET,
      origin: env.LISTEN_ORIGIN ?? 'https://listen.groovehouserecords.com'
    });
    if (env.DB) await save(env.DB, store);
    return res;
  }
};

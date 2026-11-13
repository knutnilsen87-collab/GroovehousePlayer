import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Ingest-motoren skriver til ../../media. Den serveres under /media/ (samme kode som apps/server),
// så apps/web/public/ er en vanlig public-mappe (ikoner, manifest).
// Fase 2: lyd og analyse hentes via media-workeren med signerte tokens i stedet.
const repoRoot = path.resolve(__dirname, '../..');
const mediaDir = path.resolve(__dirname, process.env.GH_MEDIA_DIR ? path.resolve(repoRoot, process.env.GH_MEDIA_DIR) : '../../media');
const ingestSrc = path.resolve(repoRoot, 'packages/ingest/src');
const ports = (JSON.parse(readFileSync(path.join(repoRoot, 'groovehouse.config.json'), 'utf8')) as { ports?: { dev?: number } }).ports;

type Handler = (req: unknown, res: unknown, next: () => void) => Promise<void>;

/** /media/* og /api/* i dev. Samme moduler brukes av apps/server. */
function vaultMiddleware(): Plugin {
  return {
    name: 'groovehouse-vault-middleware',
    configureServer(server) {
      let api: Handler | null = null;
      let media: Handler | null = null;
      server.middlewares.use(async (req, res, next) => {
        try {
          if (req.url?.startsWith('/api/')) {
            if (!api) {
              const mod = (await server.ssrLoadModule(path.join(ingestSrc, 'api.ts'))) as { createApiHandler: (o: { mediaDir: string }) => Handler };
              api = mod.createApiHandler({ mediaDir });
            }
            return await api(req, res, next);
          }
          if (req.url?.startsWith('/media/')) {
            if (!media) {
              const mod = (await server.ssrLoadModule(path.join(ingestSrc, 'media-static.ts'))) as { createMediaHandler: (dir: string) => Handler };
              media = mod.createMediaHandler(mediaDir);
            }
            return await media(req, res, next);
          }
          next();
        } catch (err) {
          next(err);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), vaultMiddleware()],
  server: {
    host: '127.0.0.1',
    port: ports?.dev ?? 41734,
    strictPort: true,
    fs: { allow: [repoRoot] },
    // Ikke overvåk media/: på Windows holder overvåkingen mappehåndtak åpne, så ingest ikke
    // får byttet inn ferdige versjoner (EPERM ved rename). Katalogen hentes uansett med no-cache.
    watch: { ignored: [`${mediaDir.replace(/\\/g, '/')}/**`] }
  },
  preview: { host: '127.0.0.1' }
});

import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Fase 1: ingest-motoren skriver til ../../media. Vite serverer mappa som statiske filer,
// så /index.json og /<slug>/v<N>/hls/index.m3u8 fungerer lokalt.
// Fase 2: lyd og analyse hentes via media-workeren med signerte tokens i stedet.
const mediaDir = path.resolve(__dirname, process.env.GH_MEDIA_DIR ?? '../../media');
const apiModule = path.resolve(__dirname, '../../packages/ingest/src/api.ts');

/** Studio-API (/api/...) i dev. Samme modul brukes av apps/server. */
function vaultApi(): Plugin {
  return {
    name: 'groovehouse-vault-api',
    configureServer(server) {
      type Handler = (req: unknown, res: unknown, next: () => void) => Promise<void>;
      let handler: Handler | null = null;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        if (!handler) {
          const mod = (await server.ssrLoadModule(apiModule)) as { createApiHandler: (o: { mediaDir: string }) => Handler };
          handler = mod.createApiHandler({ mediaDir });
        }
        await handler(req, res, next);
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), vaultApi()],
  publicDir: mediaDir,
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '../..')] },
    // Ikke overvåk media/: på Windows holder overvåkingen mappehåndtak åpne, så ingest ikke
    // får byttet inn ferdige versjoner (EPERM ved rename). Katalogen hentes uansett med no-cache.
    watch: { ignored: [`${mediaDir.replace(/\\/g, '/')}/**`] }
  }
});

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fase 1: ingest-motoren skriver til ../../media. Vite serverer mappa som statiske filer,
// så /index.json og /<slug>/v<N>/hls/index.m3u8 fungerer lokalt.
// Fase 2: lyd og analyse hentes via media-workeren med signerte tokens i stedet.
const mediaDir = path.resolve(__dirname, process.env.GH_MEDIA_DIR ?? '../../media');

export default defineConfig({
  plugins: [react()],
  publicDir: mediaDir,
  server: { port: 5173, fs: { allow: [path.resolve(__dirname, '../..')] } }
});

import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Publishes the deployed version, so a tab left open can notice an update. */
const versionFile = (): Plugin => ({
  name: 'version-file',
  generateBundle() {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
  },
});

export default defineConfig({
  plugins: [react(), versionFile()],
  build: { outDir: 'dist/web' },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});

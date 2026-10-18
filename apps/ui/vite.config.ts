// Vite config for the SPA (plan/10 §1, 06 UI-50). Dev and preview bind 127.0.0.1 only; the BFF
// (127.0.0.1:3100) serves `dist/` in the bundle, and the dev server proxies the API to it.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BFF_ORIGIN = 'http://127.0.0.1:3100';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': BFF_ORIGIN, '/proxy': BFF_ORIGIN, '/return': BFF_ORIGIN },
  },
  preview: { host: '127.0.0.1' },
});

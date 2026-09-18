import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';
const WS_PROXY_TARGET =
  process.env.VITE_WS_PROXY_TARGET || 'ws://127.0.0.1:3000';

const APP_BASE = (() => {
  const raw = (process.env.VITE_BASE_PATH || '/').trim();
  if (!raw) return '/';
  let base = raw;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
})();

export default defineConfig({
  base: APP_BASE,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    allowedHosts: true,
    hmr: {
      // VS Code Remote port forwarding requires explicit HMR client config
      clientPort: 5173,
    },
    proxy: {
      '/api': API_PROXY_TARGET,
      '/ws': {
        target: WS_PROXY_TARGET,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The SPA talks only to the frozen v1 HTTP/SSE contract. In development the
// /api proxy targets the standalone API (:3001) so the browser is same-origin;
// production nginx proxies the same path and injects the bearer token. Set
// VITE_API_BASE_URL to bypass the proxy when testing cross-origin directly.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY || 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});

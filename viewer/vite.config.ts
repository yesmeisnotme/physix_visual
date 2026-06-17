import { defineConfig } from 'vite';
import { physixApiPlugin } from './vite-plugin-physix';

export default defineConfig({
  base: './',
  plugins: [physixApiPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    open: false,
    host: '127.0.0.1',
    fs: {
      allow: ['..'],
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});

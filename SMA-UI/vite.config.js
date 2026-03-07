import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/broker': {
        target: 'http://localhost:9003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/broker/, ''),
      },
      '/execution': {
        target: 'http://localhost:9004',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/execution/, ''),
      },
      '/data-api': {
        target: 'http://localhost:9005',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/data-api/, ''),
      },
      '/strategy': {
        target: 'http://localhost:9006',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/strategy/, ''),
      },
    },
  },
});

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
        // No timeout for SSE long-lived connections
        timeout: 0,
        proxyTimeout: 0,
      },
      '/strategy-api': {
        target: 'http://localhost:9006',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/strategy-api/, ''),
        timeout: 0,
        proxyTimeout: 0,
      },
      '/strategy': {
        target: 'http://localhost:9006',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/strategy/, ''),
        // Backtest on sub-15min intervals can take several minutes to fetch + persist candles
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});

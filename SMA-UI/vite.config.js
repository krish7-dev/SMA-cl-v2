import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Override via .env.ec2: VITE_BACKEND_HOST=http://<ec2-ip>
  const host = env.VITE_BACKEND_HOST || 'http://localhost';

  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        '/broker':       { target: `${host}:9003`, changeOrigin: true, rewrite: (p) => p.replace(/^\/broker/, '') },
        '/execution':    { target: `${host}:9004`, changeOrigin: true, rewrite: (p) => p.replace(/^\/execution/, '') },
        '/data-api':     { target: `${host}:9005`, changeOrigin: true, rewrite: (p) => p.replace(/^\/data-api/, ''), timeout: 0, proxyTimeout: 0 },
        '/strategy-api': { target: `${host}:9006`, changeOrigin: true, rewrite: (p) => p.replace(/^\/strategy-api/, ''), timeout: 0, proxyTimeout: 0 },
        '/strategy':     { target: `${host}:9006`, changeOrigin: true, rewrite: (p) => p.replace(/^\/strategy/, ''), timeout: 0, proxyTimeout: 0 },
      },
    },
  };
});

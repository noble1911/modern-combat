import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset URLs: the game is served under a path (games.noblehaus.uk/modern-combat/)
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);

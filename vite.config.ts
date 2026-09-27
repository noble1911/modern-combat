import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset URLs: the game is served under a path (games.noblehaus.uk/modern-combat/)
  base: './',
  // `npm run server` runs the multiplayer relay on :3004; the dev server forwards /ws to it
  server: { port: 5173, host: '127.0.0.1', proxy: { '/ws': { target: 'ws://127.0.0.1:3004', ws: true } } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);

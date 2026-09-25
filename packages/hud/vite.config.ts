import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});

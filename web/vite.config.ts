import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev -w web` with CONSOLE_URL set to a deployed console serves its config and API
// through this origin (http://localhost:5173 is a registered callback in the dev user pool).
const target = process.env.CONSOLE_URL;

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: target
    ? { proxy: { '/api': { target, changeOrigin: true }, '/config.json': { target, changeOrigin: true } } }
    : {},
});

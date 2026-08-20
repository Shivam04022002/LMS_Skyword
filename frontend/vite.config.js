import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5174 rather than Vite's default 5173: another local project occupies
    // 5173. strictPort keeps the origin predictable, because the backend's CORS
    // allowlist (FRONTEND_URL) has to match this exactly.
    port: 5174,
    strictPort: true
  }
});

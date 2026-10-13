import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard runs on port 5173 and forwards /api calls to the server on 4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});

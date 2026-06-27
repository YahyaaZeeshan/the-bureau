import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:4317',
      '/ws': { target: 'ws://localhost:4317', ws: true },
    },
  },
});

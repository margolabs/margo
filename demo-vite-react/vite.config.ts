import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import margo from 'margo-dev';

export default defineConfig({
  plugins: [react(), margo()],
  server: { port: 5175 },
});

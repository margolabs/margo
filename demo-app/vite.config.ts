import { defineConfig } from 'vite';
import margo from 'margo-dev';

export default defineConfig({
  plugins: [margo()],
  server: { port: 5173 },
});

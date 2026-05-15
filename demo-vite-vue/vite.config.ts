import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import margo from 'margo-dev';

export default defineConfig({
  plugins: [vue(), margo()],
  server: { port: 5174 },
});

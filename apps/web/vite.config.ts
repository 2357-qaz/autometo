import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwa } from './pwa-plugin';

export default defineConfig({
  plugins: [react(), pwa()],
  base: './',
});

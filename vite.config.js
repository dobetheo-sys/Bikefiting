import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/Bikefiting/' : '/',
  plugins: [react(), tailwindcss()],
  build: {
    // index-swim.html : app nage (SwimApp.jsx), projet parallèle indépendant (cf.
    // docs/SPEC_ANALYSE_NAGE_MOTEUR.md §8) — ajouté comme second point d'entrée pour que
    // `npm run build` le génère aussi, sans changer le comportement de index.html (app vélo).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        swim: fileURLToPath(new URL('index-swim.html', import.meta.url)),
      },
    },
  },
});

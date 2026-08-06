// Copie les binaires WASM de @mediapipe/tasks-vision (12 Mo par fichier) vers
// public/mediapipe-wasm/ pour que FilesetResolver.forVisionTasks() les serve
// en local plutôt que de dépendre du CDN jsdelivr à l'exécution.
// Régénéré à chaque `npm run dev`/`npm run build` (predev/prebuild) — jamais commité,
// voir .gitignore.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(here, '..', 'public', 'mediapipe-wasm');

if (!existsSync(src)) {
  console.error(`copy-mediapipe-wasm: introuvable ${src} — as-tu lancé npm install ?`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`copy-mediapipe-wasm: ${src} -> ${dest}`);

// mediapipe-vision.ts
// Point d'entrée navigateur unique pour MediaPipe Tasks Vision : charge le fileset
// WASM une seule fois (coûteux, ~12 Mo) et le partage entre ImageSegmenter et
// PoseLandmarker. Sert les binaires WASM en local (public/mediapipe-wasm/, copiés
// depuis node_modules par scripts/copy-mediapipe-wasm.mjs) plutôt que via le CDN
// jsdelivr, pour ne pas dépendre d'un tiers au runtime.
//
// Ce fichier importe directement @mediapipe/tasks-vision (contrairement au premier
// jet de segmentation-integration.ts qui passait par un globalThis injecté) — le
// package s'importe sans problème hors navigateur (types + classes JS), seul
// FilesetResolver.forVisionTasks() a besoin d'un vrai DOM/fetch, donc rien ne casse
// les tests node:test tant qu'on n'appelle pas cette fonction depuis un test.
import { FilesetResolver } from '@mediapipe/tasks-vision';

// import.meta.env.BASE_URL reflète le `base` de vite.config.js (ex. '/Bikefiting/' sur
// GitHub Pages, '/' en local) — un chemin absolu en dur ('/mediapipe-wasm') donnait un
// 404 une fois déployé sous un sous-chemin, ce qui faisait échouer FilesetResolver avec
// un Event brut (pas une Error) propagé jusqu'à l'écran d'erreur ("[object Event]").
const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe-wasm`;

let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

// Audit fiabilité : un premier appel qui échoue (ex. accroc réseau passager en chargeant les
// binaires WASM) mettait en cache la promesse REJETÉE indéfiniment — tous les appels suivants,
// y compris via le bouton "Réessayer" de l'appli (App.jsx), retombaient immédiatement sur cette
// même promesse déjà rejetée, sans jamais retenter le chargement. La fonctionnalité photo/pFSA
// restait cassée pour le reste de la session, un simple accroc réseau devenant permanent.
export function getVisionFileset() {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(WASM_BASE).catch((e) => {
      filesetPromise = null;
      throw e;
    });
  }
  return filesetPromise;
}

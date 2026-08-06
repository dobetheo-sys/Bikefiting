// segmentation-integration.ts
// Intégration MediaPipe ImageSegmenter (Web) pour produire le BinaryMask
// attendu par computePFSA_cm2() (capture-processing.ts).
//
// ÉTAT (mis à jour lors du branchement réel, cf. mediapipe-vision.ts) :
// - createBikeFitSegmenter() importe directement @mediapipe/tasks-vision et est
//   appelée pour de vrai par src/App.jsx (mode photo frontale). Le fileset WASM
//   est injecté par l'appelant (getVisionFileset() dans mediapipe-vision.ts) —
//   ce fichier reste sans dépendance sur *comment* le fileset est construit, donc
//   testable en isolant juste readCategoryIndices()/toBikeFitBinaryMask.
// - CE QUI RESTE À VÉRIFIER SUR UN VRAI APPAREIL : qu'une vraie photo (cycliste +
//   vélo) produit un masque dont la pFSA calculée tombe dans l'ordre de grandeur
//   attendu (~3000-4500 cm² en position aéro adulte, cf. spec). Pas exécutable
//   dans ce sandbox (pas de caméra, et le CDN jsdelivr par défaut de MediaPipe est
//   bloqué par le proxy réseau d'ici — d'où le WASM local plutôt que la doc CDN).
// - CE QUI EST TESTÉ (segmentation-integration.test.ts) : la logique de filtrage
//   par classe (toBikeFitBinaryMask), qui est pure et ne dépend d'aucun modèle réel.
import { ImageSegmenter } from '@mediapipe/tasks-vision';

// ---------- Choix du modèle ----------
// DeepLabV3 (Pascal VOC, 21 classes) plutôt qu'un "selfie segmenter" pur :
// la méthode pFSA publiée (Debraux et al. 2009) mesure CYCLISTE + VÉLO ensemble.
// Un segmenteur "personne uniquement" perdrait le cadre/roues qui dépassent de la
// silhouette du corps, sous-estimant la vraie surface frontale.
// Pascal VOC inclut "bicycle" (classe 2) et "person" (classe 15) — ordering standard
// et stable du dataset (fixe depuis sa publication, pas une valeur qui bouge avec
// les versions du modèle).
export const CATEGORY_BICYCLE = 2;
export const CATEGORY_PERSON = 15;

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

// ---------- Types minimaux ----------
// Sous-ensemble de l'API réelle de MPMask (vision.d.ts, @mediapipe/tasks-vision 1.0.1) :
// getAsUint8Array() est l'accesseur confirmé pour un categoryMask (confirmé contre les
// types du package installé, plus l'hypothèse de départ "readCategoryIndices").

export interface MPCategoryMaskResult {
  width: number;
  height: number;
  getAsUint8Array: () => Uint8Array;
}

export interface SegmentationResult {
  categoryMask: MPCategoryMaskResult;
}

// ---------- Initialisation ----------
// `visionFileset` = résultat de getVisionFileset() (mediapipe-vision.ts), injecté par
// l'appelant plutôt qu'importé ici, pour que ce fichier n'ait qu'une seule responsabilité
// (config du segmenteur) et reste facile à isoler en test.

export async function createBikeFitSegmenter(
  visionFileset: Awaited<ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>>
) {
  return ImageSegmenter.createFromOptions(visionFileset, {
    baseOptions: { modelAssetPath: MODEL_URL },
    outputCategoryMask: true,
    outputConfidenceMasks: false,
    runningMode: 'IMAGE',
  });
}

// ---------- Conversion résultat MediaPipe -> BinaryMask (testée, cf. demo()) ----------

import type { BinaryMask } from './capture-processing';
import { computePFSA_cm2 } from './capture-processing';

export function toBikeFitBinaryMask(result: SegmentationResult): BinaryMask {
  const indices = result.categoryMask.getAsUint8Array();
  const data = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    data[i] = indices[i] === CATEGORY_PERSON || indices[i] === CATEGORY_BICYCLE ? 1 : 0;
  }
  return { width: result.categoryMask.width, height: result.categoryMask.height, data };
}

// ---------- Calibration manuelle (2 taps sur la photo) ----------
// Pas d'auto-détection d'objet de référence en V1 (pas de modèle dédié, trop fragile
// à faire seul) : l'utilisateur pointe 2 points sur la photo correspondant à une
// longueur réelle connue (ex. largeur de cintre). Cf. §2B / §9 du spec.

export interface TapPoint {
  xPx: number;
  yPx: number;
}

export function pixelLengthFromTaps(a: TapPoint, b: TapPoint): number {
  return Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx);
}

// Sanity checks déplacés dans segmentation-integration.test.ts (node:test).

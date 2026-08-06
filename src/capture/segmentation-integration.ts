// segmentation-integration.ts
// Intégration MediaPipe ImageSegmenter (Web) pour produire le BinaryMask
// attendu par computePFSA_cm2() (capture-processing.ts).
//
// HONNÊTETÉ SUR CE QUI EST VÉRIFIÉ ICI vs PAS :
// - L'API d'init (FilesetResolver, ImageSegmenter.createFromOptions, .segment())
//   est confirmée contre la doc officielle actuelle (Google AI Edge, consultée
//   le 06/08/2026) — donc correcte au niveau de la forme.
// - CE QUI N'EST PAS TESTÉ : cet environnement n'a ni navigateur ni accès réseau
//   pour télécharger le WASM/modèle .tflite. Impossible d'exécuter un vrai
//   segment() ici. La fonction createBikeFitSegmenter() est donc du code
//   "documenté mais pas exécuté" — à smoke-tester en vrai avant de la considérer fiable.
// - CE QUI EST TESTÉ (voir demo() en bas) : la logique de filtrage par classe
//   (toBikeFitBinaryMask), qui est pure et ne dépend d'aucun modèle réel.

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
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

// ---------- Types minimaux (le package officiel a ses propres types, plus riches) ----------

export interface MPCategoryMaskResult {
  width: number;
  height: number;
  // MediaPipe expose l'accès aux données du masque via une méthode sur l'objet
  // MPMask (ex. getAsUint8Array() dans les versions récentes). On isole cette
  // lecture dans une seule fonction pour n'avoir qu'un endroit à corriger si
  // l'accesseur exact a changé au moment de l'implémentation réelle.
  readCategoryIndices: () => Uint8Array;
}

export interface SegmentationResult {
  categoryMask: MPCategoryMaskResult;
}

// ---------- Initialisation — NON EXÉCUTÉ ICI, forme vérifiée contre la doc uniquement ----------

export async function createBikeFitSegmenter(visionFileset: unknown) {
  // Squelette conforme à la doc officielle Google AI Edge (Image Segmenter, web) :
  //   const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  //   const imageSegmenter = await ImageSegmenter.createFromOptions(vision, {...});
  // `visionFileset` = le résultat de FilesetResolver.forVisionTasks(), à obtenir
  // côté app (ce fichier ne dépend pas directement du package pour rester testable
  // sans lui). Import réel à faire dans l'app :
  //   import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
  const { ImageSegmenter } = (globalThis as any).__mediapipeTasksVision__ ?? {};
  if (!ImageSegmenter) {
    throw new Error(
      "createBikeFitSegmenter: package @mediapipe/tasks-vision non injecté — ce chemin n'a pas pu être testé dans ce sandbox (pas de réseau/navigateur)."
    );
  }
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
  const indices = result.categoryMask.readCategoryIndices();
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

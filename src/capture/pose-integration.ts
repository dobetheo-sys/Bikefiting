// pose-integration.ts
// Intégration MediaPipe PoseLandmarker (Web) pour produire les PoseFrame[] attendus
// par extractTrialAngles() (capture-processing.ts) — tâche 3 du handoff : alimenter
// le pipeline d'angles avec un vrai modèle plutôt que des landmarks synthétiques.
//
// Suit le même pattern que segmentation-integration.ts : fileset WASM injecté par
// l'appelant (getVisionFileset(), mediapipe-vision.ts), ce fichier ne fait que
// configurer le modèle et convertir son résultat.
//
// CE QUI RESTE À VÉRIFIER SUR UN VRAI APPAREIL : que detectForVideo() sur une vraie
// vidéo profil de cycliste produit des landmarks hanche/genou/cheville avec une
// visibilité exploitable (pas juste "ça ne crash pas") — pas testable dans ce sandbox
// (pas de caméra ni de vraie vidéo d'entraînement).
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from './capture-processing';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

export async function createBikeFitPoseLandmarker(
  visionFileset: Awaited<ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>>
) {
  return PoseLandmarker.createFromOptions(visionFileset, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

// ---------- Conversion résultat MediaPipe -> PoseFrame (pure, testée) ----------

export interface MPPoseLandmarkerResult {
  landmarks: Landmark[][]; // un tableau de landmarks par pose détectée
}

export function toPoseFrame(result: MPPoseLandmarkerResult, timestampMs: number): PoseFrame | null {
  const landmarks = result.landmarks[0];
  if (!landmarks || landmarks.length === 0) return null;
  return { landmarks, timestampMs };
}

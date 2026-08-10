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

// Retour terrain (08/08/2026) : sur une vraie vidéo ASLR (allongé, caméra au sol très
// proche), le modèle "lite" ne détectait une pose sur QUE 14/40 frames échantillonnées, et
// une seule d'entre elles avait un genou droit détecté — pas assez pour mesurer quoi que ce
// soit de fiable, indépendamment de la logique de extractAslrAngle (déjà durcie par
// ailleurs). Passage à "full" (9.4 Mo contre 5.8 Mo pour "lite" — pas "heavy", 30.7 Mo,
// trop lourd vu les connexions lentes observées) : meilleure précision de détection,
// coût raisonnable vu que le modèle est mis en cache par le navigateur après le premier
// chargement (cache-control: max-age=3600 côté storage.googleapis.com).
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

export async function createBikeFitPoseLandmarker(
  visionFileset: Awaited<ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>>
) {
  return PoseLandmarker.createFromOptions(visionFileset, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: 'VIDEO',
    numPoses: 1,
    // Retour terrain (10/08/2026) : sur une vraie vidéo ASLR filmée correctement (même pièce,
    // pas de contre-jour, cadrage correct) mais avec le sujet à distance relativement grande
    // dans le cadre (contrainte d'espace réelle — reculer davantage sort du cadre en mode
    // portrait), la détection restait quasi nulle avec les seuils de confiance par défaut de
    // MediaPipe (0.5). Le cas d'usage ici (vue au sol, sujet allongé, souvent assez petit dans
    // l'image) est en dehors du cas standard "personne debout, cadrée serrée" sur lequel ces
    // seuils par défaut sont calibrés — on les abaisse pour ce mode d'usage précis. Le risque
    // (landmarks plus bruités sur certaines frames) est acceptable ici : extractAslrAngle ne
    // retient que le max de la cuisse tant que le genou reste verrouillé sur plusieurs frames
    // consécutives (ENGAGE_STREAK_FRAMES), donc un faux positif isolé n'engage pas la mesure.
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
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

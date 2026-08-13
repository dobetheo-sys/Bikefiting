// swim-pose-integration.ts
// Intégration MediaPipe PoseLandmarker (Web) pour produire les PoseFrame[] attendus par
// swim-capture-processing.ts. Même pattern que src/capture/pose-integration.ts côté vélo
// (fileset injecté par l'appelant, cf. mediapipe-vision.ts), aucun import croisé.
//
// CE QUI RESTE À VÉRIFIER SUR UN VRAI APPAREIL (audit professionnels, point 7, bloquant) :
// que detectForVideo() sur une vraie vidéo de nage (caméra fixe au bord du bassin, nageur qui
// traverse le champ, cf. §1 du spec) produit des landmarks poignet/épaule/nez exploitables. Ce
// sandbox a la même limite documentée que côté vélo (proxy réseau qui bloque le téléchargement
// du modèle .task depuis storage.googleapis.com, cf. HANDOFF_CLAUDE_CODE.md) — pas testable ici,
// et le cas d'usage nage est probablement encore plus exigeant pour le modèle que le vélo
// (mouvement rapide, corps partiellement immergé, entrée/sortie de champ) : s'attendre à devoir
// ajuster ces réglages après un premier retour terrain, pas les considérer comme acquis.
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from './swim-capture-processing';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

export async function createSwimPoseLandmarker(
  visionFileset: Awaited<ReturnType<typeof import('@mediapipe/tasks-vision').FilesetResolver.forVisionTasks>>
) {
  return PoseLandmarker.createFromOptions(visionFileset, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: 'VIDEO',
    numPoses: 1,
    // [DEFAULT] Seuils abaissés par anticipation (même logique que côté vélo pour l'ASLR,
    // cas hors du standard "personne debout cadrée serrée") plutôt qu'après un premier échec
    // terrain — la nage cumule plusieurs facteurs qui dégradent la confiance par défaut de
    // MediaPipe (0.5) : reflets de surface, éclaboussures, corps partiellement immergé,
    // mouvement rapide en fin de longueur. À resserrer si ça s'avère trop permissif une fois
    // testé (faux positifs), pas à considérer comme validé avant ce test.
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

// capture-processing.ts
// Transforme les captures brutes (landmarks MediaPipe Pose, masque de silhouette)
// en objets consommables par posture-aero-engine.ts (TrialAngles, pFSA_cm2).
//
// LIMITE CONNUE ET IMPORTANTE (à ne pas survoler) :
// MediaPipe Pose (33 points, BlazePose) ne fournit qu'UN point poignet (WRIST),
// pas les landmarks de doigts/main. La déviation ulnaire réelle (rotation du
// poignet dans le plan de la main) ne peut donc PAS être calculée depuis Pose seul.
// Il faudrait un second modèle (MediaPipe Hands) pointé sur la zone poignet/cocotte,
// ce qui n'est pas câblé ici. Cohérent avec le fait que ce paramètre est déjà
// [DEFAULT / non sourcé] côté moteur (§10 du spec) — on ne fait pas semblant de le
// mesurer précisément tant que ce second modèle n'est pas intégré.

import type { AngleStats, TrialAngles } from '../engine/posture-aero-engine';

// ---------- Angles depuis landmarks MediaPipe Pose ----------

export interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface PoseFrame {
  landmarks: Landmark[]; // index standard MediaPipe Pose, 0-32
  timestampMs: number;
}

export const IDX = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

function angleAt(a: Landmark, vertex: Landmark, b: Landmark): number {
  // Angle interne au sommet "vertex", entre vertex->a et vertex->b (degrés)
  const v1 = { x: a.x - vertex.x, y: a.y - vertex.y };
  const v2 = { x: b.x - vertex.x, y: b.y - vertex.y };
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function angleVsHorizontal(from: Landmark, to: Landmark): number {
  // Angle aigu entre le segment from->to et l'horizontale, indépendant du sens (avant/arrière).
  // BUG CORRIGÉ : la version initiale (atan2(-dy, dx) puis abs()) donnait ~180°-x au lieu de x
  // quand le segment pointe vers l'arrière (dx négatif, cas normal pour un buste penché en avant
  // filmé de profil). On prend les valeurs absolues des deux composantes avant atan2.
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function pickSide(frames: PoseFrame[]): 'LEFT' | 'RIGHT' {
  // Vue de profil : un seul côté est fiable (l'autre est partiellement masqué par le cadre/vélo).
  // On choisit le côté à la visibilité moyenne la plus haute plutôt que de supposer un côté fixe.
  let leftVis = 0;
  let rightVis = 0;
  for (const f of frames) {
    leftVis += f.landmarks[IDX.LEFT_HIP]?.visibility ?? 0;
    rightVis += f.landmarks[IDX.RIGHT_HIP]?.visibility ?? 0;
  }
  return rightVis >= leftVis ? 'RIGHT' : 'LEFT';
}

function stats(values: number[]): AngleStats {
  const clean = values.filter((v) => !Number.isNaN(v));
  if (clean.length === 0) return { mean: NaN, min: NaN, max: NaN, amplitude: NaN, variance: NaN };
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length;
  return { mean: r1(mean), min: r1(min), max: r1(max), amplitude: r1(max - min), variance: r1(variance) };
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function extractTrialAngles(frames: PoseFrame[]): TrialAngles {
  if (frames.length === 0) throw new Error('extractTrialAngles: aucune frame fournie');
  const side = pickSide(frames);
  const S =
    side === 'RIGHT'
      ? { SHOULDER: IDX.RIGHT_SHOULDER, HIP: IDX.RIGHT_HIP, KNEE: IDX.RIGHT_KNEE, ANKLE: IDX.RIGHT_ANKLE, FOOT: IDX.RIGHT_FOOT_INDEX }
      : { SHOULDER: IDX.LEFT_SHOULDER, HIP: IDX.LEFT_HIP, KNEE: IDX.LEFT_KNEE, ANKLE: IDX.LEFT_ANKLE, FOOT: IDX.LEFT_FOOT_INDEX };

  const hip: number[] = [];
  const trunk: number[] = [];
  const knee: number[] = [];
  const ankle: number[] = [];

  for (const f of frames) {
    const lm = f.landmarks;
    hip.push(angleAt(lm[S.SHOULDER], lm[S.HIP], lm[S.KNEE]));
    trunk.push(angleVsHorizontal(lm[S.HIP], lm[S.SHOULDER]));
    knee.push(angleAt(lm[S.HIP], lm[S.KNEE], lm[S.ANKLE]));
    ankle.push(angleAt(lm[S.KNEE], lm[S.ANKLE], lm[S.FOOT]));
  }

  return {
    hip: stats(hip),
    trunk: stats(trunk),
    knee: stats(knee),
    ankle: stats(ankle),
    // Stub explicite tant que MediaPipe Hands n'est pas intégré — voir avertissement en tête de fichier.
    wrist: { mean: 0, min: 0, max: 0, amplitude: 0, variance: 0 },
  };
}

// ---------- §3.1 — Test ASLR (souplesse hanche) : angle cuisse au point d'arrêt ----------
// Protocole (spec §3.1) : allongé, jambe testée tendue (genou verrouillé), on la lève le plus
// haut possible sans plier le genou ; la mesure s'arrête au moment où le genou commence à plier.

const KNEE_STRAIGHT_THRESHOLD = 165; // sous ce seuil, le genou est considéré en train de plier -> fin de mesure

export function extractAslrAngle(frames: PoseFrame[]): number {
  if (frames.length === 0) throw new Error('extractAslrAngle: aucune frame fournie');
  const side = pickSide(frames);
  const S =
    side === 'RIGHT'
      ? { HIP: IDX.RIGHT_HIP, KNEE: IDX.RIGHT_KNEE, ANKLE: IDX.RIGHT_ANKLE }
      : { HIP: IDX.LEFT_HIP, KNEE: IDX.LEFT_KNEE, ANKLE: IDX.LEFT_ANKLE };

  let maxThighAngle = 0;
  for (const f of frames) {
    const lm = f.landmarks;
    const kneeAngle = angleAt(lm[S.HIP], lm[S.KNEE], lm[S.ANKLE]);
    if (Number.isNaN(kneeAngle) || kneeAngle < KNEE_STRAIGHT_THRESHOLD) break; // genou qui plie -> fin de la mesure valide
    const thighAngle = angleVsHorizontal(lm[S.HIP], lm[S.KNEE]);
    if (!Number.isNaN(thighAngle)) maxThighAngle = Math.max(maxThighAngle, thighAngle);
  }
  return r1(maxThighAngle);
}

// ---------- pFSA depuis un masque de silhouette calibré ----------

export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array; // 1 = pixel appartient à la silhouette (cycliste + vélo), 0 sinon
}

export interface CalibrationRef {
  pixelLength: number; // longueur mesurée en pixels sur la photo (ex: largeur de cintre)
  realLengthCm: number; // longueur réelle connue correspondante
}

export function computePFSA_cm2(mask: BinaryMask, calibration: CalibrationRef): number {
  if (calibration.pixelLength <= 0) throw new Error('computePFSA_cm2: calibration.pixelLength doit être > 0');
  const cmPerPixel = calibration.realLengthCm / calibration.pixelLength;
  const cm2PerPixel = cmPerPixel * cmPerPixel;
  let count = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) count++;
  return r1(count * cm2PerPixel);
}

// Sanity checks déplacés dans capture-processing.test.ts (node:test).

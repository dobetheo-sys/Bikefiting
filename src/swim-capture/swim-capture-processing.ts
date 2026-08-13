// swim-capture-processing.ts
// Transforme des frames de pose brutes (MediaPipe Pose, capture au-dessus de l'eau, §0/§2 de
// SPEC_ANALYSE_NAGE_MOTEUR.md) en LengthMeasurement consommable par swim-analysis-engine.ts.
//
// Portée strictement V0 : caméra fixe hors de l'eau, nageur qui traverse le champ. Rien ici
// ne suppose une caméra immergée (cf. SPEC_MODULE_SOUS_MARIN.md, module séparé, pas encore
// codé). Type Landmark/PoseFrame redéfinis ici volontairement (même forme que
// src/capture/capture-processing.ts côté vélo, standard MediaPipe Pose 33 points) — aucun
// import croisé entre les deux moteurs, cf. §8 du spec nage.
//
// AVERTISSEMENT — RIEN CI-DESSOUS N'EST VALIDÉ SUR VRAIE VIDÉO (audit professionnels,
// point 7, toujours bloquant). Tous les seuils sont des [DEFAULT] de départ. Le projet vélo
// a eu 3 bugs réels coup sur coup sur exactement ce type de logique de détection sur vraie
// vidéo (seek cassé, règle d'arrêt mal armée, modèle trop faible — cf.
// HANDOFF_CLAUDE_CODE.md) avant d'être fiable : s'attendre au même ici, ne pas présenter ces
// seuils comme acquis avant un premier test piscine réel.

import type { BreathingSide, LengthMeasurement, VisionSignal } from '../swim-engine/swim-analysis-engine';

// ---------- Types ----------

export interface Landmark {
  x: number;
  y: number; // normalisé [0,1], 0 = haut de l'image (donc "hors de l'eau" = y plus petit)
  z?: number;
  visibility?: number;
}

export interface PoseFrame {
  landmarks: Landmark[]; // index standard MediaPipe Pose, 0-32
  timestampMs: number;
}

export const IDX = {
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
};

// [DEFAULT] En dessous, un landmark est considéré non fiable (probablement immergé/occlus)
// — MediaPipe baisse la visibilité sur ce qu'il ne voit pas franchement, mais aucun seuil
// précis n'est sourcé pour ce cas d'usage précis (nage, caméra au ras de l'eau).
const VISIBILITY_THRESHOLD = 0.5;

// [DEFAULT] Sépare deux pics détectés sur la même main pour ne pas compter deux fois le même
// recovery à cause d'un bruit de détection frame à frame.
const MIN_PEAK_SEPARATION_MS = 300;

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- Détection de cycles de bras (couche 1 — comptage, cf. §3 du spec) ----------
// Un "recovery" = le poignet atteint son point le plus haut (y minimal en coordonnées image)
// pendant qu'il est visible (donc hors de l'eau). Convention retenue : chaque entrée de bras
// (gauche ET droite) compte comme 1 "stroke" — cohérent avec la convention la plus répandue
// chez les trackers de nage grand public, mais [DEFAULT] non vérifiée avec un entraîneur
// (audit professionnels, point 1) : certains comptent plutôt en "cycles" (1 cycle = 2 bras).
// À confirmer avant de présenter un strokeCount comme directement comparable à un comptage
// manuel fait par un nageur/entraîneur habitué à l'autre convention.

export interface StrokeEvent {
  side: 'LEFT' | 'RIGHT';
  timestampMs: number;
  frameIndex: number;
}

function detectArmRecoveries(frames: PoseFrame[], wristIdx: number, side: 'LEFT' | 'RIGHT'): StrokeEvent[] {
  const events: StrokeEvent[] = [];
  let lastEventMs = -Infinity;

  for (let i = 1; i < frames.length - 1; i++) {
    const prev = frames[i - 1].landmarks[wristIdx];
    const cur = frames[i].landmarks[wristIdx];
    const next = frames[i + 1].landmarks[wristIdx];
    if (!prev || !cur || !next) continue;
    if ((cur.visibility ?? 0) < VISIBILITY_THRESHOLD) continue;

    // Minimum local de y = point le plus haut de la trajectoire du poignet sur ces 3 frames
    const isLocalPeak = cur.y < prev.y && cur.y <= next.y;
    if (!isLocalPeak) continue;

    const ts = frames[i].timestampMs;
    if (ts - lastEventMs < MIN_PEAK_SEPARATION_MS) continue;

    events.push({ side, timestampMs: ts, frameIndex: i });
    lastEventMs = ts;
  }

  return events;
}

export function detectStrokeEvents(frames: PoseFrame[]): StrokeEvent[] {
  if (frames.length < 3) return [];
  const left = detectArmRecoveries(frames, IDX.LEFT_WRIST, 'LEFT');
  const right = detectArmRecoveries(frames, IDX.RIGHT_WRIST, 'RIGHT');
  return [...left, ...right].sort((a, b) => a.timestampMs - b.timestampMs);
}

// ---------- Détection du côté de respiration (couche 1, cf. §3 du spec) ----------
// Un "breath" = le nez redevient franchement visible (tête sortie/tournée hors de l'eau)
// après une phase où il ne l'était pas. Le côté est déterminé par l'oreille la plus visible
// à cet instant (tête tournée vers ce côté pour respirer). [DEFAULT] heuristique de départ,
// pas de méthode publiée trouvée pour ce cas précis phone-only (cf. §9 du spec nage).

function detectBreathEvents(frames: PoseFrame[]): number[] {
  const indices: number[] = [];
  let wasVisible = false;
  for (let i = 0; i < frames.length; i++) {
    const nose = frames[i].landmarks[IDX.NOSE];
    const visible = (nose?.visibility ?? 0) >= VISIBILITY_THRESHOLD;
    if (visible && !wasVisible) indices.push(i);
    wasVisible = visible;
  }
  return indices;
}

export function detectBreathingSides(frames: PoseFrame[]): BreathingSide[] {
  return detectBreathEvents(frames)
    .map((i) => {
      const lm = frames[i].landmarks;
      const leftEarVis = lm[IDX.LEFT_EAR]?.visibility ?? 0;
      const rightEarVis = lm[IDX.RIGHT_EAR]?.visibility ?? 0;
      if (leftEarVis === rightEarVis) return null; // ambigu, pas assez d'écart pour trancher
      return leftEarVis > rightEarVis ? ('left' as const) : ('right' as const);
    })
    .filter((s): s is BreathingSide => s !== null);
}

// ---------- Roulis proxy (couche 2, confiance faible — cf. §4 du spec) ----------
// Angle de la ligne épaules vs horizontale, mesuré aux instants de recovery détectés (seuls
// instants où les deux épaules peuvent être visibles hors de l'eau, cf. §4 du spec).

function angleVsHorizontal(from: Landmark, to: Landmark): number {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

export function computeRollProxy(frames: PoseFrame[]): VisionSignal<number> | null {
  const events = detectStrokeEvents(frames);
  const angles: number[] = [];
  for (const e of events) {
    const lm = frames[e.frameIndex].landmarks;
    const l = lm[IDX.LEFT_SHOULDER];
    const r = lm[IDX.RIGHT_SHOULDER];
    if (!l || !r) continue;
    if ((l.visibility ?? 0) < VISIBILITY_THRESHOLD || (r.visibility ?? 0) < VISIBILITY_THRESHOLD) continue;
    angles.push(angleVsHorizontal(l, r));
  }
  if (angles.length === 0) return null;
  const avg = angles.reduce((a, b) => a + b, 0) / angles.length;
  return { value: r1(avg), confidence: 'faible' }; // cf. §4 du spec, table de confiance
}

// ---------- Indice de battement (couche 2, confiance faible — cf. §4 du spec) ----------
// Ne dépend pas des landmarks de pose (le battement est majoritairement immergé, cf. §0 du
// spec) mais d'une mesure de perturbation de surface en aval (ex. optical flow entre frames
// dans la zone derrière le nageur). Cette extraction vidéo brute n'est pas câblée ici (stub
// explicite, comme headOffset_cm côté vélo avant son câblage) — cette fonction n'agrège que
// des échantillons déjà calculés ailleurs (future intégration navigateur, canvas/optical
// flow, hors scope de ce fichier qui reste testable sans navigateur).

export function computeKickIndex(motionSamples: number[]): VisionSignal<number> {
  if (motionSamples.length === 0) throw new Error('computeKickIndex: aucun échantillon fourni');
  const avg = motionSamples.reduce((a, b) => a + b, 0) / motionSamples.length;
  return { value: r1(avg), confidence: 'faible' };
}

// ---------- Assemblage d'une longueur (LengthMeasurement complet) ----------

export function buildLengthMeasurement(id: string, frames: PoseFrame[], motionSamples?: number[]): LengthMeasurement {
  if (frames.length < 2) throw new Error('buildLengthMeasurement: au moins 2 frames requises');
  const durationS = (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / 1000;
  if (durationS <= 0) throw new Error('buildLengthMeasurement: timestamps non croissants sur la plage de frames');

  const events = detectStrokeEvents(frames);
  const strokeCount = events.length;
  if (strokeCount === 0) throw new Error('buildLengthMeasurement: aucun cycle de bras détecté sur ces frames');

  const measurement: LengthMeasurement = {
    id,
    durationS: r1(durationS),
    strokeCount,
    breathingSides: detectBreathingSides(frames),
  };
  const roll = computeRollProxy(frames);
  if (roll) measurement.rollProxyDeg = roll;
  if (motionSamples && motionSamples.length > 0) measurement.kickIndex = computeKickIndex(motionSamples);

  return measurement;
}

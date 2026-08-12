// running-capture-processing.ts
// Transforme les captures de course (taps utilisateur sur l'image d'attaque du pied, comptage
// d'appuis, landmarks MediaPipe) en `RunTrialMetrics` consommables par running-gait-engine.ts.
//
// POURQUOI LA MESURE MANUELLE EST LE CHEMIN PRINCIPAL ICI, ET PAS UN REPLI :
// côté vélo, la détection automatique MediaPipe a été tentée puis abandonnée après plusieurs
// échecs sur de vraies vidéos (cf. le bloc "Mesure manuelle" de capture-processing.ts, retours
// terrain des 08 et 10/08/2026 : un essai réel donnait un tronc à 43°, impossible sur un vélo).
// La course est un cas PLUS difficile, pas moins : la personne se déplace dans le cadre, les
// membres se croisent, et l'image utile dure quelques centièmes de seconde au moment précis où
// le pied touche. On part donc directement sur le protocole qui a fini par marcher — l'athlète
// choisit l'image d'attaque et tape les points — plutôt que de refaire le même détour.
//
// Ce que ça implique et qu'il ne faut pas se cacher : la précision dépend de la qualité du
// tapotage de l'utilisateur, et deux mesures du même essai ne donneront pas exactement le même
// chiffre. C'est pour ça que le moteur ne compare que des essais d'UNE session entre eux
// (scores relatifs) et n'exclut rien sur un critère biomécanique.

import {
  angleAt,
  r1,
  signedAngleVsHorizontal,
  signedAngleVsVertical,
  IDX,
  pickSide,
} from '../shared/geometry';
import type { Landmark, PoseFrame } from '../shared/geometry';
import type { RunTrialMetrics } from '../engine/running-gait-engine';

// ---------- Sens de course ----------

// Le moteur a besoin de distinguer "devant" de "derrière" (un tibia incliné vers l'avant à
// l'attaque est un marqueur d'overstriding ; le même angle vers l'arrière est une foulée
// normale). Sur tapis, le coureur peut être filmé de son côté gauche comme de son côté droit :
// on déduit donc le sens depuis l'orientation du pied plutôt que de le supposer, ou pire, de le
// demander à l'utilisateur (une question de plus à laquelle il peut répondre de travers).
//
// Retourne null quand talon et pointe sont exactement à la même abscisse : le sens est alors
// indéterminable, et c'est traité comme une mesure invalide plutôt que deviné (même parti pris
// que angleAt(), qui renvoie NaN sur deux points confondus).
export function forwardSignFromFoot(heel: Landmark, toe: Landmark): 1 | -1 | null {
  if (toe.x === heel.x) return null;
  return toe.x > heel.x ? 1 : -1;
}

// ---------- Mesure sur l'image d'attaque du pied ----------

export interface RunContactTaps {
  shoulder: Landmark;
  hip: Landmark;
  knee: Landmark;
  ankle: Landmark;
  heel: Landmark;
  toe: Landmark;
}

export interface RunContactMeasurement {
  tibiaAngleDeg: number;
  kneeFlexionICDeg: number;
  trunkLeanDeg: number;
  overstrideRatio: number;
  footStrikeAngleDeg: number;
  legLengthPx: number;
  forwardSign: 1 | -1 | null;
}

const NAN_CONTACT: Omit<RunContactMeasurement, 'forwardSign'> = {
  tibiaAngleDeg: NaN,
  kneeFlexionICDeg: NaN,
  trunkLeanDeg: NaN,
  overstrideRatio: NaN,
  footStrikeAngleDeg: NaN,
  legLengthPx: NaN,
};

export function computeRunContact(taps: RunContactTaps): RunContactMeasurement {
  const { shoulder, hip, knee, ankle, heel, toe } = taps;
  const forwardSign = forwardSignFromFoot(heel, toe);
  if (forwardSign === null) return { ...NAN_CONTACT, forwardSign };

  // Longueur de jambe en pixels par somme des segments (hanche->genou + genou->cheville) plutôt
  // que par distance directe hanche->cheville : à l'attaque le genou est fléchi, donc la
  // distance directe sous-estime la vraie longueur de jambe — et elle la sous-estime d'autant
  // plus que le genou est fléchi, ce qui introduirait un biais corrélé à la mesure même qu'on
  // cherche à normaliser.
  const legLengthPx = r1(Math.hypot(knee.x - hip.x, knee.y - hip.y) + Math.hypot(ankle.x - knee.x, ankle.y - knee.y));
  if (legLengthPx === 0) return { ...NAN_CONTACT, forwardSign };

  const internalKnee = angleAt(hip, knee, ankle);

  return {
    tibiaAngleDeg: r1(signedAngleVsVertical(knee, ankle, forwardSign)),
    // Exprimé en FLEXION (0 = jambe tendue) et non en angle interne comme côté vélo : c'est la
    // convention de la littérature course ("knee flexion at initial contact ~10-20°"), et s'en
    // écarter obligerait à traduire mentalement chaque valeur lue dans une étude.
    kneeFlexionICDeg: Number.isNaN(internalKnee) ? NaN : r1(180 - internalKnee),
    trunkLeanDeg: r1(signedAngleVsVertical(hip, shoulder, forwardSign)),
    overstrideRatio: r1((forwardSign * (ankle.x - hip.x)) / legLengthPx * 100) / 100,
    footStrikeAngleDeg: r1(signedAngleVsHorizontal(heel, toe, forwardSign)),
    legLengthPx,
    forwardSign,
  };
}

// ---------- Agrégation sur plusieurs appuis ----------

// Médiane composante par composante de plusieurs mesures d'attaque, ajoutée après audit
// (docs/AUDIT_MOTEUR_COURSE.md §2.12). La V1 retenait UN seul appui par essai, ce qui n'est pas
// défendable :
//   - Riazati 2019 : il faut 12 à 19 foulées pour obtenir des cinématiques sagittales stables.
//   - Damsted 2015, en vidéo 2D avec points placés à la main (exactement cette méthode) :
//     erreur type intra-opérateur jusqu'à 1.6°, intervalles de prédiction à 95% de 3-8° au genou
//     et 3-7° à la hanche en intra-jour, 9-14° en inter-jour.
// Autrement dit l'incertitude d'une mesure unique était du même ordre que l'écart-type de toute
// la population (4.4° pour l'angle du tibia) : impossible de distinguer un coureur à 6° d'un
// coureur à 12°.
//
// Médiane et non moyenne : un appui mal tapé (point posé sur le short au lieu du grand
// trochanter) produit une valeur très éloignée, que la moyenne intègre et que la médiane ignore.
//
// Ce que ça NE corrige PAS, et qu'il ne faut pas laisser croire : moyenner réduit le bruit
// aléatoire, pas l'erreur systématique de projection 2D (caméra non perpendiculaire au tapis).
// D'où RUN_MEASUREMENT_RESOLUTION_DEG ci-dessous.
export const RUN_MEASUREMENT_RESOLUTION_DEG = 3;

function median(values: number[]): number {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) return NaN;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export function medianRunContact(contacts: RunContactMeasurement[]): RunContactMeasurement {
  if (contacts.length === 0) throw new Error('medianRunContact: aucun appui fourni');

  // Le sens de course est catégoriel, pas numérique : on prend la majorité plutôt qu'une
  // médiane. Un désaccord entre appuis signale que talon/pointe ont été inversés sur au moins
  // une image — la majorité récupère le cas, et les appuis minoritaires ressortiront de toute
  // façon comme des valeurs aberrantes que la médiane écarte.
  const forward = contacts.map((c) => c.forwardSign).filter((s): s is 1 | -1 => s === 1 || s === -1);
  const positives = forward.filter((s) => s === 1).length;
  const forwardSign: 1 | -1 | null =
    forward.length === 0 ? null : positives * 2 === forward.length ? null : positives > forward.length / 2 ? 1 : -1;

  return {
    tibiaAngleDeg: r1(median(contacts.map((c) => c.tibiaAngleDeg))),
    kneeFlexionICDeg: r1(median(contacts.map((c) => c.kneeFlexionICDeg))),
    trunkLeanDeg: r1(median(contacts.map((c) => c.trunkLeanDeg))),
    overstrideRatio: r1(median(contacts.map((c) => c.overstrideRatio)) * 1000) / 1000,
    footStrikeAngleDeg: r1(median(contacts.map((c) => c.footStrikeAngleDeg))),
    legLengthPx: r1(median(contacts.map((c) => c.legLengthPx))),
    forwardSign,
  };
}

// ---------- Cadence ----------

// `stepCount` = nombre d'APPUIS (les deux pieds confondus), pas de foulées. C'est la source de
// confusion classique : une foulée = deux appuis, donc compter les foulées donne une cadence
// deux fois trop basse et fait basculer tout le scoring, qui est relatif à cette valeur.
export function computeCadenceSpm(stepCount: number, durationS: number): number {
  if (durationS <= 0) throw new Error('computeCadenceSpm: la durée doit être > 0');
  if (stepCount < 0) throw new Error('computeCadenceSpm: le nombre d\'appuis ne peut pas être négatif');
  return r1((stepCount / durationS) * 60);
}

// ---------- Oscillation verticale ----------

// Rapport sans dimension (amplitude verticale de la hanche / longueur de jambe) plutôt qu'une
// valeur en cm : ça évite complètement l'étape de calibration cm/px, qui est la source d'erreur
// qui a le plus coûté côté vélo (cf. CalibrationRef dans capture-processing.ts, pFSA mesurée à
// 2.9 cm² au lieu de quelques milliers). Le score d'économie ne compare de toute façon que les
// essais d'une même session entre eux, où la longueur de jambe est constante.
export function computeVerticalOscillationRatio(
  hipAtLowest: Landmark,
  hipAtHighest: Landmark,
  legLengthPx: number
): number {
  if (legLengthPx <= 0) throw new Error('computeVerticalOscillationRatio: legLengthPx doit être > 0');
  return r1((Math.abs(hipAtLowest.y - hipAtHighest.y) / legLengthPx) * 1000) / 1000;
}

// ---------- Cadence automatique depuis les landmarks (optionnel) ----------

// Contrairement aux angles, la cadence est la métrique qui se prête le MIEUX à l'automatisation :
// elle ne dépend pas de la précision d'un point, seulement du rythme d'oscillation verticale du
// bassin. Un landmark de hanche bruité de quelques pixels ne change pas le nombre d'oscillations
// comptées.
//
// Contrainte d'échantillonnage (Nyquist), à ne pas ignorer : à 180 pas/min, la hanche oscille à
// 3 Hz. Il faut donc largement plus de 6 échantillons/s pour ne pas replier le signal et
// sous-compter les appuis. sampleVideoFrames() (video-frame-sampler.ts) prend un nombre fixe
// d'échantillons sur toute la durée — une vidéo de 15 s à 60 échantillons donne 4 Hz, ce qui est
// INSUFFISANT et produirait une cadence fausse sans que rien ne le signale. D'où le drapeau
// `reliable` renvoyé ici plutôt qu'un chiffre livré sans réserve.
export const MIN_SAMPLE_RATE_HZ = 8; // [DEFAULT] marge au-dessus des 6 Hz théoriques

export interface CadenceEstimate {
  cadenceSpm: number;
  sampleRateHz: number;
  cyclesDetected: number;
  reliable: boolean;
  reason?: string;
}

// [DEFAULT] Non validé sur un vrai appareil (le sandbox de dev ne peut pas charger les modèles
// MediaPipe, cf. README "Limite d'environnement"). À confronter au comptage manuel sur les
// premiers essais réels avant de s'en servir sans le vérifier.
export function estimateCadenceFromFrames(frames: PoseFrame[]): CadenceEstimate {
  const empty: CadenceEstimate = { cadenceSpm: NaN, sampleRateHz: NaN, cyclesDetected: 0, reliable: false };
  if (frames.length < 2) return { ...empty, reason: 'moins de 2 frames' };

  const durationS = (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / 1000;
  if (durationS <= 0) return { ...empty, reason: 'durée non exploitable (timestamps identiques)' };
  const sampleRateHz = r1((frames.length - 1) / durationS);

  const side = pickSide(frames);
  const hipIdx = side === 'RIGHT' ? IDX.RIGHT_HIP : IDX.LEFT_HIP;
  const samples = frames
    .map((f) => ({ y: f.landmarks[hipIdx]?.y, t: f.timestampMs }))
    .filter((s): s is { y: number; t: number } => Number.isFinite(s.y));
  if (samples.length < frames.length / 2) {
    return { ...empty, sampleRateHz, reason: 'hanche détectée sur moins de la moitié des frames' };
  }

  const ys = samples.map((s) => s.y);
  const max = Math.max(...ys);
  const min = Math.min(...ys);
  const amplitude = max - min;
  if (amplitude === 0) return { ...empty, sampleRateHz, reason: 'aucune oscillation verticale détectée' };

  // Comptage par franchissement avec hystérésis plutôt que détection de maxima locaux : un
  // maximum local se déclenche sur le moindre pixel de bruit, alors qu'il faut ici traverser
  // toute une bande morte pour compter un cycle. Un cycle d'oscillation du bassin = un appui.
  const mid = (max + min) / 2;
  const band = amplitude * 0.15; // [DEFAULT] largeur de la bande morte
  let state: 'low' | 'high' | 'unknown' = 'unknown';
  const crossingsMs: number[] = [];
  for (const s of samples) {
    if (s.y > mid + band) {
      if (state === 'low') crossingsMs.push(s.t);
      state = 'high';
    } else if (s.y < mid - band) {
      state = 'low';
    }
  }

  // On mesure la cadence entre le PREMIER et le DERNIER franchissement, pas sur la durée totale
  // de la vidéo.
  //
  // Première version (fausse, corrigée ici) : `cycles / durée totale`. Elle comptait les cycles
  // entiers mais les rapportait à une durée qui inclut deux fragments de cycle inexploitables,
  // un à chaque bout — la vidéo ne commence ni ne finit pile sur un franchissement. Sur un
  // signal de test à 180 pas/min exactement, elle renvoyait 165 : 8% d'erreur. C'est
  // disqualifiant ici, parce que tout le moteur raisonne sur des écarts de cadence de 5 à 10% —
  // une erreur de mesure plus grande que l'effet mesuré aurait rendu le balayage ininterprétable
  // tout en ayant l'air de fonctionner.
  //
  // Entre le premier et le dernier franchissement, il s'est écoulé exactement
  // (nombre de franchissements - 1) cycles complets : plus aucun fragment, et la seule erreur
  // résiduelle est la quantification des deux instants de franchissement au pas
  // d'échantillonnage.
  const crossings = crossingsMs.length;
  if (crossings < 2) {
    return { ...empty, sampleRateHz, reason: 'moins de 2 franchissements détectés — filme plus longtemps' };
  }
  const spanS = (crossingsMs[crossings - 1] - crossingsMs[0]) / 1000;
  if (spanS <= 0) return { ...empty, sampleRateHz, reason: 'durée entre franchissements non exploitable' };

  const cyclesDetected = crossings - 1;
  const cadenceSpm = r1((cyclesDetected / spanS) * 60);
  const reliable = sampleRateHz >= MIN_SAMPLE_RATE_HZ && cyclesDetected >= 3;
  return {
    cadenceSpm,
    sampleRateHz,
    cyclesDetected,
    reliable,
    reason: reliable
      ? undefined
      : sampleRateHz < MIN_SAMPLE_RATE_HZ
        ? `échantillonnage trop lâche (${sampleRateHz} Hz < ${MIN_SAMPLE_RATE_HZ} Hz) — augmente le nombre d'images analysées ou raccourcis la vidéo`
        : `seulement ${cyclesDetected} cycle(s) complet(s) mesuré(s) — filme plus longtemps`,
  };
}

// ---------- Assemblage ----------

export function buildRunTrialMetrics(
  contact: RunContactMeasurement,
  cadenceSpm: number,
  verticalOscillationRatio?: number
): RunTrialMetrics {
  return {
    cadenceSpm,
    tibiaAngleDeg: contact.tibiaAngleDeg,
    kneeFlexionICDeg: contact.kneeFlexionICDeg,
    trunkLeanDeg: contact.trunkLeanDeg,
    overstrideRatio: contact.overstrideRatio,
    verticalOscillationRatio,
    footStrikeAngleDeg: contact.footStrikeAngleDeg,
  };
}

// Repère purement descriptif, jamais utilisé pour scorer ni valider (cf. RunTrialMetrics
// .footStrikeAngleDeg) : la littérature ne converge pas sur un type d'attaque supérieur aux
// autres, donc en faire un critère serait inventer une norme. Affiché pour que l'athlète sache
// ce qu'il fait, pas pour lui dire que c'est bien ou mal.
//
// [SOURCED] Bornes d'Altman & Davis 2012 (Gait Posture) — méthode cinématique de classification
// du type d'attaque : talon > 8°, medio-pied entre -1.6° et 8°, avant-pied < -1.6°.
// Corrigé après audit (docs/AUDIT_MOTEUR_COURSE.md §2.5) : la V1 utilisait des bornes
// symétriques à ±5°, inventées. Elles annonçaient "talon" entre 5 et 8° (en réalité medio-pied)
// et "medio-pied" entre -5 et -1.6° (en réalité avant-pied). Les vraies bornes ne sont pas
// symétriques — une attaque talon typique se situe à 20.4 ± 4.8° (Breine 2017), la zone
// medio-pied est donc décalée vers le positif, pas centrée sur zéro.
//
// Limite à connaître : l'angle d'attaque dépend fortement de la vitesse (Breine 2014, 2019) —
// ces bornes sont établies autour de 3.2 m/s et ne sont pas qualifiées par l'allure ici.
const FOOT_STRIKE_REARFOOT_MIN_DEG = 8;
const FOOT_STRIKE_FOREFOOT_MAX_DEG = -1.6;

export function describeFootStrike(footStrikeAngleDeg: number): 'talon' | 'medio-pied' | 'avant-pied' | 'indéterminé' {
  if (!Number.isFinite(footStrikeAngleDeg)) return 'indéterminé';
  if (footStrikeAngleDeg > FOOT_STRIKE_REARFOOT_MIN_DEG) return 'talon';
  if (footStrikeAngleDeg < FOOT_STRIKE_FOREFOOT_MAX_DEG) return 'avant-pied';
  return 'medio-pied';
}

// posture-aero-engine.ts
// Moteur de scoring posture aéro (prolongateurs) — V1
// Implémente SPEC_POSTURE_AERO_MOTEUR.md
//
// Statut des constantes (voir §9 du spec, table de confiance) :
//   [SOURCED]  = valeur vérifiée en littérature / pratique pro (citée dans le spec)
//   [DEFAULT]  = hypothèse d'ingénierie, pas de source chiffrée trouvée — à calibrer par le feedback

// ---------- Types ----------

export interface AngleStats {
  mean: number;
  min: number;
  max: number;
  amplitude: number;
  variance: number;
}

export interface TrialAngles {
  hip: AngleStats;   // torse-hanche-cuisse, degrés, mesuré au PMH
  trunk: AngleStats; // torse / horizontale, degrés
  knee: AngleStats;  // angle interne hanche-genou-cheville, au PMB
  ankle: AngleStats; // amplitude cheville sur le cycle
  wrist: AngleStats; // déviation ulnaire, degrés
}

export interface AthleteProfile {
  hipFlexibilityScore: 1 | 2 | 3 | 4 | 5; // via ASLR, cf. aslrToFlexScore()
  raceDurationHours?: number;
}

export interface FrontalCapture {
  pFSA_cm2: number;      // surface frontale projetée, mesurée sur la photo calibrée (§2B)
  athleteHeight_cm: number;
  headOffset_cm: number; // tête au-dessus de la ligne d'épaules, 0 = neutre
}

export interface Trial {
  id: string;
  angles: TrialAngles;
  frontal: FrontalCapture;
  // saddleSetbackMm/hasAeroBars optionnels : ajoutés après coup (retour terrain), optionnels
  // pour ne pas casser les Trial déjà persistés en localStorage avant l'ajout des champs.
  // saddleSetbackMm : le recul de selle manquait alors qu'il conditionne directement l'angle
  // hanche/genou à un trunk angle donné (retour d'audit bikefitting). hasAeroBars : purement
  // informatif (affiché, pas utilisé par le moteur) — le vélo a-t-il des prolongateurs pour cet
  // essai, ça change beaucoup l'aérodynamisme et la position des mains.
  deltas: { saddleHeightMm: number; saddleSetbackMm?: number; reachMm: number; dropMm: number; hasAeroBars?: boolean };
}

export interface Violation {
  param: string;
  value: number;
  bound: number;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  warnings: Violation[];
  margins: Record<string, number>;
}

export interface ScoredTrial extends Trial {
  validation: ValidationResult;
  comfortScore: number;
  aeroScore: number;
}

export interface SubjectiveWeights {
  neck: number;
  lowerBack: number;
  hands: number;
  knees: number;
} // multiplicateur, 1.0 = neutre

// ---------- §3.1 — ASLR -> score de souplesse ----------
// Ancrage clinique : seuil de tightness ischio-jambiers = 80° (littérature SLR test)

export function aslrToFlexScore(angleDeg: number): 1 | 2 | 3 | 4 | 5 {
  if (angleDeg < 60) return 1;
  if (angleDeg < 70) return 2;
  if (angleDeg < 80) return 3;
  if (angleDeg < 90) return 4;
  return 5;
}

// ---------- §3 — Contraintes dures ----------

const HIP_FLOOR_ABS = 40; // [SOURCED] Retül/BikeFittr — sous 40°, perte de puissance 5-15% chez la majorité
const HIP_TARGET_BY_FLEX: Record<number, number> = { 1: 50, 2: 48, 3: 46, 4: 43, 5: 40 }; // [SOURCED, indicatif] cible, jamais sous le plancher
const TRUNK_MIN = 5;
const TRUNK_MAX = 15; // [convergence de sources pro]
const KNEE_MIN = 137;
const KNEE_MAX = 150; // [convergence de sources pro] angle interne hanche-genou-cheville
const ANKLE_FLAG = 22; // [SOURCED] typique 15-20° (BikeDynamics), flag au-delà — jamais exclusoire
const WRIST_WARN = 15; // [DEFAULT] non sourcé — warning uniquement, jamais exclusoire (cf. §10 du spec)

export function validateTrial(angles: TrialAngles, profile: AthleteProfile): ValidationResult {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  const margins: Record<string, number> = {};

  // Hanche : plancher absolu, indépendant de la souplesse déclarée
  if (angles.hip.mean < HIP_FLOOR_ABS) {
    violations.push({ param: 'hip_floor', value: angles.hip.mean, bound: HIP_FLOOR_ABS });
  }
  margins.hip_deg = round1(angles.hip.mean - HIP_FLOOR_ABS);

  // Tronc
  if (angles.trunk.mean < TRUNK_MIN) {
    violations.push({ param: 'trunk_min', value: angles.trunk.mean, bound: TRUNK_MIN });
  }
  if (angles.trunk.mean > TRUNK_MAX) {
    violations.push({ param: 'trunk_max', value: angles.trunk.mean, bound: TRUNK_MAX });
  }
  margins.trunk_deg = round1(Math.min(angles.trunk.mean - TRUNK_MIN, TRUNK_MAX - angles.trunk.mean));

  // Genou : doit rester dans la plage sur tout le cycle (min/max), pas juste en moyenne
  if (angles.knee.min < KNEE_MIN || angles.knee.max > KNEE_MAX) {
    violations.push({ param: 'knee_range', value: angles.knee.mean, bound: KNEE_MIN });
  }
  margins.knee_deg = round1(Math.min(angles.knee.min - KNEE_MIN, KNEE_MAX - angles.knee.max));

  // Ankling : jamais exclusoire, juste un flag qualité
  if (angles.ankle.amplitude > ANKLE_FLAG) {
    warnings.push({ param: 'ankle_unstable', value: angles.ankle.amplitude, bound: ANKLE_FLAG });
  }

  // Poignet : warning seulement (non sourcé, cf. §10 du spec)
  if (angles.wrist.mean > WRIST_WARN) {
    warnings.push({ param: 'wrist_deviation', value: angles.wrist.mean, bound: WRIST_WARN });
  }

  return { valid: violations.length === 0, violations, warnings, margins };
}

// ---------- §4 — Score confort ----------

function quadPenalty(distance: number, scale: number, cap = 40): number {
  // distance <= 0 => dans la plage confortable, pas de pénalité
  if (distance <= 0) return 0;
  return Math.min(cap, scale * distance * distance);
}

export function computeComfortScore(t: Trial, profile: AthleteProfile, weights: SubjectiveWeights): number {
  let score = 100;

  const hipTarget = HIP_TARGET_BY_FLEX[profile.hipFlexibilityScore];
  const hipGap = Math.max(0, hipTarget - t.angles.hip.mean); // en dessous de la cible = pénalité croissante
  score -= quadPenalty(hipGap, 0.3) * weights.lowerBack;

  const trunkMid = (TRUNK_MIN + TRUNK_MAX) / 2;
  const trunkHalfRange = (TRUNK_MAX - TRUNK_MIN) / 2;
  const trunkGap = Math.abs(t.angles.trunk.mean - trunkMid) - trunkHalfRange;
  score -= quadPenalty(trunkGap, 0.5) * weights.neck;

  // Stabilité inter-cycles : variance élevée = moins fiable / moins confortable sur la durée
  score -= Math.min(15, (t.angles.hip.variance + t.angles.trunk.variance) * 2);

  // Poignet : coûte du confort au-delà du seuil, même s'il ne bloque pas la validité
  const wristGap = Math.max(0, t.angles.wrist.mean - WRIST_WARN);
  score -= quadPenalty(wristGap, 0.4) * weights.hands;

  return Math.max(0, Math.min(100, round1(score)));
}

// ---------- §5 — Score aéro (relatif, via pFSA mesurée) ----------

const AERO_WEIGHTS = { pfsa: 0.65, trunk: 0.25, head: 0.10 }; // [DEFAULT] pondération de départ, à calibrer (§10)

export function computeAeroScore(t: Trial, cohortMaxPFSANorm: number): number {
  const pfsaNorm = t.frontal.pFSA_cm2 / t.frontal.athleteHeight_cm;
  const pfsaScore = 100 * (1 - pfsaNorm / cohortMaxPFSANorm); // relatif aux essais de LA session, jamais absolu

  const trunkScore = 100 * (1 - (t.angles.trunk.mean - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN));

  const headPenalty = Math.min(30, Math.abs(t.frontal.headOffset_cm) * 5);
  const headScore = 100 - headPenalty;

  const raw = AERO_WEIGHTS.pfsa * pfsaScore + AERO_WEIGHTS.trunk * trunkScore + AERO_WEIGHTS.head * headScore;
  return Math.max(0, Math.min(100, round1(raw)));
}

// ---------- §6 — Front de Pareto + sélection des 3 profils ----------

export function paretoFront(trials: ScoredTrial[]): ScoredTrial[] {
  const valid = trials.filter((t) => t.validation.valid);
  return valid.filter(
    (a) =>
      !valid.some(
        (b) =>
          b.id !== a.id &&
          b.comfortScore >= a.comfortScore &&
          b.aeroScore >= a.aeroScore &&
          (b.comfortScore > a.comfortScore || b.aeroScore > a.aeroScore)
      )
  );
}

export function selectProfiles(front: ScoredTrial[]) {
  if (front.length === 0) return null;
  const confortMax = [...front].sort((a, b) => b.comfortScore - a.comfortScore)[0];
  const aeroMax = [...front].sort((a, b) => b.aeroScore - a.aeroScore)[0];
  const equilibre = [...front].sort((a, b) => distToIdeal(a) - distToIdeal(b))[0];
  return { confort_max: confortMax, equilibre, aero_max: aeroMax };
}

function distToIdeal(t: ScoredTrial): number {
  return Math.hypot(100 - t.comfortScore, 100 - t.aeroScore);
}

// ---------- §7 — Boucle de feedback ----------

export interface FeedbackEntry {
  zone: 'neck' | 'lowerBack' | 'hands' | 'knees';
  painScore: number; // 1-5
}

export function recalibrateWeights(current: SubjectiveWeights, history: FeedbackEntry[][]): SubjectiveWeights {
  const next = { ...current };
  (['neck', 'lowerBack', 'hands', 'knees'] as const).forEach((zone) => {
    const last2 = history.slice(-2).map((session) => session.find((e) => e.zone === zone)?.painScore ?? 0);
    // Recalibration seulement si 2 sorties consécutives signalent la même zone — évite l'overfit à un mauvais jour
    if (last2.length === 2 && last2.every((p) => p >= 4)) {
      next[zone] = Math.min(2.0, round1(next[zone] + 0.2));
    }
  });
  return next;
}

// ---------- Pipeline complet (§8 — format de sortie) ----------

export function runEngine(trials: Trial[], profile: AthleteProfile, weights: SubjectiveWeights) {
  const scored: ScoredTrial[] = trials.map((t) => ({
    ...t,
    validation: validateTrial(t.angles, profile),
    comfortScore: computeComfortScore(t, profile, weights),
    aeroScore: 0, // calculé après normalisation cohort ci-dessous
  }));

  const validTrials = scored.filter((t) => t.validation.valid);
  const excluded = scored
    .filter((t) => !t.validation.valid)
    .map((t) => ({ trial_id: t.id, violations: t.validation.violations }));

  if (validTrials.length < 3) {
    return {
      status: 'insufficient_valid_trials' as const,
      trials_valid: validTrials.length,
      trials_needed: 3,
      excluded_trials: excluded,
      message: `${validTrials.length} essai(s) valide(s) sur ${trials.length} — minimum 3 requis pour proposer une frontière Pareto.`,
    };
  }

  const cohortMaxPFSANorm = Math.max(...validTrials.map((t) => t.frontal.pFSA_cm2 / t.frontal.athleteHeight_cm));
  validTrials.forEach((t) => {
    t.aeroScore = computeAeroScore(t, cohortMaxPFSANorm);
  });

  const front = paretoFront(validTrials);
  const profiles = selectProfiles(front);

  return {
    status: 'ok' as const,
    trials_valid: validTrials.length,
    trials_excluded: excluded.length,
    profiles: profiles && {
      confort_max: toOutputProfile(profiles.confort_max),
      equilibre: toOutputProfile(profiles.equilibre),
      aero_max: toOutputProfile(profiles.aero_max),
    },
    excluded_trials: excluded,
  };
}

function toOutputProfile(t: ScoredTrial) {
  return {
    trial_id: t.id,
    comfort_score: t.comfortScore,
    aero_score: t.aeroScore,
    deltas: t.deltas,
    margins: t.validation.margins,
    warnings: t.validation.warnings,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Sanity checks déplacés dans posture-aero-engine.test.ts (node:test).

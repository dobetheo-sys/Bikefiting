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
  // Retour terrain : "les critères sont très précis, j'ai dû tricher un peu pour aligner les
  // points" puis "je pense qu'il faut élargir les zones... moi je cherche une position très
  // aéro [...] mais un débutant va chercher une position plus confortable et facile à régler".
  // 'aero' (défaut) : tronc [TRUNK_MIN,TRUNK_MAX] et genou [KNEE_MIN,KNEE_MAX] restent des
  // critères d'exclusion durs — la plage tronc en particulier est sourcée pour une position
  // TT/tri précise (§9 du spec), pas pour une position route générique. 'comfort' : pas de
  // plage tronc/genou "confort" sourcée équivalente à inventer (la fausse précision que
  // l'app évite ailleurs) — tronc et genou passent en avertissement plutôt qu'en exclusion,
  // mêmes seuils, même convention déjà utilisée pour le poignet (WRIST_WARN, non sourcé ->
  // jamais exclusoire). La hanche (HIP_FLOOR_ABS) reste exclusoire dans les deux cas : c'est
  // une perte de puissance mesurée, indépendante du style de position recherché.
  goal?: 'aero' | 'comfort';
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
  // Nommé "deltas" mais contient en réalité les mesures ABSOLUES du vélo pour cet essai (pas une
  // différence par rapport à un essai de référence) — retour terrain "ça marche pas" : le
  // formulaire demandait des différences, les utilisateurs entraient naturellement leurs mesures
  // réelles (ex. 745mm de hauteur de selle), ce qui n'a de sens que comme valeur absolue. Le nom
  // du champ est conservé pour ne pas casser les Trial déjà persistés en localStorage. Ce champ
  // n'est jamais lu par validateTrial/computeComfortScore/computeAeroScore (purement descriptif,
  // affiché tel quel via toOutputProfile) donc ce changement de sémantique n'affecte pas le scoring.
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

// ---------- Hauteur de selle de référence (formule LeMond) ----------
// Retour terrain : "plutôt un réglage de base sur le vélo avant, comme une norme pour
// l'athlète" — un point de départ documenté si l'athlète ne connaît pas déjà son réglage
// habituel, pas une prescription. Volontairement limité à la hauteur de selle : c'est la seule
// des 4 valeurs de TrialDeltasForm (hauteur/recul selle, reach, drop) qui a une formule
// largement citée et reproductible (LeMond, popularisée dans "Greg LeMond's Complete Book of
// Bicycling", 1987) ; reach/recul/drop dépendent trop du vélo, de la souplesse et de la
// discipline pour qu'une "norme" universelle ait un sens — en proposer une inventerait une
// fausse précision, ce que l'appli a justement évité de faire ailleurs (cf. les corrections
// successives sur la détection ASLR).
const LEMOND_SADDLE_HEIGHT_RATIO = 0.883; // [SOURCED] entrejambe -> hauteur pédalier–haut de selle

export function computeReferenceSaddleHeightCm(inseamCm: number): number {
  if (inseamCm <= 0) throw new Error('computeReferenceSaddleHeightCm: entrejambe doit être > 0');
  return round1(inseamCm * LEMOND_SADDLE_HEIGHT_RATIO);
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
  const goal = profile.goal ?? 'aero';

  // Garde-fou défensif : angleAt()/angleVsHorizontal() (capture-processing.ts) retournent NaN
  // quand 2 points tapés coïncident. La couche UI (measure screen) filtre déjà ce cas avant
  // d'enregistrer un essai, mais validateTrial est la couche d'autorité pour la validité d'un
  // essai — s'appuyer uniquement sur l'UI serait fragile. Sans ce garde-fou, TOUTES les
  // comparaisons numériques ci-dessous (<, >) valent silencieusement false pour NaN : un essai
  // avec un angle NaN ne serait jamais exclu ici, et ne serait jamais dominé dans paretoFront
  // (b.comfortScore >= a.comfortScore est aussi toujours false avec NaN) — il resterait sur la
  // frontière et pourrait ressortir comme une des 3 positions recommandées.
  const numericFields = [angles.hip.mean, angles.trunk.mean, angles.knee.mean, angles.knee.min, angles.knee.max];
  if (numericFields.some((v) => !Number.isFinite(v))) {
    violations.push({ param: 'invalid_measurement', value: NaN, bound: 0 });
    return { valid: false, violations, warnings, margins };
  }

  // Hanche : plancher absolu, indépendant de la souplesse déclarée ET de l'objectif (perte de
  // puissance mesurée, pas une question de style de position — cf. AthleteProfile.goal)
  if (angles.hip.mean < HIP_FLOOR_ABS) {
    violations.push({ param: 'hip_floor', value: angles.hip.mean, bound: HIP_FLOOR_ABS });
  }
  margins.hip_deg = round1(angles.hip.mean - HIP_FLOOR_ABS);

  // Tronc : exclusoire en objectif 'aero' (plage TT/tri sourcée) ; avertissement seulement en
  // 'comfort', cf. commentaire sur AthleteProfile.goal.
  if (angles.trunk.mean < TRUNK_MIN) {
    const entry: Violation = { param: 'trunk_min', value: angles.trunk.mean, bound: TRUNK_MIN };
    (goal === 'aero' ? violations : warnings).push(entry);
  }
  if (angles.trunk.mean > TRUNK_MAX) {
    const entry: Violation = { param: 'trunk_max', value: angles.trunk.mean, bound: TRUNK_MAX };
    (goal === 'aero' ? violations : warnings).push(entry);
  }
  margins.trunk_deg = round1(Math.min(angles.trunk.mean - TRUNK_MIN, TRUNK_MAX - angles.trunk.mean));

  // Genou : doit rester dans la plage sur tout le cycle (min/max), pas juste en moyenne.
  // Exclusoire en 'aero' ; avertissement en 'comfort' (même raison que le tronc ci-dessus).
  if (angles.knee.min < KNEE_MIN || angles.knee.max > KNEE_MAX) {
    const entry: Violation = { param: 'knee_range', value: angles.knee.mean, bound: KNEE_MIN };
    (goal === 'aero' ? violations : warnings).push(entry);
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

// ---------- Suggestion de réglage entre 2 essais ----------
// Retour terrain : "est-ce qu'on ne peut pas avoir cette réflexion entre chaque essai ? regarder
// le paramètre le plus loin de la norme et donner une suggestion" — jusqu'ici ce raisonnement
// (quel angle mesuré est le plus problématique, quel réglage vélo agit dessus) restait à faire
// à la main, essai par essai. Automatise le même calcul : parmi hanche/tronc/genou, identifie
// celui dont l'écart à sa zone cible (en degrés) est le plus grand, et donne le réglage vélo qui
// agit dessus dans le bon sens.
//
// Relations directionnelles utilisées [SOURCED, convergence de sources pro Retül/BikeFittr/
// BikeDynamics, mêmes sources que §3/§9 du spec] : plus de recul de selle ouvre la hanche, plus
// de drop/reach la ferme ; une selle plus haute tend la jambe au point bas du cycle (genou plus
// ouvert), plus basse la plie (genou plus fermé). Volontairement PAS de valeur en mm suggérée :
// contrairement à la hauteur de selle (cf. computeReferenceSaddleHeightCm), aucune formule
// fiable ne relie un écart en degrés à un delta en mm pour reach/recul/drop — donner un chiffre
// inventerait exactement la fausse précision que l'appli évite ailleurs. Seule la direction et
// le réglage à toucher sont fournis ; à l'athlète d'avancer par petits pas et de re-tester.
export interface AdjustmentSuggestion {
  param: 'hip' | 'trunk_high' | 'trunk_low' | 'knee_flexed' | 'knee_extended';
  gapDeg: number; // écart par rapport à la zone cible, toujours > 0 (sinon pas de suggestion)
  message: string;
}

export function suggestNextAdjustment(t: Trial, profile: AthleteProfile): AdjustmentSuggestion | null {
  const hipTarget = HIP_TARGET_BY_FLEX[profile.hipFlexibilityScore];
  // Le tronc ne cible la plage aéro [TRUNK_MIN,TRUNK_MAX] qu'en objectif 'aero' — en 'comfort'
  // il n'y a pas de cible sourcée équivalente (cf. AthleteProfile.goal), donc pas de
  // suggestion sur ce critère : gapDeg à 0 l'exclut simplement des candidats ci-dessous.
  const trunkTargeted = (profile.goal ?? 'aero') === 'aero';
  const candidates: AdjustmentSuggestion[] = [
    {
      param: 'hip',
      gapDeg: round1(Math.max(0, hipTarget - t.angles.hip.mean)),
      message: `Hanche fermée à ${t.angles.hip.mean}° (cible ${hipTarget}° pour ta souplesse) — essaie de reculer la selle, ou de réduire le drop/reach, pour l'ouvrir.`,
    },
    {
      param: 'trunk_high',
      gapDeg: trunkTargeted ? round1(Math.max(0, t.angles.trunk.mean - TRUNK_MAX)) : 0,
      message: `Tronc à ${t.angles.trunk.mean}°, au-dessus du seuil aéro de ${TRUNK_MAX}° — essaie d'augmenter le drop (cintre plus bas) ou le reach.`,
    },
    {
      param: 'trunk_low',
      gapDeg: trunkTargeted ? round1(Math.max(0, TRUNK_MIN - t.angles.trunk.mean)) : 0,
      message: `Tronc à ${t.angles.trunk.mean}°, sous le minimum de ${TRUNK_MIN}° — essaie de réduire le drop pour te redresser un peu.`,
    },
    {
      param: 'knee_flexed',
      gapDeg: round1(Math.max(0, KNEE_MIN - t.angles.knee.min)),
      message: `Genou trop plié au point le plus fermé du cycle (${t.angles.knee.min}°, sous ${KNEE_MIN}°) — essaie de monter la selle.`,
    },
    {
      param: 'knee_extended',
      gapDeg: round1(Math.max(0, t.angles.knee.max - KNEE_MAX)),
      message: `Genou trop tendu au point le plus ouvert du cycle (${t.angles.knee.max}°, au-dessus de ${KNEE_MAX}°) — essaie de baisser la selle.`,
    },
  ];

  const worst = candidates.reduce((a, b) => (b.gapDeg > a.gapDeg ? b : a));
  return worst.gapDeg > 0 ? worst : null;
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

  // Le tronc n'est pénalisé par rapport à la plage aéro [TRUNK_MIN,TRUNK_MAX] qu'en objectif
  // 'aero' — en 'comfort' il n'y a pas de plage tronc sourcée équivalente (cf. commentaire sur
  // AthleteProfile.goal), pénaliser quand même inventerait une cible non sourcée, alors que le
  // confort réel d'un débutant peut très bien se situer à un tronc nettement plus redressé.
  if ((profile.goal ?? 'aero') === 'aero') {
    const trunkMid = (TRUNK_MIN + TRUNK_MAX) / 2;
    const trunkHalfRange = (TRUNK_MAX - TRUNK_MIN) / 2;
    const trunkGap = Math.abs(t.angles.trunk.mean - trunkMid) - trunkHalfRange;
    score -= quadPenalty(trunkGap, 0.5) * weights.neck;
  }

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
  // Audit fiabilité : sans ce garde-fou, cohortMaxPFSANorm === 0 (tous les essais de la session
  // à pFSA=0 — ex. segmentation ayant échoué sur toute la session, photos trop sombres/mal
  // cadrées) ou athleteHeight_cm falsy (ancienne session persistée avant que ce champ soit
  // obligatoire) produit un score NaN affiché tel quel sur l'écran de résultats. Comme le score
  // est "relatif aux essais de LA session, jamais absolu" (cf. commentaire ci-dessous), un
  // dénominateur nul signifie qu'aucune comparaison relative n'a de sens ici : neutre (0) plutôt
  // que NaN, les autres composantes (trunk/head) restent utilisables.
  const pfsaScore = cohortMaxPFSANorm > 0 && Number.isFinite(pfsaNorm) ? 100 * (1 - pfsaNorm / cohortMaxPFSANorm) : 0; // relatif aux essais de LA session, jamais absolu

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

  // Filtre les valeurs non finies avant le max : sans ça, un seul essai avec athleteHeight_cm
  // falsy (0/null, ancienne session persistée) donnerait un NaN qui empoisonnerait Math.max
  // pour TOUTE la cohorte (Math.max renvoie NaN dès qu'un seul argument l'est) — un essai
  // corrompu ferait perdre le score aéro relatif de tous les autres essais, pourtant valides.
  const pfsaNorms = validTrials.map((t) => t.frontal.pFSA_cm2 / t.frontal.athleteHeight_cm).filter(Number.isFinite);
  const cohortMaxPFSANorm = pfsaNorms.length > 0 ? Math.max(...pfsaNorms) : 0;
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

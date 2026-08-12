// running-gait-engine.ts
// Moteur d'analyse de foulée (course à pied) — V1, protocole tapis.
// Implémente docs/SPEC_MOTEUR_COURSE.md
//
// Même convention de statut des constantes que le moteur vélo (§9 du spec vélo) :
//   [SOURCED]  = valeur/relation vérifiée en littérature, citée dans le spec course
//   [DEFAULT]  = hypothèse d'ingénierie, pas de source chiffrée — à calibrer par le terrain
//
// DIFFÉRENCE STRUCTURELLE IMPORTANTE AVEC LE MOTEUR VÉLO, à ne pas survoler :
// en vélo, il existe une contrainte biomécanique dure et sourcée (hanche sous 40° = 5-15% de
// puissance perdue chez la majorité des athlètes) qui justifie d'EXCLURE un essai. En course,
// aucune métrique mesurable au téléphone n'a d'équivalent : il n'existe pas de seuil publié
// du type "au-delà de X° de tibia à l'attaque, blessure". Les seules contraintes dures ici sont
// donc des contraintes de VALIDITÉ DE MESURE (essai filmé à une autre vitesse, cadence
// aberrante, point mal tapé) — tout ce qui est biomécanique est en avertissement, jamais
// exclusoire. C'est la même règle que le poignet côté vélo ("non sourcé -> jamais exclusoire"),
// appliquée ici à la quasi-totalité des critères.

import { clampScore, paretoDominant, quadPenalty } from '../shared/analysis';
import type { ValidationResult, Violation } from '../shared/analysis';
import { r1 } from '../shared/geometry';

export type { ValidationResult, Violation };

// ---------- Types ----------

export interface RunnerProfile {
  heightCm: number;
  // Cadence librement choisie, MESURÉE sur un essai de référence à `testSpeedKmh`.
  //
  // C'est l'équivalent structurel du test ASLR côté vélo : une calibration individuelle
  // obligatoire sans laquelle le moteur refuse de scorer (cf. runRunningEngine). Raison :
  // les deux scores ci-dessous sont définis RELATIVEMENT à cette cadence, jamais dans l'absolu.
  //
  // Volontairement PAS de valeur par défaut à 180 spm. Le "180 universel" vient d'une
  // observation de Jack Daniels sur des coureurs élite en compétition, jamais d'une norme
  // validée pour tous les coureurs à toutes les allures — la cadence dépend de l'allure et de
  // la longueur de jambe. Poser 180 par défaut inventerait exactement la fausse précision que
  // ce projet évite ailleurs (cf. la décision de ne pas inventer de norme de reach/drop côté
  // vélo, computeReferenceSaddleHeightCm).
  selfSelectedCadenceSpm: number;
  // Vitesse du tapis pendant TOUS les essais de la session. Deux essais à des vitesses
  // différentes ne sont pas comparables (cadence et angles varient avec l'allure), d'où la
  // contrainte dure de validité ci-dessous.
  testSpeedKmh: number;
  // Ne change aucun calcul : sélectionne seulement lequel des 3 profils de sortie est mis en
  // avant comme recommandation. Pas de pondération cachée dépendante de l'objectif — les deux
  // scores gardent la même définition pour tout le monde.
  goal?: 'charge' | 'economy';
}

export interface RunTrialMetrics {
  cadenceSpm: number;
  // Signé, > 0 = cheville DEVANT le genou à l'attaque du pied (marqueur d'overstriding).
  tibiaAngleDeg: number;
  // Flexion du genou à l'attaque, en degrés depuis la jambe tendue (0 = tendue).
  kneeFlexionICDeg: number;
  // Signé, > 0 = buste penché vers l'avant par rapport à la verticale.
  trunkLeanDeg: number;
  // Distance horizontale cheville->hanche à l'attaque, divisée par la longueur de jambe.
  // Sans dimension exprès : pas besoin d'objet de calibration cm/px (contrairement à la pFSA
  // côté vélo), donc une source d'erreur terrain en moins.
  overstrideRatio: number;
  // Amplitude verticale de la hanche / longueur de jambe. Optionnel : demande 2 images de plus
  // à l'utilisateur, et le moteur sait s'en passer (cf. useVerticalOscillation ci-dessous).
  verticalOscillationRatio?: number;
  // INFORMATIF UNIQUEMENT, jamais scoré ni utilisé pour valider — signé, > 0 = pointe plus haute
  // que le talon (attaque talon). Même traitement que le KOPS côté vélo (§1 du spec vélo) :
  // calculable et affichable comme repère, mais la littérature ne converge pas sur un type
  // d'attaque supérieur aux autres, donc en faire un critère serait inventer une norme.
  footStrikeAngleDeg?: number;
}

export interface RunTrial {
  id: string;
  speedKmh: number;
  metrics: RunTrialMetrics;
  label?: string;
}

export interface ScoredRunTrial extends RunTrial {
  validation: ValidationResult;
  chargeScore: number;
  economyScore: number;
}

// ---------- Contraintes ----------

// Contraintes DURES — validité de mesure uniquement (cf. avertissement en tête de fichier).
const SPEED_TOLERANCE_KMH = 0.3; // [DEFAULT] sur tapis l'allure est exacte ; tolérance pour l'arrondi de saisie
// [DEFAULT] garde-fou de mesure, pas un jugement biomécanique. Rend un service non prévu à
// l'origine et repéré à l'audit : c'est le filet qui attrape la confusion appuis/foulées. Un
// coureur à 170 pas/min qui compte ses FOULÉES saisit 85, tombe sous le plancher, et l'essai est
// écarté au lieu de fausser silencieusement tout le scoring — qui est entièrement relatif à
// cette valeur (cf. docs/AUDIT_MOTEUR_COURSE.md §2.11).
const CADENCE_PLAUSIBLE_MIN = 130;
const CADENCE_PLAUSIBLE_MAX = 220;

// Seuils d'AVERTISSEMENT — jamais exclusoires.
// [SOURCED, indicatif] Flexion typique au contact : 15-25° (corrigé à l'audit — la V1 annonçait
// 10-20°). Le seuil à 10° n'avertit donc que ~0.6% des coureurs : c'est un détecteur de valeur
// aberrante, pas un jugement sur une foulée ordinaire. Nuance non traitée : les attaques
// avant-pied contactent avec PLUS de flexion que les attaques talon (Almeida/Davis/Lopes 2015),
// donc ce seuil n'est pas neutre vis-à-vis du type d'attaque.
const KNEE_FLEX_IC_WARN = 10;
const TRUNK_LEAN_MIN = 5; // [SOURCED, convergence] inclinaison typique 5-15° ; Teng & Powers 2014 : plus de flexion du tronc réduit la contrainte fémoro-patellaire
const TRUNK_LEAN_MAX = 15;
const TIBIA_ANGLE_WARN = 10; // [DEFAULT] le principe "tibia proche de la verticale à l'attaque" est standard en réathlétisation, le seuil chiffré ne l'est pas
const OVERSTRIDE_WARN = 0.15; // [DEFAULT] idem

// Fenêtre de cadence sur laquelle la littérature documente l'effet : Heiderscheit et al. 2011
// ont testé ±5% et ±10% autour de la cadence librement choisie. Au-delà de +10%, on sort de ce
// qui a été mesuré — le moteur cesse donc de créditer davantage plutôt que d'extrapoler.
const CADENCE_EVIDENCE_WINDOW_PCT = 10; // [SOURCED]

export function cadenceGainPct(cadenceSpm: number, selfSelectedCadenceSpm: number): number {
  return r1(100 * (cadenceSpm / selfSelectedCadenceSpm - 1));
}

export function cadenceTargetSpm(profile: RunnerProfile, gainPct: number): number {
  return Math.round(profile.selfSelectedCadenceSpm * (1 + gainPct / 100));
}

export function validateRunTrial(trial: RunTrial, profile: RunnerProfile): ValidationResult {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  const margins: Record<string, number> = {};
  const m = trial.metrics;

  // Même garde-fou défensif que validateTrial() côté vélo : les helpers géométriques renvoient
  // NaN quand deux points tapés coïncident, et TOUTES les comparaisons < / > ci-dessous valent
  // silencieusement false pour NaN. Sans ce test explicite, un essai corrompu ne serait jamais
  // exclu ici et ne serait jamais dominé dans le front de Pareto (aucune comparaison NaN >=
  // n'est vraie non plus) — il pourrait donc ressortir comme profil recommandé.
  const required = [m.cadenceSpm, m.tibiaAngleDeg, m.kneeFlexionICDeg, m.trunkLeanDeg, m.overstrideRatio];
  if (required.some((v) => !Number.isFinite(v))) {
    violations.push({ param: 'invalid_measurement', value: NaN, bound: 0 });
    return { valid: false, violations, warnings, margins };
  }

  // Vitesse : contrainte dure de comparabilité. Cadence et angles dépendent directement de
  // l'allure — comparer un essai à 11 km/h avec un essai à 13 km/h ne mesure pas l'effet de la
  // cadence, il mesure l'effet de la vitesse. C'est la seule contrainte dure vraiment solide de
  // ce moteur, et elle est méthodologique, pas biomécanique.
  const speedGap = Math.abs(trial.speedKmh - profile.testSpeedKmh);
  if (speedGap > SPEED_TOLERANCE_KMH) {
    violations.push({ param: 'speed_mismatch', value: trial.speedKmh, bound: profile.testSpeedKmh });
  }
  margins.speed_kmh = r1(SPEED_TOLERANCE_KMH - speedGap);

  // Cadence aberrante = erreur de comptage (pas assez d'appuis comptés, durée mal saisie),
  // pas une foulée exotique. On exclut pour protéger le reste du calcul, qui est entièrement
  // relatif à la cadence.
  if (m.cadenceSpm < CADENCE_PLAUSIBLE_MIN) {
    violations.push({ param: 'cadence_implausible', value: m.cadenceSpm, bound: CADENCE_PLAUSIBLE_MIN });
  } else if (m.cadenceSpm > CADENCE_PLAUSIBLE_MAX) {
    violations.push({ param: 'cadence_implausible', value: m.cadenceSpm, bound: CADENCE_PLAUSIBLE_MAX });
  }

  // --- À partir d'ici : avertissements seulement, jamais d'exclusion ---

  if (m.tibiaAngleDeg > TIBIA_ANGLE_WARN) {
    warnings.push({ param: 'tibia_forward', value: m.tibiaAngleDeg, bound: TIBIA_ANGLE_WARN });
  }
  margins.tibia_deg = r1(TIBIA_ANGLE_WARN - m.tibiaAngleDeg);

  if (m.overstrideRatio > OVERSTRIDE_WARN) {
    warnings.push({ param: 'overstride', value: m.overstrideRatio, bound: OVERSTRIDE_WARN });
  }
  margins.overstride_ratio = r1(OVERSTRIDE_WARN - m.overstrideRatio);

  if (m.kneeFlexionICDeg < KNEE_FLEX_IC_WARN) {
    warnings.push({ param: 'stiff_landing', value: m.kneeFlexionICDeg, bound: KNEE_FLEX_IC_WARN });
  }
  margins.knee_flex_ic_deg = r1(m.kneeFlexionICDeg - KNEE_FLEX_IC_WARN);

  if (m.trunkLeanDeg < TRUNK_LEAN_MIN) {
    warnings.push({ param: 'trunk_upright', value: m.trunkLeanDeg, bound: TRUNK_LEAN_MIN });
  } else if (m.trunkLeanDeg > TRUNK_LEAN_MAX) {
    warnings.push({ param: 'trunk_overleaned', value: m.trunkLeanDeg, bound: TRUNK_LEAN_MAX });
  }
  margins.trunk_deg = r1(Math.min(m.trunkLeanDeg - TRUNK_LEAN_MIN, TRUNK_LEAN_MAX - m.trunkLeanDeg));

  return { valid: violations.length === 0, violations, warnings, margins };
}

// ---------- Score charge (0-100, 100 = charge articulaire estimée la plus faible) ----------

// [DEFAULT] pondérations de départ, à calibrer par le terrain (même statut que AERO_WEIGHTS
// côté vélo). `overstride` et `tibia` mesurent le même phénomène par deux points différents :
// ce n'est pas un double comptage accidentel mais une redondance voulue — deux mesures
// indépendantes du même défaut rendent le score moins sensible à UN point mal tapé, ce qui est
// le mode d'échec réel observé sur le terrain côté vélo.
const CHARGE_WEIGHTS = { cadence: 0.45, overstride: 0.25, tibia: 0.15, kneeFlex: 0.15 };

export function computeChargeScore(t: RunTrial, profile: RunnerProfile): number {
  const m = t.metrics;
  const gain = cadenceGainPct(m.cadenceSpm, profile.selfSelectedCadenceSpm);

  // [SOURCED] Heiderscheit et al. 2011 (Med Sci Sports Exerc) : augmenter la cadence de 5 à 10%
  // au-dessus de la cadence librement choisie réduit l'énergie absorbée au genou et à la hanche,
  // l'impulsion de freinage et l'adduction de hanche. L'échelle est bornée à ±10% parce que
  // c'est la fenêtre effectivement testée : au-delà, aucun crédit supplémentaire n'est accordé
  // plutôt que d'extrapoler une relation hors de son domaine de validité.
  const clampedGain = Math.max(-CADENCE_EVIDENCE_WINDOW_PCT, Math.min(CADENCE_EVIDENCE_WINDOW_PCT, gain));
  const cadenceComponent = 50 + (50 * clampedGain) / CADENCE_EVIDENCE_WINDOW_PCT;

  const overstrideComponent = 100 - quadPenalty(m.overstrideRatio - OVERSTRIDE_WARN, 4000, 100);
  const tibiaComponent = 100 - quadPenalty(m.tibiaAngleDeg - TIBIA_ANGLE_WARN, 0.4, 100);
  const kneeFlexComponent = 100 - quadPenalty(KNEE_FLEX_IC_WARN - m.kneeFlexionICDeg, 1.0, 100);

  return clampScore(
    CHARGE_WEIGHTS.cadence * cadenceComponent +
      CHARGE_WEIGHTS.overstride * overstrideComponent +
      CHARGE_WEIGHTS.tibia * tibiaComponent +
      CHARGE_WEIGHTS.kneeFlex * kneeFlexComponent
  );
}

// ---------- Score économie (0-100, relatif à la session) ----------

// [DEFAULT] pondérations de départ. La composante cadence domine parce que c'est la seule des
// trois dont le lien avec le coût métabolique est directement sourcé.
const ECONOMY_WEIGHTS = { cadence: 0.55, verticalOscillation: 0.3, trunk: 0.15 };

// [DEFAULT] échelle de la pénalité en U. Cavanagh & Williams 1982 donnent la FORME de la courbe
// (coût minimal à la longueur de foulée librement choisie, coût qui remonte dans les deux sens),
// pas une conversion "% d'écart -> points de score". Le classement relatif des essais entre eux
// est ce qui compte ici, pas la valeur absolue du score.
const ECONOMY_DEVIATION_SCALE = 0.35;

export function computeEconomyScore(
  t: RunTrial,
  profile: RunnerProfile,
  cohortMaxVORatio: number,
  useVerticalOscillation: boolean
): number {
  const m = t.metrics;

  // [SOURCED] Cavanagh & Williams 1982 (Med Sci Sports Exerc) : le coût en oxygène est minimal
  // autour de la longueur de foulée librement choisie et augmente quand on s'en écarte dans un
  // sens comme dans l'autre. C'est exactement ce qui OPPOSE ce score au score de charge : la
  // charge veut plus de cadence, l'économie veut la cadence spontanée. Sans cette opposition
  // documentée, un front de Pareto sur ces deux axes n'aurait aucun sens.
  const deviationPct = Math.abs(cadenceGainPct(m.cadenceSpm, profile.selfSelectedCadenceSpm));
  const cadenceComponent = 100 - quadPenalty(deviationPct, ECONOMY_DEVIATION_SCALE, 100);

  // Oscillation verticale : notée RELATIVEMENT aux essais de la session, jamais dans l'absolu —
  // même parti pris que le score aéro côté vélo (§5 du spec vélo), pour la même raison : on
  // classe les essais de CE coureur entre eux, on ne le compare pas à une population.
  const voRatio = m.verticalOscillationRatio;
  const voComponent =
    useVerticalOscillation && cohortMaxVORatio > 0 && Number.isFinite(voRatio)
      ? 100 * (1 - (voRatio as number) / cohortMaxVORatio)
      : 0;

  const trunkMid = (TRUNK_LEAN_MIN + TRUNK_LEAN_MAX) / 2;
  const trunkHalfRange = (TRUNK_LEAN_MAX - TRUNK_LEAN_MIN) / 2;
  const trunkComponent = 100 - quadPenalty(Math.abs(m.trunkLeanDeg - trunkMid) - trunkHalfRange, 0.5, 100);

  // Quand l'oscillation verticale n'est pas mesurée, son poids est redistribué au prorata sur
  // les deux autres composantes plutôt que comptée à 0. Le moteur vélo, lui, laisse la
  // composante à 0 (cf. computeAeroScore) : c'est acceptable là-bas parce que la pénalité
  // frappe TOUS les essais de la session identiquement, donc le classement relatif survit. Ici
  // ce n'est pas garanti — un utilisateur peut très bien mesurer l'oscillation sur certains
  // essais et pas sur d'autres, et les essais non mesurés seraient alors injustement pénalisés.
  const w = useVerticalOscillation
    ? ECONOMY_WEIGHTS
    : (() => {
        const rest = ECONOMY_WEIGHTS.cadence + ECONOMY_WEIGHTS.trunk;
        return {
          cadence: ECONOMY_WEIGHTS.cadence / rest,
          verticalOscillation: 0,
          trunk: ECONOMY_WEIGHTS.trunk / rest,
        };
      })();

  return clampScore(
    w.cadence * cadenceComponent + w.verticalOscillation * voComponent + w.trunk * trunkComponent
  );
}

// ---------- Front de Pareto + sélection des 3 profils ----------

export function runningParetoFront(trials: ScoredRunTrial[]): ScoredRunTrial[] {
  const valid = trials.filter((t) => t.validation.valid);
  return paretoDominant(
    valid,
    (t) => t.chargeScore,
    (t) => t.economyScore
  );
}

export function selectRunProfiles(front: ScoredRunTrial[]) {
  if (front.length === 0) return null;
  const chargeMin = [...front].sort((a, b) => b.chargeScore - a.chargeScore)[0];
  const economieMax = [...front].sort((a, b) => b.economyScore - a.economyScore)[0];
  const equilibre = [...front].sort((a, b) => distToIdeal(a) - distToIdeal(b))[0];
  return { charge_min: chargeMin, equilibre, economie_max: economieMax };
}

function distToIdeal(t: ScoredRunTrial): number {
  return Math.hypot(100 - t.chargeScore, 100 - t.economyScore);
}

// ---------- Suggestion de l'essai suivant ----------
// Même intention que suggestNextAdjustment() côté vélo : plutôt que de laisser l'utilisateur
// deviner quoi filmer ensuite, on lui dit quelle cadence tester. La différence avec le vélo est
// qu'ici le paramètre à faire varier est connu d'avance (la cadence), donc la suggestion porte
// d'abord sur la couverture du balayage, et seulement ensuite sur un défaut de forme.

export interface RunSuggestion {
  kind: 'next_trial' | 'form_cue';
  message: string;
  targetCadenceSpm?: number;
}

// Balayage proposé : cadence spontanée, puis +5%, puis +10% — les trois points effectivement
// testés par Heiderscheit et al. 2011, ce qui donne un front de Pareto ancré sur des écarts
// dont l'effet est documenté plutôt que sur des variations arbitraires.
const SWEEP_GAINS_PCT = [0, 5, 10];
const SWEEP_MATCH_TOLERANCE_PCT = 2.5; // [DEFAULT] un essai à +4% compte comme le point "+5%"

export function suggestNextRunTrial(trials: RunTrial[], profile: RunnerProfile): RunSuggestion | null {
  const covered = trials.map((t) => cadenceGainPct(t.metrics.cadenceSpm, profile.selfSelectedCadenceSpm));
  const missing = SWEEP_GAINS_PCT.find(
    (g) => !covered.some((c) => Math.abs(c - g) <= SWEEP_MATCH_TOLERANCE_PCT)
  );

  if (missing !== undefined) {
    const target = cadenceTargetSpm(profile, missing);
    return {
      kind: 'next_trial',
      targetCadenceSpm: target,
      message:
        missing === 0
          ? `Filme d'abord un essai à ta cadence spontanée (~${target} pas/min) — c'est la référence de toute la session.`
          : `Il te manque l'essai à +${missing}% de cadence (~${target} pas/min, même vitesse de tapis). Utilise un métronome pour la tenir.`,
    };
  }

  // Balayage complet : on bascule sur le défaut de forme le plus marqué, en degrés d'écart au
  // seuil d'avertissement. Volontairement pas de conversion en "corrige de X°" — comme pour le
  // reach/drop côté vélo, aucune formule fiable ne relie un écart mesuré à une correction
  // dosée. On nomme le défaut et le repère à viser, l'athlète ajuste et refilme.
  const worst = trials
    .map((t) => {
      const m = t.metrics;
      const candidates: RunSuggestion[] = [
        {
          kind: 'form_cue',
          message: `Tibia à ${m.tibiaAngleDeg}° vers l'avant à l'attaque (repère : proche de la verticale) — tu poses le pied trop devant toi. Raccourcis la foulée plutôt que de forcer l'amplitude.`,
        },
        {
          kind: 'form_cue',
          message: `Genou quasi tendu à l'attaque (${m.kneeFlexionICDeg}° de flexion, repère : 10-20°) — réception rigide, laisse le genou fléchir à l'impact.`,
        },
        {
          kind: 'form_cue',
          message: `Buste à ${m.trunkLeanDeg}° (repère : ${TRUNK_LEAN_MIN}-${TRUNK_LEAN_MAX}°) — penche-toi légèrement plus en avant, depuis les chevilles et non depuis la taille.`,
        },
      ];
      const gaps = [
        Math.max(0, m.tibiaAngleDeg - TIBIA_ANGLE_WARN),
        Math.max(0, KNEE_FLEX_IC_WARN - m.kneeFlexionICDeg),
        Math.max(0, TRUNK_LEAN_MIN - m.trunkLeanDeg, m.trunkLeanDeg - TRUNK_LEAN_MAX),
      ];
      const bestIdx = gaps.indexOf(Math.max(...gaps));
      return { gap: gaps[bestIdx], suggestion: candidates[bestIdx] };
    })
    .reduce((a, b) => (b.gap > a.gap ? b : a), { gap: 0, suggestion: null as RunSuggestion | null });

  return worst.gap > 0 ? worst.suggestion : null;
}

// ---------- Pipeline complet ----------

export function runRunningEngine(trials: RunTrial[], profile: RunnerProfile) {
  // Calibration obligatoire, équivalent structurel du test ASLR côté vélo : les deux scores
  // sont définis relativement à la cadence spontanée, donc sans elle il n'y a rien à calculer.
  const ssc = profile.selfSelectedCadenceSpm;
  if (!Number.isFinite(ssc) || ssc < CADENCE_PLAUSIBLE_MIN || ssc > CADENCE_PLAUSIBLE_MAX) {
    return {
      status: 'missing_self_selected_cadence' as const,
      message:
        'Cadence spontanée manquante ou invraisemblable. Filme un essai à allure et cadence libres à la vitesse de test, compte les appuis, et renseigne-la avant toute analyse.',
    };
  }

  const validated = trials.map((t) => ({ ...t, validation: validateRunTrial(t, profile) }));
  const validTrials = validated.filter((t) => t.validation.valid);
  const excluded = validated
    .filter((t) => !t.validation.valid)
    .map((t) => ({ trial_id: t.id, violations: t.validation.violations }));

  if (validTrials.length < 3) {
    return {
      status: 'insufficient_valid_trials' as const,
      trials_valid: validTrials.length,
      trials_needed: 3,
      excluded_trials: excluded,
      next_trial: suggestNextRunTrial(trials, profile),
      message: `${validTrials.length} essai(s) valide(s) sur ${trials.length} — minimum 3 requis pour proposer une frontière Pareto.`,
    };
  }

  // L'oscillation verticale n'entre dans le score que si TOUS les essais valides l'ont mesurée
  // (cf. computeEconomyScore) — sinon les essais mesurés seraient comparés aux non mesurés sur
  // une composante que ces derniers n'ont pas.
  const voRatios = validTrials
    .map((t) => t.metrics.verticalOscillationRatio)
    .filter((v): v is number => Number.isFinite(v));
  const useVO = voRatios.length === validTrials.length && voRatios.length > 0;
  const cohortMaxVORatio = useVO ? Math.max(...voRatios) : 0;

  const scored: ScoredRunTrial[] = validTrials.map((t) => ({
    ...t,
    chargeScore: computeChargeScore(t, profile),
    economyScore: computeEconomyScore(t, profile, cohortMaxVORatio, useVO),
  }));

  const front = runningParetoFront(scored);
  const profiles = selectRunProfiles(front);
  const recommendedKey = profile.goal === 'charge' ? 'charge_min' : profile.goal === 'economy' ? 'economie_max' : 'equilibre';

  return {
    status: 'ok' as const,
    trials_valid: scored.length,
    trials_excluded: excluded.length,
    vertical_oscillation_used: useVO,
    recommended: recommendedKey,
    profiles: profiles && {
      charge_min: toRunOutputProfile(profiles.charge_min, profile),
      equilibre: toRunOutputProfile(profiles.equilibre, profile),
      economie_max: toRunOutputProfile(profiles.economie_max, profile),
    },
    excluded_trials: excluded,
  };
}

function toRunOutputProfile(t: ScoredRunTrial, profile: RunnerProfile) {
  return {
    trial_id: t.id,
    label: t.label,
    charge_score: t.chargeScore,
    economy_score: t.economyScore,
    cadence_spm: t.metrics.cadenceSpm,
    cadence_gain_pct: cadenceGainPct(t.metrics.cadenceSpm, profile.selfSelectedCadenceSpm),
    metrics: t.metrics,
    margins: t.validation.margins,
    warnings: t.validation.warnings,
  };
}

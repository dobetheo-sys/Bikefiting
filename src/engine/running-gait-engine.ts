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

// [DEFAULT] Bornes de plausibilité physique du ratio d'oscillation verticale (amplitude
// verticale du bassin / longueur de jambe). Une oscillation typique de 6-11 cm sur une jambe
// d'environ 90 cm donne 0.07-0.12 ; ces bornes sont volontairement larges pour n'attraper que
// l'erreur de mesure franche, pas une foulée inhabituelle.
const VO_PLAUSIBLE_MIN = 0.02;
const VO_PLAUSIBLE_MAX = 0.3;

// Seuils d'AVERTISSEMENT — jamais exclusoires.
// [SOURCED, indicatif] Flexion typique au contact : 15-25° (corrigé à l'audit — la V1 annonçait
// 10-20°). Le seuil à 10° n'avertit donc que ~0.6% des coureurs : c'est un détecteur de valeur
// aberrante, pas un jugement sur une foulée ordinaire. Nuance non traitée : les attaques
// avant-pied contactent avec PLUS de flexion que les attaques talon (Almeida/Davis/Lopes 2015),
// donc ce seuil n'est pas neutre vis-à-vis du type d'attaque.
const KNEE_FLEX_IC_WARN = 10;
// [SOURCED] Inclinaison auto-sélectionnée : 7.3 ± 3.6° (Teng & Powers 2014), individus observés
// de −2° à 25°. Bornes élargies après audit (§2.4) : la V1 utilisait [5°,15°], qui avertissait
// ~28% des coureurs normaux — dont 26% sur la seule borne basse. Ce n'était pas un détecteur
// d'anomalie mais un générateur de bruit. [2°,18°] correspond à peu près aux queues réelles de
// la distribution et n'avertit plus que ~7%.
//
// Ces bornes ne servent QUE d'avertissement descriptif : le tronc a été retiré du score
// d'économie (cf. ECONOMY_WEIGHTS) et n'entre dans aucun score. Raison de fond : pencher
// davantage ne réduit pas la charge, il la DÉPLACE — Teng & Powers 2015 mesurent jusqu'à ~23%
// d'absorption d'énergie en moins au genou pendant que la demande sur les extenseurs de hanche
// grimpe fortement (0.12 vs 0.05 J·kg⁻¹). Un score unique ne peut pas représenter un transfert,
// donc on décrit sans noter.
const TRUNK_LEAN_MIN = 2;
const TRUNK_LEAN_MAX = 18;
const TIBIA_ANGLE_WARN = 10; // [DEFAULT] le principe "tibia proche de la verticale à l'attaque" est standard en réathlétisation, le seuil chiffré ne l'est pas
const OVERSTRIDE_WARN = 0.15; // [DEFAULT] idem

// Fenêtre de cadence sur laquelle la littérature documente l'effet : Heiderscheit et al. 2011
// ont testé ±5% et ±10% autour de la cadence librement choisie. Au-delà de +10%, on sort de ce
// qui a été mesuré — le moteur cesse donc de créditer davantage plutôt que d'extrapoler.
const CADENCE_EVIDENCE_WINDOW_PCT = 10; // [SOURCED]

// [DEFAULT, mais dérivé d'une contrainte de mesure] Étalement de cadence minimal pour qu'une
// comparaison entre essais ait un sens. Compter les appuis sur 30 s donne ±2 pas/min (~±1.2%) ;
// en dessous de ~4% d'étalement total, les écarts entre essais sont dominés par le bruit.
const MIN_CADENCE_SPREAD_PCT = 4;

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
  // Même famille de garde-fou que la cadence : une oscillation verticale hors de portée
  // physique signale deux taps de bassin mal placés (ou placés sur des images qui ne sont pas
  // celles du point haut et du point bas), pas une foulée exotique. Une oscillation typique est
  // de 6-11 cm pour une jambe d'environ 90 cm, soit un ratio de 0.07-0.12 ; en dehors de
  // [0.02, 0.30] la mesure n'a pas de sens physique. Sans ce test, un ratio de 0.55 était accepté
  // en silence et faussait le score d'économie de TOUS les essais de la session, puisque la
  // composante d'oscillation est notée relativement au maximum de la session.
  const vo = m.verticalOscillationRatio;
  if (vo !== undefined && (!Number.isFinite(vo) || vo < VO_PLAUSIBLE_MIN || vo > VO_PLAUSIBLE_MAX)) {
    violations.push({
      param: 'vertical_oscillation_implausible',
      value: Number.isFinite(vo) ? (vo as number) : NaN,
      bound: (vo as number) < VO_PLAUSIBLE_MIN ? VO_PLAUSIBLE_MIN : VO_PLAUSIBLE_MAX,
    });
  }

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

// [DEFAULT] pondérations, révisées après audit (docs/AUDIT_MOTEUR_COURSE.md §1.3, §2.1, §2.2).
//
// La V1 pesait cadence 0.45 / overstride 0.25 / tibia 0.15 / genou 0.15, ce qui donnait 55 points
// d'amplitude à la forme contre 45 à la cadence. Hiérarchie inversée : la cadence porte la SEULE
// relation solidement documentée (Heiderscheit 2011, Lenhart 2014, Schubert 2014, méta-analyse
// Anderson 2022), tandis que les seuils de tibia et d'overstriding n'ont AUCUN équivalent publié
// — le "0-15° = overstriding" qui circule vient d'un brevet américain, pas d'une publication.
//
// Correction aussi d'une justification fausse écrite en V1 : je présentais overstride et tibia
// comme "deux mesures indépendantes du même défaut". Elles ne sont pas indépendantes de la
// cadence — la distance pied-hanche au contact diminue d'environ 5.9% par +5 foulées/min
// (Lieberman 2015). Les compter lourdement AMPLIFIE donc la cadence au lieu d'ajouter une
// information, en la faisant passer par des seuils inventés plutôt que par la relation sourcée.
// Elles restent dans le score (elles capturent une part de forme propre à l'athlète) mais avec
// un poids qui reflète leur statut de repères non sourcés.
const CHARGE_WEIGHTS = { cadence: 0.6, overstride: 0.15, tibia: 0.1, kneeFlex: 0.15 };

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

// [DEFAULT] pondérations, révisées après audit (docs/AUDIT_MOTEUR_COURSE.md §2.7).
//
// L'inclinaison du tronc a été RETIRÉE de ce score. Elle y pesait 0.15 alors que c'est le
// facteur le moins soutenu des trois : Van Hooren 2024 (51 études) trouve que l'inclinaison
// statique du tronc corrèle avec la performance, pas avec l'économie, et une intervention de
// lean avant (PLOS One 2024) a DÉGRADÉ l'économie de course. La garder revenait à scorer un
// facteur dont l'effet documenté va dans le sens inverse de ce que je supposais.
//
// L'oscillation verticale garde le poids le plus élevé après la cadence : c'est le meilleur
// corrélat cinématique connu de l'économie (r = 0.53 chez Folland 2017 normalisé à la taille,
// r = 0.35 dans la méta-analyse Van Hooren 2024). Nuance à ne pas oublier : ce sont des
// corrélations observationnelles, il n'existe pas de preuve causale qu'abaisser volontairement
// l'oscillation améliore l'économie.
const ECONOMY_WEIGHTS = { cadence: 0.6, verticalOscillation: 0.4 };

// [SOURCED] Le sommet de la courbe de coût métabolique n'est PAS à la cadence spontanée.
// Trois sources concordantes montrent que les coureurs choisissent spontanément une foulée un
// peu trop longue, donc une cadence un peu trop basse :
//   - de Ruiter 2014 : novices 8% sous l'optimum, expérimentés 3% sous
//   - Morgan 1994 : chez des coureurs peu économiques, la foulée optimale était 9.8 %LL plus
//     courte que la spontanée
//   - Moore 2016 : plage optimale = "préféré -3% de longueur de foulée à préféré"
// La V1 plaçait le sommet à 0% et déclarait donc l'essai à cadence spontanée gagnant par
// construction (cf. audit §2.6). +3% retient la valeur des coureurs EXPÉRIMENTÉS, la plus
// conservatrice des deux — viser les 8% des novices déplacerait l'optimum bien plus loin sur la
// foi d'une population qui n'est pas forcément celle de l'utilisateur.
const ECONOMY_OPTIMUM_GAIN_PCT = 3;

// [SOURCED] La courbe est très plate près de l'optimum : le coût au point spontané n'est que
// d'environ 0.5% de VO2 (Cavanagh & Williams 1982), et Moore 2016 conclut qu'un écart de 3%
// est métaboliquement trivial tandis que ~6% devient significatif. D'où une zone morte plutôt
// qu'une pénalité qui mord dès le premier dixième de pourcent.
const ECONOMY_FLAT_ZONE_PCT = 3;

// [DEFAULT] échelle de la pénalité au-delà de la zone morte. Cavanagh & Williams donnent la
// FORME de la courbe, pas une conversion "% d'écart -> points de score" ; et la magnitude reste
// franchement contestée (Hafer 2015, n=6, ne trouve aucune perte d'efficacité à +10% ; la
// méta-analyse Anderson 2022 classe la question en "very limited evidence"). Le classement
// relatif des essais entre eux est ce qui compte, pas la valeur absolue.
const ECONOMY_DEVIATION_SCALE = 0.35;

// [SOURCED, faible] La courbe n'est pas symétrique : allonger la foulée coûte plus cher que la
// raccourcir d'autant. Cavanagh & Williams mesurent +3.4 ml·kg⁻¹·min⁻¹ à l'extrême long contre
// +2.6 à l'extrême court, soit un rapport d'environ 1.3 ; Högberg 1952 le dit qualitativement.
// Aucune étude n'a formellement testé l'asymétrie de la courbe — d'où le statut "faible".
const ECONOMY_LOW_CADENCE_FACTOR = 1.3;

export function computeEconomyScore(
  t: RunTrial,
  profile: RunnerProfile,
  cohortMaxVORatio: number,
  useVerticalOscillation: boolean
): number {
  const m = t.metrics;

  // Écart au SOMMET de la courbe (cadence spontanée + ECONOMY_OPTIMUM_GAIN_PCT), et non à la
  // cadence spontanée elle-même. Signe conservé : négatif = cadence plus basse que l'optimum,
  // c'est la branche la plus coûteuse.
  const deviation = cadenceGainPct(m.cadenceSpm, profile.selfSelectedCadenceSpm) - ECONOMY_OPTIMUM_GAIN_PCT;
  const beyondFlatZone = Math.max(0, Math.abs(deviation) - ECONOMY_FLAT_ZONE_PCT);
  const scale = ECONOMY_DEVIATION_SCALE * (deviation < 0 ? ECONOMY_LOW_CADENCE_FACTOR : 1);
  const cadenceComponent = 100 - quadPenalty(beyondFlatZone, scale, 100);

  // Oscillation verticale : notée RELATIVEMENT aux essais de la session, jamais dans l'absolu —
  // même parti pris que le score aéro côté vélo (§5 du spec vélo), pour la même raison : on
  // classe les essais de CE coureur entre eux, on ne le compare pas à une population.
  const voRatio = m.verticalOscillationRatio;
  const voComponent =
    useVerticalOscillation && cohortMaxVORatio > 0 && Number.isFinite(voRatio)
      ? 100 * (1 - (voRatio as number) / cohortMaxVORatio)
      : 0;

  // Sans oscillation verticale mesurée, il ne reste que la cadence : le score devient une pure
  // fonction de l'écart de cadence, ce que l'app doit dire plutôt que laisser croire que la
  // vidéo y contribue (c'est précisément le défaut relevé à l'audit §1.1). Le drapeau
  // vertical_oscillation_used remonte cette information jusqu'à l'écran de résultats.
  const w = useVerticalOscillation ? ECONOMY_WEIGHTS : { cadence: 1, verticalOscillation: 0 };

  return clampScore(w.cadence * cadenceComponent + w.verticalOscillation * voComponent);
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

  // "Équilibré" n'a de sens qu'avec au moins 3 points sur le front : avec 2, il n'y a pas de
  // milieu, seulement deux extrêmes, et désigner l'un des deux comme le compromis serait
  // arbitraire. On l'omet plutôt que d'étiqueter au hasard.
  const equilibre = front.length >= 3 ? [...front].sort((a, b) => distToIdeal(a, front) - distToIdeal(b, front))[0] : null;

  return { charge_min: chargeMin, equilibre, economie_max: economieMax };
}

// Distance au point idéal, calculée sur des axes RENORMALISÉS.
//
// BUG CORRIGÉ (introduit en réparant l'axe économie) : la version précédente mesurait la
// distance au point brut (100,100). Or les deux axes n'ont pas la même échelle atteignable. Le
// score de charge est absolu et peut atteindre 100 ; le score d'économie contient une composante
// d'oscillation verticale notée relativement à la session, où le pire essai reçoit 0 par
// construction — le meilleur essai d'une session plafonne donc typiquement autour de 70.
// Résultat : "le plus proche de (100,100)" revenait à "le plus proche de 100 en charge", et
// l'essai équilibré désignait systématiquement le même que charge_min. Vérifié sur le jeu de
// test : équilibré et charge minimale tombaient sur le même essai.
//
// Renormaliser chaque axe sur son étendue observée SUR LE FRONT rend les deux comparables et
// redonne à "équilibré" son sens : le meilleur compromis entre les candidats réellement
// disponibles, pas la proximité d'un point que l'un des deux axes ne peut pas atteindre.
function distToIdeal(t: ScoredRunTrial, front: ScoredRunTrial[]): number {
  const norm = (value: number, all: number[]) => {
    const min = Math.min(...all);
    const max = Math.max(...all);
    return max === min ? 1 : (value - min) / (max - min);
  };
  const nCharge = norm(t.chargeScore, front.map((x) => x.chargeScore));
  const nEconomy = norm(t.economyScore, front.map((x) => x.economyScore));
  return Math.hypot(1 - nCharge, 1 - nEconomy);
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
          // Formulation revue après audit (§2.4) : la V1 disait "penche-toi plus en avant".
          // C'était une prescription que la littérature ne soutient pas — Teng & Powers 2015
          // montrent que davantage d'inclinaison déplace la charge du genou vers les extenseurs
          // de hanche plutôt que de la réduire, et une intervention de lean avant (PLOS One
          // 2024) a dégradé l'économie. On décrit donc l'écart et ce qu'il implique, sans dire
          // quoi faire. S'ajoute une limite de mesure : l'angle du tronc seul ne distingue pas
          // "pencher depuis les chevilles" de "pencher depuis la taille".
          message: `Buste à ${m.trunkLeanDeg}° (la plupart des coureurs se situent entre ${TRUNK_LEAN_MIN}° et ${TRUNK_LEAN_MAX}°). Information, pas un défaut : plus d'inclinaison soulage le genou mais charge davantage les extenseurs de hanche, moins d'inclinaison fait l'inverse.`,
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

  // Garde-fou de SESSION, ajouté après audit (§1.2). Jusqu'ici le moteur validait chaque essai
  // isolément mais jamais la cohérence de l'ensemble : trois essais à 168/169/170 pas/min
  // produisaient un front de Pareto d'apparence tout à fait normale, avec des profils séparés de
  // quelques points. Or compter N appuis sur D secondes a une précision de ±1 appui, soit
  // ±60/D pas/min — environ ±2 pas/min (±1.2%) sur une fenêtre de 30 s. En dessous de quelques
  // pour cent d'étalement, les écarts affichés sont du bruit de mesure présenté comme un
  // arbitrage. Non bloquant (l'athlète peut avoir de bonnes raisons de ne pas atteindre ses
  // cibles) mais remonté pour que l'écran de résultats puisse le dire au lieu de le taire.
  const gains = scored.map((t) => cadenceGainPct(t.metrics.cadenceSpm, ssc));
  const cadenceSpreadPct = r1(Math.max(...gains) - Math.min(...gains));

  const front = runningParetoFront(scored);
  const profiles = selectRunProfiles(front);

  // L'essai à cadence spontanée est-il dominé ? Ce n'est pas un raté du protocole mais le
  // résultat le plus actionnable que le moteur puisse produire : il signifie qu'un autre essai
  // est à la fois moins chargé ET au moins aussi économique que la foulée naturelle de
  // l'athlète. Depuis que le sommet de la courbe d'économie est correctement placé (~+3%), ce
  // cas arrive dans la majorité des sessions — le taire reviendrait à faire filmer un essai de
  // dix minutes pour le jeter en silence.
  const baseline = scored.find(
    (t) => Math.abs(cadenceGainPct(t.metrics.cadenceSpm, ssc)) <= SWEEP_MATCH_TOLERANCE_PCT
  );
  const baselineDominated = baseline ? !front.some((t) => t.id === baseline.id) : false;

  // Fallback si "équilibré" n'existe pas (front à moins de 3 points, cf. selectRunProfiles) :
  // sans objectif déclaré on met en avant la charge minimale, qui est l'axe le mieux documenté.
  const preferredKey = profile.goal === 'charge' ? 'charge_min' : profile.goal === 'economy' ? 'economie_max' : 'equilibre';
  const recommendedKey = preferredKey === 'equilibre' && !profiles?.equilibre ? 'charge_min' : preferredKey;

  return {
    status: 'ok' as const,
    trials_valid: scored.length,
    trials_excluded: excluded.length,
    vertical_oscillation_used: useVO,
    cadence_spread_pct: cadenceSpreadPct,
    cadence_spread_sufficient: cadenceSpreadPct >= MIN_CADENCE_SPREAD_PCT,
    baseline_dominated: baselineDominated,
    baseline_cadence_spm: baseline?.metrics.cadenceSpm,
    recommended: recommendedKey,
    profiles: profiles && {
      charge_min: toRunOutputProfile(profiles.charge_min, profile),
      equilibre: profiles.equilibre ? toRunOutputProfile(profiles.equilibre, profile) : null,
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

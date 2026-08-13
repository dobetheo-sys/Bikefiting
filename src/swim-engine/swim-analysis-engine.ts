// swim-analysis-engine.ts
// Moteur d'analyse technique de nage (crawl) — V0
// Implémente SPEC_ANALYSE_NAGE_MOTEUR.md
//
// Statut des constantes (voir §9 du spec, table de confiance) :
//   [SOURCED]  = valeur vérifiée en littérature / recherche (citée dans le spec)
//   [DEFAULT]  = hypothèse d'ingénierie, pas de source chiffrée trouvée — à calibrer par un
//                entraîneur (cf. AUDIT_PROFESSIONNELS_NAGE.md, point 1) ou par le feedback
//
// Aucun code partagé avec src/engine/posture-aero-engine.ts (domaine différent, cf. §8 du
// spec) — seule l'architecture (logique pure testable séparée de l'intégration vision) est
// reprise.

// ---------- Types ----------

export type Confidence = 'faible' | 'moyenne' | 'haute';

// Enveloppe explicite pour tout signal issu de la couche vision (§4 du spec) — jamais un
// nombre nu comme les métriques mesurées (§3), pour qu'aucun consommateur de ce type ne
// puisse traiter un proxy incertain comme une mesure directe par erreur de frappe.
export interface VisionSignal<T> {
  value: T;
  confidence: Confidence;
}

export type BreathingSide = 'left' | 'right';

export interface LengthMeasurement {
  id: string;
  durationS: number;
  strokeCount: number;
  // Un élément par respiration détectée/comptée sur cette longueur (couche 1 — comptage,
  // pas un signal vision, cf. §3 du spec : "symétrie de respiration... fiabilité moyenne"
  // vient de la détection amont, pas du comptage lui-même une fois les côtés connus).
  breathingSides?: BreathingSide[];
  // Signaux couche 2 (§4 du spec) — optionnels, jamais utilisés dans le score d'efficacité
  // (voir computeEfficiencyScore), seulement remontés tels quels avec leur confiance.
  rollProxyDeg?: VisionSignal<number>;
  kickIndex?: VisionSignal<number>;
}

export type SwimmerLevel = 'debutant' | 'intermediaire' | 'confirme' | 'competition';

export interface SwimmerProfile {
  poolLengthM: 25 | 50;
  level: SwimmerLevel;
  heightCm?: number;
  dominantBreathingSide?: BreathingSide;
  // [DEFAULT] Pas de norme DPS universelle par niveau trouvée en recherche (§9 du spec,
  // dernière ligne) — si non fourni, penalty_dps_below_baseline reste neutre (0) plutôt que
  // d'inventer un seuil. À fournir par un entraîneur (AUDIT_PROFESSIONNELS_NAGE.md, point 1).
  dpsBaselineM?: number;
}

export interface AggregatedMetrics {
  lengthsAnalyzed: number;
  strokeRateAvg: number; // cycles/min
  dpsAvg: number; // m/brasse
  swolfAvg: number;
  swolfVariance: number;
}

export interface BreathingSymmetry {
  ratioLeft: number;
  ratioRight: number;
  dominantSide: BreathingSide | 'balanced';
  totalBreaths: number;
}

export interface Flag {
  type: 'breathing_asymmetry';
  detail: string;
}

export interface FeedbackEntry {
  shoulderComfort: number; // 1-5, cf. §6 du spec
  breathlessness: number; // 1-5
}

// ---------- §3 — Couche 1 : métriques mesurées directement (haute confiance) ----------

export function computeStrokeRate(durationS: number, strokeCount: number): number {
  if (durationS <= 0) throw new Error('computeStrokeRate: durationS doit être > 0');
  if (strokeCount <= 0) throw new Error('computeStrokeRate: strokeCount doit être > 0');
  // strokeCount cycles complets sur durationS secondes -> cycles/minute
  return round1((strokeCount / durationS) * 60);
}

export function computeDPS(poolLengthM: number, strokeCount: number): number {
  if (poolLengthM <= 0) throw new Error('computeDPS: poolLengthM doit être > 0');
  if (strokeCount <= 0) throw new Error('computeDPS: strokeCount doit être > 0');
  return round1(poolLengthM / strokeCount);
}

// SWOLF = durée (s) + nombre de brasses — convention d'usage établie (§9 du spec), pas une
// formule à sourcer davantage.
export function computeSWOLF(durationS: number, strokeCount: number): number {
  if (durationS <= 0) throw new Error('computeSWOLF: durationS doit être > 0');
  if (strokeCount <= 0) throw new Error('computeSWOLF: strokeCount doit être > 0');
  return round1(durationS + strokeCount);
}

export function aggregateLengths(lengths: LengthMeasurement[]): AggregatedMetrics {
  if (lengths.length === 0) {
    return { lengthsAnalyzed: 0, strokeRateAvg: 0, dpsAvg: 0, swolfAvg: 0, swolfVariance: 0 };
  }
  const poolLengthPlaceholder = 1; // DPS calculé par appelant (aggregateSession) qui connaît poolLengthM ; ici on n'agrège que ce qui ne dépend pas du profil
  const swolfs = lengths.map((l) => computeSWOLF(l.durationS, l.strokeCount));
  const srs = lengths.map((l) => computeStrokeRate(l.durationS, l.strokeCount));
  const swolfAvg = mean(swolfs);
  return {
    lengthsAnalyzed: lengths.length,
    strokeRateAvg: round1(mean(srs)),
    // DPS moyen ici est un placeholder neutre : voir aggregateSession() qui a besoin de
    // poolLengthM (profil) pour le calculer correctement — exporté séparément pour ne pas
    // dupliquer poolLengthM dans LengthMeasurement (une longueur ne "connaît" pas le bassin,
    // c'est une propriété de session/profil).
    dpsAvg: poolLengthPlaceholder,
    swolfAvg: round1(swolfAvg),
    swolfVariance: round1(variance(swolfs, swolfAvg)),
  };
}

export function aggregateSession(lengths: LengthMeasurement[], poolLengthM: number): AggregatedMetrics {
  const base = aggregateLengths(lengths);
  if (lengths.length === 0) return base;
  const dpsValues = lengths.map((l) => computeDPS(poolLengthM, l.strokeCount));
  return { ...base, dpsAvg: round1(mean(dpsValues)) };
}

// Symétrie de respiration : comptage pur (couche 1) une fois les côtés connus — cf. §3 du
// spec, "Symétrie de respiration | ratio brasses côté A / côté B... | Moyenne".
const BREATHING_ASYMMETRY_FLAG_RATIO = 0.7; // [DEFAULT] pas de seuil sourcé — à calibrer (cf. entraîneur, audit point 1)

export function computeBreathingSymmetry(lengths: LengthMeasurement[]): BreathingSymmetry {
  const sides = lengths.flatMap((l) => l.breathingSides ?? []);
  const total = sides.length;
  if (total === 0) {
    return { ratioLeft: 0, ratioRight: 0, dominantSide: 'balanced', totalBreaths: 0 };
  }
  const left = sides.filter((s) => s === 'left').length;
  const right = total - left;
  const ratioLeft = round2(left / total);
  const ratioRight = round2(right / total);
  const dominantSide: BreathingSymmetry['dominantSide'] =
    ratioLeft >= BREATHING_ASYMMETRY_FLAG_RATIO ? 'left' : ratioRight >= BREATHING_ASYMMETRY_FLAG_RATIO ? 'right' : 'balanced';
  return { ratioLeft, ratioRight, dominantSide, totalBreaths: total };
}

export function computeFlags(breathing: BreathingSymmetry, lengthsAnalyzed: number): Flag[] {
  const flags: Flag[] = [];
  if (breathing.dominantSide !== 'balanced') {
    const pct = Math.round((breathing.dominantSide === 'left' ? breathing.ratioLeft : breathing.ratioRight) * 100);
    flags.push({
      type: 'breathing_asymmetry',
      detail: `${pct}% des respirations côté ${breathing.dominantSide === 'left' ? 'gauche' : 'droit'} sur ${lengthsAnalyzed} longueur(s)`,
    });
  }
  return flags;
}

// ---------- §5 — Couche 3 : score d'efficacité (0-100, relatif au nageur) ----------
// Uniquement à partir des métriques couche 1 (mesurées) — les signaux couche 2 (roulis,
// battement) ne rentrent jamais dans ce score (§4 du spec : "jamais des verdicts"), ils sont
// remontés à part avec leur confiance (cf. runSwimEngine ci-dessous).

export interface EfficiencyWeights {
  dpsBelowBaseline: number;
  swolfVariance: number;
  breathingAsymmetry: number;
} // [DEFAULT] pondérations de départ, non sourcées — cf. §9 du spec, à calibrer par la boucle de feedback (§6)

export const DEFAULT_EFFICIENCY_WEIGHTS: EfficiencyWeights = {
  dpsBelowBaseline: 8, // points perdus par 0.1m sous la baseline déclarée
  swolfVariance: 2, // points perdus par unité de variance SWOLF
  breathingAsymmetry: 15, // points perdus si asymétrie flagguée (au-delà du seuil §3)
};

function quadPenalty(distance: number, scale: number, cap: number): number {
  if (distance <= 0) return 0;
  return Math.min(cap, scale * distance * distance);
}

export function computeEfficiencyScore(
  metrics: AggregatedMetrics,
  breathing: BreathingSymmetry,
  profile: SwimmerProfile,
  weights: EfficiencyWeights = DEFAULT_EFFICIENCY_WEIGHTS
): number {
  let score = 100;

  // DPS sous la baseline déclarée : neutre (aucune pénalité) si pas de baseline fournie,
  // plutôt que d'inventer un seuil par défaut (cf. SwimmerProfile.dpsBaselineM, §9 du spec).
  if (profile.dpsBaselineM !== undefined) {
    const gap = Math.max(0, profile.dpsBaselineM - metrics.dpsAvg);
    score -= quadPenalty(gap * 10, weights.dpsBelowBaseline / 10, 30);
  }

  score -= Math.min(20, metrics.swolfVariance * weights.swolfVariance);

  if (breathing.dominantSide !== 'balanced') {
    score -= weights.breathingAsymmetry;
  }

  // Facteur de confiance sur l'agrégat : peu de longueurs analysées = agrégat fragile,
  // score ramené vers 100 (neutre) plutôt que de présenter une valeur extrême comme fiable
  // sur un échantillon trop petit. [DEFAULT] seuil à 3 longueurs choisi par cohérence avec
  // le minimum de 3 essais du moteur vélo (posture-aero-engine.ts, runEngine), pas re-sourcé
  // spécifiquement pour la nage.
  const confidenceWeighting = metrics.lengthsAnalyzed >= 3 ? 1 : metrics.lengthsAnalyzed / 3;
  score = 100 - (100 - score) * confidenceWeighting;

  return Math.max(0, Math.min(100, round1(score)));
}

// ---------- §6 — Couche 4 : boucle de feedback (avertissement de vigilance épaule) ----------
// Le moteur ne pose jamais de diagnostic (cf. §6 du spec et AUDIT_PROFESSIONNELS_NAGE.md,
// point 3) — cette fonction ne fait que détecter un pattern répété, la formulation affichée
// à l'utilisateur reste la responsabilité de la couche produit/UI.

const SHOULDER_VIGILANCE_THRESHOLD = 4; // sur 5
const SHOULDER_VIGILANCE_CONSECUTIVE = 2; // sorties consécutives — évite l'overfit à un mauvais jour, même logique que recalibrateWeights côté vélo

export function shouldFlagShoulderVigilance(history: FeedbackEntry[]): boolean {
  const lastN = history.slice(-SHOULDER_VIGILANCE_CONSECUTIVE);
  return lastN.length === SHOULDER_VIGILANCE_CONSECUTIVE && lastN.every((e) => e.shoulderComfort >= SHOULDER_VIGILANCE_THRESHOLD);
}

// ---------- Pipeline complet (§7 — format de sortie) ----------

export interface SwimSessionResult {
  lengths_analyzed: number;
  measured: {
    stroke_rate_avg: number;
    dps_avg_m: number;
    swolf_avg: number;
  };
  vision_signals: {
    roll_proxy_deg: VisionSignal<number> | null;
    breathing_symmetry: { ratio_left_right: number; confidence: Confidence };
    kick_index: VisionSignal<number> | null;
  };
  efficiency_score: number;
  flags: Flag[];
  shoulder_vigilance: boolean;
  out_of_scope_note: string;
}

const OUT_OF_SCOPE_NOTE =
  'Attaque, trajectoire de main et technique de traction non mesurées en V0 (nécessitent une vue sous-marine, cf. §0 du spec — voir SPEC_MODULE_SOUS_MARIN.md pour le module qui les débloquera).';

export function runSwimEngine(
  lengths: LengthMeasurement[],
  profile: SwimmerProfile,
  feedbackHistory: FeedbackEntry[] = [],
  weights: EfficiencyWeights = DEFAULT_EFFICIENCY_WEIGHTS
): SwimSessionResult {
  const metrics = aggregateSession(lengths, profile.poolLengthM);
  const breathing = computeBreathingSymmetry(lengths);
  const flags = computeFlags(breathing, metrics.lengthsAnalyzed);
  const efficiencyScore = computeEfficiencyScore(metrics, breathing, profile, weights);

  // Roulis/battement : agrégat simple (moyenne) des signaux fournis, confiance = la plus
  // basse observée (jamais optimiste sur la confiance globale à partir de signaux partiels).
  const rollSignals = lengths.map((l) => l.rollProxyDeg).filter((s): s is VisionSignal<number> => !!s);
  const kickSignals = lengths.map((l) => l.kickIndex).filter((s): s is VisionSignal<number> => !!s);

  return {
    lengths_analyzed: metrics.lengthsAnalyzed,
    measured: {
      stroke_rate_avg: metrics.strokeRateAvg,
      dps_avg_m: metrics.dpsAvg,
      swolf_avg: metrics.swolfAvg,
    },
    vision_signals: {
      roll_proxy_deg: aggregateVisionSignal(rollSignals),
      breathing_symmetry: { ratio_left_right: breathing.ratioLeft, confidence: breathing.totalBreaths > 0 ? 'moyenne' : 'faible' },
      kick_index: aggregateVisionSignal(kickSignals),
    },
    efficiency_score: efficiencyScore,
    flags,
    shoulder_vigilance: shouldFlagShoulderVigilance(feedbackHistory),
    out_of_scope_note: OUT_OF_SCOPE_NOTE,
  };
}

function aggregateVisionSignal(signals: VisionSignal<number>[]): VisionSignal<number> | null {
  if (signals.length === 0) return null;
  const confidenceRank: Record<Confidence, number> = { faible: 0, moyenne: 1, haute: 2 };
  const lowestConfidence = signals.reduce((worst, s) => (confidenceRank[s.confidence] < confidenceRank[worst] ? s.confidence : worst), signals[0].confidence);
  return { value: round1(mean(signals.map((s) => s.value))), confidence: lowestConfidence };
}

// ---------- Utilitaires ----------

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[], avg: number): number {
  return mean(values.map((v) => (v - avg) ** 2));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStrokeRate,
  computeDPS,
  computeSWOLF,
  aggregateSession,
  computeBreathingSymmetry,
  computeFlags,
  computeEfficiencyScore,
  shouldFlagShoulderVigilance,
  runSwimEngine,
  DEFAULT_EFFICIENCY_WEIGHTS,
  type LengthMeasurement,
  type SwimmerProfile,
  type FeedbackEntry,
} from './swim-analysis-engine';

function mkLength(id: string, durationS: number, strokeCount: number, breathingSides: LengthMeasurement['breathingSides'] = []): LengthMeasurement {
  return { id, durationS, strokeCount, breathingSides };
}

describe('computeStrokeRate — §3 du spec, cycles/min', () => {
  test('20 brasses en 30s -> 40 cycles/min (calcul manuel : 20/30*60 = 40)', () => {
    assert.equal(computeStrokeRate(30, 20), 40);
  });
  test('lève une erreur explicite si durée ou nombre de brasses <= 0', () => {
    assert.throws(() => computeStrokeRate(0, 20), /durationS doit être > 0/);
    assert.throws(() => computeStrokeRate(30, 0), /strokeCount doit être > 0/);
  });
});

describe('computeDPS — §3 du spec, distance par brasse', () => {
  test('bassin 25m, 14 brasses -> 1.8 m/brasse (calcul manuel : 25/14 = 1.7857)', () => {
    assert.equal(computeDPS(25, 14), 1.8);
  });
  test('lève une erreur explicite si bassin ou brasses <= 0', () => {
    assert.throws(() => computeDPS(0, 14), /poolLengthM doit être > 0/);
    assert.throws(() => computeDPS(25, 0), /strokeCount doit être > 0/);
  });
});

describe('computeSWOLF — §3 du spec, durée(s) + brasses', () => {
  test('30s + 18 brasses -> 48 (convention standard, pas un calcul à sourcer davantage)', () => {
    assert.equal(computeSWOLF(30, 18), 48);
  });
});

describe('aggregateSession — agrège plusieurs longueurs (§3 du spec)', () => {
  const lengths = [mkLength('l1', 30, 18), mkLength('l2', 32, 20), mkLength('l3', 29, 17)];

  test('moyenne SR/DPS/SWOLF sur 3 longueurs, bassin 25m', () => {
    const agg = aggregateSession(lengths, 25);
    assert.equal(agg.lengthsAnalyzed, 3);
    // SR : (36 + 37.5 + 35.17) / 3 ≈ 36.22 -> calcul manuel arrondi 1 décimale
    assert.equal(agg.strokeRateAvg, 36.2);
    // DPS : (25/18 + 25/20 + 25/17) / 3 = (1.3889+1.25+1.4706)/3 ≈ 1.3698 -> 1.4
    assert.equal(agg.dpsAvg, 1.4);
  });

  test('liste vide -> agrégat neutre, aucune division par zéro', () => {
    const agg = aggregateSession([], 25);
    assert.deepEqual(agg, { lengthsAnalyzed: 0, strokeRateAvg: 0, dpsAvg: 0, swolfAvg: 0, swolfVariance: 0 });
  });

  test('SWOLF variance nulle si toutes les longueurs identiques', () => {
    const flat = [mkLength('a', 30, 18), mkLength('b', 30, 18)];
    const agg = aggregateSession(flat, 25);
    assert.equal(agg.swolfVariance, 0);
  });
});

describe('computeBreathingSymmetry — §3 du spec, comptage pur une fois les côtés connus', () => {
  test('8 respirations droite / 2 gauche sur 3 longueurs -> asymétrie détectée (0.8 >= seuil 0.7)', () => {
    const lengths = [
      mkLength('l1', 30, 18, ['right', 'right', 'right']),
      mkLength('l2', 30, 18, ['right', 'right', 'right']),
      mkLength('l3', 30, 18, ['right', 'right', 'left', 'left']),
    ];
    const sym = computeBreathingSymmetry(lengths);
    assert.equal(sym.totalBreaths, 10);
    assert.equal(sym.ratioRight, 0.8);
    assert.equal(sym.dominantSide, 'right');
  });

  test('50/50 -> équilibré, pas de côté dominant', () => {
    const lengths = [mkLength('l1', 30, 18, ['left', 'right', 'left', 'right'])];
    const sym = computeBreathingSymmetry(lengths);
    assert.equal(sym.dominantSide, 'balanced');
  });

  test('aucune donnée de respiration -> neutre, pas de NaN', () => {
    const sym = computeBreathingSymmetry([mkLength('l1', 30, 18)]);
    assert.equal(sym.totalBreaths, 0);
    assert.equal(sym.dominantSide, 'balanced');
  });
});

describe('computeFlags — §7 du spec, format de sortie', () => {
  test('asymétrie détectée -> flag avec pourcentage et nombre de longueurs (cf. exemple JSON §7 du spec)', () => {
    const lengths = Array.from({ length: 6 }, (_, i) => mkLength(`l${i}`, 30, 18, ['right', 'right', 'right', 'right']));
    const sym = computeBreathingSymmetry(lengths);
    const flags = computeFlags(sym, 6);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].type, 'breathing_asymmetry');
    assert.match(flags[0].detail, /100% des respirations côté droit sur 6 longueur/);
  });

  test('équilibré -> aucun flag', () => {
    const sym = computeBreathingSymmetry([mkLength('l1', 30, 18, ['left', 'right'])]);
    assert.equal(computeFlags(sym, 1).length, 0);
  });
});

describe('computeEfficiencyScore — §5 du spec', () => {
  const profile: SwimmerProfile = { poolLengthM: 25, level: 'intermediaire' };

  test('sans dpsBaselineM déclaré -> pas de pénalité DPS (neutre, cf. §9 du spec)', () => {
    const lengths = [mkLength('l1', 30, 18), mkLength('l2', 30, 18), mkLength('l3', 30, 18)];
    const agg = aggregateSession(lengths, 25);
    const sym = computeBreathingSymmetry(lengths);
    const score = computeEfficiencyScore(agg, sym, profile);
    // Pas de baseline, pas de variance SWOLF (longueurs identiques), pas d'asymétrie -> 100
    assert.equal(score, 100);
  });

  test('DPS sous la baseline déclarée -> pénalité (baseline fournie explicitement par profil)', () => {
    const lengths = [mkLength('l1', 30, 25), mkLength('l2', 30, 25), mkLength('l3', 30, 25)]; // DPS = 25/25 = 1.0
    const agg = aggregateSession(lengths, 25);
    const sym = computeBreathingSymmetry(lengths);
    const withBaseline: SwimmerProfile = { ...profile, dpsBaselineM: 1.8 };
    const score = computeEfficiencyScore(agg, sym, withBaseline);
    assert.ok(score < 100, `score ${score} devrait être pénalisé (DPS 1.0 très sous baseline 1.8)`);
  });

  test('asymétrie respiratoire -> pénalité fixe appliquée', () => {
    const lengths = [
      mkLength('l1', 30, 18, ['right', 'right', 'right', 'right']),
      mkLength('l2', 30, 18, ['right', 'right', 'right', 'right']),
      mkLength('l3', 30, 18, ['right', 'right', 'right', 'right']),
    ];
    const agg = aggregateSession(lengths, 25);
    const sym = computeBreathingSymmetry(lengths);
    const score = computeEfficiencyScore(agg, sym, profile);
    assert.equal(score, 100 - DEFAULT_EFFICIENCY_WEIGHTS.breathingAsymmetry);
  });

  test('moins de 3 longueurs -> confidenceWeighting ramène le score vers 100 (agrégat trop fragile)', () => {
    const oneLength = [mkLength('l1', 30, 18, ['right', 'right', 'right', 'right'])];
    const agg = aggregateSession(oneLength, 25);
    const sym = computeBreathingSymmetry(oneLength);
    const scoreOne = computeEfficiencyScore(agg, sym, profile);
    const threeLengths = [oneLength[0], mkLength('l2', 30, 18, ['right', 'right', 'right', 'right']), mkLength('l3', 30, 18, ['right', 'right', 'right', 'right'])];
    const agg3 = aggregateSession(threeLengths, 25);
    const sym3 = computeBreathingSymmetry(threeLengths);
    const scoreThree = computeEfficiencyScore(agg3, sym3, profile);
    assert.ok(scoreOne > scoreThree, `1 longueur (${scoreOne}) devrait être moins pénalisée que 3 (${scoreThree}) — agrégat jugé moins fiable`);
  });
});

describe('shouldFlagShoulderVigilance — §6 du spec, jamais un diagnostic, juste un pattern', () => {
  test('2 sorties consécutives à >=4 -> vigilance', () => {
    const history: FeedbackEntry[] = [
      { shoulderComfort: 2, breathlessness: 2 },
      { shoulderComfort: 4, breathlessness: 3 },
      { shoulderComfort: 5, breathlessness: 3 },
    ];
    assert.equal(shouldFlagShoulderVigilance(history), true);
  });

  test('un seul retour isolé à 5 -> pas de vigilance (évite l\'overfit à un mauvais jour)', () => {
    const history: FeedbackEntry[] = [
      { shoulderComfort: 2, breathlessness: 2 },
      { shoulderComfort: 5, breathlessness: 3 },
    ];
    assert.equal(shouldFlagShoulderVigilance(history), false);
  });

  test('historique vide ou trop court -> pas de vigilance', () => {
    assert.equal(shouldFlagShoulderVigilance([]), false);
    assert.equal(shouldFlagShoulderVigilance([{ shoulderComfort: 5, breathlessness: 5 }]), false);
  });
});

describe('runSwimEngine — pipeline complet, format §7 du spec', () => {
  const profile: SwimmerProfile = { poolLengthM: 25, level: 'intermediaire' };

  test('sortie complète avec signaux vision et flag asymétrie', () => {
    const lengths: LengthMeasurement[] = [
      mkLength('l1', 30, 18, ['right', 'right', 'right', 'right']),
      { ...mkLength('l2', 31, 19, ['right', 'right', 'right']), rollProxyDeg: { value: 28, confidence: 'faible' }, kickIndex: { value: 0.6, confidence: 'faible' } },
      mkLength('l3', 29, 17, ['right', 'right', 'right', 'right']),
    ];
    const result = runSwimEngine(lengths, profile);
    assert.equal(result.lengths_analyzed, 3);
    assert.equal(result.flags[0].type, 'breathing_asymmetry');
    assert.equal(result.vision_signals.roll_proxy_deg?.value, 28);
    assert.equal(result.vision_signals.roll_proxy_deg?.confidence, 'faible');
    assert.match(result.out_of_scope_note, /Attaque/);
    assert.equal(result.shoulder_vigilance, false);
  });

  test('aucun signal vision fourni -> null explicite, pas un objet vide trompeur', () => {
    const lengths = [mkLength('l1', 30, 18), mkLength('l2', 30, 18), mkLength('l3', 30, 18)];
    const result = runSwimEngine(lengths, profile);
    assert.equal(result.vision_signals.roll_proxy_deg, null);
    assert.equal(result.vision_signals.kick_index, null);
  });

  test('avertissement de vigilance épaule remonté dans la sortie si pattern détecté', () => {
    const lengths = [mkLength('l1', 30, 18), mkLength('l2', 30, 18), mkLength('l3', 30, 18)];
    const feedback: FeedbackEntry[] = [
      { shoulderComfort: 4, breathlessness: 2 },
      { shoulderComfort: 4, breathlessness: 2 },
    ];
    const result = runSwimEngine(lengths, profile, feedback);
    assert.equal(result.shoulder_vigilance, true);
  });
});

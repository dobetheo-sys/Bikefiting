import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aslrToFlexScore,
  computeReferenceSaddleHeightCm,
  runEngine,
  recalibrateWeights,
  type Trial,
  type AthleteProfile,
  type SubjectiveWeights,
} from './posture-aero-engine';

function mkTrial(id: string, hip: number, trunk: number, pfsa: number, headOff: number, deltas: Trial['deltas']): Trial {
  return {
    id,
    angles: {
      hip: { mean: hip, min: hip - 3, max: hip + 3, amplitude: 6, variance: 1.2 },
      trunk: { mean: trunk, min: trunk - 2, max: trunk + 2, amplitude: 4, variance: 0.8 },
      knee: { mean: 143, min: 139, max: 148, amplitude: 9, variance: 0.5 },
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
    },
    frontal: { pFSA_cm2: pfsa, athleteHeight_cm: 178, headOffset_cm: headOff },
    deltas,
  };
}

describe('aslrToFlexScore — §3.1 du spec, seuil clinique 80°', () => {
  test('sous 60° -> score 1', () => assert.equal(aslrToFlexScore(55), 1));
  test('75° -> score 3 (juste sous le seuil clinique de 80°)', () => assert.equal(aslrToFlexScore(75), 3));
  test('80° pile -> score 4 (ROM normale)', () => assert.equal(aslrToFlexScore(80), 4));
  test('95° -> score 5', () => assert.equal(aslrToFlexScore(95), 5));
});

describe('computeReferenceSaddleHeightCm — formule LeMond (entrejambe × 0.883)', () => {
  test('entrejambe 82cm -> 72.4cm (calcul manuel : 82 × 0.883 = 72.406)', () => {
    assert.equal(computeReferenceSaddleHeightCm(82), 72.4);
  });
  test('lève une erreur explicite si entrejambe <= 0', () => {
    assert.throws(() => computeReferenceSaddleHeightCm(0), /entrejambe doit être > 0/);
    assert.throws(() => computeReferenceSaddleHeightCm(-5), /entrejambe doit être > 0/);
  });
});

describe('runEngine — validation, scoring, sélection Pareto', () => {
  const profile: AthleteProfile = { hipFlexibilityScore: aslrToFlexScore(75), raceDurationHours: 2.75 };
  const weights: SubjectiveWeights = { neck: 1, lowerBack: 1, hands: 1, knees: 1 };

  const trials: Trial[] = [
    mkTrial('t1_baseline', 42, 12, 3800, 2, { saddleHeightMm: 0, reachMm: 0, dropMm: 0 }),
    mkTrial('t2_confort', 47, 14, 4100, 1, { saddleHeightMm: 0, reachMm: -10, dropMm: -5 }),
    mkTrial('t3_aero', 41, 6, 3550, 4, { saddleHeightMm: 0, reachMm: 15, dropMm: 15 }),
    mkTrial('t4_trop_ferme', 36, 5, 3400, 5, { saddleHeightMm: 0, reachMm: 20, dropMm: 25 }), // hanche < 40° -> doit être exclu
    mkTrial('t5_equilibre', 44, 9, 3700, 2, { saddleHeightMm: 0, reachMm: 5, dropMm: 5 }),
  ];

  const result = runEngine(trials, profile, weights);

  test('status ok avec 5 essais dont 1 sous le plancher hanche', () => {
    assert.equal(result.status, 'ok');
  });

  test('essai à hanche 36° est exclu pour violation hip_floor (plancher 40°, cf. §3)', () => {
    if (result.status !== 'ok') throw new Error('précondition du test non remplie : status attendu ok');
    assert.equal(result.trials_excluded, 1);
    const excluded = result.excluded_trials[0];
    assert.equal(excluded.trial_id, 't4_trop_ferme');
    assert.equal(excluded.violations[0].param, 'hip_floor');
    assert.equal(excluded.violations[0].bound, 40);
  });

  test('4 essais valides scorés', () => {
    assert.equal(result.trials_valid, 4);
  });

  test('confort_max correspond à l\'essai avec la meilleure hanche/tronc (t2)', () => {
    if (result.status !== 'ok') throw new Error('précondition du test non remplie : status attendu ok');
    assert.equal(result.profiles?.confort_max.trial_id, 't2_confort');
  });

  test('insufficient_valid_trials si moins de 3 essais valides', () => {
    const tooFew = runEngine([trials[0], trials[3]], profile, weights); // 1 valide, 1 exclu
    assert.equal(tooFew.status, 'insufficient_valid_trials');
  });
});

describe('recalibrateWeights — §7, pas d\'overfit à un retour isolé', () => {
  const base: SubjectiveWeights = { neck: 1, lowerBack: 1, hands: 1, knees: 1 };

  test('2 sorties consécutives douleur nuque ≥4 -> poids nuque augmente', () => {
    const next = recalibrateWeights(base, [
      [{ zone: 'neck', painScore: 4 }],
      [{ zone: 'neck', painScore: 5 }],
    ]);
    assert.equal(next.neck, 1.2);
    assert.equal(next.lowerBack, 1); // zones non concernées inchangées
  });

  test('1 seule sortie avec douleur -> pas de recalibration (évite overfit à un mauvais jour)', () => {
    const next = recalibrateWeights(base, [[{ zone: 'neck', painScore: 5 }]]);
    assert.equal(next.neck, 1);
  });
});

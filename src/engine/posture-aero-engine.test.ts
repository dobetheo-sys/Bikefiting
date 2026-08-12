import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aslrToFlexScore,
  computeReferenceSaddleHeightCm,
  suggestNextAdjustment,
  validateTrial,
  computeComfortScore,
  computeAeroScore,
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
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
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

describe('suggestNextAdjustment — écart le plus grand -> réglage vélo à toucher', () => {
  const profile: AthleteProfile = { hipFlexibilityScore: 3 }; // cible hanche 46°

  test('tronc trop haut (cas réel terrain, essai à 745mm/125/515/95) -> suggère plus de drop/reach', () => {
    const t = mkTrial('t1', 47.5, 19.2, 722.4, 2, { saddleHeightMm: 745, saddleSetbackMm: 125, reachMm: 515, dropMm: 95 });
    const s = suggestNextAdjustment(t, profile);
    assert.equal(s?.param, 'trunk_high');
    assert.equal(s?.gapDeg, 4.2); // 19.2 - 15
    assert.match(s?.message ?? '', /drop/);
  });

  test('hanche plus fermée que la cible -> suggère reculer la selle / réduire drop-reach', () => {
    const t = mkTrial('t2', 41, 10, 700, 2, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 }); // tronc 10° = dans la zone [5,15]
    const s = suggestNextAdjustment(t, profile);
    assert.equal(s?.param, 'hip');
    assert.equal(s?.gapDeg, 5); // cible 46 - hanche 41
    assert.match(s?.message ?? '', /reculer la selle/);
  });

  test('genou trop plié au point bas -> suggère de monter la selle', () => {
    const t: Trial = {
      id: 't3',
      angles: {
        hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
        trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
        knee: { mean: 133, min: 130, max: 145, amplitude: 15, variance: 0.5 }, // min 130 < KNEE_MIN 137
        ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
        wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
        shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
        elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
      },
      frontal: { pFSA_cm2: 700, athleteHeight_cm: 178, headOffset_cm: 2 },
      deltas: { saddleHeightMm: 700, reachMm: 515, dropMm: 95 },
    };
    const s = suggestNextAdjustment(t, profile);
    assert.equal(s?.param, 'knee_flexed');
    assert.equal(s?.gapDeg, 7); // 137 - 130
    assert.match(s?.message ?? '', /monter la selle/);
  });

  test('aucun paramètre hors de sa zone cible -> pas de suggestion', () => {
    const t = mkTrial('t4', 47, 10, 700, 2, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 }); // hanche > cible 46, tronc dans [5,15], genou par défaut dans [137,150]
    assert.equal(suggestNextAdjustment(t, profile), null);
  });

  test("objectif 'comfort' -> pas de suggestion tronc même très hors plage (pas de cible sourcée)", () => {
    const t = mkTrial('t5', 47, 35, 700, 2, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 }); // tronc 35°, hanche > cible, genou par défaut ok
    assert.equal(suggestNextAdjustment(t, { hipFlexibilityScore: 3, goal: 'comfort' }), null);
  });
});

// Audit fiabilité : un angle NaN (2 points tapés au même endroit — angleAt() dans
// capture-processing.ts retourne NaN pour un vecteur de longueur nulle) ne doit JAMAIS produire
// un essai valide : les comparaisons < / > utilisées plus bas dans validateTrial valent toutes
// silencieusement false pour NaN, donc sans ce garde-fou explicite un essai corrompu serait
// accepté (et pourrait même dominer dans paretoFront, aucune comparaison NaN >= n'étant jamais
// vraie non plus).
describe('computeAeroScore — garde-fous division par zéro', () => {
  test('cohortMaxPFSANorm = 0 (session entière à pFSA 0) -> score 0, pas NaN', () => {
    const t = mkTrial('t1', 46, 10, 0, 0, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 });
    const score = computeAeroScore(t, 0);
    assert.equal(Number.isNaN(score), false);
    assert.ok(score >= 0);
  });

  test('athleteHeight_cm falsy -> score défini (pas NaN)', () => {
    const t = mkTrial('t1', 46, 10, 700, 0, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 });
    t.frontal.athleteHeight_cm = 0;
    const score = computeAeroScore(t, 5);
    assert.equal(Number.isNaN(score), false);
  });
});

describe('validateTrial — knee_range affiche la valeur/le seuil réellement franchi', () => {
  const profile: AthleteProfile = { hipFlexibilityScore: 3 };

  test('genou trop plié (min < 137) -> value=min, bound=KNEE_MIN (pas la moyenne)', () => {
    const angles = {
      hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: 143, min: 130, max: 148, amplitude: 18, variance: 0.5 }, // moyenne 143 est dans [137,150], seul min=130 est hors plage
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const v = validateTrial(angles, profile);
    assert.equal(v.violations[0]?.value, 130); // pas 143 (la moyenne, qui est dans la plage)
    assert.equal(v.violations[0]?.bound, 137);
  });

  test('genou trop tendu (max > 150) -> value=max, bound=KNEE_MAX', () => {
    const angles = {
      hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: 143, min: 139, max: 155, amplitude: 16, variance: 0.5 }, // moyenne 143 est dans [137,150], seul max=155 est hors plage
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const v = validateTrial(angles, profile);
    assert.equal(v.violations[0]?.value, 155);
    assert.equal(v.violations[0]?.bound, 150);
  });
});

// wrist.mean était câblé à 0 en permanence avant la mesure manuelle épaule/coude/poignet
// (12/08/2026) — ce chemin n'avait donc jamais été exercé avec une vraie valeur au-dessus du
// seuil. On vérifie ici qu'il se déclenche correctement maintenant qu'il est atteignable.
describe('validateTrial — wrist_bend (poignet cassé), atteignable pour la première fois', () => {
  const profile: AthleteProfile = { hipFlexibilityScore: 3 };

  test('poignet fléchi au-delà de WRIST_WARN (15°) -> avertissement, pas exclusoire', () => {
    const angles = {
      hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: 143, min: 139, max: 148, amplitude: 9, variance: 0.5 },
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 22, min: 22, max: 22, amplitude: 0, variance: 0 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const v = validateTrial(angles, profile);
    assert.equal(v.valid, true); // avertissement seulement, cf. WRIST_WARN [DEFAULT] non exclusoire
    assert.equal(v.warnings[0]?.param, 'wrist_bend');
    assert.equal(v.warnings[0]?.value, 22);
    assert.equal(v.warnings[0]?.bound, 15);
  });

  test('poignet sous le seuil -> aucun avertissement', () => {
    const angles = {
      hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: 143, min: 139, max: 148, amplitude: 9, variance: 0.5 },
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 5, min: 5, max: 5, amplitude: 0, variance: 0 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const v = validateTrial(angles, profile);
    assert.equal(v.warnings.some((w) => w.param === 'wrist_bend'), false);
  });
});

describe('validateTrial — garde-fou NaN (2 points tapés confondus)', () => {
  const profile: AthleteProfile = { hipFlexibilityScore: 3 };

  test('hanche NaN -> essai invalide avec une violation invalid_measurement, pas silencieusement accepté', () => {
    const angles = {
      hip: { mean: NaN, min: NaN, max: NaN, amplitude: 0, variance: 0 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: 143, min: 139, max: 148, amplitude: 9, variance: 0.5 },
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const v = validateTrial(angles, profile);
    assert.equal(v.valid, false);
    assert.equal(v.violations[0]?.param, 'invalid_measurement');
  });

  test('genou NaN -> également détecté, même si hanche/tronc sont valides', () => {
    const angles = {
      hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: NaN, min: NaN, max: NaN, amplitude: 0, variance: 0 },
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const v = validateTrial(angles, profile);
    assert.equal(v.valid, false);
    assert.equal(v.violations[0]?.param, 'invalid_measurement');
  });
});

// Retour terrain : "les critères sont très précis, j'ai dû tricher un peu pour aligner les
// points" puis "il faut élargir les zones... un débutant cherche une position confortable" —
// AthleteProfile.goal='comfort' repasse tronc/genou en avertissement (même convention que le
// poignet, non sourcé -> jamais exclusoire) sans changer la hanche (perte de puissance mesurée,
// indépendante du style visé).
describe("AthleteProfile.goal — 'comfort' assouplit tronc/genou sans toucher à la hanche", () => {
  const aero: AthleteProfile = { hipFlexibilityScore: 3 }; // goal absent -> 'aero' par défaut
  const comfort: AthleteProfile = { hipFlexibilityScore: 3, goal: 'comfort' };

  test("tronc à 35° (hors [5,15]) : exclusoire en 'aero', avertissement en 'comfort'", () => {
    const angles = mkTrial('x', 46, 35, 700, 0, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 }).angles;
    const vAero = validateTrial(angles, aero);
    assert.equal(vAero.valid, false);
    assert.equal(vAero.violations[0]?.param, 'trunk_max');

    const vComfort = validateTrial(angles, comfort);
    assert.equal(vComfort.valid, true);
    assert.equal(vComfort.violations.length, 0);
    assert.equal(vComfort.warnings.some((w) => w.param === 'trunk_max'), true);
  });

  test("genou hors plage : exclusoire en 'aero', avertissement en 'comfort'", () => {
    const angles = {
      hip: { mean: 46, min: 43, max: 49, amplitude: 6, variance: 1 },
      trunk: { mean: 10, min: 8, max: 12, amplitude: 4, variance: 0.5 },
      knee: { mean: 133, min: 130, max: 145, amplitude: 15, variance: 0.5 }, // min 130 < KNEE_MIN 137
      ankle: { mean: 0, min: -10, max: 10, amplitude: 18, variance: 0.3 },
      wrist: { mean: 8, min: 5, max: 11, amplitude: 6, variance: 0.2 },
      shoulder: { mean: 60, min: 60, max: 60, amplitude: 0, variance: 0 },
      elbow: { mean: 150, min: 150, max: 150, amplitude: 0, variance: 0 },
    };
    const vAero = validateTrial(angles, aero);
    assert.equal(vAero.valid, false);
    assert.equal(vAero.violations[0]?.param, 'knee_range');

    const vComfort = validateTrial(angles, comfort);
    assert.equal(vComfort.valid, true);
    assert.equal(vComfort.warnings.some((w) => w.param === 'knee_range'), true);
  });

  test("hanche sous 40° : reste exclusoire même en 'comfort' (perte de puissance, pas un style)", () => {
    const angles = mkTrial('x', 36, 10, 700, 0, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 }).angles;
    const vComfort = validateTrial(angles, comfort);
    assert.equal(vComfort.valid, false);
    assert.equal(vComfort.violations[0]?.param, 'hip_floor');
  });

  test("computeComfortScore : tronc à 35° ne coûte aucun point en 'comfort', coûte des points en 'aero'", () => {
    const weights: SubjectiveWeights = { neck: 1, lowerBack: 1, hands: 1, knees: 1 };
    const t = mkTrial('x', 46, 35, 700, 0, { saddleHeightMm: 745, reachMm: 515, dropMm: 95 });
    const scoreAero = computeComfortScore(t, aero, weights);
    const scoreComfort = computeComfortScore(t, comfort, weights);
    assert.ok(scoreComfort > scoreAero, `attendu comfort(${scoreComfort}) > aero(${scoreAero})`);
    // comfort : 100 - 0 (hanche à la cible) - 0 (tronc non pénalisé) - 4 (variance hip+trunk) = 96
    // aero    : 100 - 0 (hanche) - 40 (tronc, pénalité plafonnée) - 4 (variance) = 56
    assert.equal(scoreComfort, 96);
    assert.equal(scoreAero, 56);
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

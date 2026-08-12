import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunTrialMetrics,
  computeCadenceSpm,
  computeRunContact,
  computeVerticalOscillationRatio,
  describeFootStrike,
  estimateCadenceFromFrames,
  forwardSignFromFoot,
  MIN_SAMPLE_RATE_HZ,
  type RunContactTaps,
} from './running-capture-processing';
import { IDX, type PoseFrame } from '../shared/geometry';

// Repère image : x vers la droite, y vers le BAS (convention MediaPipe et taps sur photo).
// Coureur filmé de profil allant vers la DROITE : la pointe du pied est à droite du talon.
const facingRight: RunContactTaps = {
  shoulder: { x: 110, y: 100 },
  hip: { x: 100, y: 200 },
  knee: { x: 100, y: 300 },
  ankle: { x: 100, y: 400 },
  heel: { x: 95, y: 410 },
  toe: { x: 125, y: 405 },
};

describe('forwardSignFromFoot — le sens de course est déduit, jamais supposé', () => {
  test('pointe à droite du talon -> +1', () => {
    assert.equal(forwardSignFromFoot({ x: 95, y: 410 }, { x: 125, y: 405 }), 1);
  });
  test('pointe à gauche du talon -> -1', () => {
    assert.equal(forwardSignFromFoot({ x: 105, y: 410 }, { x: 75, y: 405 }), -1);
  });
  test('talon et pointe à la même abscisse -> null (indéterminable, pas deviné)', () => {
    assert.equal(forwardSignFromFoot({ x: 100, y: 410 }, { x: 100, y: 395 }), null);
  });
});

describe('computeRunContact — géométrie vérifiée à la main', () => {
  const m = computeRunContact(facingRight);

  test('longueur de jambe = somme des segments cuisse + tibia (100 + 100 = 200 px)', () => {
    assert.equal(m.legLengthPx, 200);
  });

  test('tibia parfaitement vertical (cheville pile sous le genou) -> 0°', () => {
    assert.equal(m.tibiaAngleDeg, 0);
  });

  test('jambe parfaitement tendue -> 0° de flexion de genou (angle interne 180°)', () => {
    assert.equal(m.kneeFlexionICDeg, 0);
  });

  test('buste : atan2(10, 100) = 5.7° vers l\'avant', () => {
    assert.equal(m.trunkLeanDeg, 5.7);
  });

  test('cheville pile sous la hanche -> overstrideRatio = 0', () => {
    assert.equal(m.overstrideRatio, 0);
  });

  test('pied : atan2(5, 30) = 9.5°, pointe plus haute que le talon -> attaque talon', () => {
    assert.equal(m.footStrikeAngleDeg, 9.5);
    assert.equal(describeFootStrike(m.footStrikeAngleDeg), 'talon');
  });
});

describe('computeRunContact — overstriding : cheville posée devant le genou et la hanche', () => {
  const m = computeRunContact({ ...facingRight, ankle: { x: 140, y: 400 } });

  test('tibia incliné vers l\'avant : atan2(40, 100) = 21.8° (signe positif = overstriding)', () => {
    assert.equal(m.tibiaAngleDeg, 21.8);
  });

  test('longueur de jambe = 100 + hypot(40,100) = 207.7 px', () => {
    assert.equal(m.legLengthPx, 207.7);
  });

  test('overstrideRatio = 40 / 207.7 = 0.193', () => {
    assert.equal(m.overstrideRatio, 0.193);
  });
});

// Le même geste filmé depuis l'autre côté doit donner exactement les mêmes chiffres : c'est
// précisément ce que signedAngleVsVertical/forwardSign servent à garantir. Sans ça, un coureur
// filmé de son côté gauche verrait son overstriding compté comme une foulée parfaite (angle de
// signe inverse), le défaut le plus coûteux du moteur passant totalement inaperçu.
describe('computeRunContact — invariance au sens de filmage (coureur allant vers la gauche)', () => {
  const mirrored = computeRunContact({
    shoulder: { x: 90, y: 100 },
    hip: { x: 100, y: 200 },
    knee: { x: 100, y: 300 },
    ankle: { x: 60, y: 400 },
    heel: { x: 105, y: 410 },
    toe: { x: 75, y: 405 },
  });
  const reference = computeRunContact({ ...facingRight, ankle: { x: 140, y: 400 } });

  test('sens détecté = -1', () => assert.equal(mirrored.forwardSign, -1));
  test('tibia identique au cas miroir (21.8°, et non -21.8°)', () => {
    assert.equal(mirrored.tibiaAngleDeg, reference.tibiaAngleDeg);
  });
  test('buste identique (5.7° vers l\'avant)', () => {
    assert.equal(mirrored.trunkLeanDeg, reference.trunkLeanDeg);
  });
  test('overstrideRatio identique (0.193)', () => {
    assert.equal(mirrored.overstrideRatio, reference.overstrideRatio);
  });
  test('attaque pied identique (9.5°, talon)', () => {
    assert.equal(mirrored.footStrikeAngleDeg, reference.footStrikeAngleDeg);
  });
});

// Même convention que angleAt() côté vélo : une mesure impossible produit NaN, que
// validateRunTrial transforme ensuite en exclusion explicite (invalid_measurement) plutôt que
// de la laisser traverser silencieusement le scoring.
describe('computeRunContact — mesure impossible -> NaN, jamais une valeur inventée', () => {
  test('talon/pointe confondus en x : sens indéterminable -> toutes les métriques NaN', () => {
    const m = computeRunContact({ ...facingRight, heel: { x: 100, y: 410 }, toe: { x: 100, y: 395 } });
    assert.equal(m.forwardSign, null);
    assert.ok(Number.isNaN(m.tibiaAngleDeg));
    assert.ok(Number.isNaN(m.overstrideRatio));
  });

  test('hanche/genou/cheville tapés au même point : longueur de jambe nulle -> NaN', () => {
    const m = computeRunContact({
      ...facingRight,
      hip: { x: 100, y: 300 },
      knee: { x: 100, y: 300 },
      ankle: { x: 100, y: 300 },
    });
    assert.ok(Number.isNaN(m.overstrideRatio));
  });
});

describe('computeCadenceSpm — appuis (pas foulées) par minute', () => {
  test('30 appuis en 10 s -> 180 pas/min', () => {
    assert.equal(computeCadenceSpm(30, 10), 180);
  });
  test('durée nulle ou négative -> erreur explicite', () => {
    assert.throws(() => computeCadenceSpm(30, 0), /durée doit être > 0/);
  });
  test('nombre d\'appuis négatif -> erreur explicite', () => {
    assert.throws(() => computeCadenceSpm(-1, 10), /ne peut pas être négatif/);
  });
});

describe('computeVerticalOscillationRatio — sans dimension, aucune calibration cm/px requise', () => {
  test('20 px d\'amplitude sur 200 px de jambe -> 0.1', () => {
    assert.equal(computeVerticalOscillationRatio({ x: 0, y: 400 }, { x: 0, y: 380 }, 200), 0.1);
  });
  test('longueur de jambe nulle -> erreur explicite plutôt qu\'une division par zéro', () => {
    assert.throws(() => computeVerticalOscillationRatio({ x: 0, y: 400 }, { x: 0, y: 380 }, 0), /doit être > 0/);
  });
});

// Frames synthétiques : bassin oscillant à `hz` Hz (1 oscillation = 1 appui), échantillonné à
// `sampleRateHz`. Hanche droite bien visible, gauche non -> pickSide doit choisir la droite.
function oscillatingFrames(hz: number, sampleRateHz: number, durationS: number): PoseFrame[] {
  const n = Math.round(sampleRateHz * durationS) + 1;
  return Array.from({ length: n }, (_, i) => {
    const t = i / sampleRateHz;
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
    landmarks[IDX.RIGHT_HIP] = { x: 0.5, y: 0.5 + 0.02 * Math.sin(2 * Math.PI * hz * t), visibility: 0.9 };
    landmarks[IDX.LEFT_HIP] = { x: 0.5, y: 0.5, visibility: 0.1 };
    return { landmarks, timestampMs: t * 1000 };
  });
}

describe('estimateCadenceFromFrames — cadence auto + garde-fou d\'échantillonnage (Nyquist)', () => {
  // Fourchette volontairement SERRÉE (±2%) : le moteur raisonne sur des écarts de cadence de 5
  // à 10%, donc une mesure à ±8% serait inutilisable tout en ayant l'air de marcher. Une
  // fourchette large ici laisserait passer exactement ce bug (c'est ce qui est arrivé : une
  // première version renvoyait 165 au lieu de 180, cf. le commentaire dans l'implémentation).
  test('3 Hz (180 pas/min) échantillonné à 30 Hz -> 180 ± 2%, fiable', () => {
    const e = estimateCadenceFromFrames(oscillatingFrames(3, 30, 4));
    assert.equal(e.reliable, true);
    assert.equal(e.sampleRateHz, 30);
    assert.ok(e.cadenceSpm >= 176.4 && e.cadenceSpm <= 183.6, `cadence estimée ${e.cadenceSpm}, attendu ~180`);
  });

  test('2.5 Hz (150 pas/min) -> 150 ± 2% : la mesure suit la vraie cadence, pas une constante', () => {
    const e = estimateCadenceFromFrames(oscillatingFrames(2.5, 30, 4));
    assert.equal(e.reliable, true);
    assert.ok(e.cadenceSpm >= 147 && e.cadenceSpm <= 153, `cadence estimée ${e.cadenceSpm}, attendu ~150`);
  });

  test('même signal échantillonné à 4 Hz -> marqué NON fiable (sous le seuil Nyquist)', () => {
    const e = estimateCadenceFromFrames(oscillatingFrames(3, 4, 4));
    assert.equal(e.reliable, false);
    assert.ok(e.sampleRateHz < MIN_SAMPLE_RATE_HZ);
    assert.match(e.reason ?? '', /échantillonnage trop lâche/);
  });

  test('bassin immobile -> pas de cadence inventée', () => {
    const flat = oscillatingFrames(0, 30, 4);
    const e = estimateCadenceFromFrames(flat);
    assert.equal(e.reliable, false);
    assert.ok(Number.isNaN(e.cadenceSpm));
  });

  test('moins de 2 frames -> non fiable, raison explicite', () => {
    const e = estimateCadenceFromFrames([]);
    assert.equal(e.reliable, false);
    assert.match(e.reason ?? '', /moins de 2 frames/);
  });
});

describe('describeFootStrike — repère descriptif, aucune notion de "bon" ou "mauvais"', () => {
  test('pointe nettement plus haute que le talon -> talon', () => assert.equal(describeFootStrike(12), 'talon'));
  test('pied à plat -> medio-pied', () => assert.equal(describeFootStrike(2), 'medio-pied'));
  test('pointe plus basse que le talon -> avant-pied', () => assert.equal(describeFootStrike(-9), 'avant-pied'));
  test('mesure NaN -> indéterminé', () => assert.equal(describeFootStrike(NaN), 'indéterminé'));
});

describe('buildRunTrialMetrics — assemblage contact + cadence', () => {
  test('oscillation verticale omise -> champ absent (le moteur sait s\'en passer)', () => {
    const metrics = buildRunTrialMetrics(computeRunContact(facingRight), 176);
    assert.equal(metrics.cadenceSpm, 176);
    assert.equal(metrics.trunkLeanDeg, 5.7);
    assert.equal(metrics.verticalOscillationRatio, undefined);
  });
});

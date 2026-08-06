import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractTrialAngles, computePFSA_cm2, IDX, type PoseFrame, type Landmark, type BinaryMask } from './capture-processing';

/**
 * Coordonnées VÉRIFIÉES À LA MAIN (produit scalaire calculé manuellement, pas juste
 * "plausibles") pour confirmer que angleAt() et angleVsHorizontal() sont mathématiquement
 * corrects. Voir la session de debug du 06/08/2026 : la première version de
 * angleVsHorizontal donnait ~63° au lieu de 12° pour un segment pointant vers l'arrière —
 * bug de signe corrigé, ce test empêche une régression silencieuse.
 *
 * hip attendu ≈ 45.0°, trunk attendu ≈ 12.0° (calcul manuel, voir commentaires inline).
 * knee/ankle : coordonnées non ciblées précisément, juste vérifiées "non-NaN, plausibles".
 */
function synthCycleFrames(): PoseFrame[] {
  const base = {
    shoulder: { x: 0.2, y: 0.4862, visibility: 0.95 },
    hip: { x: 0.5, y: 0.55, visibility: 0.97 },
    knee: { x: 0.3474, y: 0.3151, visibility: 0.9 },
    ankle: { x: 0.3, y: 0.55, visibility: 0.85 },
    foot: { x: 0.36, y: 0.57, visibility: 0.8 },
  };

  const frames: PoseFrame[] = [];
  for (let i = 0; i < 30; i++) {
    const kneeY = base.knee.y + 0.02 * Math.sin(i / 4);
    const landmarks: Landmark[] = new Array(33).fill({ x: 0, y: 0, visibility: 0 });
    landmarks[IDX.RIGHT_SHOULDER] = base.shoulder;
    landmarks[IDX.LEFT_SHOULDER] = { x: 0, y: 0, visibility: 0 };
    landmarks[IDX.RIGHT_HIP] = base.hip;
    landmarks[IDX.LEFT_HIP] = { x: 0, y: 0, visibility: 0 };
    landmarks[IDX.RIGHT_KNEE] = { ...base.knee, y: kneeY };
    landmarks[IDX.RIGHT_ANKLE] = base.ankle;
    landmarks[IDX.RIGHT_FOOT_INDEX] = base.foot;
    frames.push({ landmarks, timestampMs: i * 33 });
  }
  return frames;
}

describe('extractTrialAngles — géométrie vérifiée à la main', () => {
  const angles = extractTrialAngles(synthCycleFrames());

  test('hip mean proche de 45.0° (calcul manuel exact pour frame i=0)', () => {
    assert.ok(Math.abs(angles.hip.mean - 45) < 1.5, `hip.mean=${angles.hip.mean}, attendu ≈45.0°`);
  });

  test('trunk mean = 12.0° exact (indépendant de l\'oscillation du genou)', () => {
    assert.equal(angles.trunk.mean, 12);
  });

  test('trunk amplitude = 0 (le tronc ne bouge pas dans ce synthétique)', () => {
    assert.equal(angles.trunk.amplitude, 0);
  });

  test('knee/ankle produisent des valeurs numériques valides (pas de NaN)', () => {
    assert.ok(!Number.isNaN(angles.knee.mean));
    assert.ok(!Number.isNaN(angles.ankle.mean));
  });

  test('wrist est un stub à 0 tant que MediaPipe Hands n\'est pas intégré (limite documentée)', () => {
    assert.equal(angles.wrist.mean, 0);
    assert.equal(angles.wrist.amplitude, 0);
  });

  test('lève une erreur explicite si aucune frame fournie', () => {
    assert.throws(() => extractTrialAngles([]), /aucune frame/);
  });
});

describe('computePFSA_cm2 — méthode terrain Debraux et al. 2009', () => {
  test('surface calculée correctement à partir d\'un masque + calibration', () => {
    const mask: BinaryMask = { width: 100, height: 200, data: new Uint8Array(20000) };
    for (let i = 0; i < 6000; i++) mask.data[i] = 1;
    const pfsa = computePFSA_cm2(mask, { pixelLength: 50, realLengthCm: 40 });
    // 6000 px * (40cm / 50px)^2 = 3840 cm²
    assert.equal(pfsa, 3840);
  });

  test('rejette une calibration avec pixelLength <= 0', () => {
    const mask: BinaryMask = { width: 1, height: 1, data: new Uint8Array([1]) };
    assert.throws(() => computePFSA_cm2(mask, { pixelLength: 0, realLengthCm: 40 }), /pixelLength doit être > 0/);
  });
});

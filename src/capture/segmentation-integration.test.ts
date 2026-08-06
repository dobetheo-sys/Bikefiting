import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBikeFitBinaryMask,
  pixelLengthFromTaps,
  CATEGORY_PERSON,
  CATEGORY_BICYCLE,
  type SegmentationResult,
} from './segmentation-integration';
import { computePFSA_cm2 } from './capture-processing';

function fakeSegmentationResult(): SegmentationResult {
  const width = 10;
  const height = 10;
  const indices = new Uint8Array(width * height);
  for (let y = 3; y < 7; y++) for (let x = 2; x < 5; x++) indices[y * width + x] = CATEGORY_PERSON; // 12 px
  for (let y = 5; y < 8; y++) for (let x = 5; x < 9; x++) indices[y * width + x] = CATEGORY_BICYCLE; // 12 px
  indices[0] = 7; // bruit d'une classe non pertinente (ex. voiture en arrière-plan)
  return { categoryMask: { width, height, getAsUint8Array: () => indices } };
}

describe('toBikeFitBinaryMask — filtre uniquement personne + vélo', () => {
  test('compte 24 px (12 personne + 12 vélo), exclut le bruit', () => {
    const mask = toBikeFitBinaryMask(fakeSegmentationResult());
    const count = mask.data.reduce((s, v) => s + v, 0);
    assert.equal(count, 24);
  });

  test('conserve les dimensions du masque source', () => {
    const mask = toBikeFitBinaryMask(fakeSegmentationResult());
    assert.equal(mask.width, 10);
    assert.equal(mask.height, 10);
  });
});

describe('pixelLengthFromTaps — calibration manuelle par 2 points', () => {
  test('distance horizontale simple', () => {
    assert.equal(pixelLengthFromTaps({ xPx: 100, yPx: 50 }, { xPx: 150, yPx: 50 }), 50);
  });

  test('distance en diagonale (Pythagore)', () => {
    assert.equal(pixelLengthFromTaps({ xPx: 0, yPx: 0 }, { xPx: 3, yPx: 4 }), 5);
  });
});

describe('Intégration bout-en-bout — masque simulé + taps -> pFSA', () => {
  test('la chaîne complète produit la valeur attendue', () => {
    const mask = toBikeFitBinaryMask(fakeSegmentationResult());
    const px = pixelLengthFromTaps({ xPx: 100, yPx: 50 }, { xPx: 150, yPx: 50 }); // 50px
    const pfsa = computePFSA_cm2(mask, { pixelLength: px, realLengthCm: 40 });
    // 24 px * (40/50)^2 = 15.36 -> arrondi 1 décimale par computePFSA_cm2 -> 15.4
    assert.equal(pfsa, 15.4);
  });
});

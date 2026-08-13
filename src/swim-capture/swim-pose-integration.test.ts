import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toPoseFrame, type MPPoseLandmarkerResult } from './swim-pose-integration';

function fakeResult(landmarksForFirstPose: MPPoseLandmarkerResult['landmarks'][number]): MPPoseLandmarkerResult {
  return { landmarks: [landmarksForFirstPose] };
}

describe('toPoseFrame — conversion PoseLandmarkerResult -> PoseFrame (nage)', () => {
  test('reprend les landmarks de la première pose détectée et le timestamp fourni', () => {
    const lm = [{ x: 0.1, y: 0.2, z: 0, visibility: 0.9 }];
    const frame = toPoseFrame(fakeResult(lm), 1234);
    assert.deepEqual(frame, { landmarks: lm, timestampMs: 1234 });
  });

  test('retourne null si aucune pose détectée (ex. nageur hors du champ à cet instant)', () => {
    const frame = toPoseFrame({ landmarks: [] }, 1234);
    assert.equal(frame, null);
  });

  test('retourne null si la pose détectée a un tableau de landmarks vide', () => {
    const frame = toPoseFrame(fakeResult([]), 1234);
    assert.equal(frame, null);
  });
});

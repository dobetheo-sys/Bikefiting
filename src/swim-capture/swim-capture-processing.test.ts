import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectStrokeEvents,
  detectBreathingSides,
  computeRollProxy,
  computeKickIndex,
  buildLengthMeasurement,
  IDX,
  type Landmark,
  type PoseFrame,
} from './swim-capture-processing';

function defaultLandmarks(): Landmark[] {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
}

// patches: { [timestampMs]: { [landmarkIndex]: Partial<Landmark> } }
function mkFrames(timestampsMs: number[], patches: Record<number, Record<number, Partial<Landmark>>> = {}): PoseFrame[] {
  return timestampsMs.map((t) => {
    const landmarks = defaultLandmarks();
    const patch = patches[t];
    if (patch) {
      for (const [idx, values] of Object.entries(patch)) {
        landmarks[Number(idx)] = { ...landmarks[Number(idx)], ...values };
      }
    }
    return { landmarks, timestampMs: t };
  });
}

describe('detectStrokeEvents — §3 du spec, comptage de cycles de bras', () => {
  test('trajectoire du poignet droit avec 2 pics nets et bien séparés -> 2 events', () => {
    // y : 0.8, 0.6, 0.3 (pic), 0.6, 0.8, 0.6, 0.3 (pic), 0.6, 0.8 — pics à t=200 et t=600
    const ts = [0, 100, 200, 300, 400, 500, 600, 700, 800];
    const ys = [0.8, 0.6, 0.3, 0.6, 0.8, 0.6, 0.3, 0.6, 0.8];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {};
    ts.forEach((t, i) => (patches[t] = { [IDX.RIGHT_WRIST]: { y: ys[i] } }));
    const events = detectStrokeEvents(mkFrames(ts, patches));
    assert.equal(events.length, 2);
    assert.equal(events[0].timestampMs, 200);
    assert.equal(events[1].timestampMs, 600);
    assert.equal(events[0].side, 'RIGHT');
  });

  test('deux pics trop rapprochés (< 300ms) -> un seul compté', () => {
    const ts = [0, 100, 200, 300, 350, 400, 500, 600];
    const ys = [0.8, 0.6, 0.3, 0.6, 0.5, 0.3, 0.6, 0.8];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {};
    ts.forEach((t, i) => (patches[t] = { [IDX.RIGHT_WRIST]: { y: ys[i] } }));
    const events = detectStrokeEvents(mkFrames(ts, patches));
    assert.equal(events.length, 1);
    assert.equal(events[0].timestampMs, 200);
  });

  test('pic net mais visibilité basse (poignet probablement immergé) -> non détecté', () => {
    const ts = [0, 100, 200, 300, 400];
    const ys = [0.8, 0.6, 0.3, 0.6, 0.8];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {};
    ts.forEach((t, i) => (patches[t] = { [IDX.RIGHT_WRIST]: { y: ys[i], visibility: i === 2 ? 0.2 : 1 } }));
    const events = detectStrokeEvents(mkFrames(ts, patches));
    assert.equal(events.length, 0);
  });

  test('bras gauche et droit alternés -> events des deux côtés, triés par timestamp', () => {
    const ts = [0, 100, 200, 300, 400, 500];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {
      100: { [IDX.LEFT_WRIST]: { y: 0.3 } },
      400: { [IDX.RIGHT_WRIST]: { y: 0.3 } },
    };
    // besoin des frames voisines à y=0.6 pour que ce soit un minimum local
    ts.forEach((t) => {
      patches[t] = patches[t] ?? {};
      if (!patches[t][IDX.LEFT_WRIST]) patches[t][IDX.LEFT_WRIST] = { y: 0.6 };
      if (!patches[t][IDX.RIGHT_WRIST]) patches[t][IDX.RIGHT_WRIST] = { y: 0.6 };
    });
    const events = detectStrokeEvents(mkFrames(ts, patches));
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.side).sort(), ['LEFT', 'RIGHT']);
  });

  test('moins de 3 frames -> aucun event (pas assez pour un minimum local)', () => {
    assert.deepEqual(detectStrokeEvents(mkFrames([0, 100])), []);
  });
});

describe('detectBreathingSides — §3 du spec, côté déterminé par l\'oreille la plus visible', () => {
  test('nez qui redevient visible avec oreille gauche plus visible -> respiration côté gauche', () => {
    const ts = [0, 100, 200, 300];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {
      0: { [IDX.NOSE]: { visibility: 0.1 } },
      100: { [IDX.NOSE]: { visibility: 0.1 } },
      200: { [IDX.NOSE]: { visibility: 0.9 }, [IDX.LEFT_EAR]: { visibility: 0.9 }, [IDX.RIGHT_EAR]: { visibility: 0.3 } },
      300: { [IDX.NOSE]: { visibility: 0.9 }, [IDX.LEFT_EAR]: { visibility: 0.9 }, [IDX.RIGHT_EAR]: { visibility: 0.3 } },
    };
    const sides = detectBreathingSides(mkFrames(ts, patches));
    assert.deepEqual(sides, ['left']);
  });

  test('deux respirations, une par côté, dans l\'ordre chronologique', () => {
    const ts = [0, 100, 200, 300, 400, 500];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {
      0: { [IDX.NOSE]: { visibility: 0.1 } },
      100: { [IDX.NOSE]: { visibility: 0.9 }, [IDX.LEFT_EAR]: { visibility: 0.9 }, [IDX.RIGHT_EAR]: { visibility: 0.2 } },
      200: { [IDX.NOSE]: { visibility: 0.1 } },
      300: { [IDX.NOSE]: { visibility: 0.1 } },
      400: { [IDX.NOSE]: { visibility: 0.9 }, [IDX.LEFT_EAR]: { visibility: 0.2 }, [IDX.RIGHT_EAR]: { visibility: 0.9 } },
      500: { [IDX.NOSE]: { visibility: 0.1 } },
    };
    const sides = detectBreathingSides(mkFrames(ts, patches));
    assert.deepEqual(sides, ['left', 'right']);
  });

  test('visibilité des deux oreilles égale -> événement ambigu exclu', () => {
    const ts = [0, 100, 200];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {
      0: { [IDX.NOSE]: { visibility: 0.1 } },
      100: { [IDX.NOSE]: { visibility: 0.9 }, [IDX.LEFT_EAR]: { visibility: 0.5 }, [IDX.RIGHT_EAR]: { visibility: 0.5 } },
    };
    const sides = detectBreathingSides(mkFrames(ts, patches));
    assert.deepEqual(sides, []);
  });
});

describe('computeRollProxy — §4 du spec, confiance faible explicite', () => {
  test('épaules à des hauteurs différentes au moment du recovery -> angle non nul, confiance faible', () => {
    const ts = [0, 100, 200, 300, 400];
    const ys = [0.8, 0.6, 0.3, 0.6, 0.8];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {};
    ts.forEach((t, i) => (patches[t] = { [IDX.RIGHT_WRIST]: { y: ys[i] } }));
    // au frame du pic (t=200), épaules décalées : dx=0.1, dy=0.1 -> 45°
    patches[200][IDX.LEFT_SHOULDER] = { x: 0.45, y: 0.4 };
    patches[200][IDX.RIGHT_SHOULDER] = { x: 0.55, y: 0.5 };
    const roll = computeRollProxy(mkFrames(ts, patches));
    assert.ok(roll);
    assert.equal(roll?.value, 45);
    assert.equal(roll?.confidence, 'faible');
  });

  test('aucun cycle détecté -> null (pas de faux signal)', () => {
    const roll = computeRollProxy(mkFrames([0, 100]));
    assert.equal(roll, null);
  });
});

describe('computeKickIndex — §4 du spec, agrégat de mesures de mouvement externes', () => {
  test('moyenne des échantillons fournis, confiance toujours faible', () => {
    const idx = computeKickIndex([0.4, 0.6, 0.5]);
    assert.equal(idx.value, 0.5);
    assert.equal(idx.confidence, 'faible');
  });

  test('lève une erreur explicite si aucun échantillon', () => {
    assert.throws(() => computeKickIndex([]), /aucun échantillon fourni/);
  });
});

describe('buildLengthMeasurement — assemblage complet d\'une longueur', () => {
  function mkStrokeFrames() {
    const ts = [0, 100, 200, 300, 400, 500, 600, 700, 800];
    const ys = [0.8, 0.6, 0.3, 0.6, 0.8, 0.6, 0.3, 0.6, 0.8];
    const patches: Record<number, Record<number, Partial<Landmark>>> = {};
    ts.forEach((t, i) => (patches[t] = { [IDX.RIGHT_WRIST]: { y: ys[i] } }));
    return mkFrames(ts, patches);
  }

  test('longueur avec 2 cycles détectés -> durée, strokeCount et signaux assemblés', () => {
    const m = buildLengthMeasurement('l1', mkStrokeFrames(), [0.3, 0.5]);
    assert.equal(m.id, 'l1');
    assert.equal(m.durationS, 0.8); // 800ms
    assert.equal(m.strokeCount, 2);
    assert.ok(Array.isArray(m.breathingSides));
    assert.equal(m.kickIndex?.value, 0.4);
  });

  test('moins de 2 frames -> erreur explicite', () => {
    assert.throws(() => buildLengthMeasurement('l1', mkFrames([0])), /au moins 2 frames requises/);
  });

  test('aucun cycle de bras détecté (poignet immobile) -> erreur explicite plutôt qu\'un strokeCount de 0 silencieux', () => {
    const ts = [0, 100, 200, 300];
    assert.throws(() => buildLengthMeasurement('l1', mkFrames(ts)), /aucun cycle de bras détecté/);
  });
});

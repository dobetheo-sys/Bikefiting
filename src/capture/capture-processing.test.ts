import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTrialAngles,
  extractAslrAngle,
  extractAslrAngleTrace,
  computeManualAslrAngle,
  computeManualTrialPmh,
  computeManualTrialPmb,
  buildManualTrialAngles,
  computePFSA_cm2,
  IDX,
  type PoseFrame,
  type Landmark,
  type BinaryMask,
} from './capture-processing';

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

/**
 * Coordonnées construites (pas juste plausibles) : hanche fixe en (0.5, 0.5), la cuisse
 * (hanche->genou) tourne de 0° à 75° par pas de 15° sur 6 frames, cheville alignée
 * hanche-genou-cheville (genou verrouillé, angleAt = 180°). Frame 7 : la cheville quitte
 * l'alignement (genou qui plie, angleAt << 165°) -> doit stopper la mesure. Frame 8 :
 * angle cuisse plus élevé (85°) mais genou toujours plié -> NE DOIT PAS être pris en compte
 * (vérifie que le point d'arrêt est bien respecté, pas juste "le max sur toute la vidéo").
 */
function synthAslrFrames(): PoseFrame[] {
  const hip: Landmark = { x: 0.5, y: 0.5, visibility: 0.95 };
  const frames: PoseFrame[] = [];
  let t = 0;

  const pushFrame = (knee: Landmark, ankle: Landmark) => {
    const landmarks: Landmark[] = new Array(33).fill({ x: 0, y: 0, visibility: 0 });
    landmarks[IDX.RIGHT_HIP] = hip;
    landmarks[IDX.LEFT_HIP] = { x: 0, y: 0, visibility: 0 };
    landmarks[IDX.RIGHT_KNEE] = knee;
    landmarks[IDX.RIGHT_ANKLE] = ankle;
    frames.push({ landmarks, timestampMs: t });
    t += 33;
  };

  const dirAt = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return { x: Math.cos(rad), y: -Math.sin(rad) };
  };

  for (const angle of [0, 15, 30, 45, 60, 75]) {
    const u = dirAt(angle);
    const knee = { x: hip.x + 0.2 * u.x, y: hip.y + 0.2 * u.y, visibility: 0.9 };
    const ankle = { x: hip.x + 0.4 * u.x, y: hip.y + 0.4 * u.y, visibility: 0.85 }; // aligné hanche-genou-cheville
    pushFrame(knee, ankle);
  }

  const uBend = dirAt(85);
  const kneeBend = { x: hip.x + 0.2 * uBend.x, y: hip.y + 0.2 * uBend.y, visibility: 0.9 };
  pushFrame(kneeBend, { x: kneeBend.x + 0.15, y: kneeBend.y + 0.05, visibility: 0.85 }); // genou qui plie
  pushFrame(kneeBend, { x: hip.x + 0.4 * uBend.x, y: hip.y + 0.4 * uBend.y, visibility: 0.85 }); // après le point d'arrêt

  return frames;
}

/**
 * Reproduit le cas réel du 08/08/2026 : la vidéo commence par une phase d'installation
 * (utilisateur accroupi pour ajuster le téléphone, genou plié) AVANT que la personne
 * s'allonge et lève la jambe. Préfixe la séquence propre de `synthAslrFrames()` avec des
 * frames genou-plié dont la cuisse n'a jamais atteint le seuil d'engagement — ces frames ne
 * doivent pas déclencher l'arrêt de la mesure.
 */
function synthAslrFramesWithSetup(): PoseFrame[] {
  const hip: Landmark = { x: 0.5, y: 0.5, visibility: 0.95 };
  const setupFrames: PoseFrame[] = [];
  let t = -99; // avant les timestamps de synthAslrFrames()

  // Accroupi : genou très plié (angle hanche-genou-cheville bien sous le seuil de 165°),
  // cuisse quasi verticale — géométrie d'installation, pas du tout la levée testée.
  const crouchKnee = { x: hip.x + 0.05, y: hip.y - 0.15, visibility: 0.9 };
  const crouchAnkle = { x: hip.x + 0.02, y: hip.y - 0.02, visibility: 0.85 };
  for (let i = 0; i < 3; i++) {
    const landmarks: Landmark[] = new Array(33).fill({ x: 0, y: 0, visibility: 0 });
    landmarks[IDX.RIGHT_HIP] = hip;
    landmarks[IDX.LEFT_HIP] = { x: 0, y: 0, visibility: 0 };
    landmarks[IDX.RIGHT_KNEE] = crouchKnee;
    landmarks[IDX.RIGHT_ANKLE] = crouchAnkle;
    setupFrames.push({ landmarks, timestampMs: t });
    t += 33;
  }

  return [...setupFrames, ...synthAslrFrames()];
}

/**
 * Reproduit le cas réel du 10/08/2026 : une vidéo filmée trop loin et à contre-jour (caméra
 * dans une autre pièce, à travers une porte, en direction d'une fenêtre) n'a laissé le modèle
 * détecter QUE des frames "genou plié" (installation) — jamais la levée elle-même. Le genou
 * ne se redresse jamais au-dessus du seuil, donc la levée n'est jamais "engagée".
 */
function synthAslrFramesNeverEngaged(): PoseFrame[] {
  const hip: Landmark = { x: 0.5, y: 0.5, visibility: 0.95 };
  const crouchKnee: Landmark = { x: hip.x + 0.05, y: hip.y - 0.15, visibility: 0.9 };
  const crouchAnkle: Landmark = { x: hip.x + 0.02, y: hip.y - 0.02, visibility: 0.85 };
  const frames: PoseFrame[] = [];
  for (let i = 0; i < 5; i++) {
    const landmarks: Landmark[] = new Array(33).fill({ x: 0, y: 0, visibility: 0 });
    landmarks[IDX.RIGHT_HIP] = hip;
    landmarks[IDX.LEFT_HIP] = { x: 0, y: 0, visibility: 0 };
    landmarks[IDX.RIGHT_KNEE] = crouchKnee;
    landmarks[IDX.RIGHT_ANKLE] = crouchAnkle;
    frames.push({ landmarks, timestampMs: i * 33 });
  }
  return frames;
}

describe('extractAslrAngle — §3.1 du spec, point d\'arrêt = genou qui plie', () => {
  test('reprend le max de la cuisse tant que le genou reste verrouillé (75°, pas 85°)', () => {
    assert.equal(extractAslrAngle(synthAslrFrames()), 75);
  });

  test('lève une erreur explicite si aucune frame fournie', () => {
    assert.throws(() => extractAslrAngle([]), /aucune frame/);
  });

  test('ignore un genou plié pendant l\'installation, avant que la levée ne commence (retour terrain 08/08/2026)', () => {
    assert.equal(extractAslrAngle(synthAslrFramesWithSetup()), 75);
  });

  test('engagedAtIndex reste null si la levée n\'a jamais été détectée — un 0° silencieux serait trompeur (retour terrain 10/08/2026)', () => {
    const trace = extractAslrAngleTrace(synthAslrFramesNeverEngaged());
    assert.equal(trace.engagedAtIndex, null);
    assert.equal(trace.angle, 0);
  });
});

describe('computeManualAslrAngle — mesure par 3 taps (hanche/genou/cheville), retour terrain 10/08/2026', () => {
  // hanche->genou->cheville alignés, cuisse à 60° de l'horizontale (calcul manuel exact,
  // même construction que synthAslrFrames() ci-dessus).
  const hip: Landmark = { x: 0.5, y: 0.5, visibility: 0.95 };
  const knee: Landmark = { x: 0.6, y: 0.3268, visibility: 0.9 };
  const straightAnkle: Landmark = { x: 0.7, y: 0.1536, visibility: 0.85 };

  test('angle cuisse = 60° et genou = 180° quand hanche/genou/cheville sont alignés', () => {
    const m = computeManualAslrAngle(hip, knee, straightAnkle);
    assert.equal(m.angle, 60);
    assert.equal(m.kneeAngle, 180);
  });

  test('kneeAngle sous le seuil "tendu" quand la cheville sort de l\'alignement (genou plié)', () => {
    const bentAnkle: Landmark = { x: knee.x + 0.15, y: knee.y + 0.05, visibility: 0.85 };
    const m = computeManualAslrAngle(hip, knee, bentAnkle);
    assert.ok(m.kneeAngle < 165, `kneeAngle=${m.kneeAngle}, attendu < 165 (genou plié)`);
  });
});

describe('mesure manuelle vidéo profil (PMH/PMB) — retour terrain 10/08/2026', () => {
  // Mêmes coordonnées vérifiées à la main que synthCycleFrames() (voir plus haut) : hanche
  // attendue ≈45.0°, tronc attendu = 12.0° exact — inchangées par l'ajout épaule/coude/poignet
  // (12/08/2026), qui ne dépend que des nouveaux points ci-dessous.
  const shoulder: Landmark = { x: 0.2, y: 0.4862, visibility: 0.95 };
  const hipPmh: Landmark = { x: 0.5, y: 0.55, visibility: 0.97 };
  const kneePmh: Landmark = { x: 0.3474, y: 0.3151, visibility: 0.9 };

  // Bras construit pour des angles ronds, vérifiés à la main comme le reste du fichier :
  // épaule->coude horizontal, coude->poignet vertical (perpendiculaire) -> coudeAngle = 90°
  // exact. Poignet->main dans le prolongement exact de coude->poignet (colinéaire, même sens
  // que l'avant-bras) -> poignet aligné, aucun fléchissement -> wristBendAngle = 0° exact.
  const elbow: Landmark = { x: shoulder.x + 0.1, y: shoulder.y, visibility: 0.9 };
  const wrist: Landmark = { x: elbow.x, y: elbow.y + 0.1, visibility: 0.9 };
  const hand: Landmark = { x: wrist.x, y: wrist.y + 0.1, visibility: 0.85 };

  test('computeManualTrialPmh : hanche ≈45.0° et tronc = 12.0° (mêmes points que synthCycleFrames vérifiés à la main)', () => {
    const m = computeManualTrialPmh(hand, wrist, elbow, shoulder, hipPmh, kneePmh);
    assert.ok(Math.abs(m.hipAngle - 45) < 1.5, `hipAngle=${m.hipAngle}, attendu ≈45.0°`);
    assert.equal(m.trunkAngle, 12);
  });

  test('computeManualTrialPmh : coude = 90° (segments perpendiculaires par construction)', () => {
    const m = computeManualTrialPmh(hand, wrist, elbow, shoulder, hipPmh, kneePmh);
    assert.equal(m.elbowAngle, 90);
  });

  test('computeManualTrialPmh : poignet aligné (main dans le prolongement de l\'avant-bras) -> wristBendAngle = 0°', () => {
    const m = computeManualTrialPmh(hand, wrist, elbow, shoulder, hipPmh, kneePmh);
    assert.equal(m.wristBendAngle, 0);
  });

  test('computeManualTrialPmh : poignet fléchi (main décalée hors du prolongement) -> wristBendAngle > 0°', () => {
    const bentHand: Landmark = { x: wrist.x + 0.1, y: wrist.y + 0.02, visibility: 0.85 };
    const m = computeManualTrialPmh(bentHand, wrist, elbow, shoulder, hipPmh, kneePmh);
    assert.ok(m.wristBendAngle > 0, `wristBendAngle=${m.wristBendAngle}, attendu > 0° (poignet cassé)`);
  });

  // Mêmes points alignés que le test ASLR ci-dessus (genou verrouillé -> 180° exact).
  const hipPmb: Landmark = { x: 0.5, y: 0.5, visibility: 0.95 };
  const kneePmb: Landmark = { x: 0.6, y: 0.3268, visibility: 0.9 };
  const anklePmb: Landmark = { x: 0.7, y: 0.1536, visibility: 0.85 };

  test('computeManualTrialPmb : genou = 180° quand hanche/genou/cheville sont alignés', () => {
    const m = computeManualTrialPmb(hipPmb, kneePmb, anklePmb);
    assert.equal(m.kneeAngle, 180);
  });

  test('buildManualTrialAngles : combine PMH + PMB en TrialAngles (mean=min=max, amplitude/variance=0)', () => {
    const pmh = computeManualTrialPmh(hand, wrist, elbow, shoulder, hipPmh, kneePmh);
    const pmb = computeManualTrialPmb(hipPmb, kneePmb, anklePmb);
    const angles = buildManualTrialAngles(pmh, pmb);

    assert.equal(angles.hip.mean, pmh.hipAngle);
    assert.equal(angles.hip.min, pmh.hipAngle);
    assert.equal(angles.hip.max, pmh.hipAngle);
    assert.equal(angles.hip.amplitude, 0);

    assert.equal(angles.trunk.mean, pmh.trunkAngle);
    assert.equal(angles.knee.mean, pmb.kneeAngle);
    assert.equal(angles.knee.min, pmb.kneeAngle);
    assert.equal(angles.knee.max, pmb.kneeAngle);

    assert.equal(angles.shoulder.mean, pmh.shoulderAngle);
    assert.equal(angles.elbow.mean, pmh.elbowAngle);
    assert.equal(angles.elbow.amplitude, 0);
    assert.equal(angles.wrist.mean, pmh.wristBendAngle);
    assert.equal(angles.wrist.amplitude, 0);

    assert.equal(angles.ankle.amplitude, 0); // jamais de warning qualité en mesure manuelle
    assert.equal(angles.wrist.mean, 0);
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

  // Retour terrain (10/08/2026) : pFSA mesurée à 2.9 cm² au lieu de quelques milliers sur une
  // vraie photo. Cause : le masque de segmentation MediaPipe (segmentation-integration.ts) a
  // sa PROPRE résolution de sortie, différente de la photo où la calibration est mesurée —
  // sans remise à l'échelle, la formule traitait chaque pixel du masque comme s'il avait la
  // taille physique d'un pixel de la photo, sous-estimant l'aire d'un facteur énorme dès que
  // le masque est plus petit que la photo (cas réel avec MediaPipe).
  test('masque à une résolution différente de la photo -> remise à l\'échelle via photoWidthPx/photoHeightPx', () => {
    // Masque 10x plus petit que la photo dans chaque dimension (aire 100x plus petite) :
    // 60 px du masque doivent représenter la même aire réelle que 6000 px d'un masque à la
    // résolution de la photo (test précédent) -> même résultat, 3840 cm².
    const mask: BinaryMask = { width: 100, height: 100, data: new Uint8Array(10000) };
    for (let i = 0; i < 60; i++) mask.data[i] = 1;
    const pfsa = computePFSA_cm2(mask, { pixelLength: 50, realLengthCm: 40, photoWidthPx: 1000, photoHeightPx: 1000 });
    assert.equal(pfsa, 3840);
  });

  test('sans photoWidthPx/photoHeightPx -> pas de remise à l\'échelle (comportement historique préservé)', () => {
    const mask: BinaryMask = { width: 100, height: 100, data: new Uint8Array(10000) };
    for (let i = 0; i < 60; i++) mask.data[i] = 1;
    const pfsa = computePFSA_cm2(mask, { pixelLength: 50, realLengthCm: 40 });
    // 60 px * (40/50)^2 = 38.4 cm² — faux si le masque n'est vraiment pas à l'échelle de la
    // photo, mais c'est le comportement attendu quand l'appelant ne fournit pas ces champs
    // (ex. masque déjà à la résolution de la photo par construction).
    assert.equal(pfsa, 38.4);
  });
});

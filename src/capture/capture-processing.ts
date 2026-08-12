// capture-processing.ts
// Transforme les captures brutes (landmarks MediaPipe Pose, masque de silhouette)
// en objets consommables par posture-aero-engine.ts (TrialAngles, pFSA_cm2).
//
// LIMITE CONNUE ET IMPORTANTE (à ne pas survoler) :
// MediaPipe Pose (33 points, BlazePose) ne fournit qu'UN point poignet (WRIST),
// pas les landmarks de doigts/main. La déviation ulnaire réelle (rotation du
// poignet dans le plan de la main) ne peut donc PAS être calculée depuis Pose seul.
// Il faudrait un second modèle (MediaPipe Hands) pointé sur la zone poignet/cocotte,
// ce qui n'est pas câblé ici. Cohérent avec le fait que ce paramètre est déjà
// [DEFAULT / non sourcé] côté moteur (§10 du spec) — on ne fait pas semblant de le
// mesurer précisément tant que ce second modèle n'est pas intégré.

import type { TrialAngles } from '../engine/posture-aero-engine';
import { IDX, angleAt, angleVsHorizontal, pickSide, stats, r1 } from '../shared/geometry';
import type { AngleStats, Landmark, PoseFrame } from '../shared/geometry';

// ---------- Angles depuis landmarks MediaPipe Pose ----------
// Les primitives géométriques (angleAt, angleVsHorizontal, pickSide, stats, r1) et l'index
// MediaPipe vivent désormais dans src/shared/geometry.ts : elles n'ont rien de spécifique au
// vélo et le moteur de course a besoin exactement des mêmes (cf. l'en-tête de ce fichier-là).
// Ré-exportés ici parce que pose-integration.ts et PostureCaptureFlow.jsx les importent depuis
// ce module — ce chemin d'import ne doit pas casser.
export type { Landmark, PoseFrame, AngleStats };
export { IDX };

export function extractTrialAngles(frames: PoseFrame[]): TrialAngles {
  if (frames.length === 0) throw new Error('extractTrialAngles: aucune frame fournie');
  const side = pickSide(frames);
  const S =
    side === 'RIGHT'
      ? { SHOULDER: IDX.RIGHT_SHOULDER, HIP: IDX.RIGHT_HIP, KNEE: IDX.RIGHT_KNEE, ANKLE: IDX.RIGHT_ANKLE, FOOT: IDX.RIGHT_FOOT_INDEX }
      : { SHOULDER: IDX.LEFT_SHOULDER, HIP: IDX.LEFT_HIP, KNEE: IDX.LEFT_KNEE, ANKLE: IDX.LEFT_ANKLE, FOOT: IDX.LEFT_FOOT_INDEX };

  const hip: number[] = [];
  const trunk: number[] = [];
  const knee: number[] = [];
  const ankle: number[] = [];

  for (const f of frames) {
    const lm = f.landmarks;
    hip.push(angleAt(lm[S.SHOULDER], lm[S.HIP], lm[S.KNEE]));
    trunk.push(angleVsHorizontal(lm[S.HIP], lm[S.SHOULDER]));
    knee.push(angleAt(lm[S.HIP], lm[S.KNEE], lm[S.ANKLE]));
    ankle.push(angleAt(lm[S.KNEE], lm[S.ANKLE], lm[S.FOOT]));
  }

  return {
    hip: stats(hip),
    trunk: stats(trunk),
    knee: stats(knee),
    ankle: stats(ankle),
    // Stub explicite tant que MediaPipe Hands n'est pas intégré — voir avertissement en tête de fichier.
    wrist: { mean: 0, min: 0, max: 0, amplitude: 0, variance: 0 },
  };
}

// ---------- §3.1 — Test ASLR (souplesse hanche) : angle cuisse au point d'arrêt ----------
// Protocole (spec §3.1) : allongé, jambe testée tendue (genou verrouillé), on la lève le plus
// haut possible sans plier le genou ; la mesure s'arrête au moment où le genou commence à plier.

export const KNEE_STRAIGHT_THRESHOLD = 165; // sous ce seuil, le genou est considéré en train de plier -> fin de mesure

// Sous ce seuil de cuisse, on considère qu'on est encore en position de repos/installation
// (avant que la levée n'ait vraiment commencé), pas dans le mouvement testé lui-même.
//
// Bug réel trouvé sur une vraie vidéo ASLR (retour terrain, 08/08/2026) : la vidéo contient
// naturellement une phase d'installation au tout début (l'utilisateur s'accroupit pour
// ajuster le téléphone avant de s'allonger — genou plié) AVANT le mouvement testé. L'ancienne
// logique arrêtait la mesure (`break`) dès le premier genou plié rencontré, y compris pendant
// cette installation — donnant un angle proche de 0 ou très sous-estimé alors que la vraie
// levée, filmée juste après, atteignait ~85° (vérifié en rejouant la vidéo réelle image par
// image). Le seuil d'"engagement" ci-dessous retarde l'armement de la règle d'arrêt jusqu'à
// ce que la cuisse soit réellement levée — les genoux pliés AVANT ce point (installation)
// sont ignorés plutôt que fatals ; ceux APRÈS (le vrai point d'arrêt clinique du test)
// arrêtent toujours la mesure comme prévu (cf. test "un angle plus élevé après que le genou
// ait plié n'est pas retenu").
const RAISE_ENGAGED_THRESHOLD_DEG = 15;

// Retour terrain (08/08/2026, suite) : même après le fix ci-dessus, la même vidéo réelle
// redonnait le même angle sous-estimé (18.9°) — donc l'armement se déclenchait quand même
// trop tôt. Hypothèse la plus probable (non confirmée par des données réelles : le sandbox
// de dev ne peut pas télécharger le modèle MediaPipe, cf. limite d'environnement — vérifiable
// seulement via le téléphone de l'utilisateur) : la phase d'installation en gros plan flou
// (cf. capture d'écran) donne des landmarks bruités qui peuvent franchir le seuil de 15° sur
// UNE frame par hasard. On exige maintenant plusieurs frames straight-knee consécutives
// au-dessus du seuil avant d'armer, pour filtrer un faux positif isolé. Reste un choix
// d'ingénierie non validé sur vraies données — voir extractAslrAngleTrace() ci-dessous,
// exposée pour afficher un diagnostic à l'écran et confirmer/infirmer sur le prochain test
// réel (ce sandbox ne peut pas faire tourner PoseLandmarker pour vérifier autrement).
const ENGAGE_STREAK_FRAMES = 3;

export interface AslrTrace {
  angle: number;
  framesTotal: number;
  framesStraightKnee: number;
  engagedAtIndex: number | null;
  stoppedAtIndex: number | null; // null si jamais de genou plié après l'armement (fin de vidéo)
}

function computeAslrTrace(frames: PoseFrame[]): AslrTrace {
  const side = pickSide(frames);
  const S =
    side === 'RIGHT'
      ? { HIP: IDX.RIGHT_HIP, KNEE: IDX.RIGHT_KNEE, ANKLE: IDX.RIGHT_ANKLE }
      : { HIP: IDX.LEFT_HIP, KNEE: IDX.LEFT_KNEE, ANKLE: IDX.LEFT_ANKLE };

  let maxThighAngle = 0;
  let raiseEngaged = false;
  let engageStreak = 0;
  let framesStraightKnee = 0;
  let engagedAtIndex: number | null = null;
  let stoppedAtIndex: number | null = null;

  for (let i = 0; i < frames.length; i++) {
    const lm = frames[i].landmarks;
    const kneeAngle = angleAt(lm[S.HIP], lm[S.KNEE], lm[S.ANKLE]);
    if (Number.isNaN(kneeAngle) || kneeAngle < KNEE_STRAIGHT_THRESHOLD) {
      if (raiseEngaged) {
        stoppedAtIndex = i; // genou qui plie après le début de la levée -> fin de la mesure valide
        break;
      }
      engageStreak = 0; // genou plié avant que la levée commence (installation) -> ignoré
      continue;
    }
    framesStraightKnee++;
    const thighAngle = angleVsHorizontal(lm[S.HIP], lm[S.KNEE]);
    if (Number.isNaN(thighAngle)) continue;
    maxThighAngle = Math.max(maxThighAngle, thighAngle);
    if (!raiseEngaged) {
      engageStreak = thighAngle >= RAISE_ENGAGED_THRESHOLD_DEG ? engageStreak + 1 : 0;
      if (engageStreak >= ENGAGE_STREAK_FRAMES) {
        raiseEngaged = true;
        engagedAtIndex = i - ENGAGE_STREAK_FRAMES + 1;
      }
    }
  }

  return { angle: r1(maxThighAngle), framesTotal: frames.length, framesStraightKnee, engagedAtIndex, stoppedAtIndex };
}

export function extractAslrAngle(frames: PoseFrame[]): number {
  if (frames.length === 0) throw new Error('extractAslrAngle: aucune frame fournie');
  return computeAslrTrace(frames).angle;
}

// Diagnostic exposé à l'écran (cf. App.jsx) pour comprendre à distance ce qui se passe sur
// un vrai appareil, faute de pouvoir faire tourner PoseLandmarker dans ce sandbox.
export function extractAslrAngleTrace(frames: PoseFrame[]): AslrTrace {
  if (frames.length === 0) throw new Error('extractAslrAngle: aucune frame fournie');
  return computeAslrTrace(frames);
}

// ---------- Mesure manuelle ASLR (3 taps : hanche, genou, cheville) ----------
// Alternative à la détection automatique ci-dessus — retour terrain (10/08/2026) : la
// détection MediaPipe a échoué sur plusieurs vraies vidéos malgré des corrections
// successives (cadrage, contre-jour, seuils de confiance), toujours pour la même raison de
// fond : filmer quelqu'un allongé au sol, vu de loin et au ras du sol, sort largement du cas
// standard ("personne debout, cadrée serré") sur lequel ces modèles sont entraînés/calibrés.
// Plutôt que de continuer à durcir un pipeline auto peu fiable pour ce cas précis, l'utilisateur
// choisit lui-même l'image où sa jambe testée est la plus haute et touche 3 points — mêmes
// formules géométriques que la détection auto (angleAt, angleVsHorizontal), juste alimentées
// par des points tapés à la main plutôt que par des landmarks MediaPipe.

export interface ManualAslrMeasurement {
  angle: number; // cuisse (hanche -> genou) vs horizontale, en degrés — c'est l'angle ASLR
  kneeAngle: number; // hanche-genou-cheville, en degrés — indicateur de jambe tendue (proche de 180°)
}

export function computeManualAslrAngle(hip: Landmark, knee: Landmark, ankle: Landmark): ManualAslrMeasurement {
  return {
    angle: r1(angleVsHorizontal(hip, knee)),
    kneeAngle: r1(angleAt(hip, knee, ankle)),
  };
}

// ---------- Mesure manuelle vidéo profil (2 images : point mort haut / point mort bas) ----------
// Même logique que la mesure ASLR ci-dessus, étendue à la vidéo profil (retour terrain,
// 10/08/2026, suite : "il y a une erreur dans le calcul du logiciel, laisse l'utilisateur faire
// lui-même les mesures" — un essai réel a donné un angle de tronc de 43°, bien au-delà de ce
// qu'une position sur vélo peut produire, révélant que la détection automatique se trompait
// aussi sur cette vidéo, pas seulement sur l'ASLR).
//
// extractTrialAngles() ci-dessus calcule des statistiques (mean/min/max/amplitude/variance) sur
// tout le cycle de pédalage à partir de frames échantillonnées automatiquement. En mesure
// manuelle, on ne demande à l'utilisateur que les 2 images cliniquement significatives d'un tour
// de pédale :
//   - le point mort haut (PMH) : cuisse la plus proche du buste -> hanche la plus fermée (c'est
//     la valeur qui compte pour la contrainte HIP_FLOOR_ABS et le score confort), et le tronc y
//     est mesuré (position relativement stable sur un cycle stable, donc représentatif).
//   - le point mort bas (PMB) : jambe la plus tendue -> genou le plus extension (c'est la valeur
//     qui compte pour la plage KNEE_MIN/KNEE_MAX).
// L'angle de cheville (ANKLE_FLAG) n'est qu'un warning qualité non-bloquant basé sur une
// amplitude sur tout le cycle — pas mesurable de façon fiable à la main sur 2 images fixes, donc
// volontairement pas demandé ici (buildManualTrialAngles renvoie une amplitude de 0, qui ne
// déclenche jamais ce warning plutôt que d'inventer une fausse précision).

export interface ManualTrialPmhMeasurement {
  hipAngle: number; // angleAt(épaule, hanche, genou) au point mort haut
  trunkAngle: number; // tronc vs horizontale, au point mort haut
}

export function computeManualTrialPmh(shoulder: Landmark, hip: Landmark, knee: Landmark): ManualTrialPmhMeasurement {
  return {
    hipAngle: r1(angleAt(shoulder, hip, knee)),
    trunkAngle: r1(angleVsHorizontal(hip, shoulder)),
  };
}

export interface ManualTrialPmbMeasurement {
  kneeAngle: number; // angleAt(hanche, genou, cheville) au point mort bas
}

export function computeManualTrialPmb(hip: Landmark, knee: Landmark, ankle: Landmark): ManualTrialPmbMeasurement {
  return { kneeAngle: r1(angleAt(hip, knee, ankle)) };
}

function fixedStat(value: number): AngleStats {
  // Mesure manuelle = une seule valeur, pas une distribution sur un cycle : min = max = mean,
  // amplitude et variance à 0 (pas mesurées). C'est un choix délibéré, pas une approximation
  // cachée — la seule chose que le moteur regarde pour hip/trunk/knee est mean (+ min/max pour
  // knee), donc ça reste sémantiquement correct pour valider la position.
  return { mean: value, min: value, max: value, amplitude: 0, variance: 0 };
}

export function buildManualTrialAngles(pmh: ManualTrialPmhMeasurement, pmb: ManualTrialPmbMeasurement): TrialAngles {
  const zero: AngleStats = { mean: 0, min: 0, max: 0, amplitude: 0, variance: 0 };
  return {
    hip: fixedStat(pmh.hipAngle),
    trunk: fixedStat(pmh.trunkAngle),
    knee: fixedStat(pmb.kneeAngle),
    ankle: zero, // non mesuré manuellement (warning qualité non-bloquant, cf. commentaire ci-dessus)
    wrist: zero, // stub existant, cf. limite MediaPipe Hands documentée en tête de fichier
  };
}

// ---------- pFSA depuis un masque de silhouette calibré ----------

export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array; // 1 = pixel appartient à la silhouette (cycliste + vélo), 0 sinon
}

export interface CalibrationRef {
  pixelLength: number; // longueur mesurée en pixels sur la photo (ex: largeur de cintre)
  realLengthCm: number; // longueur réelle connue correspondante
  // Résolution de la photo dans laquelle pixelLength a été mesuré (les 2 taps de calibration
  // se font sur la photo affichée à sa résolution native, cf. capturedMeta dans
  // PostureCaptureFlow.jsx). Optionnels pour ne pas casser un appelant qui donne déjà un
  // masque à cette même résolution (cf. test "surface calculée..." plus bas), mais
  // indispensables dès que ce n'est pas le cas — et ce n'est PAS le cas pour la segmentation
  // MediaPipe réelle : mask.width/height (segmentation-integration.ts) est la résolution de
  // SORTIE du modèle, qui n'a aucune raison de correspondre à la résolution de la photo.
  // Retour terrain : pFSA mesurée à 2.9 cm² au lieu de quelques milliers — cohérent avec un
  // masque nettement plus petit que la photo et aucune remise à l'échelle avant ce fix.
  photoWidthPx?: number;
  photoHeightPx?: number;
}

export function computePFSA_cm2(mask: BinaryMask, calibration: CalibrationRef): number {
  if (calibration.pixelLength <= 0) throw new Error('computePFSA_cm2: calibration.pixelLength doit être > 0');
  const cmPerPixel = calibration.realLengthCm / calibration.pixelLength;
  // cmPerPixel ci-dessus est à l'échelle de la PHOTO où la calibration a été mesurée. Le
  // masque de segmentation peut être à une résolution différente (cf. CalibrationRef) — on
  // ramène l'aire d'un pixel du masque à l'aire qu'il représente réellement sur la photo
  // avant d'appliquer cm²/pixel-photo, sinon la surface est faussée d'un facteur
  // (résolution photo / résolution masque)² — potentiellement énorme.
  const scaleX = calibration.photoWidthPx ? calibration.photoWidthPx / mask.width : 1;
  const scaleY = calibration.photoHeightPx ? calibration.photoHeightPx / mask.height : 1;
  const cm2PerMaskPixel = cmPerPixel * cmPerPixel * scaleX * scaleY;
  let count = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) count++;
  return r1(count * cm2PerMaskPixel);
}

// Sanity checks déplacés dans capture-processing.test.ts (node:test).

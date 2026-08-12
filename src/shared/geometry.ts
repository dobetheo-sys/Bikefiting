// geometry.ts
// Primitives géométriques partagées par les moteurs d'analyse (position vélo, foulée course).
//
// Pourquoi ce fichier existe : ces fonctions étaient locales à capture-processing.ts (module
// vélo) alors qu'elles n'ont rien de spécifique au vélo — ce sont des calculs d'angles sur des
// points 2D. Le moteur de course en a besoin des mêmes. Les dupliquer aurait créé un vrai
// risque de dérive : angleVsHorizontal() porte une correction de bug non évidente (cf. son
// commentaire), qu'une copie aurait très bien pu ne pas suivre.
//
// Convention de repère (celle de MediaPipe, et celle des taps utilisateur sur une image) :
//   x croît vers la DROITE de l'image, y croît vers le BAS.
// C'est contre-intuitif pour les angles "vers le haut" — les fonctions ci-dessous s'en
// occupent, aucun appelant ne devrait avoir à y penser.

export interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface PoseFrame {
  landmarks: Landmark[]; // index standard MediaPipe Pose, 0-32
  timestampMs: number;
}

export interface AngleStats {
  mean: number;
  min: number;
  max: number;
  amplitude: number;
  variance: number;
}

// Index standard MediaPipe Pose (BlazePose, 33 points).
// HEEL/NOSE ajoutés pour le moteur de course (angle de pied à l'attaque, cf.
// running-capture-processing.ts) — additif, aucun consommateur existant n'est affecté.
export const IDX = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

export function angleAt(a: Landmark, vertex: Landmark, b: Landmark): number {
  // Angle interne au sommet "vertex", entre vertex->a et vertex->b (degrés)
  const v1 = { x: a.x - vertex.x, y: a.y - vertex.y };
  const v2 = { x: b.x - vertex.x, y: b.y - vertex.y };
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function angleVsHorizontal(from: Landmark, to: Landmark): number {
  // Angle aigu entre le segment from->to et l'horizontale, indépendant du sens (avant/arrière).
  // BUG CORRIGÉ : la version initiale (atan2(-dy, dx) puis abs()) donnait ~180°-x au lieu de x
  // quand le segment pointe vers l'arrière (dx négatif, cas normal pour un buste penché en avant
  // filmé de profil). On prend les valeurs absolues des deux composantes avant atan2.
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// Angle SIGNÉ par rapport à la verticale, orienté par le sens de course.
//
// Ajouté pour le moteur de course : contrairement au vélo, où seule l'amplitude de l'angle
// compte (un tronc penché est penché, peu importe le sens dans lequel on filme), la course a
// besoin de distinguer "devant" de "derrière" — un tibia incliné vers l'AVANT à l'attaque du
// pied (pied posé devant le genou) est le marqueur d'overstriding, alors que le même angle vers
// l'arrière est une foulée normale. angleVsHorizontal() ne peut pas répondre à ça : elle prend
// les valeurs absolues, donc les deux cas y sont indiscernables.
//
// `forwardSign` vaut +1 si le coureur avance vers la droite de l'image, -1 vers la gauche
// (déterminé depuis l'orientation du pied, cf. forwardSignFromFoot()).
// Le résultat est POSITIF quand `to` est déplacé vers l'AVANT par rapport à `from`.
// La composante verticale est prise en valeur absolue pour que la fonction se comporte
// identiquement sur un segment orienté vers le bas (genou->cheville) et vers le haut
// (hanche->épaule) : dans les deux cas on mesure l'écart à la verticale, pas une direction.
export function signedAngleVsVertical(from: Landmark, to: Landmark, forwardSign: 1 | -1): number {
  const dxForward = forwardSign * (to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (Math.hypot(dxForward, dy) === 0) return NaN; // points confondus, cf. angleAt()
  return (Math.atan2(dxForward, dy) * 180) / Math.PI;
}

// Angle SIGNÉ par rapport à l'horizontale, orienté par le sens de course.
// Positif = `to` est plus HAUT que `from` dans l'image (y plus petit). Utilisé pour l'angle du
// pied à l'attaque (talon->pointe) : pointe plus haute que le talon = attaque talon.
export function signedAngleVsHorizontal(from: Landmark, to: Landmark, forwardSign: 1 | -1): number {
  const dxForward = forwardSign * (to.x - from.x);
  const dyUp = from.y - to.y; // repère image : y croît vers le bas
  if (Math.hypot(dxForward, dyUp) === 0) return NaN;
  return (Math.atan2(dyUp, Math.abs(dxForward)) * 180) / Math.PI;
}

export function pickSide(frames: PoseFrame[]): 'LEFT' | 'RIGHT' {
  // Vue de profil : un seul côté est fiable (l'autre est partiellement masqué par le cadre/vélo).
  // On choisit le côté à la visibilité moyenne la plus haute plutôt que de supposer un côté fixe.
  let leftVis = 0;
  let rightVis = 0;
  for (const f of frames) {
    leftVis += f.landmarks[IDX.LEFT_HIP]?.visibility ?? 0;
    rightVis += f.landmarks[IDX.RIGHT_HIP]?.visibility ?? 0;
  }
  return rightVis >= leftVis ? 'RIGHT' : 'LEFT';
}

export function stats(values: number[]): AngleStats {
  const clean = values.filter((v) => !Number.isNaN(v));
  if (clean.length === 0) return { mean: NaN, min: NaN, max: NaN, amplitude: NaN, variance: NaN };
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length;
  return { mean: r1(mean), min: r1(min), max: r1(max), amplitude: r1(max - min), variance: r1(variance) };
}

export function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

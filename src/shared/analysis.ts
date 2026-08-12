// analysis.ts
// Briques de scoring partagées par les moteurs d'analyse (position vélo, foulée course).
//
// Même raison d'être que shared/geometry.ts : la forme d'une violation de contrainte, la
// dominance de Pareto et la pénalité quadratique ne sont spécifiques à aucun sport. Le moteur
// de course les réutilise à l'identique — ce qui garantit qu'un essai exclu, un front de Pareto
// ou une pénalité se comportent pareil des deux côtés, plutôt que "à peu près pareil".

export interface Violation {
  param: string;
  value: number;
  bound: number;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  warnings: Violation[];
  margins: Record<string, number>;
}

// Front de Pareto générique sur deux axes à maximiser.
// Un élément est dominé si un autre est >= sur les DEUX axes et > sur au moins un (§6 du spec
// vélo). Les éléments passés sont supposés déjà filtrés sur leur validité — c'est à l'appelant
// de décider ce qui a le droit d'entrer dans le front.
export function paretoDominant<T extends { id: string }>(
  items: T[],
  scoreA: (t: T) => number,
  scoreB: (t: T) => number
): T[] {
  return items.filter(
    (a) =>
      !items.some(
        (b) =>
          b.id !== a.id &&
          scoreA(b) >= scoreA(a) &&
          scoreB(b) >= scoreB(a) &&
          (scoreA(b) > scoreA(a) || scoreB(b) > scoreB(a))
      )
  );
}

// Pénalité quadratique (pas linéaire) : un paramètre à 2° de la limite coûte peu, largement
// au-delà coûte beaucoup — reflète que l'inconfort/la contrainte ne croît pas linéairement avec
// l'écart (§4 du spec vélo). `distance <= 0` = dans la zone acceptable, pas de pénalité.
export function quadPenalty(distance: number, scale: number, cap = 40): number {
  if (distance <= 0) return 0;
  return Math.min(cap, scale * distance * distance);
}

export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

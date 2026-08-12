import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cadenceGainPct,
  cadenceTargetSpm,
  computeChargeScore,
  computeEconomyScore,
  runRunningEngine,
  suggestNextRunTrial,
  validateRunTrial,
  type RunTrial,
  type RunTrialMetrics,
  type RunnerProfile,
} from './running-gait-engine';

const profile: RunnerProfile = { heightCm: 178, selfSelectedCadenceSpm: 168, testSpeedKmh: 12 };

// Foulée propre : aucun seuil d'avertissement franchi, pour isoler l'effet de la cadence.
const cleanMetrics: Omit<RunTrialMetrics, 'cadenceSpm'> = {
  tibiaAngleDeg: 8,
  kneeFlexionICDeg: 15,
  trunkLeanDeg: 8,
  overstrideRatio: 0.12,
};

function mkTrial(id: string, cadenceSpm: number, over: Partial<RunTrialMetrics> = {}, speedKmh = 12): RunTrial {
  return { id, speedKmh, metrics: { ...cleanMetrics, cadenceSpm, ...over } };
}

describe('cadenceGainPct / cadenceTargetSpm — tout est relatif à la cadence spontanée', () => {
  test('176 pas/min pour une spontanée de 168 -> +4.8%', () => {
    assert.equal(cadenceGainPct(176, 168), 4.8);
  });
  test('cible +5% depuis 168 -> 176 pas/min', () => {
    assert.equal(cadenceTargetSpm(profile, 5), 176);
  });
  test('cadence spontanée elle-même -> +0%', () => {
    assert.equal(cadenceGainPct(168, 168), 0);
  });
});

// Différence structurelle assumée avec le moteur vélo : il n'existe pas en course de seuil
// biomécanique publié justifiant d'exclure un essai (rien d'équivalent au "hanche < 40° = 5-15%
// de puissance perdue"). Les seules exclusions sont des problèmes de VALIDITÉ DE MESURE.
describe('validateRunTrial — seules les erreurs de mesure excluent, jamais la biomécanique', () => {
  test('essai filmé à une autre vitesse -> exclu (non comparable)', () => {
    const v = validateRunTrial(mkTrial('t', 170, {}, 13), profile);
    assert.equal(v.valid, false);
    assert.equal(v.violations[0]?.param, 'speed_mismatch');
    assert.equal(v.violations[0]?.value, 13);
  });

  test('écart de vitesse dans la tolérance (12.2 vs 12) -> valide', () => {
    assert.equal(validateRunTrial(mkTrial('t', 170, {}, 12.2), profile).valid, true);
  });

  test('cadence aberrante (100 pas/min) -> exclue comme erreur de comptage', () => {
    const v = validateRunTrial(mkTrial('t', 100), profile);
    assert.equal(v.valid, false);
    assert.equal(v.violations[0]?.param, 'cadence_implausible');
  });

  test('métrique NaN (deux points tapés confondus) -> exclu explicitement, pas accepté en silence', () => {
    const v = validateRunTrial(mkTrial('t', 170, { tibiaAngleDeg: NaN }), profile);
    assert.equal(v.valid, false);
    assert.equal(v.violations[0]?.param, 'invalid_measurement');
  });

  test('foulée franchement mauvaise -> essai VALIDE avec avertissements, jamais exclu', () => {
    const v = validateRunTrial(
      mkTrial('t', 170, { tibiaAngleDeg: 28, overstrideRatio: 0.31, kneeFlexionICDeg: 4, trunkLeanDeg: 1 }),
      profile
    );
    assert.equal(v.valid, true);
    assert.equal(v.violations.length, 0);
    const params = v.warnings.map((w) => w.param).sort();
    assert.deepEqual(params, ['overstride', 'stiff_landing', 'tibia_forward', 'trunk_upright']);
  });
});

// Le cœur du moteur : les deux scores doivent s'OPPOSER sur la cadence, sinon un front de
// Pareto n'aurait aucun sens (charge : Heiderscheit et al. 2011, plus de cadence = moins de
// charge ; économie : Cavanagh & Williams 1982, le coût est minimal à la cadence spontanée).
describe('computeChargeScore / computeEconomyScore — opposition documentée sur la cadence', () => {
  const libre = mkTrial('libre', 168);
  const plus5 = mkTrial('plus5', 176);
  const plus10 = mkTrial('plus10', 185);

  test('charge : +0% -> 77.5 (composante cadence à 50/100, le reste sans pénalité)', () => {
    assert.equal(computeChargeScore(libre, profile), 77.5);
  });

  test('charge : +10% -> 100 (haut de la fenêtre effectivement testée en littérature)', () => {
    assert.equal(computeChargeScore(plus10, profile), 100);
  });

  test('charge : au-delà de +10%, aucun crédit supplémentaire (pas d\'extrapolation hors du domaine étudié)', () => {
    assert.equal(computeChargeScore(mkTrial('plus25', 210), profile), computeChargeScore(plus10, profile));
  });

  test('économie : maximale à la cadence spontanée (100)', () => {
    assert.equal(computeEconomyScore(libre, profile, 0, false), 100);
  });

  test('économie : décroît quand on s\'écarte de la cadence spontanée', () => {
    const e0 = computeEconomyScore(libre, profile, 0, false);
    const e5 = computeEconomyScore(plus5, profile, 0, false);
    const e10 = computeEconomyScore(plus10, profile, 0, false);
    assert.ok(e0 > e5 && e5 > e10, `attendu ${e0} > ${e5} > ${e10}`);
    assert.equal(e10, 71.9);
  });

  test('économie : la pénalité est symétrique (une cadence trop BASSE coûte aussi)', () => {
    const moins10 = mkTrial('moins10', 151); // -10.1%
    assert.equal(computeEconomyScore(moins10, profile, 0, false), computeEconomyScore(plus10, profile, 0, false));
  });

  test('charge : à l\'inverse, une cadence trop basse est pénalisée, pas récompensée', () => {
    assert.ok(computeChargeScore(mkTrial('moins10', 151), profile) < computeChargeScore(libre, profile));
  });
});

describe('runRunningEngine — pipeline complet, balayage de cadence', () => {
  const trials: RunTrial[] = [
    { ...mkTrial('t_libre', 168), label: 'cadence spontanée' },
    { ...mkTrial('t_plus5', 176), label: '+5%' },
    { ...mkTrial('t_plus10', 185), label: '+10%' },
    mkTrial('t_mauvaise_vitesse', 178, {}, 13.5),
  ];
  const result = runRunningEngine(trials, profile);

  test('status ok, essai hors vitesse exclu', () => {
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.trials_valid, 3);
    assert.equal(result.trials_excluded, 1);
    assert.equal(result.excluded_trials[0].trial_id, 't_mauvaise_vitesse');
    assert.equal(result.excluded_trials[0].violations[0].param, 'speed_mismatch');
  });

  test('charge minimale = essai à +10%', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(result.profiles?.charge_min.trial_id, 't_plus10');
  });

  test('économie maximale = essai à cadence spontanée', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(result.profiles?.economie_max.trial_id, 't_libre');
  });

  test('équilibré = essai à +5% (le compromis classique de la littérature, retrouvé par le calcul et non codé en dur)', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(result.profiles?.equilibre.trial_id, 't_plus5');
    assert.equal(result.profiles?.equilibre.cadence_gain_pct, 4.8);
  });

  test('aucun essai ne domine les autres : les 3 sont sur le front (vraie opposition, pas un front dégénéré)', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    const ids = [
      result.profiles?.charge_min.trial_id,
      result.profiles?.equilibre.trial_id,
      result.profiles?.economie_max.trial_id,
    ];
    assert.equal(new Set(ids).size, 3);
  });

  test('recommandation par défaut = équilibré ; goal la déplace sans changer aucun score', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(result.recommended, 'equilibre');
    const charge = runRunningEngine(trials, { ...profile, goal: 'charge' });
    if (charge.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(charge.recommended, 'charge_min');
    assert.equal(charge.profiles?.equilibre.charge_score, result.profiles?.equilibre.charge_score);
  });
});

describe('runRunningEngine — refus explicites plutôt que résultats douteux', () => {
  test('cadence spontanée manquante -> refus de scorer (équivalent du test ASLR obligatoire côté vélo)', () => {
    const r = runRunningEngine([mkTrial('t1', 168), mkTrial('t2', 176), mkTrial('t3', 185)], {
      ...profile,
      selfSelectedCadenceSpm: NaN,
    });
    assert.equal(r.status, 'missing_self_selected_cadence');
  });

  test('moins de 3 essais valides -> pas de front, et on dit quoi filmer ensuite', () => {
    const r = runRunningEngine([mkTrial('t1', 168), mkTrial('t2', 176)], profile);
    assert.equal(r.status, 'insufficient_valid_trials');
    if (r.status !== 'insufficient_valid_trials') return;
    assert.equal(r.trials_valid, 2);
    assert.equal(r.next_trial?.kind, 'next_trial');
    assert.equal(r.next_trial?.targetCadenceSpm, 185); // 168 × 1.10
  });
});

// L'oscillation verticale est optionnelle. Si elle n'entrait dans le score que pour les essais
// qui l'ont mesurée, ceux qui ne l'ont pas seraient pénalisés sur une composante absente —
// un artefact de protocole de capture déguisé en différence de foulée.
describe('runRunningEngine — oscillation verticale : tout le monde ou personne', () => {
  const withVO = (id: string, cadence: number, vo: number) => mkTrial(id, cadence, { verticalOscillationRatio: vo });

  test('mesurée sur tous les essais valides -> utilisée', () => {
    const r = runRunningEngine([withVO('a', 168, 0.1), withVO('b', 176, 0.09), withVO('c', 185, 0.08)], profile);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.vertical_oscillation_used, true);
  });

  test('mesurée sur une partie seulement -> ignorée pour tout le monde', () => {
    const r = runRunningEngine([withVO('a', 168, 0.1), withVO('b', 176, 0.09), mkTrial('c', 185)], profile);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.vertical_oscillation_used, false);
  });
});

describe('suggestNextRunTrial — d\'abord compléter le balayage, ensuite corriger la forme', () => {
  test('seul l\'essai spontané est filmé -> propose le +5% avec sa cadence cible', () => {
    const s = suggestNextRunTrial([mkTrial('t1', 168)], profile);
    assert.equal(s?.kind, 'next_trial');
    assert.equal(s?.targetCadenceSpm, 176);
    assert.match(s?.message ?? '', /\+5%/);
  });

  test('aucun essai -> commence par la cadence spontanée, qui est la référence', () => {
    const s = suggestNextRunTrial([], profile);
    assert.equal(s?.targetCadenceSpm, 168);
    assert.match(s?.message ?? '', /cadence spontanée/);
  });

  test('balayage complet et foulée propre -> aucune suggestion', () => {
    const s = suggestNextRunTrial([mkTrial('a', 168), mkTrial('b', 176), mkTrial('c', 185)], profile);
    assert.equal(s, null);
  });

  test('balayage complet mais overstriding marqué -> bascule sur le défaut de forme le plus grand', () => {
    const s = suggestNextRunTrial(
      [mkTrial('a', 168), mkTrial('b', 176), mkTrial('c', 185, { tibiaAngleDeg: 26 })],
      profile
    );
    assert.equal(s?.kind, 'form_cue');
    assert.match(s?.message ?? '', /Tibia/);
    assert.equal(s?.targetCadenceSpm, undefined); // pas de correction chiffrée inventée
  });
});

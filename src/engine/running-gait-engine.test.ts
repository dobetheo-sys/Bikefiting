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
// charge ; économie : Cavanagh & Williams 1982, courbe en U autour de la foulée optimale).
//
// Modèle d'économie révisé après audit (docs/AUDIT_MOTEUR_COURSE.md §2.6, §2.8) : le sommet
// n'est PAS à la cadence spontanée mais ~3% au-dessus, la courbe est plate près du sommet, et
// la branche basse-cadence est plus raide que la branche haute.
describe('computeChargeScore — la cadence domine, comme la littérature le justifie', () => {
  const libre = mkTrial('libre', 168);
  const plus10 = mkTrial('plus10', 185);

  test('+0% -> 70 (composante cadence à 50/100, le reste sans pénalité)', () => {
    assert.equal(computeChargeScore(libre, profile), 70);
  });

  test('+10% -> 100 (haut de la fenêtre effectivement testée en littérature)', () => {
    assert.equal(computeChargeScore(plus10, profile), 100);
  });

  test('au-delà de +10%, aucun crédit supplémentaire (pas d\'extrapolation hors du domaine étudié)', () => {
    assert.equal(computeChargeScore(mkTrial('plus25', 210), profile), computeChargeScore(plus10, profile));
  });

  test('une cadence trop basse est pénalisée, pas récompensée', () => {
    assert.ok(computeChargeScore(mkTrial('moins10', 151), profile) < computeChargeScore(libre, profile));
  });

  // Audit §1.3 : la V1 donnait 55 points d'amplitude à la forme (seuils inventés) contre 45 à la
  // cadence (seule relation sourcée). La hiérarchie doit rester dans ce sens-ci.
  test('l\'amplitude due à la cadence dépasse celle due aux seuils de forme non sourcés', () => {
    const formeParfaite = mkTrial('a', 168, { tibiaAngleDeg: 0, overstrideRatio: 0, kneeFlexionICDeg: 25 });
    const formeHorrible = mkTrial('b', 168, { tibiaAngleDeg: 40, overstrideRatio: 0.5, kneeFlexionICDeg: 0 });
    const amplitudeForme = computeChargeScore(formeParfaite, profile) - computeChargeScore(formeHorrible, profile);
    const amplitudeCadence = computeChargeScore(mkTrial('c', 185), profile) - computeChargeScore(mkTrial('d', 151), profile);
    assert.ok(
      amplitudeCadence > amplitudeForme,
      `cadence ${amplitudeCadence} doit dépasser forme ${amplitudeForme}`
    );
  });
});

describe('computeEconomyScore — courbe en U décalée, plate au sommet et asymétrique', () => {
  test('le sommet n\'est PAS à la cadence spontanée : +5% est aussi économique que +0%', () => {
    // C'est le correctif central de l'audit §2.6 : de Ruiter 2014, Morgan 1994 et Moore 2016
    // montrent tous que la cadence spontanée est SOUS l'optimum métabolique.
    assert.equal(computeEconomyScore(mkTrial('libre', 168), profile, 0, false), 100);
    assert.equal(computeEconomyScore(mkTrial('plus5', 176), profile, 0, false), 100);
  });

  test('au-delà de la zone plate, le coût réapparaît (+10% -> 94.1)', () => {
    assert.equal(computeEconomyScore(mkTrial('plus10', 185), profile, 0, false), 94.1);
  });

  test('la branche BASSE cadence est plus raide que la haute (Cavanagh & Williams, Högberg)', () => {
    // 161 spm est à -7.2% du sommet, 185 spm à +7.1% : écart quasi identique, côté bas légèrement
    // PLUS PETIT. S'il est malgré tout plus pénalisé, l'asymétrie est bien appliquée.
    const bas = computeEconomyScore(mkTrial('bas', 161), profile, 0, false);
    const haut = computeEconomyScore(mkTrial('haut', 185), profile, 0, false);
    assert.ok(bas < haut, `côté bas ${bas} doit être plus pénalisé que côté haut ${haut}`);
  });

  test('une cadence franchement basse s\'effondre (-10% -> 53.6)', () => {
    assert.equal(computeEconomyScore(mkTrial('moins10', 151), profile, 0, false), 53.6);
  });

  // Audit §2.4 : le tronc a été retiré du score d'économie (Van Hooren 2024 — l'inclinaison
  // statique corrèle avec la performance, pas l'économie ; une intervention de lean avant a
  // dégradé l'économie).
  test('l\'inclinaison du tronc n\'influence plus le score d\'économie', () => {
    const droit = mkTrial('a', 176, { trunkLeanDeg: 1 });
    const penche = mkTrial('b', 176, { trunkLeanDeg: 22 });
    assert.equal(computeEconomyScore(droit, profile, 0, false), computeEconomyScore(penche, profile, 0, false));
  });

  // Audit §1.1 : c'était LE défaut structurel — l'axe économie n'utilisait aucune mesure vidéo.
  // Avec l'oscillation verticale collectée, deux essais de même cadence doivent enfin différer.
  test('avec oscillation verticale, deux essais de même cadence ne sont plus identiques', () => {
    const souple = mkTrial('a', 176, { verticalOscillationRatio: 0.08 });
    const sautillant = mkTrial('b', 176, { verticalOscillationRatio: 0.14 });
    const eSouple = computeEconomyScore(souple, profile, 0.14, true);
    const eSautillant = computeEconomyScore(sautillant, profile, 0.14, true);
    assert.ok(eSouple > eSautillant, `moins d'oscillation (${eSouple}) doit primer (${eSautillant})`);
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

  // Conséquence directe du décalage du sommet (audit §2.6) : avant correction, l'essai à cadence
  // spontanée gagnait l'axe économie par construction. Il est maintenant DOMINÉ par le +5%, qui
  // est aussi économique et moins chargé — il sort donc entièrement du front.
  test('économie maximale = essai à +5%, plus l\'essai spontané (qui est désormais dominé)', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(result.profiles?.economie_max.trial_id, 't_plus5');
    const surLeFront = [
      result.profiles?.charge_min.trial_id,
      result.profiles?.equilibre.trial_id,
      result.profiles?.economie_max.trial_id,
    ];
    assert.equal(surLeFront.includes('t_libre'), false);
  });

  test('le front garde bien deux essais distincts (pas un front dégénéré à un seul point)', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    const ids = new Set([
      result.profiles?.charge_min.trial_id,
      result.profiles?.equilibre.trial_id,
      result.profiles?.economie_max.trial_id,
    ]);
    assert.equal(ids.size, 2);
  });

  test('étalement de cadence suffisant sur un vrai balayage', () => {
    if (result.status !== 'ok') throw new Error('précondition non remplie');
    assert.equal(result.cadence_spread_sufficient, true);
    assert.equal(result.cadence_spread_pct, 10.1);
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

// Audit §1.2 : le moteur validait chaque essai isolément mais jamais la cohérence de la session.
// Trois essais séparés de 1 pas/min produisaient un front d'apparence normale, alors que la
// précision du comptage d'appuis est d'environ ±2 pas/min.
describe('runRunningEngine — étalement de cadence : le bruit de mesure ne doit pas passer pour un compromis', () => {
  test('trois essais à 168/169/170 -> analyse rendue mais étalement signalé insuffisant', () => {
    const r = runRunningEngine([mkTrial('a', 168), mkTrial('b', 169), mkTrial('c', 170)], profile);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.cadence_spread_sufficient, false);
    assert.ok(r.cadence_spread_pct < 4, `étalement ${r.cadence_spread_pct}`);
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

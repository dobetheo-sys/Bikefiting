# SPEC — Moteur d'analyse posturale, position aéro (prolongateurs)

**Statut** : V1 — projet parallèle, indépendant d'EnduraBuild
**Portée** : position prolongateurs uniquement. Position guidon = module séparé, réutilise ce pipeline.

---

## 1. Décisions de conception (prises pour avancer)

- **Discret, pas continu.** Le moteur ne suppose pas un espace de recherche continu de positions (pas de modèle biomécanique complet du vélo). Il score des **essais réellement filmés** par l'utilisateur (variantes de reach/drop/recul testées physiquement) et compare ces essais entre eux. Minimum 3 essais pour proposer une frontière, 5 recommandés.
- **Aéro = score relatif, pas CdA absolu.** Sans soufflerie, impossible de sortir un CdA comparable à d'autres coureurs. Le score aéro classe les essais de l'utilisateur *entre eux*, mais s'appuie maintenant sur une méthode terrain publiée et validée (section 5) plutôt qu'un proxy approximatif.
- **Le test de souplesse hanche est obligatoire avant toute analyse.** Sans lui, la contrainte dure de fermeture de hanche ne peut pas être calibrée → le moteur refuse de scorer et redirige vers le test (protocole ASLR, scoré 1-5).
- **KOPS écarté comme contrainte dure.** Audit fait : le KOPS (genou au-dessus de l'axe pédalier) n'a aucune base biomécanique validée (Bontrager, largement corroboré depuis, y compris par les fitters qui l'utilisaient historiquement). Il reste calculable comme **repère informatif** dans le module guidon, jamais comme critère d'exclusion.
- **Paysage concurrentiel vérifié : l'approche phone-only est déjà pratiquée par des acteurs établis** (MyVeloFit : 2 vidéos courtes, souplesse d'abord puis vidéo sur home-trainer, itératif ; BikeFittr, BikeFit-IA : analyse d'angles par photo/vidéo). Ça valide la faisabilité technique globale et confirme le séquençage retenu ici : souplesse → capture posturale → itération.

---

## 2. Pipeline d'entrée

Deux captures par essai (les deux réalisables au téléphone, sans aide extérieure avec un simple support/trépied) :

**A. Vidéo profil (sagittal)** — pour les angles articulaires
```
Vidéo profil, N cycles pédalage, effort stable
  → pose estimation (33 keypoints/frame)
  → séries temporelles d'angles par articulation
  → agrégation par essai : {mean, min, max, amplitude, variance} par angle
```

**B. Photo frontale statique — pour la surface frontale projetée (pFSA)**
Méthode terrain publiée (Debraux et al. 2009 ; reprise Sci-Sport) : protocole simple, exécutable seul.
```
Photo de face, axe caméra aligné sur le vélo, distance ≥ 5 m, objet de calibration
connu placé au niveau des hanches (ex. une règle, ou la largeur de cintre connue)
  → segmentation silhouette (personne + vélo)
  → comptage pixels dans le contour, converti en cm² via la calibration
  → 1 photo = 1 valeur pFSA (cm²)
```

→ 1 essai = 1 vecteur de métriques angulaires (A) + 1 valeur pFSA (B).

Profil athlète requis en entrée :
- `hip_flexibility_score` (1-5, test ASLR)
- `femur_length`, `torso_length` (optionnel, affine les plages mais pas bloquant en v1)
- `race_duration_hours` (pour Aix 70.3 : ~2h30-3h vélo — pondère le poids "durée d'exposition" dans le score confort)

---

## 3. Couche 1 — Validation (contraintes dures)

Fonction : `validate(angles, profile) → {valid: bool, violations: [...], margins: {...}}`

| Paramètre | Plage valide | Dépendance / source |
|---|---|---|
| Fermeture hanche (torse-hanche-cuisse, PMH) | plancher dur à **40°**, cible **45-50°** selon format et souplesse | Données Retül/BikeFittr : sous 40°, la majorité des athlètes perdent 5-15% de puissance (compression respiratoire, empiètement de hanche) — c'est le seuil où le compromis s'inverse, pas 35° comme en v1 |
| Angle tronc (horizontale) | 5° – 15° | cohérent avec littérature bike-fit TT/tri, à affiner par retours |
| Genou au PMB (angle interne hanche-genou-cheville) | ~137-150° interne (≈ 30-43° de flexion) | sources pro convergent sur cette fourchette plus qu'un chiffre unique — garder en plage, pas en valeur cible fixe |
| Ankling (variation cheville) | flag si > 22° | sourcé : un cycliste type utilise 15-20° sur les ~60° disponibles à la cheville (BikeDynamics). Nuance importante trouvée en audit : la littérature récente (220 Triathlon) doute que l'ankling soit un vrai facteur d'efficacité et note qu'un ankling excessif signale plus souvent une hauteur de selle mal réglée qu'un problème de position aéro — le flag reste informatif, jamais un critère d'exclusion |
| Déviation poignet | **non exclusoire** (warning à ~15° ulnaire) | **non sourcé** — pas de littérature bike-fit chiffrée trouvée. Rétrogradé en avertissement plutôt qu'en contrainte dure pour ne pas invalider une position sur un chiffre inventé (cf. §10) |
| KOPS (position genou/axe pédalier) | **non exclusoire** | affiché en informatif uniquement (voir §1) — jamais utilisé pour invalider un essai |

**Correction v1 → v2** : le plancher de fermeture hanche est remonté de 35° à **40°** (v1 sous-estimait le coût en puissance d'une hanche trop fermée). Au-delà, la cible dépend du format : ~45° pour du 70.3, plus ouvert (50°+) tolérable en flexibilité moyenne sur format plus court. `min_hip(flex_score)` reste modulé par la souplesse déclarée, mais ne descend plus sous 40° même pour un score de souplesse élevé — la marge de manœuvre se joue désormais entre 40° et 50°, pas entre 35° et 45°.

Règle : **une seule violation de contrainte dure = essai invalide**, exclu du calcul Pareto, mais gardé en base avec le motif (utile pour montrer à l'utilisateur pourquoi une position a été écartée).

Cas `ankling` élevé : l'essai n'est pas invalidé mais un flag `unstable_pedaling=true` est attaché — le score confort de cet essai est calculé avec un intervalle de confiance élargi plutôt qu'exclu, car l'instabilité peut être un artefact du jour (fatigue, cale mal réglée) plutôt qu'un vrai problème de position.

---

## 3.1 Protocole du test de souplesse hanche (ASLR)

Test clinique standard, adapté pour être réalisable seul avec un téléphone (pas de goniomètre ni de partenaire nécessaire).

**Ancrage clinique** : l'Active Straight Leg Raise (ASLR) est un test validé, seuil de référence largement cité en littérature clinique = **80° de flexion de hanche**. En dessous de 80°, tightness des ischio-jambiers/chaîne postérieure ; au-dessus, ROM considérée normale à bonne.

**Protocole phone-only proposé** :
1. S'allonger sur le dos, jambe testée tendue (genou verrouillé), jambe opposée à plat ou stabilisée
2. Téléphone posé au sol/sur un support, dans l'axe latéral (vue sagittale), cadré sur la hanche et la jambe entière
3. Lever la jambe testée le plus haut possible sans plier le genou, sans forcer
4. Pose estimation extrait l'angle cuisse/horizontale au point d'arrêt (genou qui commence à plier = fin de mesure)
5. Répéter 2x par côté, garder la valeur médiane

**Mapping vers `hip_flexibility_score` (1-5)**, ancré sur le seuil clinique de 80° :

| Angle ASLR mesuré | `flex_score` | Interprétation |
|---|---|---|
| < 60° | 1 | Raideur marquée |
| 60° – 70° | 2 | Raideur modérée |
| 70° – 80° | 3 | Limite (juste sous le seuil clinique de tightness) |
| 80° – 90° | 4 | ROM normale |
| > 90° | 5 | Bonne flexibilité |

Asymétrie gauche/droite > 10° → flag à part (affecte potentiellement le réglage cale/asymétrie plutôt que la position aéro globale, hors scope v1).

---

## 4. Couche 2 — Score confort (0-100)

```
comfort_score = 100
  - penalty_hip(hip_mean, hip_flex_score)      # quadratique près des bornes
  - penalty_trunk(trunk_mean)
  - penalty_variance(hip_var, trunk_var)        # stabilité inter-cycles
  - penalty_wrist(wrist_deviation)
  × subjective_multiplier                       # 1.0 par défaut, ajusté par feedback (couche 4)
```

Pénalités quadratiques (pas linéaires) : un angle à 2° de la limite coûte peu, à la limite même coûte beaucoup — reflète que la douleur n'est pas linéaire avec l'écart angulaire.

`subjective_multiplier` par zone (nuque/lombaires/mains/genoux) initialisé à 1.0 pour tout nouvel utilisateur, recalibré uniquement après un premier feedback (couche 4).

---

## 5. Couche 3 — Score aéro (0-100, relatif) via pFSA mesurée

Amélioration par rapport à la v1 (proxy keypoints) : on utilise la **surface frontale projetée (pFSA)** mesurée directement sur la photo frontale calibrée (pipeline §2B). C'est une méthode terrain publiée (Debraux et al. 2009, validée contre digitalisation CAO et méthode de pesée de photos — pas d'écart significatif entre méthodes), pas une approximation par squelette.

```
aero_score = f(pFSA_normalized, trunk_angle, head_position)
```

- `pFSA_normalized` : poids dominant (~65%), surface mesurée (cm²) normalisée par la taille du sujet — mesure directe, plus fiable que l'ancien proxy largeur d'épaules
- `trunk_angle` : poids secondaire (~25%), reste utile car il capture la dynamique du cycle de pédalage (la photo frontale est statique, la vidéo profil apporte la variabilité dans le temps)
- `head_position` : signal correctif (~10%), tête haute par rapport à la ligne d'épaules = pénalité (compensation nuque)

**Protocole de capture (contraintes terrain, cf. §2B)** : caméra dans l'axe du vélo, distance minimale 5 m (sinon distorsion de perspective qui fausse la mesure), objet de calibration connu au niveau des hanches. Faisable seul avec un trépied ou un support téléphone + retardateur — aucun équipement spécialisé.

**Limite affichée à l'utilisateur** : ce score sert à classer SES positions entre elles (comparaison intra-utilisateur), pas à produire un CdA absolu comparable à un autre coureur ou à une valeur de soufflerie — même avec la pFSA mesurée, il manque le CdA (coefficient de traînée) propre à la texture/forme, qui nécessite une soufflerie.

---

## 6. Couche 4 — Sélection Pareto + 3 profils de sortie

1. Filtrer les essais invalides (couche 1)
2. Sur les essais valides, calculer le front de Pareto (dominance simple : un essai domine un autre s'il est ≥ sur les deux scores et > sur au moins un)
3. Sélectionner dans le front :
   - **Confort max** : meilleur `comfort_score` du front
   - **Aéro max** : meilleur `aero_score` du front
   - **Équilibré** : point du front minimisant la distance euclidienne au point idéal (100,100) normalisé

Si < 3 essais valides → le moteur ne propose pas de front, retourne un message explicite demandant des essais supplémentaires (avec suggestion de variantes à tester : ex. "essai avec reach -1cm" basé sur les violations observées).

Sortie par profil : deltas matériel (hauteur selle, recul, reach, drop, longueur prolongateurs) dérivés de la différence entre l'essai sélectionné et le baseline, + les deux scores + marge par rapport aux contraintes dures.

---

## 7. Couche 5 — Boucle de feedback

Après N sorties sur un profil choisi, questionnaire post-sortie :
- Douleur/gêne par zone (nuque, lombaires, mains, genoux) — échelle 1-5
- RPE position globale — échelle 1-5

Recalibration : si une zone est notée ≥4 de façon répétée (2 sorties consécutives), le poids de la contrainte angulaire correspondante augmente pour CET utilisateur (`subjective_multiplier` baisse pour cette zone), resserrant la proposition à l'itération suivante. Pas de recalibration sur un seul retour isolé — évite l'overfit à un mauvais jour.

---

## 8. Format de sortie (JSON, exemple)

```json
{
  "session_id": "aero_2026-08-06",
  "trials_valid": 4,
  "trials_excluded": 1,
  "profiles": {
    "confort_max": {
      "trial_id": "t2",
      "comfort_score": 87,
      "aero_score": 61,
      "deltas": {"saddle_height_mm": 0, "reach_mm": -10, "drop_mm": -5},
      "margins": {"hip_deg": 6.2, "trunk_deg": 3.1}
    },
    "equilibre": { "...": "..." },
    "aero_max": { "...": "..." }
  },
  "excluded_trials": [
    {"trial_id": "t5", "violation": "trunk_angle < 5deg", "value": 3.2}
  ]
}
```

---

## 9. Table de confiance des sources

Pour que tu saches exactement sur quoi s'appuyer sans le revérifier, et ce qui reste à consolider :

| Élément | Statut | Source |
|---|---|---|
| Plancher hanche 40° | **Sourcé** | Retül/BikeFittr (données agrégées, seuil de bascule puissance/aéro) |
| Seuil ASLR 80° | **Sourcé, clinique** | Littérature kinésithérapie/clinique (SLR test, multiples études) |
| Ankling typique 15-20° | **Sourcé** | BikeDynamics (fitters pro) |
| pFSA (surface frontale par photo) | **Sourcé, publié** | Debraux et al. 2009, validé contre 2 autres méthodes |
| KOPS non-exclusoire | **Sourcé** | Bontrager + corroboration large depuis (biomécanique, fitters modernes) |
| Angle tronc 5-15°, genou 137-150° | **Convergence de sources pro**, pas une norme unique gravée dans le marbre | Multiples bike-fitters (BikeDynamics, Rocket Bicycle, BikeFittr) |
| Déviation poignet 15° | **Non sourcé — défaut d'ingénierie** | Aucune littérature chiffrée trouvée ; paramètre réglable à traiter avec prudence |
| Poids du score aéro (65/25/10) et confort (pondérations) | **Non sourcé — défaut d'ingénierie** | Choix raisonnable de départ, à calibrer par la boucle de feedback (couche 5), pas une vérité biomécanique |

Deux paramètres du moteur (déviation poignet, pondérations exactes des scores) restent des hypothèses de travail assumées comme telles — c'est normal pour un V1, mais je ne veux pas te les présenter comme aussi solides que le reste.

---

## 10. Portée V1 proposée

**Dans le scope V1** :
- Position aéro/prolongateurs uniquement (guidon = V2)
- Capture : vidéo profil (angles) + photo frontale calibrée (pFSA)
- Test ASLR pour la souplesse hanche (obligatoire avant 1ère analyse)
- Contraintes dures : hanche (40° plancher), tronc, genou, ankling (flag), poignet (flag, non bloquant vu l'absence de source solide — je le passerais en avertissement plutôt qu'en contrainte dure tant qu'on n'a pas de donnée fiable)
- Scores confort + aéro (pFSA-based), sélection Pareto sur essais réels (min. 3)
- 3 profils de sortie avec deltas matériel
- Boucle de feedback post-sortie (recalibration par zone)

**Hors scope V1, explicitement reporté** :
- Position guidon (module V2, réutilise le pipeline)
- Vue frontale dynamique (uniquement statique en V1 — une vidéo frontale sur cycle complet serait plus riche mais double la complexité de capture solo)
- Asymétrie gauche/droite (mesurée au passage via ASLR mais pas exploitée dans le moteur de reco V1)
- Calibration cm/px : choix définitif de l'objet de référence (règle vs largeur de cintre connue) — la largeur de cintre est préférable si fiable, évite un objet à manipuler seul

**Point où ton arbitrage compte vraiment** : je propose de passer `déviation poignet` en avertissement (warning) plutôt qu'en contrainte dure d'exclusion, puisqu'aucune source ne justifie un seuil précis — l'inverse (le garder en contrainte dure) risquerait d'éliminer à tort de bonnes positions sur la base d'un chiffre inventé. Je pars sur ce choix sauf avis contraire de ta part.

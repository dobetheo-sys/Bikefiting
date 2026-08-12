# SPEC — Moteur d'analyse de foulée (course à pied)

**Statut** : V1 complète — moteur, mesure et parcours utilisateur faits et vérifiés en navigateur
**Portée** : protocole tapis de course uniquement. Course en extérieur = module séparé (§10).
**Projet parent** : `posture-aero` (moteur position vélo). Ce moteur réutilise le même pipeline
de capture et les mêmes briques de scoring, cf. `src/shared/`.

---

## 1. Décisions de conception (et ce qu'elles écartent)

- **Discret, pas continu.** Comme le moteur vélo (§1 du spec vélo) : on ne modélise pas la
  foulée, on score des **essais réellement filmés**. La différence est qu'en vélo l'utilisateur
  fait varier le matériel, alors qu'ici il fait varier **sa cadence** — c'est le seul paramètre
  de foulée qu'un coureur peut modifier de façon fiable et immédiate, avec un métronome.

- **Tout est relatif à la cadence spontanée de l'athlète. Il n'y a pas de "180 pas/min".**
  Le chiffre de 180 vient d'une observation de Jack Daniels sur des coureurs élite en
  compétition ; ce n'est pas une norme validée pour tous les coureurs à toutes les allures. La
  cadence dépend de l'allure et de la longueur de jambe. Le moteur mesure donc la cadence
  librement choisie de l'athlète **à la vitesse de test**, et exprime tout en écart relatif à
  celle-ci. C'est la même discipline que le refus d'inventer une norme de reach/drop côté vélo.

- **Le front de Pareto tient sur UNE opposition, et il faut qu'elle soit réelle.**
  Il aurait été facile de fabriquer deux scores "charge" et "économie" et de prétendre qu'ils
  s'opposent. En réalité, la plupart des métriques de foulée mesurables au téléphone
  (overstriding, oscillation verticale) s'améliorent **dans le même sens** sur les deux axes —
  un front construit là-dessus serait dégénéré et donnerait l'illusion d'un compromis inexistant.
  La seule opposition documentée porte sur la cadence :
  - **plus de cadence → moins de charge** (Heiderscheit et al. 2011)
  - **s'écarter de la cadence spontanée → coût métabolique plus élevé** (Cavanagh & Williams 1982)

  C'est pour cette raison que la composante cadence pèse le plus dans les deux scores, et que le
  balayage proposé (spontanée / +5% / +10%) reprend exactement les points testés par Heiderscheit.

- **Aucune contrainte biomécanique dure. C'est la différence structurelle majeure avec le vélo.**
  Le moteur vélo peut exclure un essai parce qu'il existe un seuil sourcé (hanche sous 40° =
  5-15% de puissance perdue chez la majorité des athlètes). **Rien d'équivalent n'existe en
  course** : aucune métrique mesurable au téléphone n'a de seuil publié du type "au-delà de X°,
  blessure". Les seules exclusions de ce moteur sont donc des **problèmes de validité de mesure**
  (essai filmé à une autre vitesse, cadence aberrante, point mal tapé). Tout le reste est en
  avertissement — c'est la règle déjà appliquée au poignet côté vélo ("non sourcé → jamais
  exclusoire"), étendue ici à la quasi-totalité des critères.

- **Type d'attaque du pied : mesuré, affiché, jamais scoré.** La littérature ne converge pas sur
  la supériorité d'un type d'attaque (talon / medio / avant-pied). Même traitement que le KOPS
  côté vélo : repère informatif, jamais un critère.

---

## 2. Pipeline d'entrée

Une session = N essais **à la même vitesse de tapis**, à des cadences différentes.

**A. Cadence** (la mesure qui porte tout le reste)
```
Compter les APPUIS (les deux pieds) sur une durée connue -> pas/min
   ou : estimation automatique depuis l'oscillation verticale du bassin
        (estimateCadenceFromFrames, avec garde-fou d'échantillonnage)
```
Piège classique : une foulée = deux appuis. Compter les foulées donne une cadence deux fois trop
basse et fait basculer tout le scoring.

**B. Image d'attaque du pied** — pour les angles
```
Vidéo profil sur tapis -> l'athlète choisit l'image où le pied touche le sol
  -> 6 taps : épaule, hanche, genou, cheville, talon, pointe
  -> tibia (signé), flexion genou, inclinaison tronc, ratio d'overstriding, angle de pied
```
Le sens de course est **déduit** de l'orientation du pied (talon → pointe), pas demandé à
l'utilisateur ni supposé : sur tapis on peut être filmé de son côté gauche comme de son côté
droit, et sans ça un overstriding filmé du mauvais côté serait compté comme une foulée parfaite.

**C. Oscillation verticale (optionnelle)** — 2 images de plus (bassin au plus bas, au plus haut)
```
amplitude verticale du bassin / longueur de jambe -> ratio SANS DIMENSION
```
Volontairement un ratio et non des centimètres : ça supprime complètement l'étape de calibration
cm/px, qui est la source d'erreur qui a le plus coûté côté vélo (pFSA mesurée à 2.9 cm² au lieu
de quelques milliers, cf. `CalibrationRef`).

**Pourquoi la mesure manuelle est le chemin principal, pas un repli** : côté vélo, la détection
automatique a été tentée puis abandonnée après plusieurs échecs sur de vraies vidéos (un essai
réel donnait un tronc à 43°, impossible sur un vélo). La course est un cas *plus* difficile, pas
moins : le sujet se déplace dans le cadre, les membres se croisent, et l'image utile dure
quelques centièmes de seconde. On part donc directement sur le protocole qui a fini par marcher.

Profil athlète requis :
- `selfSelectedCadenceSpm` — **obligatoire**, mesurée à la vitesse de test (équivalent structurel
  du test ASLR côté vélo : sans elle, le moteur refuse de scorer)
- `testSpeedKmh` — identique pour tous les essais de la session
- `heightCm`

---

## 3. Couche 1 — Validation

`validateRunTrial(trial, profile) → {valid, violations, warnings, margins}`

**Contraintes dures — validité de mesure uniquement**

| Paramètre | Règle | Justification |
|---|---|---|
| Vitesse de l'essai | écart > 0.3 km/h avec `testSpeedKmh` → **exclu** | Cadence et angles dépendent de l'allure. Comparer un essai à 11 km/h et un à 13 km/h ne mesure pas l'effet de la cadence, il mesure l'effet de la vitesse. Seule contrainte dure vraiment solide de ce moteur, et elle est méthodologique. |
| Cadence hors [130, 220] | **exclu** | Erreur de comptage (appuis mal comptés, durée mal saisie), pas une foulée exotique. |
| Métrique NaN | **exclu** | Deux points tapés confondus. Sans ce test explicite, toutes les comparaisons `<`/`>` valent silencieusement `false` et l'essai corrompu ressortirait comme profil recommandé. |

**Avertissements — jamais exclusoires**

| Paramètre | Repère | Source |
|---|---|---|
| Tibia à l'attaque | > 10° vers l'avant | Le principe "tibia proche de la verticale" est standard en réathlétisation ; **le seuil chiffré ne l'est pas** |
| Ratio d'overstriding | > 0.15 | **Non sourcé** — défaut d'ingénierie |
| Flexion genou à l'attaque | < 10° | Flexion typique 10-20° à l'attaque ; sous 10°, réception jambe quasi tendue |
| Inclinaison du tronc | hors 5-15° | Convergence de sources ; Teng & Powers 2014 : plus de flexion du tronc réduit la contrainte fémoro-patellaire |
| Angle de pied | — | **Jamais évalué**, seulement décrit (talon / medio / avant-pied) |

---

## 4. Couche 2 — Score charge (0-100, 100 = charge estimée la plus faible)

```
charge = 0.45 × cadence + 0.25 × overstriding + 0.15 × tibia + 0.15 × flexion_genou
```

Composante cadence, ancrée sur Heiderscheit et al. 2011 (±5% et ±10% autour de la cadence
spontanée) :
```
-10% -> 0     cadence spontanée -> 50     +10% -> 100
```
**L'échelle sature à ±10% parce que c'est la fenêtre effectivement testée.** Au-delà, le moteur
cesse de créditer plutôt que d'extrapoler une relation hors de son domaine de validité.

`overstriding` et `tibia` mesurent le même phénomène par deux points différents. Ce n'est pas un
double comptage accidentel : deux mesures indépendantes du même défaut rendent le score moins
sensible à **un** point mal tapé, qui est le mode d'échec réellement observé sur le terrain.

Pénalités quadratiques, mêmes raisons qu'au §4 du spec vélo.

---

## 5. Couche 3 — Score économie (0-100, relatif à la session)

```
économie = 0.55 × écart_cadence + 0.30 × oscillation_verticale + 0.15 × tronc
```

Composante dominante ancrée sur Cavanagh & Williams 1982 : le coût en oxygène est minimal autour
de la longueur de foulée librement choisie et remonte **dans les deux sens**. C'est exactement ce
qui oppose ce score au score de charge — sans cette opposition documentée, le front de Pareto
n'aurait pas de sens.

L'oscillation verticale est notée **relativement aux essais de la session**, jamais dans l'absolu
— même parti pris que le score aéro côté vélo, pour la même raison : on classe les essais de CE
coureur entre eux, on ne le compare pas à une population.

**Si l'oscillation verticale n'est pas mesurée sur tous les essais valides, elle est ignorée pour
tout le monde** et son poids redistribué. Sinon les essais où elle n'a pas été mesurée seraient
pénalisés sur une composante absente — un artefact de protocole déguisé en différence de foulée.
(Le moteur vélo, lui, laisse la composante à 0 : acceptable là-bas parce que la pénalité frappe
tous les essais identiquement.)

---

## 6. Couche 4 — Front de Pareto + 3 profils

Dominance identique au moteur vélo (`paretoDominant`, `src/shared/analysis.ts`) :
- **Charge min** : meilleur score de charge du front
- **Économie max** : meilleur score d'économie du front
- **Équilibré** : point du front le plus proche de l'idéal (100,100)

`goal` (`charge` / `economy`) ne change **aucun calcul** : il sélectionne seulement lequel des
trois est mis en avant. Pas de pondération cachée dépendante de l'objectif.

Moins de 3 essais valides → pas de front, et le moteur dit quelle cadence filmer ensuite.

**Résultat obtenu sur le jeu de test** (cadence spontanée 168, foulée propre, tapis à 12 km/h) :

| Essai | Cadence | Charge | Économie |
|---|---|---|---|
| spontanée | 168 | 77.5 | 100 |
| +5% | 176 | 88.3 | 93.7 |
| +10% | 185 | 100 | 71.9 |

Les trois sont sur le front (aucun n'en domine un autre — l'opposition est donc réelle, pas
décorative), et l'**équilibré tombe sur +5%**, qui est le compromis classique de la littérature.
Ce n'est pas codé en dur : c'est ce que le calcul retourne.

---

## 7. Table de confiance des sources

| Élément | Statut | Source |
|---|---|---|
| Augmenter la cadence de 5-10% réduit la charge articulaire | **Sourcé** | Heiderscheit et al. 2011, *Med Sci Sports Exerc* — énergie absorbée genou/hanche, impulsion de freinage, adduction de hanche |
| Coût métabolique minimal à la foulée librement choisie (courbe en U) | **Sourcé** | Cavanagh & Williams 1982, *Med Sci Sports Exerc* |
| Fenêtre de validité ±10% | **Sourcé** | C'est l'amplitude effectivement testée par Heiderscheit et al. |
| Flexion genou 10-20° à l'attaque | **Sourcé, indicatif** | Biomécanique de la course, valeurs largement rapportées |
| Inclinaison tronc 5-15° | **Convergence de sources** | Teng & Powers 2014 pour le lien avec la contrainte fémoro-patellaire |
| Absence de norme universelle de cadence (le "180") | **Sourcé** | Origine élite/compétition (Daniels), jamais validée comme norme générale |
| Pas de type d'attaque supérieur aux autres | **Sourcé (absence de consensus)** | D'où le choix "informatif, jamais scoré" |
| Seuils tibia 10° et overstriding 0.15 | **Non sourcé — défaut d'ingénierie** | Le principe est standard, le chiffre est une hypothèse. Avertissement seulement. |
| Pondérations des deux scores | **Non sourcé — défaut d'ingénierie** | Choix de départ, à calibrer par le terrain |
| Tolérance de vitesse 0.3 km/h | **Non sourcé** | Sur tapis l'allure est exacte ; tolérance pour l'arrondi de saisie |
| `estimateCadenceFromFrames` | **Non validé sur appareil réel** | Correct sur signal synthétique (180 pas/min mesurés sur une vérité terrain de 180). À confronter au comptage manuel sur les premiers essais réels. |

---

## 8. Limites à afficher à l'utilisateur, pas à enterrer

1. **Les scores classent SES essais entre eux, ils ne le comparent à personne.** Un score
   d'économie de 100 ne veut pas dire "foulée économique", il veut dire "le plus économique de
   tes essais d'aujourd'hui". Même limite que le score aéro côté vélo.
2. **Tapis ≠ terrain.** La foulée sur tapis diffère de la foulée au sol (courroie motrice,
   absence de résistance de l'air, surface constante). Les écarts *relatifs* entre essais restent
   exploitables ; les valeurs absolues ne transfèrent pas telles quelles.
3. **La précision dépend du tapotage.** Deux mesures du même essai ne donneront pas exactement le
   même chiffre. C'est pour ça qu'aucun essai n'est exclu sur un critère biomécanique.
4. **Le moteur estime une charge, il ne prédit pas une blessure.** Le lien cadence → charge est
   documenté ; le lien charge → blessure chez un individu donné ne l'est pas.
5. **Une cadence plus haute n'est pas gratuite.** C'est exactement ce que dit l'axe économie : le
   moteur ne recommande pas "monte ta cadence", il montre ce que ça coûte et ce que ça rapporte.

---

## 9. Ce qui est fait

| Brique | Fichier | Testé |
|---|---|---|
| Moteur (validation, 2 scores, Pareto, suggestion) | `src/engine/running-gait-engine.ts` | `running-gait-engine.test.ts` |
| Mesure (taps → métriques, cadence, oscillation) | `src/capture/running-capture-processing.ts` | `running-capture-processing.test.ts` |
| Primitives partagées avec le vélo | `src/shared/geometry.ts`, `src/shared/analysis.ts` | via les tests des deux moteurs |
| Mode de capture `run_video` (6 taps sur l'image d'attaque) | `src/components/PostureCaptureFlow.jsx` | Piloté dans un vrai Chromium jusqu'à l'écran de capture |
| Parcours complet (intro → profil → essais → résultats) | `src/components/RunningSession.jsx` | Piloté dans un vrai Chromium de bout en bout, y compris l'écran de résultats sur une session pré-remplie |

**Ce qui reste non vérifié sur appareil réel** : la mesure elle-même sur une vraie vidéo de
course (choix de l'image d'attaque, précision des 6 taps). C'est le point à confronter au
terrain en premier — c'est là que le parcours vélo avait révélé ses vrais problèmes.

---

## 10. Hors scope V1, explicitement reporté

- **Métronome intégré.** L'app donne la cadence cible en pas/min, l'athlète utilise une appli
  de métronome. Un métronome maison ajouterait une surface de bug (Web Audio, autoplay bloqué,
  dérive du timing en arrière-plan) pour remplacer quelque chose qui existe déjà et marche.
- **Cadence automatique branchée dans l'UI.** `estimateCadenceFromFrames` existe et est testée,
  mais la saisie reste manuelle : tant que l'estimateur n'a pas été confronté au comptage manuel
  sur de vraies vidéos, l'afficher comme une mesure fiable serait prématuré.
- **Historique et tendance entre sessions** (le parcours vélo les a, la course non)
- **Course en extérieur.** Le sujet traverse le cadre, donc la perspective change pendant le
  passage — les angles mesurés en bord de cadre sont faussés par la parallaxe. Exploitable
  seulement en ne retenant que les appuis proches du centre de l'image, soit 1 à 2 appuis par
  passage. Demande une correction de parallaxe et un protocole différent.
- **Détection automatique de l'image d'attaque** (le moment où le pied touche)
- **Asymétrie gauche/droite** — mesurable en tapant les deux côtés, non exploitée par le moteur
- **Temps de contact au sol** — demande une vidéo à cadence d'images élevée et une détection
  fiable du décollage, hors de portée du protocole actuel
- **Boucle de feedback post-sortie** (l'équivalent du §7 vélo : douleur par zone → recalibration)

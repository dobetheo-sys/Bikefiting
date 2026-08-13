# SPEC — Moteur d'analyse technique de nage (crawl)

**Statut** : V0 — projet parallèle, indépendant de posture-aero (vélo). Nouveau domaine,
aucun code réutilisé du moteur vélo — seule la méthode de travail est reprise (spec écrite
d'abord, table de confiance des sources, tests réels avant de considérer une brique "faite").
**Portée** : crawl (nage libre) uniquement. Dos/brasse/papillon = hors scope, pipeline
probablement réutilisable en partie (§10).

---

## 0. Contrainte fondatrice, à lire avant tout le reste

En vélo, la caméra filme un sujet globalement statique dans un plan aérien, sans eau entre
la caméra et le sujet. En natation, le sujet est **majoritairement immergé**, ce qui change
le problème de fond :

**La pose estimation grand public (MediaPipe Pose et équivalents) ne fonctionne pas de façon
fiable sous l'eau.** Recherche vérifiée : la réfraction de l'eau déplace la position apparente
des membres immergés (un cas documenté : un modèle standard place le bras à ~15 cm de sa
position réelle), et les perturbations visuelles (bulles, éclaboussures, reflets) dégradent
fortement la précision. Même des approches spécialisées publiées (SwimmerNET, drones) doivent
construire des modèles ou des filtrages dédiés pour compenser, et perdent encore ~15% des
frames en nettoyage de données malgré ça.

**Conséquence directe sur la portée V0** : ce moteur n'analyse que ce qui est observable
**au-dessus de la surface** depuis une caméra fixe posée au bord du bassin (téléphone sur
support/trépied, comme en vélo — pas d'assistant, pas de caisson étanche requis en V0).
Tout ce qui nécessite une vue sous-marine fiable (attaque de la nage, trajectoire de main,
angle de coude, appui) est **explicitement hors scope V0** (§10) — pas parce que ce n'est
pas intéressant, mais parce qu'aucune méthode phone-only fiable n'existe aujourd'hui pour
le mesurer solo. Un moteur qui prétendrait le faire quand même produirait des chiffres qui
ont l'air précis mais ne le sont pas — pire qu'un moteur qui ne le fait pas.

---

## 1. Décisions de conception

- **Caméra fixe, nageur qui traverse le champ — pas de suivi/panoramique.** Le téléphone est
  posé au bord du bassin (support/trépied), perpendiculaire à une ligne d'eau, cadré sur une
  portion médiane du bassin (~3-5 m, hors virages et hors mur de départ pour éviter les
  artefacts de poussée/virage). Le nageur fait des longueurs dans cette ligne ; l'analyse
  porte sur les quelques cycles de bras visibles pendant la traversée du champ. Solo-friendly
  (aucun opérateur caméra requis), au prix d'une fenêtre d'observation courte par longueur —
  compromis assumé, à valider avec un entraîneur (§ audit professionnels, point 1).
- **Deux capture indépendantes possibles, combinables** :
  A. **Vidéo latérale (le nageur traverse le champ)** — stroke rate, respiration, roulis
     partiel, indice de battement (proxy éclaboussures)
  B. **Chronométrage manuel d'une longueur** (durée + nombre de brasses saisis par
     l'utilisateur, ou dérivés de A si la longueur entière est filmée) — DPS, SWOLF
- **Score relatif au nageur, pas absolu par rapport à l'élite.** Comme en vélo (aéro relatif,
  pas CdA absolu), ce moteur compare les séances d'un même nageur entre elles. Les seuils
  DPS/SR "bons" dépendent fortement du niveau, de la taille et du format de course — il n'y a
  pas d'équivalent au "plancher hanche 40°" du vélo qui soit universel ici (voir §9).
- **Pas de contrainte dure d'exclusion façon vélo.** En vélo, une violation invalide l'essai
  (risque articulaire mesurable). En nage V0, aucune métrique captée n'est assez fiable ou
  assez universellement sourcée pour justifier d'invalider une séance — tout est en couche
  "signal", avec un niveau de confiance affiché (§4), jamais un verdict binaire.
- **Paysage concurrentiel vérifié** : aucun produit grand public phone-only trouvé qui fasse
  de l'analyse technique de nage par pose estimation en solo (contrairement au vélo où
  MyVeloFit/BikeFittr existent déjà). Recherche académique active (SwimmerNET, drones,
  projets étudiants) mais rien de déployé/validé en produit — ce moteur serait plus
  expérimental que son équivalent vélo, à annoncer comme tel à l'utilisateur.

---

## 2. Pipeline d'entrée

```
Vidéo latérale, nageur traversant le champ fixe, N longueurs
  → pose estimation (frames où le nageur est visible hors eau : recovery du bras, tête)
  → détection de cycles de bras (maxima locaux du bras de recovery au-dessus de la ligne d'eau)
  → séries temporelles : timestamps de recovery, orientation tête/épaules aux instants visibles
  → agrégation par longueur : {stroke_rate, breathing_pattern, roll_proxy, kick_index}
```

```
Chronométrage longueur (entrée utilisateur ou dérivé de la vidéo si le mur de départ
et le mur d'arrivée sont dans le champ — sinon saisie manuelle)
  → durée (s) + nombre de brasses comptées + longueur du bassin (m, saisie profil)
  → DPS = longueur_bassin / nb_brasses
  → SWOLF = durée_s + nb_brasses
```

Profil nageur requis en entrée :
- `pool_length_m` (25 ou 50, obligatoire pour DPS/SWOLF)
- `level` (débutant / intermédiaire / confirmé / compétition — module l'interprétation
  des seuils DPS/SR, cf. §9, pas de valeur universelle)
- `height_cm` (optionnel, affine DPS attendu mais pas bloquant)
- `dominant_breathing_side` (optionnel, sert de référence pour détecter l'asymétrie)

---

## 3. Couche 1 — Métriques mesurées directement (haute confiance)

Ces métriques ne dépendent d'aucun modèle de vision — juste du temps et d'un comptage, la
vision sert seulement à automatiser le comptage :

| Métrique | Calcul | Fiabilité |
|---|---|---|
| Stroke rate (SR, cycles/min) | intervalle entre recoveries successifs du même bras | Haute — le bras en recovery est hors de l'eau, bien détecté par pose estimation standard |
| DPS (distance par brasse) | longueur bassin / nb brasses sur la longueur | Haute si le comptage est fiable (vision ou manuel) |
| SWOLF | durée (s) + nb brasses | Haute — métrique établie, utilisée par la plupart des montres/trackers de nage |
| Symétrie de respiration | ratio brasses côté A / côté B sur N longueurs | Moyenne — dépend de la détection fiable de l'orientation tête, plus difficile que le bras en l'air |

---

## 4. Couche 2 — Signaux assistés par vision (confiance modérée à faible, jamais des verdicts)

Chaque signal est affiché avec un **niveau de confiance explicite** (Haute/Moyenne/Faible),
jamais présenté comme un chiffre clinique au même titre que le SR/DPS ci-dessus.

| Signal | Proxy utilisé | Confiance | Ce qu'il ne mesure PAS |
|---|---|---|---|
| Roulis (roll) partiel | angle épaules vs horizontale à l'instant du recovery (seul instant où les deux épaules peuvent être visibles hors eau) | Faible-Moyenne | Le roulis complet hanche+épaule sur tout le cycle (recherche : amplitude épaule 97-111°, hanche 37-57° chez nageurs élite — la fenêtre visible en V0 n'en capture qu'une fraction) |
| Indice de battement (kick) | intensité/fréquence des perturbations de surface (optical flow) derrière le nageur | Faible | Amplitude ou technique réelle du battement (genou, 2 vs 6 temps) — ce n'est qu'un proxy d'activité, pas une mesure biomécanique |
| Position tête en respiration | angle de rotation tête détecté aux instants où le visage émerge | Moyenne | Un cycle non observé n'est pas compté — sous-estimation possible de l'asymétrie si le champ de caméra rate certains passages |

**Explicitement hors de la couche 2 (pas même en signal faible confiance) : attaque
(catch/EVF), trajectoire de main, angle de coude, technique de traction.** Ces éléments sont
sous l'eau en continu — aucun proxy au-dessus de la surface n'y donne accès, et la pose
estimation sous-marine standard n'est pas fiable (§0). Les inclure même en "signal faible"
donnerait une fausse impression de couverture.

---

## 5. Couche 3 — Score d'efficacité (0-100, relatif au nageur)

```
efficiency_score = 100
  - penalty_dps_below_baseline(dps, level, height)   # DPS sous la médiane attendue pour le niveau déclaré
  - penalty_swolf_variance(swolf_par_longueur)         # instabilité inter-longueurs
  - penalty_breathing_asymmetry(ratio_A_B)             # asymétrie forte, pas juste "respire d'un côté"
  × confidence_weighting                                # les signaux couche 2 pèsent moins que couche 1 dans le score
```

Contrairement au vélo (pénalités quadratiques near-bornes sourcées sur un risque
articulaire), il n'existe pas de seuil clinique équivalent ici — les pénalités sont des
**défauts d'ingénierie explicites**, à calibrer avec un entraîneur (§9, point non sourcé) et
via la boucle de feedback (couche 4).

---

## 6. Couche 4 — Tendance et boucle de feedback

Comme en vélo, comparaison inter-séances (même nageur, même format d'exercice) plutôt qu'un
score absolu isolé. Après N séances, questionnaire optionnel :
- Sensation d'essoufflement / fatigue de traction — échelle 1-5
- Confort épaule (zone à risque documentée, cf. §9) — échelle 1-5

Recalibration : si "confort épaule" est noté ≥4 de façon répétée, le moteur affiche un
avertissement de vigilance (pas un diagnostic) et suggère la consultation d'un
kinésithérapeute — cf. audit professionnels, point 4. Le moteur ne pose jamais de diagnostic
médical, il signale un pattern à faire vérifier.

---

## 7. Format de sortie (JSON, exemple)

```json
{
  "session_id": "nage_2026-08-12",
  "pool_length_m": 25,
  "lengths_analyzed": 6,
  "measured": {
    "stroke_rate_avg": 34.2,
    "dps_avg_m": 1.85,
    "swolf_avg": 42
  },
  "vision_signals": {
    "roll_proxy_deg": {"value": 28, "confidence": "faible"},
    "breathing_symmetry": {"ratio_left_right": 0.4, "confidence": "moyenne"},
    "kick_index": {"value": 0.62, "confidence": "faible"}
  },
  "efficiency_score": 71,
  "flags": [
    {"type": "breathing_asymmetry", "detail": "82% des respirations côté droit sur 6 longueurs"}
  ],
  "out_of_scope_note": "Attaque, trajectoire de main et technique de traction non mesurées (nécessitent une vue sous-marine, cf. §0 du spec)."
}
```

---

## 8. Ce qui est déjà écrit ailleurs et reste réutilisable du projet vélo

Rien du **code** n'est repris (nouveau domaine, nouvelles hypothèses). Ce qui est repris :
- La méthode : spec écrite avant code, table de confiance des sources, tests réels avant
  "fait", handoff structuré pour continuer la session en dehors de ce sandbox.
- Le pattern d'architecture logicielle (`engine/` logique pure testée séparément de
  `capture/` intégration MediaPipe, cf. `src/engine/posture-aero-engine.ts` et
  `src/capture/` dans ce même repo) — à reproduire dans un nouveau dossier
  `src/swim-engine/` / `src/swim-capture/` le jour où ce spec est validé et qu'on passe au
  code, mais aucun fichier n'est partagé entre les deux moteurs.
- La leçon opérationnelle la plus directement transférable : le bug ASLR du projet vélo
  (frames toujours à 0.00s à cause d'un seek `MediaRecorder` cassé, cf. `HANDOFF_CLAUDE_CODE.md`
  §"Bug réel trouvé et corrigé") touchera probablement aussi ce moteur — même technique de
  capture vidéo navigateur. À vérifier en premier si l'échantillonnage vidéo paraît figé.

---

## 9. Table de confiance des sources

| Élément | Statut | Source |
|---|---|---|
| Pose estimation grand public non fiable sous l'eau (réfraction, bulles, reflets) | **Sourcé** | Recherche académique (SwimmerNET/PMC9966167 ; retours d'expérience projets pose-estimation nage documentés) |
| Roulis élite (épaule 97-111°, hanche 37-57°, torse 61-78°, sprint-400m) | **Sourcé, étude spécifique** | Étude biomécanique nageurs de compétition (roulis élite, cf. littérature biomécanique de la nage) |
| Roulis "généraliste" recommandé ~30-40° | **Convergence de sources coaching**, pas une norme clinique unique | Multiples ressources techniques/coaching |
| L'attaque (EVF) est le facteur propulsif dominant (main = 90-97% de la poussée) | **Sourcé** | Takagi et al., cité dans littérature technique nage |
| Longueur de nage (DPS) meilleur prédicteur de performance que la fréquence seule | **Sourcé, tendance de recherche** | Études comparatives DPS/SR en natation de compétition |
| Respiration bilatérale réduit l'asymétrie de traction/roulis | **Sourcé** | Étude cinématique roulis de hanche vs latéralité respiratoire (PMC8950838) et littérature coaching convergente |
| Facteurs de risque épaule du nageur (rotation interne excessive, retard de rotation externe en recovery, force interne/externe déséquilibrée) | **Sourcé, littérature clinique** | Littérature sport-médecine (StatPearls, revues épaule du nageur) |
| SWOLF comme métrique d'efficacité établie | **Convention d'usage large** (trackers/montres), pas une découverte scientifique en soi | Usage standard dans l'industrie du suivi de nage |
| Battement 2 vs 6 temps, indice de battement par éclaboussures comme proxy | **Non sourcé — défaut d'ingénierie** | Aucune méthode publiée vérifiée dans cette session pour un proxy solo phone-only ; à traiter comme signal faible confiance explicite, jamais une mesure |
| Pondérations exactes du score d'efficacité (§5) | **Non sourcé — défaut d'ingénierie** | Comme les pondérations aéro/confort du vélo à leur lancement — à calibrer par la boucle de feedback (§6) et l'audit entraîneur (§ audit professionnels, point 1), pas une vérité biomécanique |
| Seuils DPS/SR "bons" par niveau | **Non sourcé ici — dépend fortement du contexte** (taille, niveau, format) | Nécessite un référentiel entraîneur plutôt qu'une littérature générique — voir audit professionnels, point 1, priorité haute |

Contrairement au vélo où la plupart des seuils durs étaient sourçables, **la majorité des
seuils d'interprétation ici restent à valider par un professionnel humain** (§9 même
tableau) — c'est le point le plus important de ce document : ce moteur V0 est plus un
outil de mesure et de suivi de tendance qu'un outil de verdict technique, tant que ces
validations n'ont pas eu lieu.

---

## 10. Portée V0 proposée

**Dans le scope V0** :
- Crawl uniquement
- Capture : vidéo latérale caméra fixe (nageur traverse le champ) + saisie/dérivation
  longueur-temps-brasses
- Couche 1 (SR, DPS, SWOLF) — mesures directes, haute confiance
- Couche 2 (roulis proxy, symétrie respiration, indice battement) — signaux affichés avec
  niveau de confiance explicite, jamais un verdict
- Score d'efficacité relatif au nageur (tendance inter-séances), pas de comparaison à
  l'élite
- Avertissement de vigilance épaule (pattern répété), sans diagnostic

**Hors scope V0, explicitement reporté** :
- Attaque, trajectoire de main, angle de coude, traction (nécessite vue sous-marine fiable —
  aucune méthode phone-only solo validée trouvée, cf. §0)
- Dos, brasse, papillon (pipeline de détection de cycle différent par nage)
- Virages et départs (dynamique différente, zones explicitement exclues du champ caméra V0)
- ~~Caisson étanche / caméra sous-marine dédiée~~ — **décision prise le 13/08/2026 : ce
  n'est plus hors scope.** Voir `SPEC_MODULE_SOUS_MARIN.md` (module V1 séparé) : caméra
  immergée fixe (pas une caméra hors de l'eau regardant à travers la surface, qui elle reste
  le problème décrit au §0) — casse la contrainte solo-friendly/matériel minimal, assumé
  explicitement dans ce nouveau module.
- Comparaison à des références élite/absolues

**Point où l'arbitrage d'un professionnel compte plus qu'ailleurs** : contrairement au vélo,
je n'ai trouvé aucune base solide pour fixer des seuils DPS/SR "bons" par niveau, ni pour
pondérer le score d'efficacité — voir l'audit des professionnels nécessaires
(`AUDIT_PROFESSIONNELS_NAGE.md`), point 1, qui est la dépendance la plus bloquante avant de
coder quoi que ce soit au-delà d'un prototype.

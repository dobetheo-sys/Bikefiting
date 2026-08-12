# AUDIT — Moteur d'analyse de foulée

Revue de tous les paramètres du moteur course (`src/engine/running-gait-engine.ts`) contre la
littérature en biomécanique et physiologie de la course, plus un audit structurel du
comportement réel du moteur.

**Date** : 12/08/2026 · **Portée** : V1 telle que livrée (commits `3ab0ae5`, `14570f6`)

---

## 0. Limite de méthode, à lire avant le reste

Les textes intégraux sont inaccessibles depuis cet environnement (proxy sortant : PMC, LWW,
Springer, JOSPT, ScienceDirect renvoient tous 403). **Tout ce qui suit vient de résumés et de
synthèses secondaires, pas de tables vérifiées.** Les valeurs chiffrées sont donc à reconfirmer
sur les PDF avant d'être gravées dans le code. Cet audit dit surtout *où* le moteur s'appuie sur
du vide — ça, c'est solide — plutôt que *quelle* valeur exacte mettre à la place.

---

## 1. Constats structurels (vérifiés sur le code, sans littérature)

### 1.1 — L'axe « économie » n'utilise aucune mesure vidéo — **critique**

Vérifié en exécutant le moteur : à cadence identique, une foulée parfaite et une foulée
catastrophique donnent **exactement le même score d'économie** (écart mesuré : 0,0 point).

Deux causes cumulées :
- `verticalOscillationRatio` (poids 0.30) n'est **jamais collecté par l'UI**. La fonction
  `computeVerticalOscillationRatio` existe et est testée, elle n'est appelée nulle part. Son
  poids est donc redistribué en permanence.
- L'inclinaison du tronc ne pèse **que 2,7 points au maximum**, et exactement 0 tant qu'elle
  reste dans [5°,15°] — c'est-à-dire pour ~72% des coureurs (cf. §2.4).

Le score d'économie est donc à ~91% une fonction de la seule cadence, et en pratique à 100%.
**L'utilisateur filme 3 vidéos et place 18 points pour alimenter un axe qui se calcule sans
aucune vidéo.**

### 1.2 — Le moteur valide chaque essai, jamais la session

Avec trois essais à 168/169/170 pas/min, le moteur renvoie `status: ok` et affiche trois profils
séparés de ~3 points, comme s'il y avait un compromis à arbitrer. Or compter 84 appuis sur 30 s
a une précision de ±1 appui, soit **±2 pas/min** : ces écarts sont sous le bruit de mesure.
Rien n'avertit que le balayage ne couvre rien.

### 1.3 — Dans le score de charge, l'inventé pèse plus que le sourcé

À cadence égale, la forme fait varier le score de **55 points** ; à forme égale, la cadence de
**45 points**. Or les 45 points reposent sur la seule relation solidement documentée
(Heiderscheit), et les 55 points sur `TIBIA_ANGLE_WARN` et `OVERSTRIDE_WARN`, pour lesquels
**aucun seuil publié n'existe** (cf. §2.1, §2.2). La hiérarchie est inversée.

### 1.4 — Code mort livré

`estimateCadenceFromFrames` et `computeVerticalOscillationRatio` sont écrits, testés, et jamais
appelés par l'application. Pour l'estimateur de cadence c'était une décision documentée ; pour
l'oscillation verticale, non — le spec la présente comme une mesure optionnelle que le moteur
sait exploiter, alors que l'app ne l'offre jamais.

---

## 2. Audit paramètre par paramètre

### 2.1 — `TIBIA_ANGLE_WARN = 10°` — **non calibré**

| | |
|---|---|
| Population de référence | 6,4 ± 4,4° (cohorte vidéo 2D) |
| Seuil publié | **Aucun.** « Tibia vertical au contact » est une heuristique d'entraîneur |
| Coureurs normaux avertis | **~21%** |

Le « 0-15° = overstriding » qui circule vient d'un **brevet américain** (US 10,115,319), pas d'une
publication à comité de lecture. Souza 2016 recommande la mesure comme indicateur *comparatif*
ou d'asymétrie, pas comme un seuil pass/fail.

### 2.2 — `OVERSTRIDE_WARN = 0.15` — **non calibrable en l'état**

Aucun seuil publié en cm ni en % de longueur de jambe. La normalisation par la longueur du membre
inférieur (mon choix) a au moins un précédent : Lieberman 2015. Ce qui est établi, ce sont des
*relations*, pas des seuils : la distance diminue d'environ **5,9% par +5 foulées/min**
(Lieberman 2015), et elle prédit l'impulsion de freinage et la charge au genou (Wille 2014).

Conséquence collatérale : overstriding et cadence étant fortement liés par construction, les
compter tous les deux dans le score de charge **amplifie** la cadence plutôt que d'ajouter une
information indépendante — la justification « deux mesures indépendantes du même défaut » que
j'avais écrite dans le code est fausse.

### 2.3 — `KNEE_FLEX_IC_WARN = 10°` — **bien placé, mais le spec ment sur la norme**

Plage typique réelle : **15-25°** (le spec dit 10-20°, à corriger). Le seuil à 10° n'avertit que
**0,6%** des coureurs — c'est un vrai détecteur de valeur aberrante, correctement placé.
Nuance : les attaques avant-pied contactent avec **plus** de flexion que les attaques talon
(Almeida/Davis/Lopes 2015), donc le seuil n'est pas neutre vis-à-vis du type d'attaque.

### 2.4 — `TRUNK_LEAN_MIN/MAX = 5/15°` — **sur-déclenche, et mal placé**

| | |
|---|---|
| Population de référence | 7,3 ± 3,6° (Teng & Powers 2014), individus de −2° à 25° |
| Coureurs normaux avertis | **~28%** (dont 26% sur la borne basse seule) |

Deux problèmes distincts :

**(a) Le tronc n'a pas sa place dans le score d'économie.** Van Hooren 2024 : l'inclinaison
statique du tronc corrèle avec la *performance*, pas avec l'économie. Une intervention de
« lean » avant (PLOS One 2024) a **dégradé** l'économie de course. Le tronc est donc le facteur
le moins soutenu des trois que je score — et je l'ai gardé, tout en laissant de côté
l'oscillation verticale, qui est le mieux soutenu (§2.7).

**(b) Plus penché n'est pas « mieux », c'est un transfert.** Teng & Powers 2014 : passer de 7,3°
à 14,1° réduit la contrainte fémoro-patellaire (~7% de moment extenseur du genou en moins). Mais
Teng & Powers 2015 : l'absorption d'énergie au genou baisse jusqu'à ~23% pendant que **la demande
sur les extenseurs de hanche grimpe fortement** (0,12 vs 0,05 J·kg⁻¹). Ce n'est pas une charge
supprimée, c'est une charge déplacée. Un score unique « charge » ne peut pas représenter ça.

Enfin, la mesure ne peut pas distinguer « pencher depuis les chevilles » de « pencher depuis la
taille », alors que c'est exactement la consigne affichée par l'app. Les points cheville et
épaule sont déjà tapés : l'inclinaison corps entier est calculable et lèverait l'ambiguïté.

### 2.5 — `describeFootStrike`, bornes à ±5° — **faux, un seuil publié existe**

Altman & Davis 2012 (*Gait Posture*) donnent des bornes validées :
**talon > 8°, medio-pied −1,6° à 8°, avant-pied < −1,6°**. Mes bornes symétriques à ±5°
classent mal les angles entre 5-8° (annoncés talon, en réalité medio-pied) et entre −5 et −1,6°
(annoncés medio-pied, en réalité avant-pied). Référence : une attaque talon typique se situe à
**20,4 ± 4,8°** (Breine 2017).

À noter : l'angle d'attaque dépend fortement de la vitesse, donc un seuil fixe devrait être
qualifié par l'allure.

### 2.6 — Le sommet de la courbe d'économie n'est **pas** à la cadence spontanée — **majeur**

C'est le constat le plus important de l'audit côté physiologie. Mon score d'économie donne
100/100 à la cadence spontanée, en supposant qu'elle est l'optimum métabolique. Trois sources
concordantes disent qu'elle est systématiquement **trop basse** (foulée trop longue) :

- **de Ruiter 2014** : les novices préfèrent 77 foulées/min pour un optimum à 84 (**8% sous
  l'optimum**) ; les expérimentés 85 pour 87 (**3% sous**). Les deux groupes sont du même côté.
- **Morgan 1994** : chez des coureurs peu économiques, la longueur de foulée optimale était
  **9,8 %LL plus courte** que la spontanée, pour un gain de 1,46 ml·kg⁻¹·min⁻¹.
- **Moore 2016** : la plage optimale est « préféré −3% à préféré », donc un optimum de cadence
  situé entre la cadence spontanée et +3%.

**Conséquence directe sur le moteur** : l'axe économie récompense systématiquement une cadence
trop basse, et déclare la cadence spontanée gagnante par construction. Avec un sommet à ~+3%,
l'essai à +5% deviendrait au moins aussi économique que l'essai spontané — ce qui change
l'ordonnancement du front de Pareto, pas seulement les chiffres.

### 2.7 — `ECONOMY_WEIGHTS` — les deux variables sont à l'envers

| Variable | Poids dans mon score | Soutien réel |
|---|---|---|
| Oscillation verticale | 0.30, **jamais collectée** | **Le mieux soutenu** : r = 0,53 (Folland 2017, normalisé à la taille, pendant l'appui) ; r = 0,35 (Van Hooren 2024, 51 études) |
| Écart de cadence | 0.55 | r = −0,20 en observationnel (faible), mais la manipulation intra-sujet est mieux établie que la corrélation inter-sujets |
| Inclinaison du tronc | 0.15 | **Le moins soutenu** — voir §2.4(a) |

Van Hooren 2024 liste explicitement comme **non significatifs** pour l'économie : les angles de
cheville/genou/hanche au contact, à l'appui médian et au décollage, *et leurs amplitudes*. Mes
mesures d'angles au contact n'ont donc aucune pertinence pour l'axe économie — ce qui est
cohérent avec le fait qu'elles n'y entrent pas, mais confirme que cet axe ne peut pas être
alimenté par ce que je mesure aujourd'hui.

Piste : Folland classe en deuxième variable la **perte de vitesse horizontale / freinage**,
approximable depuis la distance pied-hanche au contact — que je mesure déjà.

### 2.8 — `ECONOMY_DEVIATION_SCALE = 0.35`, pénalité symétrique — **asymétrie documentée**

La courbe n'est pas symétrique : **allonger la foulée (baisser la cadence) coûte plus cher que la
raccourcir d'autant**.
- Cavanagh & Williams 1982 : +2,6 ml·kg⁻¹·min⁻¹ à l'extrême court contre **+3,4** à l'extrême
  long, soit une branche basse-cadence **~1,3× plus raide**.
- Högberg 1952 (l'original) dit qualitativement la même chose.

Mon test `running-gait-engine.test.ts` **assert explicitement la symétrie** (« la pénalité est
symétrique »). Ce test encode une hypothèse que la littérature contredit.

Sur la magnitude, en revanche, **je ne peux pas trancher** : C&W font varier la foulée de ±20 %LL
(pourcentage de *longueur de jambe*, pas de longueur de foulée — les sources secondaires
confondent constamment les deux) pour un coût de 6,5-8,5% de VO2, tandis que Hafer 2015 (n=6,
6 semaines à +10% de cadence) ne trouve **aucune** perte d'efficacité, et Anderson 2022 classe la
question en « very limited evidence ». Ma pénalité de 28 points à +10% n'est ni manifestement
fausse ni calibrée. La courbe est en revanche clairement **très plate près de l'optimum** :
~0,5% de VO2 au point spontané, un écart de ±3% est métaboliquement trivial, ~6% devient
significatif.

### 2.9 — `CADENCE_EVIDENCE_WINDOW_PCT = 10` et la rampe linéaire — **globalement validé**

Heiderscheit 2011 a bien testé ±5% et ±10%, et **aucune variable ne s'inverse** dans cette
fenêtre. Borner à ±10% plutôt qu'extrapoler est donc justifié.

Nuance : l'effet est **à seuil, pas progressif**. L'absorption d'énergie au genou baisse dès +5%,
mais la hanche et les variables du plan frontal (adduction de hanche) ne répondent **qu'à +10%**.
Ma rampe linéaire lisse ce palier. C'est une approximation acceptable, à documenter comme telle.

Corroboration solide par ailleurs : Lenhart 2014 (−14% de force fémoro-patellaire à +10%),
Schubert 2014 (revue systématique), Anderson 2022 (méta-analyse, 37 études). La crainte d'un
**transfert de charge vers l'Achille est contestée** — Van Hooren 2024 trouve au contraire une
impulsion cumulée réduite au tendon d'Achille aussi.

### 2.10 — `SPEED_TOLERANCE_KMH = 0.3` — sans objet mais sans danger

Compare deux valeurs saisies à la main : ne vérifie rien de physique. Inoffensif.

### 2.11 — `CADENCE_PLAUSIBLE_MIN = 130` — **bénéfice non documenté**

Le plancher attrape la confusion appuis/foulées : un coureur à 170 pas/min qui compte ses foulées
saisit 85, sous le plancher, et l'essai est écarté. C'est le principal service rendu par cette
borne, et ce n'était pas écrit dans le code.

### 2.12 — **Une seule mesure par essai** — **critique, méthodologique**

Le moteur retient **un seul appui** par essai. La littérature est sans ambiguïté :

- **Riazati 2019** : il faut **12 à 19 foulées** pour obtenir des cinématiques sagittales stables.
- **Damsted 2015**, en vidéo 2D avec placement manuel de points — exactement ma méthode : erreur
  type intra-opérateur jusqu'à **1,6°**, et intervalles de prédiction à 95% **intra-jour de 3-8°
  au genou** et 3-7° à la hanche ; **9-14° en inter-jour**.

Autrement dit : l'incertitude d'une mesure unique (3-8°) est du même ordre que l'écart-type de
toute la population (4,4° pour le tibia). **Une mesure sur un appui ne peut pas distinguer un
coureur à 6° d'un coureur à 12°.** Et l'inter-jour de 9-14° signifie qu'une comparaison entre
deux sessions n'a, en l'état, aucune valeur.

Corollaire : ne jamais afficher mieux que ~3° de résolution, et moyenner ne corrige que le bruit
aléatoire — pas l'erreur systématique de projection 2D (caméra non perpendiculaire).

---

## 3. Ce qui tient

- Le refus de scorer sans cadence spontanée mesurée (calibration individuelle obligatoire).
- Le refus d'une norme universelle à 180 pas/min.
- L'absence de contrainte biomécanique dure : confirmée comme le bon choix — **aucun seuil
  publié n'existe** pour le tibia ni l'overstriding, et le type d'attaque n'a pas de supériorité
  établie.
- « Estime une charge, ne prédit pas une blessure » : confirmé. Aucun essai randomisé n'établit
  de réduction d'incidence de blessure ; le lien avec les symptômes repose sur une série de cas
  non contrôlée de 12 coureurs (Bramah 2019), classée « very limited evidence ».
- La fenêtre ±10% et la borne anti-extrapolation.
- L'exclusion des essais filmés à une autre vitesse.

---

## 4. Corrections — état

Arbitrage retenu : **réparer l'axe économie en conservant le Pareto**, et **médiane sur 5 appuis**.

| # | Correction | État |
|---|---|---|
| A | Bornes d'attaque du pied → Altman & Davis 2012 | **Appliqué** |
| B | Spec : flexion genou au contact 15-25°, pas 10-20° | **Appliqué** |
| C | Documenter le bénéfice appuis/foulées du plancher à 130 | **Appliqué** |
| D | Sommet de la courbe d'économie à +3% + zone plate de ±3% | **Appliqué** |
| E | Pénalité asymétrique (branche basse-cadence ×1,3) | **Appliqué** |
| F | Sortir le tronc du score d'économie | **Appliqué** |
| G | Collecter l'oscillation verticale dans l'UI (2 images/essai) | **Appliqué** |
| H | Médiane de 5 appuis par essai | **Appliqué** |
| I | Valider l'étalement de cadence de la session | **Appliqué** (non bloquant, signalé) |
| J | Rééquilibrer `CHARGE_WEIGHTS` vers la cadence | **Appliqué** (0.60/0.15/0.10/0.15) |
| K | Bornes de tronc élargies à [2°,18°], avertissement seulement | **Appliqué** |
| L | Inclinaison corps entier (cheville→épaule) en plus du tronc | Non fait |

### Ce que ça change concrètement

Sur le jeu de test de référence (cadence spontanée 168, foulée propre, tapis à 12 km/h) :

| Essai | Charge (avant → après) | Économie (avant → après) |
|---|---|---|
| spontanée (168) | 77,5 → **70** | 100 → **100** |
| +5% (176) | 88,3 → **84,4** | 93,7 → **100** |
| +10% (185) | 100 → **100** | 71,9 → **94,1** |

**L'essai à cadence spontanée sort entièrement du front de Pareto** : il est désormais dominé par
le +5%, qui est aussi économique et moins chargé. C'est la conséquence directe du décalage du
sommet (§2.6) — avant correction, il gagnait l'axe économie par construction.

---

## 4bis. Seconde passe — défauts trouvés APRÈS les correctifs

Les correctifs ci-dessus ont été relus, dont un en revue adversariale indépendante. Huit défauts
supplémentaires, tous corrigés. Trois méritent d'être retenus parce qu'ils illustrent des pièges
récurrents.

**Un correctif d'audit en a cassé un autre.** Rendre la composante d'oscillation verticale
relative à la session a fait perdre au score d'économie la capacité d'atteindre 100 (le pire
essai reçoit 0 par construction, donc le meilleur plafonne vers 70), pendant que le score de
charge restait absolu. Mesurer la distance au point brut (100,100) revenait alors à « le plus
proche de 100 en charge » : **« équilibré » désignait systématiquement le même essai que
« charge minimale »**. Les axes sont désormais renormalisés sur leur étendue observée. Leçon :
en changeant l'échelle d'un axe, vérifier tout ce qui compare les deux.

**Un garde-fou disproportionné.** J'avais traité une oscillation verticale aberrante comme une
exclusion d'essai, par symétrie avec la cadence invraisemblable. Erreur d'échelle : l'oscillation
est explicitement optionnelle et le moteur sait s'en passer, alors qu'exclure l'essai jetait ses
cinq mesures d'appui (30 points tapés à la main) et sa cadence — et pouvait faire passer une
session de 3 essais valides à 2, donc inanalysable, sans aucun moyen de refaire les deux seules
étapes fautives. Repassé en avertissement, avec la valeur simplement écartée du calcul.

**Une validation trop tardive.** Le formulaire de profil n'exigeait qu'une cadence `> 0` alors
que le moteur exige [130, 220]. Un athlète comptant ses **foulées** au lieu de ses appuis (85 au
lieu de 170) passait la saisie, filmait trois essais de dix minutes, tapait 90 points, et ne
découvrait le refus qu'à l'analyse finale. Les bornes du moteur sont maintenant appliquées à la
saisie, avec le message qui nomme l'erreur.

Les cinq autres : un `useEffect` qui écrasait la cadence du parent au montage (rouvrir
« Modifier » effaçait la mesure et bloquait l'écran) ; l'essai de référence identifié par ordre
de filmage plutôt que par proximité à 0% ; une affirmation non vérifiée dans l'interface
(« un des essais **plus rapides** », faux quand un essai plus lent domine) ; l'absence de
confirmation sur « Reprendre » alors que « Annuler » en demandait une pour la même perte ; et une
valeur aberrante qui contaminait le maximum de session.

**Ce que la revue a explicitement blanchi** : la géométrie et les conventions de signe (vérifiées
numériquement, invariantes au sens de filmage), la machinerie de mesure à 7 étapes, la migration
des sessions enregistrées avant l'oscillation verticale, et l'absence de régression côté vélo —
les extractions vers `shared/` et `ui.jsx` sont identiques aux originales, fonction par fonction.

---

## 5. Ce qui reste ouvert

- **§2.1 et §2.2 sont insolubles en l'état** : aucun seuil publié n'existe pour le tibia ni
  l'overstriding. Leur poids a été réduit, mais ils restent des chiffres inventés. La seule
  sortie propre serait de collecter des données sur une population d'utilisateurs et de définir
  les seuils sur les queues de la distribution observée, plutôt que dans l'absolu.
- **La magnitude de la pénalité d'économie n'est pas calibrée** (§2.8). La forme de la courbe est
  sourcée, la conversion « % d'écart → points de score » ne l'est pas.
- **L'erreur systématique de projection 2D** (caméra non perpendiculaire) n'est pas traitée. La
  médiane sur 5 appuis ne corrige que le bruit aléatoire.
- **Aucune comparaison entre sessions n'est possible** (inter-jour 9-14° en vidéo 2D). Tant que
  ce n'est pas résolu, un historique de foulée serait trompeur — à ne pas construire.
- **`estimateCadenceFromFrames` reste du code mort** : jamais confronté au comptage manuel sur
  de vraies vidéos, donc pas branché.
- **Tout l'audit repose sur des résumés**, pas sur des textes intégraux (§0). À reconfirmer.

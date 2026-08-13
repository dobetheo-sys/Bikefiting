# SPEC — Module sous-marin (attaque, traction), V1

**Statut** : décision prise le 13/08/2026 de lancer ce module (option A retenue face à
l'alternative capteurs portés, cf. discussion de scoping). S'ajoute à
`SPEC_ANALYSE_NAGE_MOTEUR.md` (V0, capture au-dessus de l'eau) — ne le remplace pas. Ce
module est plus incertain que le V0 : il dépend d'un travail de vision par ordinateur réel,
pas seulement d'ingénierie produit.

---

## 1. Ce qui change par rapport au diagnostic du §0 de la spec V0

Le §0 de la spec V0 décrivait la pose estimation sous-marine comme peu fiable, en citant un
cas où un modèle standard place un bras à ~15 cm de sa position réelle. Ce cas — comme la
plupart des retours similaires trouvés en recherche — correspond à une caméra **au-dessus
de l'eau (ou au niveau de la surface), regardant à travers l'interface air-eau en biais**.
C'est là que la réfraction est sévère (effet "paille qui a l'air cassée dans un verre
d'eau") : angle de vue variable + interface changeante = distorsion difficile à corriger
génériquement.

**Le choix retenu ici évite ce problème à la source** : caméra **entièrement immergée**,
qui ne regarde jamais à travers la surface. Toute la chaîne optique (nageur → caméra) reste
dans un seul milieu (eau), donc pas de réfraction air-eau à corriger. C'est exactement le
montage utilisé par SwimmerNET (recherche publiée, §5) : « une seule caméra fixée sur le
côté, sous l'eau, cadrant uniquement le corps immergé du nageur » — précision obtenue
~1 mm en moyenne (écart-type ~10 mm). Ce n'est pas une invention : c'est le montage qui
marche dans la littérature, pas une réfraction résiduelle à corriger après coup.

**Ce qui reste un vrai problème, même caméra immergée** :
- **Bulles, éclaboussures, remous** créés par le nageur lui-même (main qui entre dans
  l'eau, battement) — perturbation visuelle réelle, documentée aussi pour les montages
  immergés, pas seulement les vues à travers la surface
- **Décalage de domaine (domain shift)** : les modèles de pose estimation grand public
  (MediaPipe Pose, etc.) sont entraînés sur des images aériennes normales — teinte
  bleu-vert, contraste réduit, éclairage caustique (reflets ondulants) de l'image
  sous-marine ne ressemblent à rien de leur jeu d'entraînement. Un modèle non adapté peut
  donc échouer même sans réfraction à corriger.
- **Occlusion partielle** : bras qui passe devant le corps, alternance recovery/traction
  hors du plan caméra fixe

Ce module ne "résout" donc pas magiquement le problème initial — il le rend **tractable**
(un problème d'adaptation de modèle plutôt qu'un problème optique insoluble en solo), ce qui
change concrètement l'effort requis : R&D vision par ordinateur ciblée, pas une bidouille de
seuils.

---

## 2. Équipement requis (rupture avec la contrainte "phone-only" du V0)

- **Caisson étanche pour téléphone, ou caméra d'action (GoPro/équivalent) en caisson
  dédié**, à **port plat ou dôme selon le setup** — port dôme préférable pour un grand-angle
  net sans aberration de bord (cf. §1), port plat acceptable si focale plus longue/moins
  grand-angle et si le budget dôme n'est pas justifié pour un prototype
- **Support fixe immergé** : perche/trépied lesté posé au fond du bassin, ou fixation sur
  la ligne d'eau/le mur, positionné pour cadrer une portion de couloir en vue latérale —
  même logique de "caméra fixe, nageur qui traverse le champ" que le V0, mais sous l'eau
- **Synchronisation avec la caméra V0 (hors de l'eau)** : les deux caméras filment la même
  portion de couloir, déclenchées ensemble (top départ commun, ex. un signal sonore/visuel
  capté par les deux, ou simplement deux enregistrements longs recoupés a posteriori par
  time-code). Objectif : garder les signaux respiration/roulis du V0 (mieux vus hors de
  l'eau) ET débloquer attaque/traction (uniquement visibles immergé) sur les **mêmes cycles
  de bras**, pas deux séances déconnectées.

**Conséquence assumée** : ce module casse la contrainte "aucun équipement spécialisé, solo
phone-only" qui structurait le V0 et le projet vélo. C'est un choix explicite (option A),
pas un oubli — à documenter clairement pour l'utilisateur final (l'app ne sera plus
utilisable avec juste un téléphone posé sur un support pour cette partie-là).

---

## 3. Approche modèle — en deux étapes, dans cet ordre

**Étape 1 — Pas de réentraînement immédiat.** Avant d'investir dans un modèle sous-marin
dédié : tester un modèle de pose estimation standard (MediaPipe Pose) directement sur de la
vraie vidéo immergée réelle (caméra fixe, cf. §2), et **mesurer** l'erreur par comparaison à
un pointage manuel image par image (comme le projet vélo l'a fait pour valider la géométrie
d'angles, cf. `capture-processing.test.ts`). Il est possible que le domain shift soit moins
grave qu'attendu pour les quelques repères utiles ici (poignet, coude, épaule) — à vérifier
avant de supposer qu'un réentraînement est nécessaire.

**Étape 2 — Si l'étape 1 échoue** (erreur trop grande sur les repères qui comptent) :
adaptation de domaine plutôt que réentraînement complet from scratch —
- fine-tuning léger d'un modèle existant sur un petit jeu de vidéos sous-marines annotées
  manuellement (quelques centaines de frames, pas besoin d'un jeu massif pour du
  fine-tuning), plutôt que reproduire SwimmerNET (FCN entraîné from scratch) sans les
  données ni le temps d'un labo de recherche
- alternative moins coûteuse à tester d'abord : pré-traitement de l'image (correction de
  teinte/contraste pour se rapprocher du domaine d'entraînement du modèle standard) avant
  inférence, sans toucher au modèle — à essayer avant le fine-tuning, moins cher si ça
  suffit

**Ce point est le cœur du travail du profil "ingénieur vision par ordinateur milieu
aquatique"** (audit professionnels, point 4 — passé de priorité conditionnelle à
**bloquante** pour ce module, cf. mise à jour de l'audit).

---

## 4. Nouvelles métriques débloquées (si étape 1 ou 2 valide)

| Métrique | Ce qu'elle mesure | Confiance attendue |
|---|---|---|
| Angle du coude au catch (proxy EVF) | avant-bras proche de la verticale tôt après l'entrée de main | Moyenne — dépend de la qualité de détection coude/poignet immergés, à confirmer étape 1 |
| Trajectoire de main (vue latérale) | profondeur et trajectoire relative de la main pendant la traction | Faible-Moyenne au démarrage — une seule caméra latérale ne donne qu'une projection 2D, pas la trajectoire 3D complète (S-curve vs traction droite se juge surtout en vue de dessous/dessus, hors scope de ce montage à une caméra) |
| Point d'entrée de main | position de la main à l'entrée dans l'eau, relative à l'axe de l'épaule/tête | Moyenne — instant précis, bien visible en vue latérale |
| Angle du coude en traction | flexion du coude entre catch et sortie | Moyenne, sous réserve de l'étape 1 |

**Toujours hors scope, même avec ce module** : vue de dessous (nécessiterait une seconde
caméra sous-marine à un autre angle, montage nettement plus lourd, hors budget V1),
comparaison 3D complète de la trajectoire de main.

---

## 5. Table de confiance des sources (complète celle du V0)

| Élément | Statut | Source |
|---|---|---|
| Caméra immergée fixe latérale évite la réfraction air-eau sévère | **Sourcé, montage publié** | SwimmerNET (PMC9966167) — précision ~1mm/10mm obtenue avec exactement ce montage |
| Dôme vs port plat : le dôme élimine la réfraction résiduelle du hublot lui-même, meilleur pour le grand-angle | **Sourcé, photographie sous-marine technique** | Littérature technique caissons étanches (dôme vs port plat) |
| Domain shift (teinte/contraste/caustiques) dégrade les modèles entraînés en air | **Sourcé, indirectement** | Cohérent avec les retours documentés dans le V0 (§9), mais pas mesuré spécifiquement pour un montage immergé fixe — à vérifier en étape 1, pas supposé acquis |
| Fine-tuning léger suffit (pas besoin de réentraînement complet type SwimmerNET) | **Non sourcé — hypothèse d'ingénierie** | Pari raisonnable (fine-tuning demande moins de données qu'un entraînement from scratch) mais pas vérifié pour ce cas précis — à confirmer ou infirmer par l'étape 1/2 elles-mêmes |
| Une seule caméra latérale ne donne pas la trajectoire 3D de main | **Fait géométrique, pas une hypothèse** | Projection 2D intrinsèque à un montage mono-caméra |

---

## 6. Impact sur le reste du projet

- **`SPEC_ANALYSE_NAGE_MOTEUR.md` §10** ("hors scope V0") : la ligne "caisson étanche /
  caméra sous-marine dédiée" n'est plus hors scope — elle devient ce module, en cours de
  spec, à activer une fois l'étape 1 de §3 validée en conditions réelles.
- **`AUDIT_PROFESSIONNELS_NAGE.md` point 4** : mis à jour, priorité passée de
  "conditionnelle" à "haute/bloquante pour ce module" — voir le fichier, section mise à
  jour.
- **Positionnement produit** : le projet n'est plus "solo phone-only" pour cette partie —
  à assumer explicitement dans toute communication utilisateur (le module sous-marin
  nécessite un caisson étanche et un accès piscine permettant d'installer une caméra
  immergée, ce qui exclut probablement l'usage en piscine publique sans autorisation).

---

## 7. Prochaine étape concrète (bloquante avant tout code)

**Étape 1 de §3**, sur vraie vidéo immergée réelle (pas simulée) : filmer quelques longueurs
avec une caméra immergée fixe (même un GoPro basique en caisson standard suffit pour ce
test), faire tourner MediaPipe Pose dessus, comparer poignet/coude/épaule détectés à un
pointage manuel sur un échantillon de frames. Si l'erreur est acceptable → l'étape 2
(fine-tuning) n'est peut-être même pas nécessaire, et le module peut avancer bien plus vite
que prévu. Si elle ne l'est pas → l'étape 2 est confirmée nécessaire, avec un chiffre
d'erreur concret pour cadrer l'effort de fine-tuning plutôt que de deviner.

# Audit — Professionnels nécessaires au moteur d'analyse de nage

Ce document liste, par priorité, les compétences humaines nécessaires pour que
`SPEC_ANALYSE_NAGE_MOTEUR.md` passe d'un prototype technique honnête à un outil réellement
fiable et déployable. Contrairement au projet vélo (où la plupart des seuils étaient
sourçables dans la littérature bike-fit), la nage a **plus de seuils non sourcés** (§9 du
spec) — l'intervention humaine qualifiée est donc plus critique ici, pas un bonus.

Pour chaque profil : ce qu'il valide, pourquoi c'est lui (pas un autre rôle) qui doit le
faire, et ce qui se passe si ce point est sauté.

---

## 1. Entraîneur de natation qualifié (technique crawl) — **priorité bloquante**

**Valide** : l'interprétation des métriques mesurées (couche 1 du spec) en feedback
actionnable. Un DPS de 1,85 m est-il bon pour ce nageur précis ? Ça dépend de sa taille, son
niveau, son format de course (sprint vs fond) — aucune norme universelle trouvée en
recherche (§9 du spec, dernière ligne). Sans référentiel entraîneur, le score d'efficacité
(§5) reste une formule arbitraire qui a l'air sérieuse mais ne l'est pas.

**Valide aussi** : la faisabilité terrain du protocole de capture (§1 du spec — caméra fixe,
nageur qui traverse le champ). Un entraîneur qui a déjà filmé des nageurs sait tout de suite
si "3-5 m de champ, hors virages" donne assez de cycles exploitables ou si c'est trop court
en pratique.

**Pourquoi lui et pas un biomécanicien** : la calibration "qu'est-ce qu'un bon chiffre pour
CE nageur" est un jugement d'entraînement quotidien (des centaines de nageurs vus, pas une
étude ponctuelle), différent de la validité biomécanique d'une mesure.

**Si sauté** : le score d'efficacité reste un prototype à ne présenter qu'avec un
avertissement explicite ("non calibré, seuils par défaut") — ne jamais le livrer comme un
outil de coaching réel sans ce point.

---

## 2. Biomécanicien du sport spécialisé natation (chercheur ou consultant) — **priorité haute**

**Valide** : que les proxies de la couche 2 (roulis partiel, indice de battement, position
tête en respiration) mesurent bien ce qu'on prétend mesurer, avec quelle marge d'erreur.
Le spec est déjà honnête sur leur confiance faible/moyenne (§4) — mais c'est une estimation
d'ingénierie, pas une validation. Un biomécanicien peut confirmer ou démentir avec des
données réelles (ex. filmer un nageur avec système de référence — caméras sous-marines de
labo — en parallèle de la capture phone-only, et comparer).

**Valide aussi** : si un futur module sous-marine (caisson étanche, §10 "hors scope V0")
devient pertinent, c'est ce profil qui doit arbitrer les seuils d'attaque/traction —
équivalent du rôle qu'a joué la littérature Retül/BikeFittr pour le plancher hanche 40° en
vélo, mais ici il faudra probablement un partenariat (labo STAPS, fédération) plutôt qu'une
littérature déjà publiée et directement exploitable.

**Si sauté** : les signaux couche 2 restent des heuristiques non vérifiées contre une
référence — acceptable pour un score de tendance interne, pas pour une affirmation
technique ("ton roulis est trop faible").

---

## 3. Kinésithérapeute du sport / médecin du sport (spécialisé épaule du nageur) — **priorité haute**

**Valide** : tout ce qui touche à l'avertissement de vigilance épaule (§6 du spec). La
littérature sourcée (§9) identifie des facteurs de risque réels (rotation interne excessive,
retard de rotation externe en recovery, déséquilibre force interne/externe) — mais le spec
ne prétend mesurer aucun de ces facteurs précisément (ils sont eux aussi largement
sous-marins ou nécessitent un bilan clinique). Ce professionnel doit border strictement le
langage utilisé ("pattern à faire vérifier", jamais "diagnostic") et confirmer que même un
avertissement bien intentionné ne induit pas une fausse alerte ou une fausse réassurance.

**Pourquoi c'est non négociable** : dès qu'un outil grand public évoque une zone de risque
articulaire, la formulation engage une responsabilité — plus proche d'un dispositif
d'information santé que d'un simple compteur de brasses.

**Si sauté** : retirer complètement l'avertissement épaule (§6) du produit livré plutôt que
de le garder sans validation — un risque non mesuré présenté comme un signal est pire que
pas de signal du tout.

---

## 4. Ingénieur vision par ordinateur avec expérience milieu aquatique — **priorité conditionnelle**

**Valide** : uniquement nécessaire si le projet veut un jour dépasser la contrainte
fondatrice du §0 (pose estimation sous-marine peu fiable). Pas bloquant pour le V0 tel que
scopé (au-dessus de l'eau uniquement), mais tout module futur "attaque/traction" en
dépendrait entièrement — ce n'est pas un ajustement de seuil, c'est un problème de recherche
appliquée (réfraction, filtrage bulles/reflets, cf. SwimmerNET §9 du spec) qui dépasse le
niveau d'un ajustement MediaPipe standard.

**Si sauté** : rester sur le scope V0 (au-dessus de l'eau). C'est un choix de scope valide,
pas un manque — voir §0 du spec, qui explique pourquoi c'est la bonne limite par défaut.

---

## 5. Référent RGPD / juriste (protection des données, image des mineurs) — **priorité haute, avant tout déploiement au-delà d'un usage strictement personnel**

**Valide** : le régime de captation vidéo dans un lieu public/semi-public (piscine), où
d'autres nageurs peuvent apparaître dans le champ sans consentement explicite, et où le
contexte club de natation inclut très souvent des mineurs. La vidéo de silhouette/posture
est une donnée sensible (biométrique-adjacente) même sans reconnaissance faciale.

**Différence avec le projet vélo** : le vélo se pratique typiquement en solo (garage,
route), la piscine est un lieu partagé par construction — le risque de capter des tiers est
structurellement plus élevé ici.

**Si sauté** : limiter strictement l'usage à de la capture personnelle, stockage local
uniquement (comme le fait déjà le projet vélo via `localStorage`, cf. `HANDOFF_CLAUDE_CODE.md`
tâche 5), et ne jamais déployer en contexte club/mineurs sans ce point traité.

---

## 6. UX/produit avec expérience terrain piscine — **priorité moyenne**

**Valide** : l'ergonomie de capture solo en environnement mouillé — écran tactile peu
fiable mains mouillées, lunettes de piscine embuées, pas d'assistant pour déclencher
l'enregistrement au bon moment. Le projet vélo a déjà buté sur un problème analogue
(indicateur de niveau mal calibré selon les appareils, cf. `HANDOFF_CLAUDE_CODE.md` §2) —
la piscine ajoute des contraintes physiques supplémentaires (déclenchement vocal ou
minuteur plutôt que tap, boîtier/support résistant aux projections).

**Si sauté** : protocole "caméra fixe posée avant d'entrer dans l'eau, déclenchement
minuteur" reste utilisable en attendant une UX affinée — dégradé mais fonctionnel.

---

## 7. Testeur avec accès piscine réelle (rôle QA, pas forcément un pro dédié) — **priorité bloquante, à faire en tout premier après validation du spec**

**Valide** : que le pipeline entier (§0-§7 du spec) fonctionne sur de la vraie vidéo de
bassin — luminosité changeante, reflets de surface, lignes d'eau dans le champ, plusieurs
nageurs dans le couloir voisin. C'est l'équivalent exact de la tâche 1 du handoff vélo
("smoke-test réel des modèles MediaPipe sur un vrai appareil, bloquant pour tout le
reste") — sauf qu'ici l'incertitude est plus grande dès le départ (§0 documente déjà que
même la littérature de recherche peine sur ce terrain), donc ce test doit arriver **avant**
d'investir dans la couche 2 (roulis/battement/respiration), pas après.

**Si sauté** : aucune des couches 1/2 du spec ne peut être considérée comme "faite" au sens
où ce repo définit le mot (cf. conventions déjà en place, `README.md` du projet vélo) —
seulement "écrite et non vérifiée contre la réalité".

---

## Ordre de dépendance recommandé

```
1. Test réel piscine (point 7) — confirme que la couche 1 (SR/DPS/SWOLF) est exploitable
   sur vraie vidéo AVANT d'investir ailleurs
2. Entraîneur (point 1) — sans lui, aucun seuil d'interprétation n'est défendable
3. Biomécanicien (point 2) + Kiné/médecin (point 3) en parallèle — bordent respectivement
   la couche 2 (signaux) et l'avertissement épaule (§6 du spec)
4. RGPD (point 5) — avant toute captation en club ou hors usage strictement personnel
5. UX piscine (point 6) — affine l'ergonomie, non bloquant pour un prototype personnel
6. Vision par ordinateur milieu aquatique (point 4) — seulement si/quand le scope
   sous-marine (§10 du spec, hors scope V0) est explicitement remis en jeu
```

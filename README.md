# posture-aero

Moteur d'analyse posturale pour position aéro (prolongateurs) en cyclisme/triathlon.
Projet parallèle, indépendant d'EnduraBuild — même méthode de travail (spec écrite,
tests réels avant de considérer une brique "faite").

**Statut : V1, position aéro uniquement.** Le module position guidon n'est pas commencé
(réutilisera ce pipeline, cf. `docs/SPEC_POSTURE_AERO_MOTEUR.md` §10).

- Démo en ligne : https://dobetheo-sys.github.io/Bikefiting/
- Spec fonctionnelle : `docs/SPEC_POSTURE_AERO_MOTEUR.md` (dont la table de confiance des
  sources, §9 — ce qui est sourcé vs ce qui est une hypothèse d'ingénierie)
- Intégration dans une autre app : `docs/INTEGRATION_HANDOFF.md`

## ⚠️ La mesure des angles est MANUELLE, pas automatique

C'est le point le plus important à comprendre avant de lire le code, et il a changé en
cours de route (10-11/08/2026) :

Le premier pipeline extrayait les angles **automatiquement** via MediaPipe `PoseLandmarker`.
Il a échoué de façon répétée sur de vraies vidéos, malgré plusieurs correctifs successifs
(cadrage, contre-jour, seuils de confiance) : d'abord sur l'ASLR (sujet allongé au sol, filmé
de loin et au ras du sol — hors du cas "personne debout, cadrée serré" sur lequel ces modèles
sont entraînés), puis sur la vidéo de profil elle-même, où un essai réel a produit un angle de
tronc de 43°, valeur que la biomécanique rend impossible.

**Depuis, l'utilisateur choisit lui-même l'image significative dans sa vidéo et tape les points
articulaires dessus** (`TapImage`/`TapLoupe` dans `PostureCaptureFlow.jsx`). Mêmes formules
géométriques qu'avant (`angleAt`, `angleVsHorizontal`), juste alimentées par des points tapés
plutôt que par des landmarks détectés.

MediaPipe reste utilisé **uniquement** pour la segmentation de la photo frontale (silhouette
entière sur fond fixe → surface frontale projetée) : problème bien mieux posé que la détection
de landmarks sur une vidéo.

**Conséquence pour le code** : `src/capture/pose-integration.ts` et
`src/capture/video-frame-sampler.ts`, ainsi que `extractTrialAngles()` dans
`capture-processing.ts`, sont des **vestiges du pipeline auto**. Plus rien ne les importe hors
de leurs propres tests. Ne pas les prendre pour la voie active.

## Ce qui est fait

| Brique | Fichier | Statut |
|---|---|---|
| Moteur (validation, scores + plages de sensibilité, Pareto, feedback) | `src/engine/posture-aero-engine.ts` | Logique pure, testée `node:test` |
| Géométrie des angles + mesures manuelles (ASLR, PMH, PMB) | `src/capture/capture-processing.ts` | Testée avec des coordonnées vérifiées à la main |
| Mesure pFSA (masque calibré → surface frontale) | `src/capture/capture-processing.ts` | Testée, méthode terrain publiée (Debraux et al. 2009) |
| Segmentation photo frontale (MediaPipe ImageSegmenter) | `src/capture/segmentation-integration.ts` + `mediapipe-vision.ts` | Logique de filtrage testée sur masque simulé ; appelée par `App.jsx` |
| Flux de capture + pointage manuel des articulations | `src/components/PostureCaptureFlow.jsx` | Vérifié en Chromium headless (Playwright) de bout en bout |
| Session complète (ASLR → profil → essais → résultats) | `src/App.jsx` | Idem, jusqu'à l'écran de résultats |
| Historique, tendance entre bilans, boucle de feedback post-sortie | `src/App.jsx` | Câblés : le feedback douleur repondère le score confort des bilans suivants (`recalibrateWeights`) |
| Habillage visuel (tokens Zenna) | `src/index.css` + tout le JSX | Restylé intégralement ; maquette de référence dans `design/` |

Angles mesurés : hanche, tronc, genou, épaule, coude, poignet. Parmi les 3 angles du bras,
seul le poignet a un effet sur le score (via `WRIST_WARN`) ; épaule et coude sont informatifs,
faute de seuil sourcé pour les pénaliser.

## Ce qui n'est PAS fait

- **Smoke-test sur appareil réel** de la segmentation MediaPipe contre de vraies photos —
  jamais exécutable dans le sandbox de développement (cf. limite d'environnement plus bas).
- **Amplitude de cheville** (`ankle.amplitude`) : non mesurable sur 2 images fixes, laissée à 0.
  Le warning `ankle_unstable` (seuil sourcé à 22°) ne peut donc jamais se déclencher — décision
  assumée et commentée dans `capture-processing.ts` plutôt qu'inventer une valeur.
- **`headOffset_cm`** (position tête, ~10% du score aéro) : toujours un stub à 0. Dérivable de
  la photo frontale (nez vs ligne d'épaules, même calibration que la pFSA) mais pas câblé.
- **Déviation ulnaire clinique** : ce qui est mesuré au poignet est un fléchissement *sagittal*
  (visible de profil). La vraie déviation ulnaire est une rotation hors du plan sagittal, non
  mesurable depuis une vue de profil — cf. l'en-tête de `capture-processing.ts`.
- **Asymétrie gauche/droite** : mesurable via l'ASLR, jamais exploitée (hors scope V1 du spec).
- **`DeviceOrientationEvent.requestPermission()`** iOS 13+ non géré : le niveau/tilt dégrade
  silencieusement sur iOS.
- **Contrôle qualité vidéo** à l'import (durée/résolution/orientation) : identifié comme utile,
  non implémenté.
- **Module position guidon** (V2).

## Limite d'environnement rencontrée (pas un bug applicatif)

Le sandbox où ce repo est développé route tout le HTTPS sortant via un proxy qui re-termine le
TLS. Chromium (via Playwright) envoie systématiquement une extension **Encrypted Client Hello**
dans son ClientHello TLS — non désactivable depuis Chrome ~117+. Le proxy ne sait pas la gérer :
le tunnel CONNECT vers `storage.googleapis.com` (host des modèles MediaPipe) s'établit, puis le
handshake reste bloqué ~6s avant `ECONNRESET`. `curl` n'est pas affecté (il n'envoie pas d'ECH),
d'où l'écart entre "la requête marche en CLI" et "elle échoue dans un vrai navigateur ici".

Concrètement : le code (URLs de modèle, CORS, WASM local, API MediaPipe) est vérifié correct par
d'autres moyens, mais **le chargement réel du modèle de segmentation reste à valider sur un vrai
appareil**, hors de ce sandbox. Un réseau normal (wifi maison, 4G) ne devrait pas reproduire ce
blocage. Tout le reste du parcours (mesure manuelle incluse) ne dépend d'aucun modèle et a été
vérifié de bout en bout en Chromium headless.

## Structure

```
docs/
  SPEC_POSTURE_AERO_MOTEUR.md    # spec fonctionnelle, table de confiance des sources (§9)
  INTEGRATION_HANDOFF.md         # pour intégrer l'outil dans une autre app
design/
  bikefitting-zenna-screen.html  # maquette visuelle de référence (statique, sans logique)
scripts/
  copy-mediapipe-wasm.mjs        # copie le WASM de @mediapipe/tasks-vision vers public/ (predev/prebuild)
src/
  main.jsx, App.jsx, index.css   # machine à états `stage` + tous les écrans + tokens de design
  ErrorBoundary.jsx              # filet si une session persistée est incompatible
  engine/
    posture-aero-engine.ts       # logique pure : validation, scores, Pareto, feedback
    posture-aero-engine.test.ts
  capture/
    capture-processing.ts        # géométrie des angles, mesures manuelles, masque -> pFSA
    capture-processing.test.ts
    segmentation-integration.ts  # ImageSegmenter réel -> BinaryMask          [ACTIF]
    segmentation-integration.test.ts
    mediapipe-vision.ts          # fileset WASM partagé (navigateur)          [ACTIF]
    pose-integration.ts          # PoseLandmarker -> PoseFrame     [VESTIGE du pipeline auto]
    pose-integration.test.ts
    video-frame-sampler.ts       # échantillonnage vidéo           [VESTIGE du pipeline auto]
  components/
    PostureCaptureFlow.jsx       # capture caméra + pointage manuel des articulations
    PrivacyNote.jsx
```

## Développement

```bash
npm install
npm test           # 70 tests node:test (engine/ et capture/)
npm run typecheck  # tsc --noEmit — ne couvre pas les .jsx (pas de checkJs)
npm run dev        # app de dev (caméra nécessaire pour la capture réelle)
npm run build      # build de prod
```

Le déploiement GitHub Pages est automatique sur `main` (`.github/workflows/deploy-pages.yml`).

## Pourquoi ce repo existe

Contexte complet dans `docs/SPEC_POSTURE_AERO_MOTEUR.md` : décisions de conception, sources
vérifiées vs hypothèses d'ingénierie (table de confiance §9), portée V1 (§10).

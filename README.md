# posture-aero

Moteur d'analyse posturale pour position aéro (prolongateurs) en cyclisme/triathlon.
Projet parallèle, indépendant d'EnduraBuild — même méthode de travail (spec écrite,
handoff structuré pour Claude Code, tests réels avant de considérer une brique "faite").

**Statut : V1, position aéro uniquement.** Le module position guidon n'est pas commencé
(réutilisera ce pipeline, cf. `docs/SPEC_POSTURE_AERO_MOTEUR.md` §10).

Un **second parcours, analyse de foulée (course à pied)**, partage le même flux de capture et
les mêmes briques de scoring — V1 complète, accessible depuis l'écran d'accueil. Voir
`docs/SPEC_MOTEUR_COURSE.md`.

## Ce qui est fait et testé

| Brique | Fichier | Testé comment |
|---|---|---|
| Moteur (validation, scores, Pareto, feedback) | `src/engine/posture-aero-engine.ts` | 24 tests `node:test`, tous passants |
| Extraction d'angles (landmarks MediaPipe Pose → angles) | `src/capture/capture-processing.ts` | Géométrie vérifiée à la main (calcul manuel vs sortie code) |
| Mesure pFSA (masque calibré → surface frontale) | `src/capture/capture-processing.ts` | Testé, méthode terrain publiée (Debraux et al. 2009) |
| Intégration segmentation (filtrage classes personne+vélo) | `src/capture/segmentation-integration.ts` | Logique de filtrage testée sur masque simulé. `createBikeFitSegmenter()` importe directement `@mediapipe/tasks-vision` (plus de placeholder) et est appelée pour de vrai par `App.jsx` |
| Intégration pose (résultat MediaPipe → `PoseFrame`) | `src/capture/pose-integration.ts` | Conversion pure testée (3 tests). `createBikeFitPoseLandmarker()` réel, appelé par `App.jsx` |
| Flux de capture caméra (UI) | `src/components/PostureCaptureFlow.jsx` | **Exécuté dans un vrai Chromium** (Playwright headless, caméra simulée) : intro → sélection mode → caméra → capture photo → étalonnage par taps, sans erreur. Un vrai bug a été trouvé et corrigé ce faisant (apostrophe échappée en texte JSX brut, s'affichait littéralement) |
| Test ASLR (souplesse hanche) | `src/capture/capture-processing.ts` (`extractAslrAngle`) | Testé (angle cuisse au point d'arrêt = genou qui plie, coordonnées construites à la main) |
| App (session complète : ASLR → profil → essais → `runEngine`) | `src/App.jsx` | Build de prod OK. Flux vérifié dans un vrai Chromium headless (caméra simulée) jusqu'à l'écran d'analyse ASLR inclus (checklist, enregistrement, bouton Valider, écran de chargement, retry) — le déclenchement réel de l'inférence (`ImageSegmenter.segment()` / `PoseLandmarker.detectForVideo()`) reste bloqué par la limite d'environnement ci-dessous |

### Parcours course à pied (V1)

| Brique | Fichier | Testé comment |
|---|---|---|
| Moteur foulée (validation, score charge, score économie, Pareto, suggestion) | `src/engine/running-gait-engine.ts` | Tests `node:test` : opposition charge↔économie vérifiée sur les 3 points du balayage, front non dégénéré, refus explicites |
| Mesure course (6 taps → angles, cadence, oscillation verticale) | `src/capture/running-capture-processing.ts` | Géométrie vérifiée à la main, dont l'invariance au sens de filmage (même geste filmé des deux côtés = mêmes chiffres) |
| Cadence automatique depuis les landmarks | `src/capture/running-capture-processing.ts` (`estimateCadenceFromFrames`) | Signal synthétique : 180 pas/min mesurés sur une vérité terrain de 180, garde-fou Nyquist testé. **Non validé sur appareil réel** |
| Primitives partagées vélo/course | `src/shared/geometry.ts`, `src/shared/analysis.ts` | Extraites de `capture-processing.ts`/`posture-aero-engine.ts` sans changement de comportement (tests vélo inchangés et toujours verts) |
| Mode de capture course (6 taps sur l'image d'attaque) | `src/components/PostureCaptureFlow.jsx` (`run_video`) | **Exécuté dans un vrai Chromium** jusqu'à l'écran de capture |
| Parcours complet (intro → profil → essais → résultats) | `src/components/RunningSession.jsx` | **Exécuté dans un vrai Chromium** de bout en bout : saisie de cadence dans ses deux modes, enregistrement d'essai, écran de résultats sur une session pré-remplie (scores conformes au moteur, essai hors vitesse écarté avec son motif) |
| Primitives d'écran partagées | `src/components/ui.jsx` | Extraites d'`App.jsx` sans changement visuel |

**Reste à confronter au terrain** : la mesure sur une vraie vidéo de course (choix de l'image
d'attaque, précision des 6 taps) — c'est là que le parcours vélo avait révélé ses vrais
problèmes. Limites du protocole (tapis uniquement, scores relatifs à la session, pas de
prédiction de blessure) détaillées au §8 de son spec.

`npm test` fait tourner tous les tests. `npm run typecheck` type-checke tout `src/`.
`npm run dev` / `npm run build` lancent l'app (shell Vite + Tailwind posé sur `PostureCaptureFlow.jsx`).

## Limite d'environnement rencontrée (pas un bug applicatif)

Le sandbox où ce repo a été développé route tout le HTTPS sortant via un proxy qui
re-termine le TLS (interception MITM classique en environnement d'entreprise/CI).
Chromium (via Playwright) envoie systématiquement une extension **Encrypted Client
Hello (ECH/GREASE-ECH)** dans son ClientHello TLS — comportement non désactivable
depuis Chrome ~117+, y compris avec `--disable-features=EncryptedClientHello`. Le
proxy de ce sandbox ne sait pas la gérer : le tunnel CONNECT vers
`storage.googleapis.com` (host des modèles MediaPipe) s'établit, puis le handshake TLS
reste bloqué ~6s avant `ECONNRESET` (diagnostiqué via `--log-net-log`, cf. historique
de session). `curl` n'est pas affecté (il n'envoie pas d'ECH), d'où l'écart entre "la
requête marche en CLI" et "elle échoue dans un vrai navigateur ici".

**Ce que ça veut dire concrètement :**
- Le code (URLs de modèle, CORS, WASM local, API MediaPipe) est vérifié correct par
  d'autres moyens (curl, inspection des types du package installé) — voir tableau
  ci-dessus.
- Le chargement réel des modèles (`ImageSegmenter`/`PoseLandmarker` contre de vraies
  données) reste à valider **sur un vrai appareil, hors de ce sandbox** — un réseau
  normal (wifi maison, 4G) n'a pas ce type de proxy interceptant et ne devrait pas
  reproduire ce blocage.

## Ce qui n'est PAS fait (voir HANDOFF_CLAUDE_CODE.md pour le détail)

- Smoke-test des modèles MediaPipe contre de vraies données (photo/vidéo réelles) —
  bloqué par la limite d'environnement ci-dessus, à faire sur appareil réel
- Déviation poignet réelle — MediaPipe Pose n'a pas les landmarks de main, stub à 0 actuellement
- `DeviceOrientationEvent.requestPermission()` iOS 13+ non géré (niveau/tilt en dégradation silencieuse sur iOS)
- `headOffset_cm` (position tête, ~10% du score aéro) : stub à 0, jamais mesuré. Dérivable de la
  photo frontale (nez vs ligne d'épaules, même calibration que la pFSA) mais pas câblé — décision
  de scope pour rester dans le temps imparti, cf. HANDOFF
- Boucle de feedback post-sortie (§7 du spec) : `recalibrateWeights()` existe et est testée dans
  le moteur, mais aucun questionnaire post-sortie n'est branché dans l'app — poids neutres (1.0)
  utilisés partout
- Module position guidon (V2)

## Structure

```
docs/
  SPEC_POSTURE_AERO_MOTEUR.md    # spec vélo, table de confiance des sources
  SPEC_MOTEUR_COURSE.md          # spec course, même format (sources vérifiées vs hypothèses)
scripts/
  copy-mediapipe-wasm.mjs        # copie le WASM de @mediapipe/tasks-vision vers public/ (predev/prebuild)
src/
  main.jsx, App.jsx, index.css   # shell Vite : orchestre capture -> inférence -> résultat
  shared/
    geometry.ts                  # angles, index MediaPipe, agrégation — partagé vélo/course
    analysis.ts                  # violations, dominance de Pareto, pénalité quadratique
  engine/
    posture-aero-engine.ts       # vélo : validation, scores, Pareto, feedback
    posture-aero-engine.test.ts
    running-gait-engine.ts       # course : validation, charge/économie, Pareto, suggestion
    running-gait-engine.test.ts
  capture/
    capture-processing.ts        # vélo : landmarks -> angles, masque -> pFSA
    capture-processing.test.ts
    running-capture-processing.ts      # course : taps -> métriques, cadence, oscillation
    running-capture-processing.test.ts
    segmentation-integration.ts  # ImageSegmenter réel + conversion résultat -> BinaryMask
    segmentation-integration.test.ts
    pose-integration.ts          # PoseLandmarker réel + conversion résultat -> PoseFrame
    pose-integration.test.ts
    mediapipe-vision.ts          # fileset WASM partagé (navigateur uniquement)
    video-frame-sampler.ts       # échantillonne une vidéo capturée pour l'inférence pose
  components/
    ui.jsx                       # primitives d'écran partagées vélo/course
    PostureCaptureFlow.jsx       # UI de capture caméra (React), vérifiée en Chromium headless
    RunningSession.jsx           # parcours course complet (intro -> profil -> essais -> résultats)
```

## Développement

```bash
npm install
npm test          # 118 tests (vélo + course), tous passants au moment de l'écriture de ce README
npm run typecheck
npm run dev        # app de dev (nécessite un navigateur avec caméra pour la capture réelle)
npm run build       # build de prod (vérifié, voir dist/)
```

## Pourquoi ce repo existe

Contexte complet dans `docs/SPEC_POSTURE_AERO_MOTEUR.md` : décisions de conception, sources
vérifiées vs hypothèses d'ingénierie (table de confiance §9), portée V1 (§10).

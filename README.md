# posture-aero

Moteur d'analyse posturale pour position aéro (prolongateurs) en cyclisme/triathlon.
Projet parallèle, indépendant d'EnduraBuild — même méthode de travail (spec écrite,
handoff structuré pour Claude Code, tests réels avant de considérer une brique "faite").

**Statut : V1, position aéro uniquement.** Le module position guidon n'est pas commencé
(réutilisera ce pipeline, cf. `docs/SPEC_POSTURE_AERO_MOTEUR.md` §10).

## Ce qui est fait et testé

| Brique | Fichier | Testé comment |
|---|---|---|
| Moteur (validation, scores, Pareto, feedback) | `src/engine/posture-aero-engine.ts` | 24 tests `node:test`, tous passants |
| Extraction d'angles (landmarks MediaPipe Pose → angles) | `src/capture/capture-processing.ts` | Géométrie vérifiée à la main (calcul manuel vs sortie code) |
| Mesure pFSA (masque calibré → surface frontale) | `src/capture/capture-processing.ts` | Testé, méthode terrain publiée (Debraux et al. 2009) |
| Intégration segmentation (filtrage classes personne+vélo) | `src/capture/segmentation-integration.ts` | Logique de filtrage testée sur masque simulé. `createBikeFitSegmenter()` importe directement `@mediapipe/tasks-vision` (plus de placeholder) et est appelée pour de vrai par `App.jsx` |
| Intégration pose (résultat MediaPipe → `PoseFrame`) | `src/capture/pose-integration.ts` | Conversion pure testée (3 tests). `createBikeFitPoseLandmarker()` réel, appelé par `App.jsx` |
| Flux de capture caméra (UI) | `src/components/PostureCaptureFlow.jsx` | **Exécuté dans un vrai Chromium** (Playwright headless, caméra simulée) : intro → sélection mode → caméra → capture photo → étalonnage par taps, sans erreur. Un vrai bug a été trouvé et corrigé ce faisant (apostrophe échappée en texte JSX brut, s'affichait littéralement) |
| App (orchestration capture → inférence → résultat) | `src/App.jsx` | Build de prod OK (`npm run build`). Le déclenchement réel de l'inférence (`ImageSegmenter.segment()` / `PoseLandmarker.detectForVideo()`) n'a **pas** pu être exercé de bout en bout dans ce sandbox — voir "Limite d'environnement" ci-dessous |

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
- Branchement du moteur (`posture-aero-engine.ts` : validation/score/Pareto) sur les résultats
  d'un essai réel — l'app affiche aujourd'hui les métriques brutes d'un essai (angles, pFSA),
  pas encore le score multi-essais (nécessite aussi le profil athlète + test ASLR, cf. spec §2)
- Module position guidon (V2)

## Structure

```
docs/
  SPEC_POSTURE_AERO_MOTEUR.md    # spec fonctionnelle complète, table de confiance des sources
scripts/
  copy-mediapipe-wasm.mjs        # copie le WASM de @mediapipe/tasks-vision vers public/ (predev/prebuild)
src/
  main.jsx, App.jsx, index.css   # shell Vite : orchestre capture -> inférence -> résultat
  engine/
    posture-aero-engine.ts       # logique pure : validation, scores, Pareto, feedback
    posture-aero-engine.test.ts
  capture/
    capture-processing.ts        # landmarks -> angles, masque -> pFSA
    capture-processing.test.ts
    segmentation-integration.ts  # ImageSegmenter réel + conversion résultat -> BinaryMask
    segmentation-integration.test.ts
    pose-integration.ts          # PoseLandmarker réel + conversion résultat -> PoseFrame
    pose-integration.test.ts
    mediapipe-vision.ts          # fileset WASM partagé (navigateur uniquement)
    video-frame-sampler.ts       # échantillonne une vidéo capturée pour l'inférence pose
  components/
    PostureCaptureFlow.jsx       # UI de capture caméra (React), vérifiée en Chromium headless
```

## Développement

```bash
npm install
npm test          # 27 tests, tous passants au moment de l'écriture de ce README
npm run typecheck
npm run dev        # app de dev (nécessite un navigateur avec caméra pour la capture réelle)
npm run build       # build de prod (vérifié, voir dist/)
```

## Pourquoi ce repo existe

Contexte complet dans `docs/SPEC_POSTURE_AERO_MOTEUR.md` : décisions de conception, sources
vérifiées vs hypothèses d'ingénierie (table de confiance §9), portée V1 (§10).

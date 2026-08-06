# Handoff — posture-aero, V1

Repo initié hors de Claude Code (conversation Claude.ai, 06/08/2026). Toute la logique pure
est écrite et testée (`npm test`, 24/24 passants). Session Claude Code du 06/08/2026 (suite) :
tâches 1, 2 et 3 ci-dessous sont faites (shell Vite, ImageSegmenter réel, PoseLandmarker réel,
orchestration App.jsx). Ce qui reste demande un vrai appareil pour être terminé — voir
"Limite d'environnement rencontrée" ci-dessous, qui explique précisément le blocage.

## État vérifié (ne pas re-questionner sans raison)

- `src/engine/posture-aero-engine.ts` : moteur complet, 24 tests passants. Plancher hanche 40°,
  seuil ASLR 80° et méthode pFSA sont sourcés (voir `docs/SPEC_POSTURE_AERO_MOTEUR.md` §9,
  table de confiance). Les pondérations de score (aéro 65/25/10, pénalités confort) sont des
  défauts d'ingénierie explicitement marqués comme tels — à calibrer via §7 (feedback), pas
  une vérité à défendre.
- `src/capture/capture-processing.ts` : géométrie des angles vérifiée à la main (voir commentaires
  dans `capture-processing.test.ts`). Un bug de signe sur `angleVsHorizontal` a été trouvé et
  corrigé pendant le développement — le test de non-régression est en place, ne pas le retirer.
- `src/capture/segmentation-integration.ts` : logique de filtrage de masque (classes Pascal VOC
  "person"=15, "bicycle"=2) testée sur masque simulé. `createBikeFitSegmenter()` importe
  directement `@mediapipe/tasks-vision` (l'accesseur réel du masque est `getAsUint8Array()`,
  confirmé contre `vision.d.ts` du package installé — pas `readCategoryIndices()` comme supposé
  au premier jet). N'a **jamais tourné contre un vrai modèle** — voir "Limite d'environnement".
- `src/capture/pose-integration.ts` (nouveau) : `createBikeFitPoseLandmarker()` réel
  (`PoseLandmarker`, mode `VIDEO`, modèle `pose_landmarker_lite`). `toPoseFrame()` (conversion
  pure) testée. Jamais tourné contre une vraie vidéo — même blocage.
- `src/App.jsx` (nouveau) : orchestre `PostureCaptureFlow` → échantillonnage vidéo
  (`video-frame-sampler.ts`) / segmentation photo → `extractTrialAngles` / `computePFSA_cm2`.
  Build de prod OK. N'affiche que les métriques brutes d'un essai — ne branche PAS encore
  `posture-aero-engine.ts` (validation/score/Pareto), qui demande plusieurs essais + profil
  athlète (test ASLR) : UI pas encore construite pour ça.
- `src/components/PostureCaptureFlow.jsx` : exécuté dans un vrai Chromium (Playwright headless,
  `--use-fake-device-for-media-stream`) jusqu'à l'écran d'étalonnage inclus, sans erreur. Bug réel
  trouvé et corrigé : une apostrophe échappée (`’`) écrite en texte JSX brut (pas dans une
  string JS) s'affichait littéralement au lieu du caractère — seule ligne 232 était concernée
  (les autres `’` étaient dans de vraies strings JS, donc déjà correctes). `onCaptured` est
  maintenant le point d'intégration avec `App.jsx` (plus d'écran "done" interne).

## Limite d'environnement rencontrée (diagnostiquée en détail, pas un bug applicatif)

Le sandbox de cette session route le HTTPS sortant via un proxy qui re-termine le TLS. Chromium
(Playwright) envoie une extension ClientHello **Encrypted Client Hello (ECH/GREASE-ECH)** —
comportement non désactivable via `--disable-features=EncryptedClientHello` sur les versions
récentes de Chrome (vérifié : le flag ne change pas `ech_enabled` dans les logs réseau). Le proxy
ne sait pas gérer cette extension pour `storage.googleapis.com` (host des modèles MediaPipe) : le
tunnel CONNECT s'établit, puis le handshake TLS reste bloqué avant `ECONNRESET` après ~6s
(confirmé via `--log-net-log` + inspection JSON, cf. session). `curl` n'envoie pas d'ECH, d'où
le succès en CLI alors que Chromium échoue. `github.com` échoue différemment (`ERR_CERT_AUTHORITY_INVALID`)
— la CA du proxy n'est pas non plus correctement approuvée par ce Chromium Playwright, second
problème indépendant de l'ECH.

**Ce que ça implique** : rien à corriger côté code applicatif pour ce point précis. Un réseau
normal (wifi/4G, sans proxy MITM interceptant) ne devrait pas reproduire ce blocage — mais ça
reste un point d'incertitude tant que ce n'est pas confirmé sur un vrai appareil (tâche 1
ci-dessous, toujours ouverte pour cette raison précise).

## Tâches, par priorité

### 1. Smoke-test réel des modèles MediaPipe sur un vrai appareil (bloquant pour la pFSA et les angles)
- Le code est câblé (`segmentation-integration.ts`, `pose-integration.ts`, `mediapipe-vision.ts`,
  `App.jsx`) et le build de prod passe. Reste à vérifier, **hors de ce sandbox** :
  - `ImageSegmenter.segment()` sur une vraie photo de vélo → `computePFSA_cm2()` tombe dans un
    ordre de grandeur plausible (position aéro adulte ≈ 3000-4500 cm², cf. spec) — pas juste
    "ça ne crash pas"
  - `PoseLandmarker.detectForVideo()` sur une vraie vidéo profil → `extractTrialAngles()` produit
    des angles hanche/genou/cheville dans une plage plausible
  - Le fetch du modèle `.tflite`/`.task` depuis `storage.googleapis.com` aboutit bien (c'est le
    point précis bloqué dans ce sandbox, cf. ci-dessus)

### 2. Tester `PostureCaptureFlow.jsx` + `App.jsx` sur téléphone réel
- Fait dans ce sandbox : flux caméra simulée (Chromium headless) jusqu'à l'étalonnage, sans
  erreur JS. Reste à vérifier sur téléphone : permission caméra réelle, enregistrement vidéo,
  précision du mapping taps de calibration écran → canvas
- **Point d'incertitude explicite, non résolu** : le niveau/tilt (`DeviceOrientationEvent`) peut
  nécessiter `DeviceOrientationEvent.requestPermission()` sur iOS 13+ (non géré — dégradation
  silencieuse plutôt que crash si l'event n'arrive jamais)

### 3. Brancher `posture-aero-engine.ts` sur des essais réels
- `App.jsx` affiche aujourd'hui les métriques brutes d'UN essai (angles OU pFSA). Il manque :
  stocker plusieurs essais, saisir le profil athlète (dont `hip_flexibility_score` via test ASLR,
  cf. spec §3.1), puis appeler `validate`/score/Pareto sur l'ensemble — pas commencé

### 4. Décision à prendre : MediaPipe Hands pour le poignet
Non câblé (cf. `capture-processing.ts`, en-tête de fichier). Avant d'investir dessus : le spec
(§10) note qu'aucune source bike-fit chiffrée ne justifie un seuil de déviation ulnaire précis
— évaluer si l'effort d'intégration d'un second modèle se justifie pour un paramètre déjà
marqué "non sourcé", ou s'il vaut mieux le laisser en warning qualitatif.

### Hors scope V1 (ne pas commencer sans arbitrage explicite)
- Module position guidon (réutilise ce pipeline, plages différentes, cf. spec §10)
- Vue frontale dynamique (vidéo plutôt que photo statique)
- Exploitation de l'asymétrie gauche/droite (mesurée par ASLR mais pas utilisée dans le moteur)

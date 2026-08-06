# Handoff — posture-aero, V1

Repo initié hors de Claude Code (conversation Claude.ai, 06/08/2026). Toute la logique pure
est écrite et testée (`npm test`, 24/24 passants). Ce qui reste demande un vrai navigateur/
appareil pour être terminé — c'est le blocage exact qui a arrêté l'avancement côté conversation.

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
  "person"=15, "bicycle"=2) testée sur masque simulé. `createBikeFitSegmenter()` n'a **jamais
  tourné contre un vrai modèle** — voir tâche 1.

## Tâches, par priorité

### 1. Smoke-test réel de `ImageSegmenter` (bloquant pour la pFSA)
`src/capture/segmentation-integration.ts`, fonction `createBikeFitSegmenter()`.
- Installer `@mediapipe/tasks-vision`, l'injecter (le fichier attend `globalThis.__mediapipeTasksVision__`
  — remplacer par un vrai import direct si plus simple, ce placeholder existait pour rester
  testable sans le package)
- Tourner `ImageSegmenter.segment()` sur une vraie photo de vélo et vérifier que
  `readCategoryIndices()` (accesseur du `categoryMask`, nom exact à confirmer contre la version
  installée de `@mediapipe/tasks-vision` — non garanti dans ce fichier) retourne bien des indices
  de classe exploitables
- **Critère d'acceptation** : une photo réelle (cycliste + vélo, fond dégagé) produit un masque
  dont la pFSA calculée (`computePFSA_cm2`) tombe dans un ordre de grandeur plausible (position
  aéro adulte ≈ 3000-4500 cm², cf. littérature citée dans le spec) — pas juste "ça ne crash pas"

### 2. Tester `PostureCaptureFlow.jsx` en conditions réelles
- Monter le composant dans un shell (Vite suffit pour un test isolé) ou l'intégrer directement
  dans l'app cible
- Vérifier sur téléphone : permission caméra, enregistrement vidéo, capture photo, taps de
  calibration (précision du mapping coordonnées écran → coordonnées canvas, cf. `handleCalibrationTap`)
- **Point d'incertitude explicite** : le niveau/tilt (`DeviceOrientationEvent`) peut nécessiter
  un appel à `DeviceOrientationEvent.requestPermission()` sur iOS 13+ (non géré dans le fichier
  actuel — dégradation silencieuse si l'event n'arrive jamais, mais pas de demande de permission
  explicite). À corriger si le niveau doit vraiment fonctionner sur iOS.

### 3. Brancher un vrai PoseLandmarker pour alimenter `extractTrialAngles`
- Actuellement alimenté uniquement par des landmarks synthétiques (tests). Il faut le pipeline
  MediaPipe PoseLandmarker (vidéo → 33 keypoints/frame → `PoseFrame[]`) qui n'existe pas encore
  dans ce repo
- Réutiliser le pattern de `segmentation-integration.ts` (init hors du fichier de traitement,
  injection) plutôt que de coupler `capture-processing.ts` au package MediaPipe

### 4. Décision à prendre : MediaPipe Hands pour le poignet
Non câblé (cf. `capture-processing.ts`, en-tête de fichier). Avant d'investir dessus : le spec
(§10) note qu'aucune source bike-fit chiffrée ne justifie un seuil de déviation ulnaire précis
— évaluer si l'effort d'intégration d'un second modèle se justifie pour un paramètre déjà
marqué "non sourcé", ou s'il vaut mieux le laisser en warning qualitatif.

### Hors scope V1 (ne pas commencer sans arbitrage explicite)
- Module position guidon (réutilise ce pipeline, plages différentes, cf. spec §10)
- Vue frontale dynamique (vidéo plutôt que photo statique)
- Exploitation de l'asymétrie gauche/droite (mesurée par ASLR mais pas utilisée dans le moteur)

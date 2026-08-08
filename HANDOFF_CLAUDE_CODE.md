# Handoff — posture-aero, V1

Repo initié hors de Claude Code (conversation Claude.ai, 06/08/2026). Toute la logique pure
est écrite et testée (`npm test`, 29/29 passants). Session Claude Code du 06/08/2026 (suite) :
shell Vite, ImageSegmenter réel, PoseLandmarker réel, test ASLR (souplesse hanche), et
`App.jsx` orchestre maintenant la session complète (ASLR → profil → essais → `runEngine`,
scores + sélection Pareto). Ce qui reste demande un vrai appareil pour être terminé — voir
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
- `src/capture/capture-processing.ts` (`extractAslrAngle`, nouveau) : angle cuisse/horizontale
  au point d'arrêt (dernier instant où le genou reste verrouillé, seuil 165° sur l'angle
  hanche-genou-cheville). Testé avec des coordonnées construites à la main (pas juste
  "plausibles") vérifiant que le point d'arrêt est bien respecté et qu'un angle plus élevé
  APRÈS que le genou ait plié n'est pas retenu.
- `src/App.jsx` (réécrit) : orchestre la session complète —
  1. capture vidéo ASLR (`mode="aslr_test"`) → `extractAslrAngle` → `aslrToFlexScore`
  2. formulaire profil (taille en cm, obligatoire ; durée de course, optionnelle)
  3. boucle d'essais : vidéo profil → photo frontale + étalonnage → formulaire deltas
     (hauteur selle/reach/drop en mm, saisie manuelle — ce sont des réglages physiques,
     pas quelque chose qu'une caméra mesure) → assemblage d'un `Trial` complet
  4. `runEngine(trials, profile, weights)` avec des poids neutres (1.0 partout — pas de
     boucle de feedback §7 branchée, `recalibrateWeights()` existe et est testée dans le
     moteur mais aucun questionnaire post-sortie n'est câblé dans l'app)
  Build de prod OK. `headOffset_cm` reste un stub à 0 (voir tâche 4 ci-dessous — c'est un
  choix de scope assumé, pas un oubli).
- `src/components/PostureCaptureFlow.jsx` : accepte maintenant une prop `initialMode` — si
  fournie, saute l'écran de choix et démarre direct la caméra pour ce mode (c'est comme ça
  qu'`App.jsx` pilote la séquence ASLR → vidéo profil → photo frontale sans passer par le
  menu). `MODES` (ex-`CHECKLISTS`) a un 3ᵉ mode `aslr_test`, vidéo comme `profile_video`
  (`VIDEO_MODES` regroupe les deux pour la logique d'enregistrement vs photo). Exécuté dans
  un vrai Chromium (Playwright headless, `--use-fake-device-for-media-stream`) jusqu'à
  l'écran d'étalonnage inclus ET jusqu'au flux ASLR complet (checklist → enregistrement →
  Valider → écran de chargement → erreur réseau connue → Réessayer → retour à l'ASLR),
  sans erreur JS. Bug réel trouvé et corrigé au passage : une apostrophe échappée (`’`)
  écrite en texte JSX brut (pas dans une string JS) s'affichait littéralement au lieu du
  caractère — seule l'ancienne ligne 232 était concernée. `onCaptured` est le point
  d'intégration avec `App.jsx` (plus d'écran "done" interne).

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

### 1. Smoke-test réel des modèles MediaPipe sur un vrai appareil (bloquant pour tout le reste)
- Le code est câblé de bout en bout (ASLR → profil → essais → résultats) et le build de prod
  passe. Reste à vérifier, **hors de ce sandbox** :
  - `ImageSegmenter.segment()` sur une vraie photo de vélo → `computePFSA_cm2()` tombe dans un
    ordre de grandeur plausible (position aéro adulte ≈ 3000-4500 cm², cf. spec) — pas juste
    "ça ne crash pas"
  - `PoseLandmarker.detectForVideo()` sur une vraie vidéo profil → `extractTrialAngles()` produit
    des angles hanche/genou/cheville dans une plage plausible
  - `PoseLandmarker.detectForVideo()` sur une vraie vidéo ASLR (personne allongée, vue sagittale)
    → `extractAslrAngle()` produit un angle plausible. Point d'incertitude spécifique : le
    modèle Pose est conçu/entraîné surtout sur des sujets debout — sa fiabilité allongé n'est
    pas garantie, à vérifier en priorité (si les landmarks hanche/genou/cheville sont dégradés,
    le point d'arrêt peut être mal détecté)
  - Le fetch du modèle `.tflite`/`.task` depuis `storage.googleapis.com` aboutit bien (c'est le
    point précis bloqué dans ce sandbox, cf. ci-dessus)

### 2. Tester `PostureCaptureFlow.jsx` + `App.jsx` sur téléphone réel
- Fait dans ce sandbox : flux caméra simulée (Chromium headless) jusqu'à l'étalonnage (photo
  frontale) et jusqu'au bouton Valider + écran de chargement (ASLR), sans erreur JS. Reste à
  vérifier sur téléphone : permission caméra réelle, enregistrement vidéo, précision du mapping
  taps de calibration écran → canvas, ergonomie de la séquence à 3 captures (ASLR + vidéo + photo)
  bout en bout sans perdre l'utilisateur en route
- **Point d'incertitude explicite, non résolu** : le niveau/tilt (`DeviceOrientationEvent`) peut
  nécessiter `DeviceOrientationEvent.requestPermission()` sur iOS 13+ (non géré — dégradation
  silencieuse plutôt que crash si l'event n'arrive jamais)
- **Retour terrain (appareil réel, 06/08/2026)** : l'indicateur de niveau affichait ~20°
  téléphone tenu droit — le capteur `gamma` n'est pas calé sur 0° à la verticale sur tous les
  appareils. Corrigé par un étalonnage manuel : l'indicateur de niveau est maintenant un bouton
  tappable (`calibrateLevel()` dans `PostureCaptureFlow.jsx`) qui capture la valeur `gamma`
  courante comme décalage (`tiltOffset`) ; l'affichage et le seuil "niveau ok" utilisent ensuite
  `tilt - tiltOffset`. Pas de correction automatique par appareil (pas de base de données de
  calibration par modèle) — l'utilisateur cale le zéro lui-même en tenant le téléphone droit.

### 3. Décision à prendre : MediaPipe Hands pour le poignet
Non câblé (cf. `capture-processing.ts`, en-tête de fichier). Avant d'investir dessus : le spec
(§10) note qu'aucune source bike-fit chiffrée ne justifie un seuil de déviation ulnaire précis
— évaluer si l'effort d'intégration d'un second modèle se justifie pour un paramètre déjà
marqué "non sourcé", ou s'il vaut mieux le laisser en warning qualitatif.

### 4. Calculer `headOffset_cm` au lieu du stub à 0
Dérivable de la photo frontale déjà capturée pour la pFSA : lancer un `PoseLandmarker` en mode
`IMAGE` (instance séparée de celui en mode `VIDEO` utilisé pour la vidéo profil — MediaPipe ne
permet pas de mélanger les modes sur une même instance) dessus, comparer la position verticale
du nez (landmark 0) à la ligne des épaules (11/12), convertir en cm avec la même calibration
(`cmPerPixel`) que la pFSA. Non fait par choix de scope (~10% du score aéro seulement, cf. §5
du spec — "signal correctif"), pas par oubli.

### 5. Boucle de feedback post-sortie (§7 du spec)
`recalibrateWeights()` existe et est testée dans le moteur, mais rien ne l'appelle : pas de
questionnaire post-sortie dans l'app, poids neutres (1.0) utilisés partout. La persistance de
session (souplesse/profil/essais déjà validés) existe maintenant via `localStorage` (retour
terrain : un plantage du navigateur en pleine capture faisait tout perdre — voir tâche 2 du
07/08) — mais elle ne survit qu'à un seul appareil/navigateur, rien n'est envoyé à un serveur.
Une vraie boucle de feedback nécessiterait d'y ajouter la persistance des scores post-sortie.

### 6. Import galerie (07/08/2026) : vérifier sur vrai appareil que le fichier importé est
bien lisible par `sampleVideoFrames`/`createImageBitmap` — codecs variables selon l'appli
caméra source (HEVC iOS, etc.), pas testé au-delà du principe (fichier généré par
`MediaRecorder` du navigateur, jamais un vrai fichier caméra native, dans ce sandbox).

### Bug réel trouvé et corrigé (08/08/2026) : angle ASLR à 0° sur vraie vidéo
Retour terrain : test ASLR donnant systématiquement un angle de 0°. Diagnostiqué en
rejouant la vraie vidéo (16 s, envoyée par l'utilisateur) dans un vrai Chromium — la
vidéo elle-même est correcte (personne allongée, jambe levée bien visible), mais
`video-frame-sampler.ts` échantillonnait par `video.currentTime = t` (seek), qui **ne
fonctionne pas** sur un webm produit par `MediaRecorder` : `onseeked` se déclenche mais
`currentTime` reste bloqué à 0 pour les 40/40 échantillons demandés (confirmé en
reproduisant exactement la boucle du code contre le fichier réel — pas une supposition).
Cause : ce webm n'a pas d'index Cues/SeekHead, que `MediaRecorder` n'écrit pas. Résultat :
toutes les frames "analysées" étaient en fait la même frame initiale, avant le mouvement
→ `extractAslrAngle` ne voyait jamais de genou verrouillé en position haute → renvoyait sa
valeur par défaut (0). Corrigé en remplaçant le seek par un échantillonnage en lecture
réelle via `requestVideoFrameCallback` (vraies frames décodées dans l'ordre de lecture,
confirmé sur ce même fichier : 39 frames avec des temps réels distincts et croissants,
contre 40/40 bloquées à 0.00s avant). Repli sur l'ancien seek si l'API n'est pas
supportée par le navigateur (mieux que rien). **Ce bug touchait potentiellement aussi les
vidéos essai (profil)**, même mécanisme de sampling — pas juste l'ASLR.

### Bug réel #2 trouvé et corrigé (08/08/2026, même session) : angle ASLR sous-estimé (18,9°)
Une fois le bug #1 corrigé, le même fichier réel donnait 18,9° au lieu des ~85° visibles à
l'œil sur la vidéo (jambe clairement levée quasi à la verticale, cf. capture d'écran de la
frame du pic). Cause distincte : `extractAslrAngle` arrêtait la mesure (`break`) dès le
**tout premier** genou plié rencontré dans l'ordre chronologique des frames — or la vidéo
réelle commence par une phase d'installation (l'utilisateur s'accroupit pour ajuster le
téléphone avant de s'allonger, genou plié) **avant** le mouvement testé. Le seek cassé du
bug #1 masquait ce second bug (tout retombait sur la frame 0, avant même l'installation).
Corrigé en n'armant la règle d'arrêt qu'une fois la cuisse réellement engagée dans la levée
(seuil `RAISE_ENGAGED_THRESHOLD_DEG = 15°`, genou plié) — les genoux pliés avant ce point
(installation) sont ignorés, ceux après (vrai point d'arrêt clinique) arrêtent toujours la
mesure comme prévu. Test de non-régression ajouté (`capture-processing.test.ts`) qui
reproduit exactement ce scénario. Point de vigilance : le seuil de 15° est un choix
d'ingénierie raisonné (cf. commentaire dans le code) mais pas sourcé cliniquement — à
surveiller si des faux positifs d'armement apparaissent sur d'autres vidéos réelles.

### Hors scope V1 (ne pas commencer sans arbitrage explicite)
- Module position guidon (réutilise ce pipeline, plages différentes, cf. spec §10)
- Vue frontale dynamique (vidéo plutôt que photo statique)
- Exploitation de l'asymétrie gauche/droite (mesurée par ASLR mais pas utilisée dans le moteur)

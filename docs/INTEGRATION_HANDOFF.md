# Handoff — intégrer l'outil Bikefitting dans l'app principale (Zenna)

Document destiné à **Claude Code travaillant dans le repo de l'app principale**. Il décrit ce
qui existe, ce qui est portable tel quel, ce qui demande une adaptation, et surtout les
décisions à NE PAS défaire (plusieurs ont été prises après des échecs terrain réels).

- **Source** : https://github.com/dobetheo-sys/Bikefiting — branche `main`
- **Démo en ligne** : https://dobetheo-sys.github.io/Bikefiting/
- **Spec fonctionnelle** : `docs/SPEC_POSTURE_AERO_MOTEUR.md` (dans ce repo) — à lire avant de
  toucher au moteur de scoring, elle explique quels seuils sont sourcés et lesquels ne le sont pas.

> **Si un autre document du repo te dit le contraire de celui-ci, tranche toi-même en 10 secondes.**
> `HANDOFF_CLAUDE_CODE.md` est un instantané daté du 08/08/2026, antérieur au passage à la mesure
> manuelle (10-11/08) — il porte désormais un bandeau "document historique". En cas de doute, ces
> 3 commandes font foi, pas la prose :
>
> ```bash
> grep -c "pose-integration\|extractTrialAngles" src/App.jsx   # 0 attendu = pipeline auto mort
> grep -c "TapImage\|TapLoupe" src/components/PostureCaptureFlow.jsx  # > 0 = pointage manuel actif
> npm test                                                      # 70 tests attendus
> ```

---

## 1. Ce que fait l'outil

Un bilan de position aéro (vélo de triathlon/CLM), réalisable seul avec un téléphone :

1. **Test de souplesse ASLR** (une vidéo, allongé au sol) → score de souplesse hanche 1-5, qui
   calibre la contrainte de fermeture de hanche du reste du bilan.
2. **Profil athlète** : taille, durée de course, entrejambe (optionnel), objectif aéro/confort.
3. **N essais** (minimum 3) — pour chaque essai :
   - vidéo de profil en pédalant → l'utilisateur choisit 2 images (point mort haut / bas) et
     **tape lui-même les points articulaires** dessus → angles hanche/tronc/genou/épaule/coude/poignet ;
   - photo de face calibrée → surface frontale projetée (pFSA) par segmentation MediaPipe ;
   - les mesures du vélo (hauteur/recul de selle, reach, drop, + réglages avancés optionnels).
4. **Résultats** : score confort + score aéro par essai (chacun avec une plage de sensibilité),
   front de Pareto, et 3 positions recommandées (confort max / équilibré / aéro max).
5. **Historique + tendance** entre bilans, et **boucle de feedback** post-sortie (douleur par
   zone, 1-5) qui repondère le score confort des bilans suivants.

---

## 2. Inventaire du code (5 955 lignes)

### Logique pure — portable telle quelle, aucune dépendance UI

| Fichier | Rôle |
|---|---|
| `src/engine/posture-aero-engine.ts` (578 l.) | Tout le scoring : validation, score confort, score aéro, plages de sensibilité, Pareto, recalibration du feedback. Zéro import React. |
| `src/capture/capture-processing.ts` (378 l.) | Géométrie des angles (`angleAt`, `angleVsHorizontal`), mesures manuelles ASLR/PMH/PMB, calcul pFSA depuis un masque. |
| `src/capture/segmentation-integration.ts` (93 l.) | MediaPipe ImageSegmenter → masque binaire pour la pFSA. **Utilisé** (photo frontale). |
| `src/capture/mediapipe-vision.ts` (36 l.) | Chargement/partage du fileset WASM MediaPipe. **Utilisé**. |

Tests associés (`*.test.ts`, node:test) : **70 tests, tous au vert**. À reprendre tels quels.

### UI React — à adapter au shell de l'app principale

| Fichier | Rôle |
|---|---|
| `src/App.jsx` (2 095 l.) | Machine à états `stage` + tous les écrans (voir §4). C'est le morceau à réintégrer, pas à copier bêtement. |
| `src/components/PostureCaptureFlow.jsx` (1 537 l.) | Flux de capture caméra/import + pointage manuel des points (`TapImage`/`TapLoupe`). Autonome, piloté par 3 props. |
| `src/components/PrivacyNote.jsx` (14 l.) | Mention "traité sur ton téléphone". |
| `src/ErrorBoundary.jsx` (57 l.) | Filet de sécurité si une session persistée est incompatible. |

### Code mort — à supprimer, pas à porter

`src/capture/pose-integration.ts`, `src/capture/video-frame-sampler.ts`, et
`extractTrialAngles()` dans `capture-processing.ts` : vestiges du pipeline de détection
**automatique** MediaPipe Pose, abandonné (voir §6). Rien ne les importe hors de leurs propres
tests. Les porter donnerait l'illusion qu'une détection auto existe.

---

## 3. Dépendances et build

```jsonc
"dependencies": {
  "@mediapipe/tasks-vision": "^1.0.1",  // segmentation photo frontale uniquement
  "lucide-react": "^0.383.0",           // icônes
  "react": "^18.3.0",
  "react-dom": "^18.3.1"
},
"devDependencies": {
  "@tailwindcss/vite": "^4.3.3",
  "tailwindcss": "^4.3.3",
  "tsx": "^4.21.0"                      // pour `npm test` (node:test sur les .ts)
}
```

Deux points d'infrastructure à ne pas oublier :

1. **WASM MediaPipe servi en local.** `scripts/copy-mediapipe-wasm.mjs` copie les binaires de
   `node_modules/@mediapipe/tasks-vision/wasm` vers `public/mediapipe-wasm/`, lancé en
   `predev`/`prebuild`. Volontairement local plutôt que via le CDN jsdelivr, pour ne pas
   dépendre d'un tiers au runtime. `mediapipe-vision.ts` construit son chemin avec
   `import.meta.env.BASE_URL` — si l'app principale est servie sous un sous-chemin, ça suit
   automatiquement ; un chemin absolu en dur avait causé un 404 en production.
2. **Polices Google** (Bebas Neue, Inter, IBM Plex Mono) chargées dans `index.html`. L'app
   principale les charge probablement déjà (voir §5).

Commandes de validation, à faire tourner après chaque étape d'intégration :

```bash
npm run typecheck      # tsc --noEmit (ne couvre PAS les .jsx, cf. tsconfig sans checkJs)
npm test               # 70 tests node:test sur engine/ et capture/
GITHUB_PAGES=true npm run build
```

---

## 4. Machine à états et point de montage

`App.jsx` exporte `export default function App()` et gère tout via un `stage` :

```
welcome → aslr-capture → profile-form → session
                                          ├→ trial-overview → trial-video / trial-photo / trial-deltas
                                          │                   └→ trial-review (relecture d'une mesure)
                                          ├→ results
                                          ├→ history → trend
                                          └→ feedback-form
```

**Pour l'intégration** : Bikefitting n'a pas de navigation propre (pas de barre d'onglets,
pas de router). Le plus simple est de monter `<App />` comme UN écran/onglet de l'app
principale, en lui laissant sa machine à états interne. Deux ajustements probables :

- `ScreenShell` (dans `App.jsx`) utilise `h-screen` + `overflow-hidden` : si l'app principale
  a un chrome persistant (header, bottom-nav), il faudra passer à une hauteur contrainte par le
  parent plutôt que par le viewport.
- L'écran `welcome` fait doublon si l'app principale a déjà sa propre page d'entrée vers
  l'outil — dans ce cas, démarrer directement sur `aslr-capture` (ou `session` si un profil
  existe déjà), cf. `initialStageFor()`.

`PostureCaptureFlow` est autonome et se pilote par 3 props :

```jsx
<PostureCaptureFlow
  initialMode="aslr_test | profile_video | frontal_photo"
  onCaptured={(payload) => {}}   // payload dépend du mode, cf. en-tête du fichier
  onCancel={() => {}}
/>
```

### Persistance (localStorage, 4 clés)

| Clé | Contenu |
|---|---|
| `posture-aero-session-v1` | session en cours : `{aslrAngle, profile, athleteHeightCm, athleteInseamCm, trials}` |
| `posture-aero-history-v1` | bilans archivés |
| `posture-aero-subjective-v1` | `{weights, feedbackLog}` de la boucle de feedback |
| `posture-aero-ref-length-cm` | dernière longueur du repère d'étalonnage |

Si l'app principale a un backend/compte utilisateur, ces 4 clés sont les points d'ancrage à
remplacer. Attention : `pendingTrial` (l'essai en cours de saisie) n'est **pas** persisté, c'est
délibéré et documenté.

---

## 5. Design system

L'outil a déjà été restylé pour adopter les tokens Zenna — `src/index.css` contient un bloc
`@theme` Tailwind v4 :

- couleurs : `--color-bg` (#000), `--color-surface`/`-2`/`-3`, `--color-border`,
  `--color-orange` (#ff3d00), `--color-cyan` (#00e0c6), `--color-gold` (#ffd23d),
  `--color-danger`, `--color-ink`, `--color-text`/`-dim`/`-faint` ;
- polices : `--font-display` (Bebas Neue), `--font-sans` (Inter), `--font-mono` (IBM Plex Mono) ;
- rayons : `--radius-card` (18px), `--radius-control` (13px).

Tout le JSX ne consomme que les utilitaires générés (`bg-surface`, `text-text-dim`,
`rounded-card`…) ou `var(--color-*)` pour les attributs SVG — la seule couleur en dur restante
est la silhouette décorative de `BikeDeltasDiagram` (voir exceptions ci-dessous). Si l'app principale
définit déjà ces mêmes tokens, il suffit de supprimer le `@theme` de `src/index.css` et tout
suit. Si ses tokens portent d'autres noms, un simple renommage des utilitaires suffit.

**Convention de couleur sémantique** (à respecter, 3 endroits doivent rester synchronisés :
`ProfileCard`, `PROFILE_SERIES`, `BikeDeltasDiagram`) :
orange = selle/confort · cyan = cintre/aéro · or = équilibré et CTA générique.

Deux exceptions volontaires aux tokens, à ne pas "corriger" :

- les voiles semi-transparents posés sur un flux caméra ou une photo importée restent en
  **noir pur** (`bg-black/50`, `/70`, `/90`) — `--color-surface` (#111318) a une dominante
  bleu-gris qui teinterait visiblement l'image en dessous ;
- la silhouette de vélo de `BikeDeltasDiagram` garde ses gris en dur : purement décorative,
  indépendante du thème.

---

## 6. Décisions à NE PAS défaire

Chacune vient d'un échec réel ou d'un choix méthodologique assumé. Les redéfaire ferait
régresser l'outil.

**a) La mesure est MANUELLE, pas automatique.** Le pipeline de détection auto (MediaPipe Pose)
a échoué de façon répétée sur de vraies vidéos : ASLR filmé au ras du sol hors du cas
d'entraînement des modèles, puis un angle de tronc à 43° sur une vidéo de profil — une valeur
que la biomécanique rend impossible. L'utilisateur choisit donc lui-même l'image et tape les
points. Ne pas réintroduire de détection auto sans données réelles prouvant que ça marche.
MediaPipe reste utilisé **uniquement** pour la segmentation de la photo frontale (silhouette
entière sur fond fixe : problème bien mieux posé que la détection de landmarks sur vidéo).

**b) Pas de fausse précision.** Le moteur distingue explicitement `[SOURCED]` (vérifié en
littérature/pratique pro) et `[DEFAULT]` (hypothèse d'ingénierie). Conséquences concrètes :
`suggestNextAdjustment` donne une **direction** ("monte la selle") mais jamais un nombre de mm,
faute de formule fiable degrés→mm ; l'inclinaison de selle, la longueur des prolongateurs,
l'écartement des coudières, la longueur de manivelle, la position de cale, la longueur de
fémur/torse sont **enregistrés et affichés mais jamais utilisés dans le scoring**, faute de
seuil sourcé. Une app concurrente (2bikefit) affiche "monte la selle de 6-12mm" — ne pas copier
ça sans source.

**c) Les plages de score ne sont pas des marges d'erreur.** `comfort_score`/`aero_score`
s'affichent avec une plage (`comfort_score_low/high`, `aero_score_low/high`) obtenue en
recalculant le score sous ±20% sur les pondérations `[DEFAULT]`. C'est une mesure de sensibilité
à des réglages non validés empiriquement, **pas** une estimation de la précision de mesure (qu'on
ne peut pas quantifier sans données). Le libellé affiché le dit explicitement — ne pas le
reformuler en "marge d'erreur".

**d) Ce qui est mesuré vs ce qui est scoré.** Sur les 3 angles du bras ajoutés récemment, seul
le poignet a un effet sur le score (via `WRIST_WARN`, déjà présent dans le moteur) ; épaule et
coude sont informatifs. Et attention au vocabulaire : ce qui est mesuré au poignet est un
**fléchissement sagittal** (visible de profil), pas la déviation ulnaire clinique (rotation hors
plan sagittal, non mesurable depuis une vue de profil) — cf. l'en-tête de `capture-processing.ts`.

**e) Cycle de vie des blob URLs.** Les images de mesure sont transférées de `measureStillUrl`
vers `measureReviews` par `finishMeasureStep()`. Un nettoyage générique les révoquait
aussitôt, ce qui cassait systématiquement l'écran de relecture. `savedStillUrlsRef` fait
exception pour ces URLs, et `retake`/`startOver`/`handleCancelMeasure` les révoquent
explicitement puisqu'eux les abandonnent vraiment. Ne pas "simplifier" ce nettoyage.

**f) Champs `deltas` optionnels.** `saddleSetbackMm`, `hasAeroBars`, `saddleTiltDeg`,
`extensionLengthMm`, `padWidthMm`, `extensionTiltDeg`, `crankLengthMm`, `cleatPositionMm` sont
optionnels **pour ne pas casser les essais déjà persistés** en localStorage. Garder l'optionalité
si des données utilisateur existent déjà. Idem `femurLengthCm`/`torsoLengthCm` sur le profil.

**g) Le formulaire de réglages est déjà jugé laborieux** (retour terrain). Les champs avancés
sont regroupés dans un panneau replié par défaut. Ne pas les remonter dans le flux principal.

---

## 7. Écarts connus, volontairement non traités

À connaître pour ne pas les prendre pour des bugs :

- **`headOffset_cm` (position de la tête, 10% du score aéro) est un stub à 0**, jamais mesuré
  (`App.jsx`, à la construction du `Trial`). Attention à l'interprétation : `headPenalty =
  min(30, |0| × 5) = 0`, donc `headScore` vaut **100, sa valeur maximale**, pour tous les essais.
  Le score aéro absolu est donc *majoré* d'un +10 constant, pas minoré — et surtout, comme cette
  contribution est identique pour tous les essais d'une session, elle **n'affecte pas le
  classement relatif** entre essais, ni le front de Pareto, ni le choix des 3 positions. Or
  c'est exactement ce à quoi le score aéro sert (comparaison intra-utilisateur, jamais une
  valeur absolue comparable à un autre coureur — cf. spec §5). Dérivable de la photo frontale
  déjà capturée (nez vs ligne d'épaules, même calibration que la pFSA) si on veut le câbler.
- **La segmentation MediaPipe n'a jamais tourné contre une vraie photo.** Le calcul de la pFSA
  est donc la seule brique du parcours dont la sortie n'a pas été vérifiée sur données réelles
  (blocage réseau du sandbox de dev, cf. README). L'ordre de grandeur attendu est **~3000-4500 cm²**
  en position aéro adulte (spec §5) : à confronter dès le premier test sur appareil réel. Si la
  valeur en sort de plusieurs ordres de grandeur, chercher du côté de la calibration (2 taps sur
  un repère de longueur connue) avant de suspecter le modèle.
- **iOS 13+ : `DeviceOrientationEvent.requestPermission()` n'est pas appelé.** L'app écoute
  `deviceorientation` directement (`PostureCaptureFlow.jsx`). Sur iOS l'événement n'arrivera
  jamais sans la demande de permission explicite : `tilt` reste `null`, et l'indicateur de niveau
  n'est simplement pas rendu. Dégradation silencieuse, pas de crash — mais pas d'indicateur de
  niveau non plus. À vérifier explicitement **sur un iPhone** à l'étape 3 du §8, pas seulement
  sur Android.
- **Amplitude de cheville** (`ankle.amplitude`) toujours à 0 : non mesurable sur 2 images fixes.
  Le warning `ankle_unstable` (seuil sourcé, 22°) ne peut donc jamais se déclencher. Décision
  documentée dans `capture-processing.ts`, et la littérature elle-même doute de la pertinence de
  l'ankling comme facteur d'efficacité.
- **Asymétrie gauche/droite** : mesurable via l'ASLR, jamais exploitée — hors scope V1 du spec.
- **`ankle_unstable` non traduit** dans `formatViolation` (App.jsx) : tomberait sur le rendu
  brut `ankle_unstable (22)`. Sans conséquence tant que (a) tient.
- **`TrendChart`** affiche les scores en point unique, pas en bandes : chantier séparé.
- **Contrôle qualité vidéo** (durée/résolution/orientation vérifiées à l'import) : identifié
  comme utile, jamais implémenté.
- **`margins`** (distance à chaque seuil) est calculé par `validateTrial` et transmis dans la
  sortie, mais **affiché nulle part** — donnée déjà disponible si l'UI veut l'exploiter.

---

## 8. Ordre d'intégration suggéré

1. Copier la logique pure (`engine/`, `capture/` moins le code mort) + ses tests, faire passer
   `npm test` dans l'app principale. Aucun risque, aucune UI.
2. Brancher les tokens de design : soit supprimer le `@theme` s'il fait doublon, soit renommer
   les utilitaires. Vérifier que les polices sont chargées.
3. Monter `PostureCaptureFlow` seul, sur un écran de test, avec `initialMode="aslr_test"` —
   c'est le composant le plus délicat (caméra, permissions, pointage) et le valider isolément
   évite de déboguer deux choses à la fois. **À tester sur un vrai téléphone**, pas seulement en
   desktop : caméra, wake lock et pointage tactile ne se vérifient pas autrement. Trois choses à
   vérifier spécifiquement à cette étape, jamais validées jusqu'ici (cf. §7) :
   - **sur un iPhone** (pas seulement Android) : l'indicateur de niveau apparaît-il ? S'il est
     absent, c'est `DeviceOrientationEvent.requestPermission()` qui manque, pas un bug d'intégration ;
   - **en `initialMode="frontal_photo"`** : la pFSA calculée tombe-t-elle dans ~3000-4500 cm² ?
     C'est le premier passage de la segmentation MediaPipe sur une vraie photo ;
   - le chargement du modèle MediaPipe lui-même (bloqué par le proxy du sandbox de dev, donc
     jamais exécuté de bout en bout).
4. Monter `App.jsx` comme écran de l'outil, ajuster `ScreenShell` au chrome de l'app principale,
   décider du point d'entrée (`welcome` ou directement `aslr-capture`).
5. Décider du sort des 4 clés localStorage (garder tel quel, ou brancher sur le backend).

Bonne pratique reprise de tout l'historique de ce repo : une commit par étape, avec
`npm run typecheck && npm test && npm run build` au vert avant chaque commit.

import { useState, useRef, useCallback, useEffect } from 'react';
import { Video, Camera, Square, RotateCcw, Check, AlertTriangle, ChevronDown, ChevronUp, Crosshair, Upload, Lock } from 'lucide-react';
import {
  computeManualAslrAngle,
  computeManualTrialPmh,
  computeManualTrialPmb,
  buildManualTrialAngles,
  KNEE_STRAIGHT_THRESHOLD,
} from '../capture/capture-processing';

// posture-capture-flow.jsx
// Flux de capture réel (caméra du téléphone) pour les entrées du pipeline §2 du spec :
//   A. vidéo profil (angles articulaires) — mesure MANUELLE en 2 images (point mort haut /
//      point mort bas), voir MANUAL_MEASURE_STEPS ci-dessous
//   B. photo frontale + étalonnage par 2 taps (pFSA)
//   C. test de souplesse ASLR — mesure MANUELLE en 1 image (jambe la plus haute)
//
// A et C partagent le même mécanisme générique (MANUAL_MEASURE_STEPS + screens 'review' puis
// 'measure') : l'utilisateur choisit lui-même la ou les images significatives dans sa propre
// vidéo et touche quelques points dessus — pas de détection automatique. Retour terrain
// (10-11/08/2026) : la détection auto MediaPipe a échoué de façon répétée, d'abord sur l'ASLR
// (sujet allongé au sol, filmé de loin/au ras du sol — hors du cas standard "personne debout,
// cadrée serré"), puis sur la vidéo profil elle-même (un essai réel a donné un angle de tronc
// de 43°, clairement faux). Plutôt que de continuer à durcir un pipeline auto peu fiable,
// l'utilisateur mesure lui-même pour les deux — cf. capture-processing.ts
// (computeManualAslrAngle / computeManualTrialPmh / computeManualTrialPmb) pour la géométrie.
//
// Pour B (frontal_photo), ce composant s'arrête à la capture + étalonnage : il appelle
// `onCaptured({ mode, blob, meta, calibration })` puis rend la main à l'appelant, qui pilote
// l'inférence de segmentation (App.jsx, via segmentation-integration.ts) — seule étape qui
// utilise encore un modèle ML, la segmentation d'une silhouette entière sur fond fixe étant un
// problème bien mieux posé que la détection de landmarks sur une vidéo. Pour A et C, ce
// composant va jusqu'au bout de la mesure lui-même : `onCaptured({ mode: 'aslr_test', angle,
// kneeAngle })` ou `onCaptured({ mode: 'profile_video', angles })` (déjà au format TrialAngles
// attendu par le moteur) — pas de blob, pas de pipeline ML à exécuter côté appelant.
//
// Point d'incertitude non résolu (cf. HANDOFF_CLAUDE_CODE.md, tâche 2) : le niveau/tilt
// (DeviceOrientationEvent) peut nécessiter DeviceOrientationEvent.requestPermission() sur
// iOS 13+, non géré ici — dégradation silencieuse (pas d'indicateur) plutôt que crash si
// l'event n'arrive jamais sur ces appareils. Le capteur n'étant pas forcément calé sur 0°
// à la verticale (retour terrain : ~20° d'écart constaté sur un appareil réel), l'indicateur
// de niveau est tappable pour caler manuellement un zéro (voir tiltOffset/calibrateLevel).

const MODES = {
  profile_video: {
    label: 'vidéo profil',
    checklist: [
      'Caméra fixe (support/trépied), vue de profil, dans l\u2019axe du vélo',
      'Recul d\u2019environ 3-4 m, caméra à hauteur de hanche (ni au sol ni en hauteur, ça fausse les angles)',
      'Cadrage : vélo + corps entier visibles',
      'Même réglage vélo qu\u2019à l\u2019essai précédent si tu compares',
      'Pédale à rythme modéré, plusieurs tours complets (au moins 5) : tu choisiras ensuite 2 images (pédale en haut, pédale en bas) pour mesurer les angles toi-même',
    ],
  },
  frontal_photo: {
    label: 'photo frontale',
    checklist: [
      'Caméra dans l\u2019axe du vélo, vue de face',
      'Recul d\u2019au moins 5 m (sinon la mesure de surface est faussée)',
      'Un repère de longueur connue visible (ex. largeur de cintre), au même plan que toi, pour l\u2019étalonnage',
      'Position immobile au moment de la photo, dans ta position aéro habituelle',
    ],
  },
  aslr_test: {
    label: 'test souplesse (ASLR)',
    checklist: [
      'Allongé sur le dos, téléphone au sol/sur un support, vue de côté (sagittale)',
      'Filme en mode paysage (téléphone à l\u2019horizontale) : plus de largeur pour te voir de près sans avoir à reculer autant',
      'Jambe non testée : garde-la tendue et bien à plat au sol pendant tout le test (sinon la mesure est faussée)',
      'Cadrage : hanche, jambe testée ET pied entièrement visibles même en haut de la levée — rapproche-toi le plus possible sans sortir du cadre, plus tu es grand dans l\u2019image plus la mesure est fiable',
      'Reste dans la même pièce que le téléphone (pas filmé depuis une pièce voisine ou par une porte), et évite le contre-jour (pas de fenêtre/lumière vive juste derrière toi)',
      'Jambe testée tendue, genou verrouillé',
      'Lève la jambe le plus haut possible sans plier le genou — arrête-toi si ça tire ou fait mal',
    ],
  },
};

const VIDEO_MODES = new Set(['profile_video', 'aslr_test']);

// Import-first pour les 3 modes, pas juste la vidéo : au départ seule la vidéo était
// concernée (MediaRecorder capricieux), mais avoir la photo se comporter différemment
// (caméra live d'emblée) sans raison visible pour l'utilisateur était incohérent — retour
// d'audit ergonomique. La checklist reste utile à lire avant de dégainer l'appareil photo
// natif, quel que soit le type de média.
const IMPORT_FIRST_MODES = new Set(['profile_video', 'aslr_test', 'frontal_photo']);

// Configuration des étapes de mesure manuelle par mode — chaque étape correspond à UNE image
// que l'utilisateur choisit dans sa vidéo (via l'écran 'review', bouton `pickButtonLabel`) puis
// tape `pointLabels.length` points dessus (écran 'measure', dans cet ordre). `compute` calcule
// le résultat de l'étape à partir des points tapés (voir capture-processing.ts). Les modes
// absents de cet objet (frontal_photo) gardent l'ancien flux caméra -> review -> finish().
const MANUAL_MEASURE_STEPS = {
  aslr_test: [
    {
      key: 'raise',
      frameInstruction: "Utilise les contrôles pour trouver l'image où ta jambe testée est le plus haut, genou tendu.",
      pickButtonLabel: 'Choisir cette image',
      pointLabels: ['hanche', 'genou', 'cheville'],
      compute: (pts) => computeManualAslrAngle(pts[0], pts[1], pts[2]),
    },
  ],
  profile_video: [
    {
      key: 'pmh',
      frameInstruction: "Trouve l'image où la pédale du côté filmé est tout en haut (point mort haut) : cuisse la plus proche du buste.",
      pickButtonLabel: 'Choisir cette image (point haut)',
      pointLabels: ['épaule', 'hanche', 'genou'],
      compute: (pts) => computeManualTrialPmh(pts[0], pts[1], pts[2]),
    },
    {
      key: 'pmb',
      frameInstruction: "Trouve l'image où la pédale du côté filmé est tout en bas (point mort bas) : jambe la plus tendue.",
      pickButtonLabel: 'Choisir cette image (point bas)',
      pointLabels: ['hanche', 'genou', 'cheville'],
      compute: (pts) => computeManualTrialPmb(pts[0], pts[1], pts[2]),
    },
  ],
};

// Assemble le résultat final envoyé à onCaptured à partir des résultats de chaque étape
// (dans l'ordre de MANUAL_MEASURE_STEPS[mode]).
const MANUAL_MEASURE_FINALIZE = {
  aslr_test: (results) => ({ angle: results[0].angle, kneeAngle: results[0].kneeAngle }),
  profile_video: (results) => ({ angles: buildManualTrialAngles(results[0], results[1]) }),
};

// Mémorise la longueur du repère d'étalonnage (ex. largeur de cintre) d'une capture à
// l'autre — c'est en général toujours le même repère, pas la peine de le retaper.
const REF_LENGTH_STORAGE_KEY = 'posture-aero-ref-length-cm';

function loadStoredRefLength() {
  try {
    return localStorage.getItem(REF_LENGTH_STORAGE_KEY) ?? '40';
  } catch {
    return '40';
  }
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 100);
  return `${String(s).padStart(2, '0')}.${cs}s`;
}

function PrivacyNote({ className = '' }) {
  return (
    <div className={`flex items-center gap-1.5 text-[11px] text-neutral-600 ${className}`}>
      <Lock className="w-3 h-3 shrink-0" />
      <span>Traité sur ton téléphone, rien n'est envoyé en ligne</span>
    </div>
  );
}

function ChecklistPanel({ mode, open, onToggle }) {
  return (
    <div className="bg-neutral-900 border-t border-neutral-800">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-neutral-400 focus:outline-none">
        <span className="tracking-wide uppercase" style={{ fontFamily: 'ui-monospace, monospace' }}>
          Checklist · {MODES[mode].label}
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <ul className="px-4 pb-3 space-y-1.5">
          {MODES[mode].checklist.map((item, i) => (
            <li key={i} className="text-xs text-neutral-300 flex gap-2">
              <span className="text-amber-400 shrink-0">·</span>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PostureCaptureFlow({ onCaptured, initialMode, onCancel }) {
  const [screen, setScreen] = useState('intro'); // intro | camera | review | calibrate | measure
  const [mode, setMode] = useState(initialMode ?? null);
  const [error, setError] = useState(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [capturedUrl, setCapturedUrl] = useState(null);
  const [capturedMeta, setCapturedMeta] = useState(null);
  const [checklistOpen, setChecklistOpen] = useState(true);
  const [taps, setTaps] = useState([]);
  const [refLengthCm, setRefLengthCm] = useState(loadStoredRefLength);
  const [tilt, setTilt] = useState(null);
  const [tiltOffset, setTiltOffset] = useState(0);
  const [captureUi, setCaptureUi] = useState('import'); // 'import' | 'live'
  // Mesure manuelle générique (screen 'measure', cf. MANUAL_MEASURE_STEPS) : image fixe
  // choisie dans la vidéo pour l'étape courante + points tapés dessus — indépendant de
  // `taps`/`capturedUrl` qui servent à l'étalonnage de la photo frontale.
  const [measureStepIndex, setMeasureStepIndex] = useState(0);
  const [measureStillUrl, setMeasureStillUrl] = useState(null);
  const [measureStillSize, setMeasureStillSize] = useState(null);
  const [measurePoints, setMeasurePoints] = useState([]);
  const [measureResults, setMeasureResults] = useState([]); // résultats des étapes déjà validées

  const videoRef = useRef(null);
  const reviewVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const capturedBlobRef = useRef(null);
  const wakeLockRef = useRef(null);

  const manualSteps = MANUAL_MEASURE_STEPS[mode] ?? [];
  const currentMeasureStep = manualSteps[measureStepIndex] ?? null;
  const measureMaxPoints = currentMeasureStep?.pointLabels.length ?? 0;
  const measureResult = currentMeasureStep && measurePoints.length === measureMaxPoints ? currentMeasureStep.compute(measurePoints) : null;

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // Best-effort : évite que le téléphone se verrouille pendant un enregistrement (retour
  // terrain — un verrouillage en pleine capture coupe/corrompt la vidéo). API non supportée
  // partout (ex. anciens navigateurs) : échec silencieux, la capture reste utilisable.
  const acquireWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = await navigator.wakeLock?.request('screen');
    } catch {
      // ignoré : best-effort
    }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    releaseWakeLock();
  }, [releaseWakeLock]);

  useEffect(() => () => { stopStream(); clearInterval(timerRef.current); }, [stopStream]);

  useEffect(() => {
    try {
      localStorage.setItem(REF_LENGTH_STORAGE_KEY, refLengthCm);
    } catch {
      // ignoré : pas bloquant si le stockage est indisponible
    }
  }, [refLengthCm]);

  // Le wake lock est automatiquement relâché par le navigateur quand l'onglet passe en
  // arrière-plan (ex. notification, changement d'appli) — on le redemande au retour si la
  // caméra est toujours active, sinon le verrouillage peut se reproduire après coup.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && screen === 'camera' && streamRef.current) {
        acquireWakeLock();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [screen, acquireWakeLock]);

  useEffect(() => {
    function onOrientation(e) {
      if (typeof e.gamma === 'number') setTilt(e.gamma);
    }
    window.addEventListener('deviceorientation', onOrientation);
    return () => window.removeEventListener('deviceorientation', onOrientation);
  }, []);

  // Pour les 3 modes, l'enregistrement natif (appli caméra/photo du téléphone) est bien
  // plus fiable que ce que le navigateur propose — c'est justement la source de la plupart
  // des bugs réels rencontrés côté vidéo (webm sans index de seek, écran qui se verrouille,
  // permissions capricieuses). Par défaut on n'ouvre donc PAS la caméra du navigateur : on
  // affiche direct la checklist + un bouton d'import. `live: true` force l'ancien
  // comportement (capturer directement dans l'appli), gardé en repli pour qui préfère.
  const startCamera = useCallback(async (m, { live = false } = {}) => {
    setError(null);
    setMode(m);
    if (IMPORT_FIRST_MODES.has(m) && !live) {
      setChecklistOpen(true);
      setCaptureUi('import');
      setScreen('camera');
      return;
    }
    // Vue caméra live : la checklist a déjà été lue sur l'écran d'import précédent (ou
    // n'a jamais servi à rien pour ce mode) — on la replie par défaut pour laisser toute
    // la place à l'aperçu (réticule + niveau), qui compte le plus au moment de cadrer.
    setChecklistOpen(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCaptureUi('live');
      setScreen('camera');
      // srcObject assigné après le rendu (voir effect ci-dessous)
      acquireWakeLock();
    } catch (e) {
      const msg =
        e && e.name === 'NotAllowedError'
          ? 'Accès caméra refusé. Autorise la caméra dans les réglages du navigateur pour continuer.'
          : 'La caméra n\u2019a pas pu s\u2019activer sur cet appareil. Réessaie, ou importe une vidéo/photo déjà prise.';
      setError(msg);
      setScreen('camera');
    }
  }, [acquireWakeLock]);

  const startLiveCapture = () => startCamera(mode, { live: true });

  // Dépend aussi de captureUi, pas seulement de screen : pendant l'étape import (checklist
  // + bouton d'import), screen vaut déjà 'camera' — passer en capture directe ne fait
  // basculer que captureUi ('import' -> 'live'), pas screen. Sans cette dépendance, l'effet
  // ne se redéclenchait jamais : le <video> se montait bien mais sans flux attaché (aperçu
  // noir, "ne marche pas").
  useEffect(() => {
    if (screen === 'camera' && captureUi === 'live' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [screen, captureUi]);

  // Si initialMode est fourni, l'appelant pilote la séquence de capture (App.jsx) :
  // on saute l'écran de choix et on démarre directement la caméra pour ce mode.
  useEffect(() => {
    if (initialMode) startCamera(initialMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode]);

  const startRecording = () => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const mimeType = window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const mr = new MediaRecorder(streamRef.current, { mimeType });
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      capturedBlobRef.current = blob;
      setCapturedUrl(URL.createObjectURL(blob));
      setCapturedMeta({ type: 'video', sizeKb: Math.round(blob.size / 1024), durationMs: elapsedMs });
      setScreen('review');
    };
    mediaRecorderRef.current = mr;
    mr.start();
    setRecording(true);
    setElapsedMs(0);
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    clearInterval(timerRef.current);
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      capturedBlobRef.current = blob;
      setCapturedUrl(URL.createObjectURL(blob));
      setCapturedMeta({ type: 'photo', sizeKb: Math.round(blob.size / 1024), width: canvas.width, height: canvas.height });
      setTaps([]);
      setScreen('calibrate');
    }, 'image/jpeg', 0.92);
  };

  // Import depuis la galerie — utile si la caméra intégrée est capricieuse (retour
  // terrain) ou pour réutiliser une vidéo/photo déjà prise avec l'appli caméra native,
  // plus fiable sur certains téléphones que l'enregistrement direct dans le navigateur.
  const importVideo = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      capturedBlobRef.current = file;
      setCapturedUrl(url);
      setCapturedMeta({ type: 'video', sizeKb: Math.round(file.size / 1024), durationMs: Math.round(probe.duration * 1000) });
      setScreen('review');
    };
    // Échec réel de décodage (format non supporté par ce navigateur, ex. certains .mov) —
    // mieux vaut le dire clairement que de laisser passer un fichier illisible plus loin.
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      setError('Cette vidéo ne peut pas être lue par ce navigateur (format non supporté). Essaie de la réexporter en .mp4 ou .mov standard, ou filme directement dans l’appli.');
    };
    probe.src = url;
  };

  const importPhoto = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (canvasRef.current) {
        canvasRef.current.width = img.naturalWidth;
        canvasRef.current.height = img.naturalHeight;
      }
      capturedBlobRef.current = file;
      setCapturedUrl(url);
      setCapturedMeta({ type: 'photo', sizeKb: Math.round(file.size / 1024), width: img.naturalWidth, height: img.naturalHeight });
      setTaps([]);
      setScreen('calibrate');
    };
    img.src = url;
  };

  const retake = () => {
    // Reprendre la capture entière invalide toute progression de mesure déjà faite (les
    // images choisies venaient de l'ancienne vidéo) — repart de l'étape 0.
    setCapturedUrl(null);
    setCapturedMeta(null);
    setTaps([]);
    setMeasureStepIndex(0);
    setMeasureResults([]);
    setMeasureStillUrl(null);
    setMeasureStillSize(null);
    setMeasurePoints([]);
    setScreen('camera');
  };

  const handleCalibrationTap = (e) => {
    if (taps.length >= 2 || !canvasRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvasRef.current.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvasRef.current.height;
    setTaps((prev) => [...prev, { x, y }]);
  };

  const pixelLength = taps.length === 2 ? Math.hypot(taps[1].x - taps[0].x, taps[1].y - taps[0].y) : null;
  const cmPerPixel = pixelLength && refLengthCm ? Number(refLengthCm) / pixelLength : null;

  const finish = () => {
    stopStream();
    onCaptured?.({
      mode,
      blob: capturedBlobRef.current,
      meta: capturedMeta,
      calibration: pixelLength ? { pixelLength, realLengthCm: Number(refLengthCm) } : null,
    });
  };

  // Étape de mesure manuelle en cours (ASLR ou vidéo profil) : au lieu de "Valider" la vidéo
  // entière (finish), on fige l'image affichée à l'instant où l'utilisateur a mis pause/navigué
  // avec les contrôles natifs du <video> — c'est à lui de trouver le bon moment (jambe la plus
  // haute pour l'ASLR, point mort haut/bas pour la vidéo profil), pas à un modèle de détecter
  // automatiquement.
  const captureMeasureFrame = () => {
    const video = reviewVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      setMeasureStillUrl(URL.createObjectURL(blob));
      setMeasureStillSize({ width: canvas.width, height: canvas.height });
      setMeasurePoints([]);
      setScreen('measure');
    }, 'image/jpeg', 0.92);
  };

  const handleMeasureTap = (e) => {
    if (measurePoints.length >= measureMaxPoints || !measureStillSize) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * measureStillSize.width;
    const y = ((e.clientY - rect.top) / rect.height) * measureStillSize.height;
    setMeasurePoints((prev) => [...prev, { x, y }]);
  };

  // Revenir choisir une autre image pour l'étape en cours (pas un redémarrage complet — la
  // vidéo source et les étapes déjà validées restent intactes).
  const backToReview = () => {
    setMeasurePoints([]);
    setScreen('review');
  };

  const finishMeasureStep = () => {
    if (!measureResult) return;
    const allResults = [...measureResults, measureResult];
    if (measureStepIndex + 1 < manualSteps.length) {
      // Étape suivante (ex. ASLR: aucune ; vidéo profil : PMH -> PMB) : retour à l'écran de
      // review pour choisir la prochaine image, sur la même vidéo déjà capturée.
      setMeasureResults(allResults);
      setMeasureStepIndex((i) => i + 1);
      setMeasurePoints([]);
      setMeasureStillUrl(null);
      setMeasureStillSize(null);
      setScreen('review');
      return;
    }
    stopStream();
    onCaptured?.({ mode, ...MANUAL_MEASURE_FINALIZE[mode](allResults) });
  };

  const startOver = () => {
    setCapturedUrl(null);
    setCapturedMeta(null);
    setTaps([]);
    setMeasureStepIndex(0);
    setMeasureResults([]);
    setMeasureStillUrl(null);
    setMeasureStillSize(null);
    setMeasurePoints([]);
    setMode(null);
    setError(null);
    setScreen('intro');
  };

  // Le capteur d'inclinaison n'est pas forcément calé sur 0 quand le téléphone est vertical
  // (ça varie d'un appareil à l'autre) — d'où le décalage manuel réglé via calibrateLevel().
  const displayedTilt = tilt === null ? null : tilt - tiltOffset;
  const isLevelOk = displayedTilt === null || Math.abs(displayedTilt) < 4;
  const calibrateLevel = () => { if (tilt !== null) setTiltOffset(tilt); };

  return (
    <div className="w-full h-full min-h-screen bg-neutral-950 text-neutral-100 flex flex-col" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <canvas ref={canvasRef} className="hidden" />

      {screen === 'intro' && (
        <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full">
          <div className="mb-8">
            <div className="text-xs tracking-widest text-amber-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
              Capture posture · aéro
            </div>
            <h1 className="text-2xl font-semibold text-neutral-100 leading-snug">Choisis ta capture</h1>
            <p className="text-neutral-400 text-sm mt-1">Deux entrées nécessaires pour scorer un essai.</p>
          </div>

          <button
            onClick={() => startCamera('profile_video')}
            className="group text-left rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-3 hover:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Video className="w-5 h-5 text-amber-400 shrink-0" />
              <div>
                <div className="font-medium text-neutral-100">Vidéo profil</div>
                <div className="text-xs text-neutral-400 mt-0.5">Angles articulaires sur le cycle de pédalage</div>
              </div>
            </div>
          </button>

          <button
            onClick={() => startCamera('frontal_photo')}
            className="group text-left rounded-lg border border-neutral-800 bg-neutral-900 p-4 hover:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Camera className="w-5 h-5 text-cyan-400 shrink-0" />
              <div>
                <div className="font-medium text-neutral-100">Photo frontale</div>
                <div className="text-xs text-neutral-400 mt-0.5">Surface frontale (pFSA), avec étalonnage</div>
              </div>
            </div>
          </button>

          <p className="text-neutral-500 text-xs mt-8 leading-relaxed">
            L’étalonnage de la photo frontale se fait par 2 points touchés directement sur l’image, pas de repère automatique en V1.
          </p>
        </div>
      )}

      {screen === 'camera' && (
        <div className="flex-1 relative flex flex-col">
          {error ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
              <AlertTriangle className="w-8 h-8 text-red-400 mb-3" />
              <p className="text-neutral-200 text-sm max-w-xs">{error}</p>
              <button onClick={startOver} className="mt-6 text-sm text-amber-400 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded">
                Retour
              </button>
            </div>
          ) : IMPORT_FIRST_MODES.has(mode) && captureUi === 'import' ? (
            <>
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center bg-black">
                {VIDEO_MODES.has(mode) ? (
                  <>
                    <Video className="w-9 h-9 text-neutral-700 mb-4" />
                    <p className="text-neutral-300 text-sm max-w-xs leading-relaxed">
                      Filme {MODES[mode].label} avec l'appli caméra de ton téléphone en suivant la checklist ci-dessous,
                      puis importe le fichier ici.
                    </p>
                  </>
                ) : (
                  <>
                    <Camera className="w-9 h-9 text-neutral-700 mb-4" />
                    <p className="text-neutral-300 text-sm max-w-xs leading-relaxed">
                      Prends {MODES[mode].label} avec l'appli photo de ton téléphone en suivant la checklist ci-dessous,
                      puis importe le fichier ici.
                    </p>
                  </>
                )}
              </div>

              <ChecklistPanel mode={mode} open={checklistOpen} onToggle={() => setChecklistOpen((v) => !v)} />

              <div className="bg-black px-6 py-5 flex flex-col items-center gap-3">
                <label className="w-full flex items-center justify-center gap-2 py-3.5 rounded-lg bg-amber-400 text-neutral-950 font-medium cursor-pointer focus-within:ring-2 focus-within:ring-amber-200">
                  <Upload className="w-4 h-4" />
                  {VIDEO_MODES.has(mode) ? 'Choisir la vidéo' : 'Choisir la photo'}
                  <input
                    type="file"
                    accept={VIDEO_MODES.has(mode) ? 'video/*' : 'image/*'}
                    className="hidden"
                    onChange={VIDEO_MODES.has(mode) ? importVideo : importPhoto}
                  />
                </label>
                <button
                  onClick={startLiveCapture}
                  className="text-xs text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded px-1"
                >
                  {VIDEO_MODES.has(mode) ? "Filmer directement dans l'appli" : 'Prendre la photo maintenant dans l’appli'}
                </button>
                {onCancel && (
                  <button
                    onClick={onCancel}
                    className="text-xs text-neutral-600 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded px-1"
                  >
                    Annuler
                  </button>
                )}
                <PrivacyNote className="pt-2" />
              </div>
            </>
          ) : (
            <>
              <div className="relative flex-1 overflow-hidden bg-black">
                <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />

                {/* Réticule — élément signature : alignement optique + niveau */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: 'rgba(232,230,225,0.18)', transform: 'translateX(-0.5px)' }} />
                  <div className="absolute top-1/2 left-0 right-0 h-px" style={{ background: 'rgba(232,230,225,0.18)', transform: 'translateY(-0.5px)' }} />
                  <div
                    className="absolute left-1/2 top-1/2 w-14 h-14 rounded-full border"
                    style={{ borderColor: 'rgba(232,230,225,0.35)', transform: 'translate(-50%,-50%)' }}
                  />
                  {/* Indicateur de niveau (best-effort, se cache si le capteur n'est pas dispo) */}
                  {displayedTilt !== null && (
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-auto">
                      <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-black/50" style={{ fontFamily: 'ui-monospace, monospace' }}>
                        <div className={`w-1.5 h-1.5 rounded-full ${isLevelOk ? 'bg-cyan-400' : 'bg-red-400'}`} />
                        <span className="text-[11px] text-neutral-200">{isLevelOk ? 'niveau ok' : `inclinaison ${displayedTilt.toFixed(0)}°`}</span>
                      </div>
                      <button
                        onClick={calibrateLevel}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-400 text-neutral-950 text-xs font-medium shadow-lg focus:outline-none focus:ring-2 focus:ring-amber-200"
                        aria-label="Calibrer le niveau : tiens le téléphone bien droit puis touche ce bouton"
                      >
                        <Crosshair className="w-3.5 h-3.5" />
                        Caler le niveau ici
                      </button>
                    </div>
                  )}
                </div>

                {recording && (
                  <div className="absolute top-4 right-4 flex items-center gap-2 px-2.5 py-1 rounded-full bg-black/60">
                    <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                    <span className="text-xs text-neutral-100" style={{ fontFamily: 'ui-monospace, monospace' }}>{formatElapsed(elapsedMs)}</span>
                  </div>
                )}
              </div>

              <ChecklistPanel mode={mode} open={checklistOpen} onToggle={() => setChecklistOpen((v) => !v)} />

              {/* Contrôles */}
              <div className="bg-black px-6 py-5 flex flex-col items-center justify-center gap-3">
                {VIDEO_MODES.has(mode) ? (
                  recording ? (
                    <button
                      onClick={stopRecording}
                      className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-red-300 ring-offset-2 ring-offset-black"
                      aria-label="Arrêter l'enregistrement"
                    >
                      <Square className="w-5 h-5 text-white" fill="white" />
                    </button>
                  ) : (
                    <button
                      onClick={startRecording}
                      className="w-16 h-16 rounded-full border-4 border-neutral-200 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-amber-400 ring-offset-2 ring-offset-black"
                      aria-label="Démarrer l'enregistrement"
                    >
                      <span className="w-12 h-12 rounded-full bg-red-500" />
                    </button>
                  )
                ) : (
                  <button
                    onClick={capturePhoto}
                    className="w-16 h-16 rounded-full border-4 border-neutral-200 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-cyan-400 ring-offset-2 ring-offset-black"
                    aria-label="Prendre la photo"
                  >
                    <span className="w-12 h-12 rounded-full bg-neutral-100" />
                  </button>
                )}
                {onCancel && !recording && (
                  <button
                    onClick={onCancel}
                    className="text-xs text-neutral-600 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded px-1"
                  >
                    Annuler
                  </button>
                )}
                {!recording && <PrivacyNote />}
              </div>
            </>
          )}
        </div>
      )}

      {screen === 'review' && (
        <div className="flex-1 flex flex-col">
          {currentMeasureStep && (
            <div className="px-6 py-3 bg-neutral-900 border-b border-neutral-800">
              {manualSteps.length > 1 && (
                <p className="text-xs text-amber-400 uppercase tracking-wide mb-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
                  Étape {measureStepIndex + 1}/{manualSteps.length}
                </p>
              )}
              <p className="text-sm text-neutral-200">{currentMeasureStep.frameInstruction}</p>
            </div>
          )}
          <div className="flex-1 bg-black flex items-center justify-center">
            <video ref={reviewVideoRef} src={capturedUrl} controls playsInline className="max-w-full max-h-full" />
          </div>
          <div className="bg-neutral-900 border-t border-neutral-800 px-6 py-4 space-y-3">
            <div className="text-xs text-neutral-400" style={{ fontFamily: 'ui-monospace, monospace' }}>
              {capturedMeta && `${(capturedMeta.durationMs / 1000).toFixed(1)}s · ${capturedMeta.sizeKb} Ko`}
            </div>
            <div className="flex gap-3">
              <button onClick={retake} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
                <RotateCcw className="w-4 h-4" /> Reprendre
              </button>
              {currentMeasureStep ? (
                <button onClick={captureMeasureFrame} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200">
                  <Check className="w-4 h-4" /> {currentMeasureStep.pickButtonLabel}
                </button>
              ) : (
                <button onClick={finish} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200">
                  <Check className="w-4 h-4" /> Valider
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {screen === 'measure' && currentMeasureStep && (
        <div className="flex-1 flex flex-col">
          <div className="px-6 py-3 bg-neutral-900 border-b border-neutral-800">
            <p className="text-sm text-neutral-200">
              Touche {measureMaxPoints} points dans l'ordre : {currentMeasureStep.pointLabels.join(' → ')}.
            </p>
            <p className="text-xs text-neutral-500 mt-1">
              {measurePoints.length}/{measureMaxPoints} points placés
              {currentMeasureStep.pointLabels[measurePoints.length] ? ` · prochain : ${currentMeasureStep.pointLabels[measurePoints.length]}` : ''}
            </p>
          </div>

          <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
            <img
              src={measureStillUrl}
              alt="Image choisie pour la mesure"
              onClick={handleMeasureTap}
              className="max-w-full max-h-full cursor-crosshair"
            />
            {measureStillSize && measurePoints.map((p, i) => (
              <div
                key={i}
                className="absolute flex flex-col items-center pointer-events-none"
                style={{
                  left: `${(p.x / measureStillSize.width) * 100}%`,
                  top: `${(p.y / measureStillSize.height) * 100}%`,
                  transform: 'translate(-50%,-50%)',
                }}
              >
                <div className="w-3 h-3 rounded-full bg-cyan-400 border-2 border-neutral-950" />
                <span className="mt-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-cyan-200 whitespace-nowrap">
                  {currentMeasureStep.pointLabels[i]}
                </span>
              </div>
            ))}
          </div>

          <div className="bg-neutral-900 border-t border-neutral-800 px-6 py-4 space-y-3">
            {measureResult && (
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3 space-y-1">
                {currentMeasureStep.key === 'raise' && (
                  <>
                    <div className="text-2xl font-semibold text-cyan-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {measureResult.angle}°
                    </div>
                    <p className="text-xs text-neutral-500">
                      {measureResult.kneeAngle < KNEE_STRAIGHT_THRESHOLD
                        ? `Genou mesuré à ${measureResult.kneeAngle}° — il a l'air plié sur cette image. Essaie une image où la jambe testée est bien tendue.`
                        : `Genou mesuré à ${measureResult.kneeAngle}° (bien tendu).`}
                    </p>
                  </>
                )}
                {currentMeasureStep.key === 'pmh' && (
                  <>
                    <div className="text-2xl font-semibold text-amber-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      Hanche {measureResult.hipAngle}°
                    </div>
                    <div className="text-sm text-neutral-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      Tronc {measureResult.trunkAngle}°
                    </div>
                  </>
                )}
                {currentMeasureStep.key === 'pmb' && (
                  <div className="text-2xl font-semibold text-amber-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
                    Genou {measureResult.kneeAngle}°
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setMeasurePoints([])} disabled={measurePoints.length === 0} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border border-neutral-700 text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-400">
                <RotateCcw className="w-4 h-4" /> Recommencer
              </button>
              <button onClick={backToReview} className="flex-1 py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
                Changer d'image
              </button>
            </div>
            <button
              onClick={finishMeasureStep}
              disabled={!measureResult}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-200"
            >
              <Check className="w-4 h-4" /> {measureStepIndex + 1 < manualSteps.length ? 'Valider et passer à l’étape suivante' : 'Valider la mesure'}
            </button>
            {onCancel && (
              <button onClick={onCancel} className="w-full text-xs text-neutral-600 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded px-1">
                Annuler
              </button>
            )}
          </div>
        </div>
      )}

      {screen === 'calibrate' && (
        <div className="flex-1 flex flex-col">
          <div className="px-6 py-3 bg-neutral-900 border-b border-neutral-800">
            <p className="text-sm text-neutral-200">
              Touche 2 points correspondant à une longueur connue (ex. les deux extrémités du cintre).
            </p>
            <p className="text-xs text-neutral-500 mt-1">{taps.length}/2 points placés</p>
          </div>

          <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
            <img
              src={capturedUrl}
              alt="Photo frontale capturée"
              onClick={handleCalibrationTap}
              className="max-w-full max-h-full cursor-crosshair"
            />
            {/* Marqueurs de taps, positionnés en % relatif à l'image affichée */}
            {capturedMeta && taps.map((t, i) => (
              <div
                key={i}
                className="absolute w-3 h-3 rounded-full bg-cyan-400 border-2 border-neutral-950 pointer-events-none"
                style={{
                  left: `${(t.x / capturedMeta.width) * 100}%`,
                  top: `${(t.y / capturedMeta.height) * 100}%`,
                  transform: 'translate(-50%,-50%)',
                }}
              />
            ))}
          </div>

          <div className="bg-neutral-900 border-t border-neutral-800 px-6 py-4 space-y-3">
            <label className="flex items-center gap-3 text-sm text-neutral-200">
              Longueur réelle du repère (cm)
              <input
                type="number"
                value={refLengthCm}
                onChange={(e) => setRefLengthCm(e.target.value)}
                className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </label>

            {pixelLength && (
              <div className="text-xs text-neutral-400" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {pixelLength.toFixed(0)}px mesurés · {cmPerPixel?.toFixed(3)} cm/px
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={retake} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
                <RotateCcw className="w-4 h-4" /> Reprendre
              </button>
              <button
                onClick={finish}
                disabled={taps.length < 2}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg bg-cyan-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-cyan-200"
              >
                <Check className="w-4 h-4" /> Valider l'étalonnage
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

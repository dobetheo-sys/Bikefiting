import { useState, useCallback } from 'react';
import { RotateCcw, Loader2, AlertTriangle } from 'lucide-react';
import PostureCaptureFlow from './components/PostureCaptureFlow.jsx';
import { getVisionFileset } from './capture/mediapipe-vision';
import { createBikeFitSegmenter, toBikeFitBinaryMask } from './capture/segmentation-integration';
import { createBikeFitPoseLandmarker, toPoseFrame } from './capture/pose-integration';
import { sampleVideoFrames } from './capture/video-frame-sampler';
import { computePFSA_cm2, extractTrialAngles } from './capture/capture-processing';

// App.jsx — orchestre la capture (PostureCaptureFlow) et l'inférence réelle
// (MediaPipe ImageSegmenter / PoseLandmarker), et affiche les métriques brutes
// obtenues (angles articulaires, pFSA). Ne fait PAS tourner le moteur
// posture-aero-engine.ts (validation/score/Pareto) : ça nécessite plusieurs essais
// + un profil athlète (test ASLR, etc.), hors scope de cette étape — cf. §6/§7 du
// spec pour la suite.

const POSE_SAMPLE_COUNT = 30; // frames échantillonnées sur la vidéo profil

async function processFrontalPhoto(blob, calibration) {
  const fileset = await getVisionFileset();
  const segmenter = await createBikeFitSegmenter(fileset);
  try {
    const bitmap = await createImageBitmap(blob);
    const segResult = segmenter.segment(bitmap);
    const mask = toBikeFitBinaryMask(segResult);
    return { pfsaCm2: computePFSA_cm2(mask, calibration) };
  } finally {
    segmenter.close();
  }
}

async function processProfileVideo(blob) {
  const fileset = await getVisionFileset();
  const landmarker = await createBikeFitPoseLandmarker(fileset);
  try {
    const frames = [];
    await sampleVideoFrames(blob, POSE_SAMPLE_COUNT, ({ video, timestampMs }) => {
      const result = landmarker.detectForVideo(video, timestampMs);
      const frame = toPoseFrame(result, timestampMs);
      if (frame) frames.push(frame);
    });
    if (frames.length === 0) {
      throw new Error("Aucune pose détectée sur la vidéo — vérifie le cadrage (corps entier visible) et l'éclairage.");
    }
    return { angles: extractTrialAngles(frames), framesUsed: frames.length, framesSampled: POSE_SAMPLE_COUNT };
  } finally {
    landmarker.close();
  }
}

export default function App() {
  const [captureKey, setCaptureKey] = useState(0);
  const [status, setStatus] = useState('capture'); // capture | loading-models | processing | result | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleCaptured = useCallback(async (payload) => {
    if (!payload.blob) {
      setError("Capture invalide : aucune donnée n'a pu être récupérée.");
      setStatus('error');
      return;
    }
    setStatus('loading-models');
    try {
      setStatus('processing');
      if (payload.mode === 'frontal_photo') {
        if (!payload.calibration) throw new Error('Étalonnage manquant (2 points requis).');
        const { pfsaCm2 } = await processFrontalPhoto(payload.blob, payload.calibration);
        setResult({ mode: 'frontal_photo', pfsaCm2, meta: payload.meta });
      } else {
        const { angles, framesUsed, framesSampled } = await processProfileVideo(payload.blob);
        setResult({ mode: 'profile_video', angles, framesUsed, framesSampled, meta: payload.meta });
      }
      setStatus('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  const startOver = useCallback(() => {
    setResult(null);
    setError(null);
    setStatus('capture');
    setCaptureKey((k) => k + 1);
  }, []);

  if (status === 'capture') {
    return <PostureCaptureFlow key={captureKey} onCaptured={handleCaptured} />;
  }

  return (
    <div
      className="w-full h-full min-h-screen bg-neutral-950 text-neutral-100 flex flex-col"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      {(status === 'loading-models' || status === 'processing') && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <Loader2 className="w-6 h-6 text-amber-400 animate-spin mb-4" />
          <p className="text-sm text-neutral-300">
            {status === 'loading-models' ? 'Chargement des modèles MediaPipe…' : 'Analyse de la capture…'}
          </p>
        </div>
      )}

      {status === 'error' && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-md mx-auto w-full">
          <AlertTriangle className="w-8 h-8 text-red-400 mb-3" />
          <p className="text-neutral-200 text-sm">{error}</p>
          <button
            onClick={startOver}
            className="mt-6 flex items-center gap-2 py-3 px-5 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <RotateCcw className="w-4 h-4" /> Réessayer
          </button>
        </div>
      )}

      {status === 'result' && result && (
        <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full">
          <div className="text-xs tracking-widest text-cyan-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Essai analysé
          </div>
          <h1 className="text-xl font-semibold mb-4">
            {result.mode === 'frontal_photo' ? 'Surface frontale (pFSA)' : 'Angles articulaires'}
          </h1>

          {result.mode === 'frontal_photo' ? (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6">
              <div className="text-3xl font-semibold text-cyan-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {result.pfsaCm2} cm²
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                Ordre de grandeur attendu en position aéro adulte : ~3000-4500 cm² (cf. spec §9).
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6" style={{ fontFamily: 'ui-monospace, monospace' }}>
              <pre className="text-xs text-neutral-300 whitespace-pre-wrap leading-relaxed">
                {JSON.stringify(result.angles, null, 2)}
              </pre>
              <p className="text-xs text-neutral-500 mt-3 font-sans">
                {result.framesUsed}/{result.framesSampled} frames exploitées.
              </p>
            </div>
          )}

          <p className="text-neutral-500 text-xs mb-6 leading-relaxed">
            Ces métriques brutes correspondent à un seul essai. Le score (confort/aéro) et la sélection Pareto
            (posture-aero-engine.ts) demandent au moins 3 essais valides + le test de souplesse hanche (ASLR) —
            pas encore branchés à cet écran.
          </p>

          <button
            onClick={startOver}
            className="py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            Nouvel essai
          </button>
        </div>
      )}
    </div>
  );
}

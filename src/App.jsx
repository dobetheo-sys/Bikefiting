import { useState, useCallback, useEffect } from 'react';
import { RotateCcw, Loader2, AlertTriangle, Plus, ArrowRight } from 'lucide-react';
import PostureCaptureFlow from './components/PostureCaptureFlow.jsx';
import { getVisionFileset } from './capture/mediapipe-vision';
import { createBikeFitSegmenter, toBikeFitBinaryMask } from './capture/segmentation-integration';
import { createBikeFitPoseLandmarker, toPoseFrame } from './capture/pose-integration';
import { sampleVideoFrames } from './capture/video-frame-sampler';
import { computePFSA_cm2, extractTrialAngles, extractAslrAngleTrace } from './capture/capture-processing';
import { aslrToFlexScore, runEngine } from './engine/posture-aero-engine';

// App.jsx — orchestre toute la session : test de souplesse (ASLR) -> profil athlète ->
// essais (vidéo profil + photo frontale + deltas matériel) -> runEngine (validation,
// score, sélection Pareto). Voir spec §2/§3.1/§6 pour le protocole complet.
//
// subjective_multiplier (§7, boucle de feedback) : pas de questionnaire post-sortie ici,
// on reste sur les poids neutres (1.0 partout) — recalibrateWeights() existe et est testé
// dans le moteur mais brancher une vraie boucle de feedback est hors scope de cette étape.

const TRIAL_SAMPLE_COUNT = 30; // frames échantillonnées sur la vidéo profil (cycle de pédalage)
const ASLR_SAMPLE_COUNT = 40; // plus fin : on cherche un point d'arrêt précis (genou qui plie)
const NEUTRAL_WEIGHTS = { neck: 1, lowerBack: 1, hands: 1, knees: 1 };

// Persistance de session (retour terrain : un plantage du navigateur en pleine capture
// faisait tout perdre, tout vivait en state React). On ne sauvegarde que les données
// "acquises" (souplesse, profil, essais déjà validés) — pas les étapes de capture en
// cours (pendingTrial), qui redémarrent proprement depuis leur écran au rechargement.
const SESSION_STORAGE_KEY = 'posture-aero-session-v1';

function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function initialStageFor(saved) {
  if (!saved) return 'aslr-capture';
  if ((saved.trials && saved.trials.length > 0) || saved.profile) return 'session';
  // Ne PAS reprendre sur 'profile-form' juste parce qu'un aslrAngle est sauvegardé : ça
  // pouvait coincer l'utilisateur sur un vieux résultat (parfois faux, avant un correctif)
  // sans aucun moyen de refaire le test tant que "Continuer" n'avait pas été cliqué — retour
  // terrain (08/08/2026), un même "0°" obsolète réapparaissait à chaque réouverture. Refaire
  // le test ASLR est rapide ; rester coincé sur un résultat périmé est pire.
  return 'aslr-capture';
}

// Lecture accélérée pendant l'échantillonnage (retour terrain : l'analyse en temps réel
// d'une vidéo de 15-20s se sentait très longue) — voir video-frame-sampler.ts pour la
// justification du facteur retenu.
const SAMPLING_PLAYBACK_RATE = 4;

async function samplePoseFramesFromVideo(blob, sampleCount, onProgress) {
  const fileset = await getVisionFileset();
  const landmarker = await createBikeFitPoseLandmarker(fileset);
  try {
    const frames = [];
    await sampleVideoFrames(
      blob,
      sampleCount,
      ({ video, timestampMs }) => {
        const result = landmarker.detectForVideo(video, timestampMs);
        const frame = toPoseFrame(result, timestampMs);
        if (frame) frames.push(frame);
      },
      { playbackRate: SAMPLING_PLAYBACK_RATE, onProgress }
    );
    return frames;
  } finally {
    landmarker.close();
  }
}

async function processAslrVideo(blob, onProgress) {
  const frames = await samplePoseFramesFromVideo(blob, ASLR_SAMPLE_COUNT, onProgress);
  if (frames.length === 0) {
    throw new Error("Aucune pose détectée sur la vidéo du test de souplesse — vérifie le cadrage (hanche et jambe entières visibles).");
  }
  return extractAslrAngleTrace(frames);
}

async function processProfileVideoTrial(blob, onProgress) {
  const frames = await samplePoseFramesFromVideo(blob, TRIAL_SAMPLE_COUNT, onProgress);
  if (frames.length === 0) {
    throw new Error("Aucune pose détectée sur la vidéo — vérifie le cadrage (corps entier visible) et l'éclairage.");
  }
  return extractTrialAngles(frames);
}

async function processFrontalPhoto(blob, calibration) {
  const fileset = await getVisionFileset();
  const segmenter = await createBikeFitSegmenter(fileset);
  try {
    const bitmap = await createImageBitmap(blob);
    const segResult = segmenter.segment(bitmap);
    const mask = toBikeFitBinaryMask(segResult);
    return computePFSA_cm2(mask, calibration);
  } finally {
    segmenter.close();
  }
}

function Shell({ children }) {
  return (
    <div
      className="w-full h-full min-h-screen bg-neutral-950 text-neutral-100 flex flex-col"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      {children}
    </div>
  );
}

function Busy({ label, progress }) {
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;
  return (
    <Shell>
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-xs mx-auto w-full">
        <Loader2 className="w-6 h-6 text-amber-400 animate-spin mb-4" />
        <p className="text-sm text-neutral-300 mb-4">{label}</p>
        {pct !== null && (
          <>
            <div className="w-full h-1.5 rounded-full bg-neutral-800 overflow-hidden">
              <div className="h-full bg-amber-400 transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs text-neutral-500 mt-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
              {progress.current}/{progress.total} images analysées · {pct}%
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <Shell>
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-md mx-auto w-full">
        <AlertTriangle className="w-8 h-8 text-red-400 mb-3" />
        <p className="text-neutral-200 text-sm">{message}</p>
        <button
          onClick={onRetry}
          className="mt-6 flex items-center gap-2 py-3 px-5 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
        >
          <RotateCcw className="w-4 h-4" /> Réessayer
        </button>
      </div>
    </Shell>
  );
}

function NumberField({ label, value, onChange, suffix, required }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-neutral-200">
      <span>
        {label}
        {required && <span className="text-amber-400"> *</span>}
      </span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-neutral-100 text-right focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        {suffix && <span className="text-xs text-neutral-500 w-6">{suffix}</span>}
      </span>
    </label>
  );
}

function ProfileForm({ aslrAngle, aslrTrace, onSubmit, onRetakeAslr }) {
  const [heightCm, setHeightCm] = useState('178');
  const [raceDurationHours, setRaceDurationHours] = useState('2.5');
  const flexScore = aslrToFlexScore(aslrAngle);
  const heightValid = Number(heightCm) > 0;

  return (
    <Shell>
      <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full">
        <div className="text-xs tracking-widest text-cyan-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
          Test de souplesse (ASLR)
        </div>
        <h1 className="text-xl font-semibold mb-4">Résultat</h1>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6">
          <div className="text-3xl font-semibold text-cyan-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {aslrAngle}°
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            Score de souplesse : {flexScore}/5 (seuil clinique de tightness = 80°, cf. spec §3.1).
          </p>
          {aslrTrace && (
            <p className="text-[11px] text-neutral-600 mt-3" style={{ fontFamily: 'ui-monospace, monospace' }}>
              debug · {aslrTrace.framesStraightKnee}/{aslrTrace.framesTotal} images genou droit ·
              {' '}engagé image #{aslrTrace.engagedAtIndex ?? '—'} ·
              {' '}arrêt image #{aslrTrace.stoppedAtIndex ?? 'fin vidéo'}
            </p>
          )}
        </div>

        <div className="space-y-4 mb-6">
          <NumberField label="Ta taille" value={heightCm} onChange={setHeightCm} suffix="cm" required />
          <NumberField label="Durée de course estimée" value={raceDurationHours} onChange={setRaceDurationHours} suffix="h" />
        </div>

        <button
          onClick={() => onSubmit(Number(heightCm), raceDurationHours ? Number(raceDurationHours) : undefined)}
          disabled={!heightValid}
          className="py-3 rounded-lg bg-cyan-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-cyan-200 flex items-center justify-center gap-2"
        >
          Continuer <ArrowRight className="w-4 h-4" />
        </button>

        <button
          onClick={onRetakeAslr}
          className="mt-4 flex items-center justify-center gap-2 py-2 text-sm text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-cyan-400 rounded"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Refaire le test de souplesse
        </button>
      </div>
    </Shell>
  );
}

function SessionScreen({ profile, trials, onNewTrial, onAnalyze, onNewSession }) {
  return (
    <Shell>
      <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full">
        <div className="text-xs tracking-widest text-amber-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
          Session
        </div>
        <h1 className="text-xl font-semibold mb-1">Tes essais</h1>
        <p className="text-neutral-400 text-sm mb-1">
          Souplesse {profile.hipFlexibilityScore}/5 · minimum 3 essais valides pour une frontière Pareto (spec §6).
        </p>
        <p className="text-neutral-600 text-xs mb-6">
          Reprend automatiquement ici si tu quittes ou si le navigateur plante.
        </p>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 divide-y divide-neutral-800 mb-6">
          {trials.length === 0 && <p className="text-sm text-neutral-500 p-4">Aucun essai enregistré pour l’instant.</p>}
          {trials.map((t) => (
            <div key={t.id} className="p-4 text-sm" style={{ fontFamily: 'ui-monospace, monospace' }}>
              <div className="text-neutral-200">{t.id}</div>
              <div className="text-xs text-neutral-500 mt-1">
                hanche {t.angles.hip.mean}° · tronc {t.angles.trunk.mean}° · pFSA {t.frontal.pFSA_cm2} cm²
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onNewTrial}
          className="flex items-center justify-center gap-2 py-3 rounded-lg border border-neutral-700 text-neutral-200 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-400"
        >
          <Plus className="w-4 h-4" /> Nouvel essai
        </button>

        <button
          onClick={onAnalyze}
          disabled={trials.length === 0}
          className="py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-200"
        >
          Voir les résultats
        </button>

        <button
          onClick={() => { if (confirm('Effacer cette session et repartir de zéro ?')) onNewSession(); }}
          className="mt-6 text-xs text-neutral-600 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
        >
          Nouvelle session (efface tout)
        </button>
      </div>
    </Shell>
  );
}

function TrialDeltasForm({ onSubmit }) {
  const [saddleHeightMm, setSaddleHeightMm] = useState('0');
  const [reachMm, setReachMm] = useState('0');
  const [dropMm, setDropMm] = useState('0');

  return (
    <Shell>
      <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full">
        <div className="text-xs tracking-widest text-amber-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
          Essai capturé
        </div>
        <h1 className="text-xl font-semibold mb-1">Qu’as-tu changé sur le vélo ?</h1>
        <p className="text-neutral-400 text-sm mb-6">Par rapport à ton réglage de référence (0 si c’est le premier essai).</p>

        <div className="space-y-4 mb-8">
          <NumberField label="Hauteur de selle" value={saddleHeightMm} onChange={setSaddleHeightMm} suffix="mm" />
          <NumberField label="Reach" value={reachMm} onChange={setReachMm} suffix="mm" />
          <NumberField label="Drop" value={dropMm} onChange={setDropMm} suffix="mm" />
        </div>

        <button
          onClick={() =>
            onSubmit({ saddleHeightMm: Number(saddleHeightMm), reachMm: Number(reachMm), dropMm: Number(dropMm) })
          }
          className="py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200"
        >
          Enregistrer l’essai
        </button>
      </div>
    </Shell>
  );
}

function ProfileCard({ title, accent, profile }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className={`text-xs tracking-widest uppercase mb-2 ${accent}`} style={{ fontFamily: 'ui-monospace, monospace' }}>
        {title} · {profile.trial_id}
      </div>
      <div className="flex gap-6 mb-2">
        <div>
          <div className="text-2xl font-semibold text-neutral-100" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {profile.comfort_score}
          </div>
          <div className="text-xs text-neutral-500">confort</div>
        </div>
        <div>
          <div className="text-2xl font-semibold text-neutral-100" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {profile.aero_score}
          </div>
          <div className="text-xs text-neutral-500">aéro</div>
        </div>
      </div>
      <div className="text-xs text-neutral-500" style={{ fontFamily: 'ui-monospace, monospace' }}>
        selle {profile.deltas.saddleHeightMm >= 0 ? '+' : ''}
        {profile.deltas.saddleHeightMm}mm · reach {profile.deltas.reachMm >= 0 ? '+' : ''}
        {profile.deltas.reachMm}mm · drop {profile.deltas.dropMm >= 0 ? '+' : ''}
        {profile.deltas.dropMm}mm
      </div>
      {profile.warnings.length > 0 && (
        <div className="text-xs text-amber-400 mt-2">
          {profile.warnings.map((w) => w.param).join(', ')} — avertissement, pas exclusoire
        </div>
      )}
    </div>
  );
}

function ResultsScreen({ result, onBack }) {
  return (
    <Shell>
      <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full">
        <div className="text-xs tracking-widest text-cyan-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
          Résultats
        </div>

        {result.status === 'insufficient_valid_trials' ? (
          <>
            <h1 className="text-xl font-semibold mb-4">Pas encore assez d’essais valides</h1>
            <p className="text-neutral-400 text-sm mb-6">{result.message}</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-1">
              {result.trials_valid} essai(s) valide(s)
              {result.trials_excluded > 0 && `, ${result.trials_excluded} exclu(s)`}
            </h1>
            {result.profiles ? (
              <div className="space-y-3 my-6">
                <ProfileCard title="Confort max" accent="text-cyan-400" profile={result.profiles.confort_max} />
                <ProfileCard title="Équilibré" accent="text-amber-400" profile={result.profiles.equilibre} />
                <ProfileCard title="Aéro max" accent="text-pink-400" profile={result.profiles.aero_max} />
              </div>
            ) : (
              <p className="text-neutral-400 text-sm my-6">Aucun front Pareto disponible.</p>
            )}
            {result.excluded_trials.length > 0 && (
              <div className="text-xs text-neutral-500 mb-6" style={{ fontFamily: 'ui-monospace, monospace' }}>
                Exclus : {result.excluded_trials.map((e) => `${e.trial_id} (${e.violations[0]?.param})`).join(', ')}
              </div>
            )}
          </>
        )}

        <button onClick={onBack} className="py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
          Retour à la session
        </button>
      </div>
    </Shell>
  );
}

export default function App() {
  const [persisted] = useState(() => loadPersistedSession());
  const [stage, setStage] = useState(() => initialStageFor(persisted));
  const [aslrAngle, setAslrAngle] = useState(() => persisted?.aslrAngle ?? null);
  const [aslrTrace, setAslrTrace] = useState(null);
  const [profile, setProfile] = useState(() => persisted?.profile ?? null);
  const [athleteHeightCm, setAthleteHeightCm] = useState(() => persisted?.athleteHeightCm ?? null);
  const [trials, setTrials] = useState(() => persisted?.trials ?? []);
  const [pendingTrial, setPendingTrial] = useState(null);
  const [captureKey, setCaptureKey] = useState(0);
  const [busy, setBusy] = useState(null);
  const [busyProgress, setBusyProgress] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ aslrAngle, profile, athleteHeightCm, trials }));
    } catch {
      // stockage indisponible (navigation privée, quota) — pas bloquant, juste pas de reprise possible
    }
  }, [aslrAngle, profile, athleteHeightCm, trials]);

  const startNewSession = useCallback(() => {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignoré
    }
    setAslrAngle(null);
    setAslrTrace(null);
    setProfile(null);
    setAthleteHeightCm(null);
    setTrials([]);
    setPendingTrial(null);
    setResult(null);
    setError(null);
    setStage('aslr-capture');
  }, []);

  const fail = useCallback((e) => {
    const message =
      e instanceof Error
        ? e.message
        : typeof Event !== 'undefined' && e instanceof Event
          ? `Erreur inattendue (${e.type}) — vérifie ta connexion et réessaie.`
          : String(e);
    setError(message);
    setBusy(null);
  }, []);

  const handleAslrCaptured = useCallback(
    async (payload) => {
      if (!payload.blob) return fail(new Error('Capture invalide : aucune donnée récupérée.'));
      setBusy('Analyse du test de souplesse…');
      setBusyProgress(null);
      try {
        const trace = await processAslrVideo(payload.blob, (current, total) => setBusyProgress({ current, total }));
        setAslrAngle(trace.angle);
        setAslrTrace(trace);
        setBusy(null);
        setStage('profile-form');
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  const handleProfileSubmit = useCallback((heightCm, raceDurationHours) => {
    setAthleteHeightCm(heightCm);
    setProfile({ hipFlexibilityScore: aslrToFlexScore(aslrAngle), raceDurationHours });
    setStage('session');
  }, [aslrAngle]);

  const retakeAslr = useCallback(() => {
    setAslrAngle(null);
    setAslrTrace(null);
    setStage('aslr-capture');
  }, []);

  const startNewTrial = useCallback(() => {
    setPendingTrial(null);
    setCaptureKey((k) => k + 1);
    setStage('trial-video');
  }, []);

  const handleTrialVideoCaptured = useCallback(
    async (payload) => {
      if (!payload.blob) return fail(new Error('Capture invalide : aucune donnée récupérée.'));
      setBusy('Analyse de la vidéo profil…');
      setBusyProgress(null);
      try {
        const angles = await processProfileVideoTrial(payload.blob, (current, total) => setBusyProgress({ current, total }));
        setPendingTrial({ angles });
        setBusy(null);
        setStage('trial-photo');
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  const handleTrialPhotoCaptured = useCallback(
    async (payload) => {
      if (!payload.blob || !payload.calibration) return fail(new Error('Étalonnage manquant (2 points requis).'));
      setBusy('Analyse de la photo frontale…');
      setBusyProgress(null);
      try {
        const pfsaCm2 = await processFrontalPhoto(payload.blob, payload.calibration);
        setPendingTrial((prev) => ({
          ...prev,
          frontal: { pFSA_cm2: pfsaCm2, athleteHeight_cm: athleteHeightCm, headOffset_cm: 0 },
        }));
        setBusy(null);
        setStage('trial-deltas');
      } catch (e) {
        fail(e);
      }
    },
    [fail, athleteHeightCm]
  );

  const handleTrialDeltasSubmit = useCallback(
    (deltas) => {
      setTrials((prev) => [
        ...prev,
        { id: `t${prev.length + 1}`, angles: pendingTrial.angles, frontal: pendingTrial.frontal, deltas },
      ]);
      setPendingTrial(null);
      setStage('session');
    },
    [pendingTrial]
  );

  const runAnalysis = useCallback(() => {
    setResult(runEngine(trials, profile, NEUTRAL_WEIGHTS));
    setStage('results');
  }, [trials, profile]);

  const retryFromError = useCallback(() => {
    setError(null);
    setStage(profile ? 'session' : 'aslr-capture');
  }, [profile]);

  if (error) return <ErrorScreen message={error} onRetry={retryFromError} />;
  if (busy) return <Busy label={busy} progress={busyProgress} />;

  switch (stage) {
    case 'aslr-capture':
      return <PostureCaptureFlow key="aslr" initialMode="aslr_test" onCaptured={handleAslrCaptured} />;
    case 'profile-form':
      return <ProfileForm aslrAngle={aslrAngle} aslrTrace={aslrTrace} onSubmit={handleProfileSubmit} onRetakeAslr={retakeAslr} />;
    case 'trial-video':
      return <PostureCaptureFlow key={`tv-${captureKey}`} initialMode="profile_video" onCaptured={handleTrialVideoCaptured} />;
    case 'trial-photo':
      return <PostureCaptureFlow key={`tp-${captureKey}`} initialMode="frontal_photo" onCaptured={handleTrialPhotoCaptured} />;
    case 'trial-deltas':
      return <TrialDeltasForm onSubmit={handleTrialDeltasSubmit} />;
    case 'results':
      return <ResultsScreen result={result} onBack={() => setStage('session')} />;
    case 'session':
    default:
      return (
        <SessionScreen
          profile={profile}
          trials={trials}
          onNewTrial={startNewTrial}
          onAnalyze={runAnalysis}
          onNewSession={startNewSession}
        />
      );
  }
}

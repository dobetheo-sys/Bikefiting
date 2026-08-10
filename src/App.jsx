import { useState, useCallback, useEffect } from 'react';
import {
  RotateCcw,
  Loader2,
  AlertTriangle,
  Plus,
  ArrowRight,
  Smartphone,
  Bike,
  Ruler,
  Sun,
  ShieldCheck,
  Timer,
  CheckCircle2,
  Video,
  Camera,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Circle,
  Lock,
} from 'lucide-react';
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
  if (!saved) return 'welcome';
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

async function samplePoseFramesFromVideo(blob, sampleCount, onProgress, onModelReady) {
  const fileset = await getVisionFileset();
  const landmarker = await createBikeFitPoseLandmarker(fileset);
  onModelReady?.();
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

async function processAslrVideo(blob, onProgress, onModelReady) {
  const frames = await samplePoseFramesFromVideo(blob, ASLR_SAMPLE_COUNT, onProgress, onModelReady);
  if (frames.length === 0) {
    throw new Error(
      "On n'a pas réussi à te repérer sur cette vidéo. Vérifie que ta hanche et toute la jambe testée sont bien visibles à l'écran, puis réessaie."
    );
  }
  const trace = extractAslrAngleTrace(frames);
  // engagedAtIndex === null : la levée n'a jamais été détectée comme réellement engagée (cuisse
  // >= 15° sur plusieurs frames consécutives). Retour terrain (10/08/2026) : une vidéo filmée
  // trop loin et à contre-jour (caméra dans une autre pièce, à travers une porte, en direction
  // d'une fenêtre) n'a laissé détecter QU'UNE frame sur 40 — cette frame avait un genou plié,
  // donc maxThighAngle (initialisé à 0) n'a jamais été mis à jour : l'appli affichait "0°" comme
  // si c'était une vraie mesure de souplesse nulle, alors que la vidéo montrait une levée à ~90°
  // parfaitement correcte, juste indétectable par le modèle. Un test jamais engagé n'est PAS un
  // 0° valide — c'est un échec de mesure, à traiter comme tel.
  if (trace.engagedAtIndex === null) {
    throw new Error(
      "On n'a pas réussi à mesurer la levée de ta jambe sur cette vidéo (pas assez d'images où tu es bien visible). Rapproche la caméra, reste dans la même pièce, évite de filmer à contre-jour, puis réessaie."
    );
  }
  return trace;
}

async function processProfileVideoTrial(blob, onProgress, onModelReady) {
  const frames = await samplePoseFramesFromVideo(blob, TRIAL_SAMPLE_COUNT, onProgress, onModelReady);
  if (frames.length === 0) {
    throw new Error(
      "On n'a pas réussi à te repérer sur cette vidéo. Vérifie que tout le corps est visible et qu'il y a assez de lumière, puis réessaie."
    );
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
            <ProgressBar value={progress.current} max={progress.total} />
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
        <AlertTriangle className="w-8 h-8 text-amber-400 mb-3" />
        <p className="text-neutral-200 text-sm">{message}</p>
        <p className="text-xs text-neutral-500 mt-2">Pas de souci, ce que tu as déjà rempli est conservé.</p>
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

function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 rounded-full bg-neutral-800 overflow-hidden">
      <div className="h-full bg-amber-400 transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

function PrivacyNote({ className = '' }) {
  return (
    <div className={`flex items-start gap-2 text-xs text-neutral-500 ${className}`}>
      <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>Traité entièrement sur ton téléphone — aucune vidéo ni photo n’est envoyée en ligne.</span>
    </div>
  );
}

// Écrans "formulaire/liste" (profil, session, essai, réglages, résultats) : contenu
// potentiellement plus long qu'un écran (liste d'essais qui grandit, checklist d'un
// essai) — même pattern que WelcomeScreen (h-screen + zone scrollable + CTA ancré en
// bas) plutôt que Shell/min-h-screen + centrage vertical, pour que le bouton principal
// reste toujours atteignable sans avoir à scroller d'abord (retour d'audit ergonomique :
// "CTA ancré en bas partout").
function ScreenShell({ eyebrow, eyebrowColor = 'text-amber-400', title, subtitle, children, footer }) {
  return (
    <div
      className="w-full h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-10 pb-8 max-w-md mx-auto w-full">
          {eyebrow && (
            <div className={`text-xs tracking-widest uppercase mb-2 ${eyebrowColor}`} style={{ fontFamily: 'ui-monospace, monospace' }}>
              {eyebrow}
            </div>
          )}
          {title && <h1 className="text-xl font-semibold mb-1">{title}</h1>}
          {subtitle}
          {children}
        </div>
      </div>
      {footer && (
        <div className="px-6 py-5 border-t border-neutral-800 bg-neutral-950">
          <div className="max-w-md mx-auto w-full space-y-3">{footer}</div>
        </div>
      )}
    </div>
  );
}

function StepCard({ icon: Icon, step, title, duration, children, accent }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 flex gap-4">
      <div
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold ${accent}`}
        style={{ fontFamily: 'ui-monospace, monospace' }}
      >
        {step}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="w-4 h-4 text-neutral-400 shrink-0" />
          <h3 className="font-medium text-neutral-100">{title}</h3>
        </div>
        <p className="text-sm text-neutral-400 leading-relaxed">{children}</p>
        {duration && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-neutral-600" style={{ fontFamily: 'ui-monospace, monospace' }}>
            <Timer className="w-3 h-3" /> {duration}
          </div>
        )}
      </div>
    </div>
  );
}

function GearItem({ icon: Icon, title, children }) {
  return (
    <div className="flex gap-3 py-3 border-b border-neutral-800 last:border-b-0">
      <Icon className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sm text-neutral-200">{title}</div>
        <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function WelcomeScreen({ onStart }) {
  // h-screen (pas min-h-screen comme Shell) : contenu plus long qu'un écran, le bouton
  // "Commencer" doit rester ancré en bas et visible sans avoir à tout faire défiler
  // d'abord — Shell est partagé par des écrans qui, eux, comptent sur min-h-screen.
  return (
    <div
      className="w-full h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-10 pb-8 max-w-md mx-auto w-full">
          <div className="text-xs tracking-widest text-amber-400 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Bilan posture aéro
          </div>
          <h1 className="text-2xl font-semibold text-neutral-100 leading-snug mb-2">Avant de commencer</h1>
          <p className="text-neutral-400 text-sm leading-relaxed mb-8">
            Compte 10-15 minutes, seul avec ton vélo et ton téléphone. Voici exactement ce qui va se passer et ce qu'il te faut.
          </p>

          <h2 className="text-xs tracking-widest text-neutral-500 uppercase mb-3" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Le déroulé
          </h2>
          <div className="space-y-3 mb-8">
            <StepCard icon={Ruler} step="1" title="Test de souplesse" duration="~1 min" accent="bg-cyan-400/10 text-cyan-300">
              Allongé au sol, tu lèves une jambe tendue le plus haut possible. Ça calibre la limite de fermeture de
              hanche que ta position sur le vélo doit respecter — sans ça, impossible de scorer tes essais.
            </StepCard>
            <StepCard icon={Bike} step="2" title="Essais sur le vélo" duration="~2-3 min par essai" accent="bg-amber-400/10 text-amber-300">
              Pour chaque réglage que tu veux comparer (hauteur de selle, reach, drop…) : une courte vidéo de profil
              en pédalant, puis une photo de face avec étalonnage. Répète pour au moins 3 essais différents.
            </StepCard>
            <StepCard icon={CheckCircle2} step="3" title="Résultats" accent="bg-pink-400/10 text-pink-300">
              Un score confort et un score aéro pour chaque essai, et une sélection automatique de tes 3 meilleures
              positions : confort max, équilibré, aéro max.
            </StepCard>
          </div>

          <h2 className="text-xs tracking-widest text-neutral-500 uppercase mb-3" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Matériel nécessaire
          </h2>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 mb-8">
            <GearItem icon={Smartphone} title="Un smartphone avec appareil photo">
              Celui que tu utilises là, ça marche.
            </GearItem>
            <GearItem icon={ShieldCheck} title="Un support fixe pour le poser">
              Trépied, étagère, pile de livres — mains libres obligatoire, il faut une vue stable pendant l'enregistrement.
            </GearItem>
            <GearItem icon={Bike} title="Ton vélo">
              Idéalement sur un home-trainer ; sinon calé à l'arrêt, bien stable.
            </GearItem>
            <GearItem icon={Ruler} title="Un repère de longueur connue">
              Visible sur la photo de face (largeur de ton cintre, un mètre ruban…) — sert à étalonner les mesures.
            </GearItem>
            <GearItem icon={Sun} title="Un peu d'espace et de lumière">
              De quoi te voir en entier de profil sur le vélo, et une lumière correcte, pas de contre-jour.
            </GearItem>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 mb-4">
            <p className="text-xs text-neutral-500 leading-relaxed">
              Méthode basée sur un protocole terrain publié (Debraux et al. 2009) pour la mesure de surface frontale,
              et sur le test clinique ASLR pour la souplesse de hanche — pas juste une estimation à l'œil.
            </p>
          </div>

          <PrivacyNote className="mb-4" />

          <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 mb-8">
            <p className="text-xs text-amber-200/80 leading-relaxed">
              Cet outil ne remplace pas l'avis d'un bikefitter professionnel ni un avis médical. Arrête immédiatement
              un mouvement si ça tire ou fait mal, en particulier pendant le test de souplesse.
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 border-t border-neutral-800 bg-neutral-950">
        <div className="max-w-md mx-auto w-full">
          <button
            onClick={onStart}
            className="w-full py-3.5 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200 flex items-center justify-center gap-2"
          >
            Commencer le bilan <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
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
  const [showDebug, setShowDebug] = useState(false);
  const flexScore = aslrToFlexScore(aslrAngle);
  const heightValid = Number(heightCm) > 0;

  return (
    <ScreenShell
      eyebrow="Test de souplesse (ASLR)"
      eyebrowColor="text-cyan-400"
      title="Résultat"
      footer={
        <>
          <button
            onClick={() => onSubmit(Number(heightCm), raceDurationHours ? Number(raceDurationHours) : undefined)}
            disabled={!heightValid}
            className="w-full py-3 rounded-lg bg-cyan-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-cyan-200 flex items-center justify-center gap-2"
          >
            Continuer <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={onRetakeAslr}
            className="w-full flex items-center justify-center gap-2 py-2 text-sm text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-cyan-400 rounded"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Refaire le test de souplesse
          </button>
        </>
      }
    >
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 mt-4">
        <div className="text-3xl font-semibold text-cyan-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
          {aslrAngle}°
        </div>
        <p className="text-xs text-neutral-500 mt-2">
          Score de souplesse : {flexScore}/5 (seuil clinique de tightness = 80°, cf. spec §3.1).
        </p>
        {aslrTrace && (
          <>
            <button
              onClick={() => setShowDebug((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-neutral-600 mt-3 focus:outline-none focus:ring-2 focus:ring-cyan-400 rounded"
            >
              Détails techniques {showDebug ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {showDebug && (
              <p className="text-[11px] text-neutral-600 mt-1.5" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {aslrTrace.framesStraightKnee}/{aslrTrace.framesTotal} images genou droit ·
                {' '}engagé image #{aslrTrace.engagedAtIndex ?? '—'} ·
                {' '}arrêt image #{aslrTrace.stoppedAtIndex ?? 'fin vidéo'}
              </p>
            )}
          </>
        )}
      </div>

      <div className="space-y-4 mb-6">
        <NumberField label="Ta taille" value={heightCm} onChange={setHeightCm} suffix="cm" required />
        <NumberField label="Durée de course estimée" value={raceDurationHours} onChange={setRaceDurationHours} suffix="h" />
      </div>
    </ScreenShell>
  );
}

function SessionScreen({ profile, trials, onNewTrial, onAnalyze, onNewSession }) {
  const minTrials = 3;
  const remaining = Math.max(0, minTrials - trials.length);

  return (
    <ScreenShell
      eyebrow="Session"
      title="Tes essais"
      footer={
        <>
          <button
            onClick={onNewTrial}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <Plus className="w-4 h-4" /> Nouvel essai
          </button>
          <button
            onClick={onAnalyze}
            disabled={trials.length === 0}
            className="w-full py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-200"
          >
            Voir les résultats
          </button>
          <button
            onClick={() => { if (confirm('Effacer cette session et repartir de zéro ?')) onNewSession(); }}
            className="w-full text-xs text-neutral-600 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
          >
            Nouvelle session (efface tout)
          </button>
        </>
      }
    >
      <p className="text-neutral-400 text-sm mb-3">Souplesse {profile.hipFlexibilityScore}/5</p>

      <div className="mb-1">
        <ProgressBar value={trials.length} max={minTrials} />
      </div>
      <p className="text-xs text-neutral-500 mb-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
        {trials.length}/{minTrials} essais
      </p>
      <p className="text-neutral-500 text-xs mb-6">
        {remaining > 0
          ? `Encore ${remaining} essai${remaining > 1 ? 's' : ''} pour pouvoir comparer tes réglages et voir tes résultats.`
          : 'Tu peux déjà voir tes résultats — ajoute d’autres essais pour affiner la comparaison.'}
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

      <p className="text-neutral-600 text-xs mb-6">
        Reprend automatiquement ici si tu quittes ou si le navigateur plante.
      </p>
    </ScreenShell>
  );
}

function formatDelta(value) {
  return `${value >= 0 ? '+' : ''}${value}mm`;
}

function formatDeltas(deltas) {
  const parts = [`selle ${formatDelta(deltas.saddleHeightMm)}`];
  if (deltas.saddleSetbackMm !== undefined) parts.push(`recul ${formatDelta(deltas.saddleSetbackMm)}`);
  parts.push(`reach ${formatDelta(deltas.reachMm)}`, `drop ${formatDelta(deltas.dropMm)}`);
  return parts.join(' · ');
}

function TrialStepRow({ icon: Icon, title, consigne, done, summary, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-4 text-left rounded-lg border border-neutral-800 bg-neutral-900 hover:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400 transition-colors"
    >
      {done ? (
        <CheckCircle2 className="w-5 h-5 text-cyan-400 shrink-0" />
      ) : (
        <Circle className="w-5 h-5 text-neutral-700 shrink-0" />
      )}
      <Icon className="w-4 h-4 text-neutral-500 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-neutral-100 text-sm">{title}</div>
        <p className="text-xs text-neutral-500 mt-0.5 truncate">{done ? summary : consigne}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-neutral-600 shrink-0" />
    </button>
  );
}

function TrialOverview({ trialNumber, pendingTrial, onOpenVideo, onOpenPhoto, onOpenDeltas, onSave, onCancel }) {
  const videoDone = Boolean(pendingTrial?.angles);
  const photoDone = Boolean(pendingTrial?.frontal);
  const deltasDone = Boolean(pendingTrial?.deltas);
  const doneCount = [videoDone, photoDone, deltasDone].filter(Boolean).length;
  const allDone = doneCount === 3;

  return (
    <ScreenShell
      eyebrow={`Essai ${trialNumber}`}
      title="3 étapes à compléter"
      footer={
        <>
          <button
            onClick={onSave}
            disabled={!allDone}
            className="w-full py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-200"
          >
            Enregistrer cet essai
          </button>
          <button
            onClick={onCancel}
            className="w-full text-sm text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
          >
            Annuler cet essai
          </button>
        </>
      }
    >
      <div className="mb-1 mt-3">
        <ProgressBar value={doneCount} max={3} />
      </div>
      <p className="text-neutral-400 text-sm mb-6" style={{ fontFamily: 'ui-monospace, monospace' }}>
        {doneCount}/3 complétées
      </p>

      <div className="space-y-3 mb-8">
        <TrialStepRow
          icon={Video}
          title="Vidéo profil"
          consigne="Vue de profil sur le vélo, en pédalant"
          done={videoDone}
          summary={videoDone ? `hanche ${pendingTrial.angles.hip.mean}° · tronc ${pendingTrial.angles.trunk.mean}°` : ''}
          onClick={onOpenVideo}
        />
        <TrialStepRow
          icon={Camera}
          title="Photo frontale"
          consigne="Vue de face, avec étalonnage"
          done={photoDone}
          summary={photoDone ? `pFSA ${pendingTrial.frontal.pFSA_cm2} cm²` : ''}
          onClick={onOpenPhoto}
        />
        <TrialStepRow
          icon={Ruler}
          title="Réglages du vélo"
          consigne="Hauteur/recul de selle, reach, drop"
          done={deltasDone}
          summary={deltasDone ? formatDeltas(pendingTrial.deltas) : ''}
          onClick={onOpenDeltas}
        />
      </div>
    </ScreenShell>
  );
}

function TrialDeltasForm({ initialDeltas, onSubmit, onCancel }) {
  const [saddleHeightMm, setSaddleHeightMm] = useState(String(initialDeltas?.saddleHeightMm ?? 0));
  const [saddleSetbackMm, setSaddleSetbackMm] = useState(String(initialDeltas?.saddleSetbackMm ?? 0));
  const [reachMm, setReachMm] = useState(String(initialDeltas?.reachMm ?? 0));
  const [dropMm, setDropMm] = useState(String(initialDeltas?.dropMm ?? 0));

  return (
    <ScreenShell
      eyebrow="Réglages du vélo"
      title="Qu’as-tu changé sur le vélo ?"
      subtitle={
        <p className="text-neutral-400 text-sm mb-6">Par rapport à ton réglage de référence (0 si c’est le premier essai).</p>
      }
      footer={
        <>
          <button
            onClick={() =>
              onSubmit({
                saddleHeightMm: Number(saddleHeightMm),
                saddleSetbackMm: Number(saddleSetbackMm),
                reachMm: Number(reachMm),
                dropMm: Number(dropMm),
              })
            }
            className="w-full py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200"
          >
            Valider ces réglages
          </button>
          {onCancel && (
            <button onClick={onCancel} className="w-full text-sm text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded">
              Annuler
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 mb-8">
        <NumberField label="Hauteur de selle" value={saddleHeightMm} onChange={setSaddleHeightMm} suffix="mm" />
        <NumberField label="Recul de selle" value={saddleSetbackMm} onChange={setSaddleSetbackMm} suffix="mm" />
        <NumberField label="Reach" value={reachMm} onChange={setReachMm} suffix="mm" />
        <NumberField label="Drop" value={dropMm} onChange={setDropMm} suffix="mm" />
      </div>
      <p className="text-xs text-neutral-500 -mt-4 mb-6">
        Idéalement, change un seul réglage à la fois entre deux essais — c'est le seul moyen de savoir lequel a fait la différence.
      </p>
    </ScreenShell>
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
        {formatDeltas(profile.deltas)}
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
    <ScreenShell
      eyebrow="Résultats"
      eyebrowColor="text-cyan-400"
      footer={
        <button onClick={onBack} className="w-full py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
          Retour à la session
        </button>
      }
    >
      <div className="mt-4">
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
      </div>
    </ScreenShell>
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
    setStage('welcome');
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
      if (!payload.blob) return fail(new Error("La capture n'a pas abouti, réessaie."));
      // Le chargement du modèle d'analyse (~10-20 Mo, premier appel de la session) peut
      // prendre du temps sur une connexion mobile lente, sans aucune progression mesurable
      // pendant ce temps — un libellé figé "Analyse…" pendant 30s donnait l'impression que
      // l'appli était plantée (retour terrain : "plus d'écran d'attente"). On distingue donc
      // les deux phases : chargement du modèle (spinner seul) puis analyse (barre de
      // progression par image).
      setBusy('Chargement du modèle d’analyse…');
      setBusyProgress(null);
      try {
        const trace = await processAslrVideo(
          payload.blob,
          (current, total) => setBusyProgress({ current, total }),
          () => setBusy('Analyse du test de souplesse…')
        );
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

  // Point d'entrée du protocole : sans ça, un utilisateur qui lance le test par erreur (ou
  // veut juste explorer l'appli) n'a aucune sortie sinon le bouton retour du navigateur.
  const cancelAslrCapture = useCallback(() => setStage(profile ? 'session' : 'welcome'), [profile]);

  // Nouvel essai : un écran unique liste les 3 étapes (vidéo, photo, réglages), chacune
  // avec son bouton — pas de séquence forcée. On peut les faire dans n'importe quel ordre,
  // revenir en arrière, et l'essai n'est enregistré qu'une fois les 3 complétées.
  const startNewTrial = useCallback(() => {
    setPendingTrial({});
    setStage('trial-overview');
  }, []);

  const openTrialVideo = useCallback(() => {
    setCaptureKey((k) => k + 1);
    setStage('trial-video');
  }, []);

  const openTrialPhoto = useCallback(() => {
    setCaptureKey((k) => k + 1);
    setStage('trial-photo');
  }, []);

  const openTrialDeltas = useCallback(() => setStage('trial-deltas'), []);

  const cancelTrialStep = useCallback(() => setStage('trial-overview'), []);

  const cancelTrial = useCallback(() => {
    // Ne demander confirmation que s'il y a vraiment quelque chose à perdre — un essai tout
    // juste démarré (aucune étape complétée) n'a rien à confirmer, ça ne ferait que ralentir
    // un simple "je me suis trompé, retour".
    const hasProgress = pendingTrial && (pendingTrial.angles || pendingTrial.frontal || pendingTrial.deltas);
    if (hasProgress && !confirm('Abandonner cet essai ? Les étapes déjà complétées seront perdues.')) return;
    setPendingTrial(null);
    setStage('session');
  }, [pendingTrial]);

  const handleTrialVideoCaptured = useCallback(
    async (payload) => {
      if (!payload.blob) return fail(new Error("La capture n'a pas abouti, réessaie."));
      setBusy('Chargement du modèle d’analyse…');
      setBusyProgress(null);
      try {
        const angles = await processProfileVideoTrial(
          payload.blob,
          (current, total) => setBusyProgress({ current, total }),
          () => setBusy('Analyse de la vidéo profil…')
        );
        setPendingTrial((prev) => ({ ...prev, angles }));
        setBusy(null);
        setStage('trial-overview');
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  const handleTrialPhotoCaptured = useCallback(
    async (payload) => {
      if (!payload.blob || !payload.calibration) return fail(new Error("Il manque l'étalonnage : touche 2 points sur la photo (ex. les extrémités du cintre) avant de valider."));
      setBusy('Analyse de la photo frontale…');
      setBusyProgress(null);
      try {
        const pfsaCm2 = await processFrontalPhoto(payload.blob, payload.calibration);
        setPendingTrial((prev) => ({
          ...prev,
          frontal: { pFSA_cm2: pfsaCm2, athleteHeight_cm: athleteHeightCm, headOffset_cm: 0 },
        }));
        setBusy(null);
        setStage('trial-overview');
      } catch (e) {
        fail(e);
      }
    },
    [fail, athleteHeightCm]
  );

  const handleTrialDeltasSubmit = useCallback((deltas) => {
    setPendingTrial((prev) => ({ ...prev, deltas }));
    setStage('trial-overview');
  }, []);

  const saveTrial = useCallback(() => {
    setTrials((prev) => [
      ...prev,
      { id: `t${prev.length + 1}`, angles: pendingTrial.angles, frontal: pendingTrial.frontal, deltas: pendingTrial.deltas },
    ]);
    setPendingTrial(null);
    setStage('session');
  }, [pendingTrial]);

  const runAnalysis = useCallback(() => {
    setResult(runEngine(trials, profile, NEUTRAL_WEIGHTS));
    setStage('results');
  }, [trials, profile]);

  const retryFromError = useCallback(() => {
    setError(null);
    // Un essai en cours (pendingTrial non nul) garde ses étapes déjà complétées — pas la
    // peine de tout perdre si une seule étape échoue.
    if (pendingTrial) setStage('trial-overview');
    else setStage(profile ? 'session' : 'aslr-capture');
  }, [profile, pendingTrial]);

  if (error) return <ErrorScreen message={error} onRetry={retryFromError} />;
  if (busy) return <Busy label={busy} progress={busyProgress} />;

  switch (stage) {
    case 'welcome':
      return <WelcomeScreen onStart={() => setStage('aslr-capture')} />;
    case 'aslr-capture':
      return <PostureCaptureFlow key="aslr" initialMode="aslr_test" onCaptured={handleAslrCaptured} onCancel={cancelAslrCapture} />;
    case 'profile-form':
      return <ProfileForm aslrAngle={aslrAngle} aslrTrace={aslrTrace} onSubmit={handleProfileSubmit} onRetakeAslr={retakeAslr} />;
    case 'trial-overview':
      return (
        <TrialOverview
          trialNumber={trials.length + 1}
          pendingTrial={pendingTrial}
          onOpenVideo={openTrialVideo}
          onOpenPhoto={openTrialPhoto}
          onOpenDeltas={openTrialDeltas}
          onSave={saveTrial}
          onCancel={cancelTrial}
        />
      );
    case 'trial-video':
      return (
        <PostureCaptureFlow
          key={`tv-${captureKey}`}
          initialMode="profile_video"
          onCaptured={handleTrialVideoCaptured}
          onCancel={cancelTrialStep}
        />
      );
    case 'trial-photo':
      return (
        <PostureCaptureFlow
          key={`tp-${captureKey}`}
          initialMode="frontal_photo"
          onCaptured={handleTrialPhotoCaptured}
          onCancel={cancelTrialStep}
        />
      );
    case 'trial-deltas':
      return <TrialDeltasForm initialDeltas={pendingTrial?.deltas} onSubmit={handleTrialDeltasSubmit} onCancel={cancelTrialStep} />;
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

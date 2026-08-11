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
  Circle,
  History,
} from 'lucide-react';
import PostureCaptureFlow from './components/PostureCaptureFlow.jsx';
import PrivacyNote from './components/PrivacyNote.jsx';
import { getVisionFileset } from './capture/mediapipe-vision';
import { createBikeFitSegmenter, toBikeFitBinaryMask } from './capture/segmentation-integration';
import { computePFSA_cm2, KNEE_STRAIGHT_THRESHOLD } from './capture/capture-processing';
import { aslrToFlexScore, computeReferenceSaddleHeightCm, suggestNextAdjustment, runEngine, recalibrateWeights } from './engine/posture-aero-engine';

// App.jsx — orchestre toute la session : test de souplesse (ASLR) -> profil athlète ->
// essais (vidéo profil + photo frontale + deltas matériel) -> runEngine (validation,
// score, sélection Pareto). Voir spec §2/§3.1/§6 pour le protocole complet.
//
// Le test ASLR ET la vidéo profil sont mesurés MANUELLEMENT (l'utilisateur touche des points
// sur des images choisies dans sa propre vidéo, cf. PostureCaptureFlow.jsx +
// capture-processing.ts/computeManualAslrAngle+computeManualTrialPmh+computeManualTrialPmb) —
// pas de pipeline MediaPipe pour ces deux étapes. handleAslrCaptured et handleTrialVideoCaptured
// ci-dessous reçoivent directement le résultat déjà calculé, sans passer par un état "busy"
// asynchrone. Seule la photo frontale (handleTrialPhotoCaptured) pilote encore un modèle ML
// (segmentation, via processFrontalPhoto) — la segmentation d'une silhouette entière sur fond
// fixe étant un problème bien mieux posé que la détection de landmarks sur une vidéo, cf.
// PostureCaptureFlow.jsx pour l'historique des échecs de détection automatique qui ont motivé
// ce choix (retours terrain 08-11/08/2026).
//
// subjective_multiplier (§7, boucle de feedback) : un retour post-sortie (douleur nuque/bas du
// dos/mains/genoux, 1-5) peut être ajouté depuis l'écran Historique sur un bilan archivé — cf.
// SUBJECTIVE_STATE_KEY et submitFeedback() dans App(). recalibrateWeights() (moteur) n'augmente
// un poids que si 2 sorties CONSÉCUTIVES signalent la même zone (évite l'overfit à un mauvais
// jour, cf. son test). Les poids recalibrés servent au score confort du bilan SUIVANT (session
// en cours et relecture d'un bilan archivé, cf. runAnalysis/viewHistoryEntry) — jamais rétroactifs
// sur un score déjà montré au moment où l'essai a été analysé la première fois.

const NEUTRAL_WEIGHTS = { neck: 1, lowerBack: 1, hands: 1, knees: 1 };

// Persistance de session (retour terrain : un plantage du navigateur en pleine capture
// faisait tout perdre, tout vivait en state React). On ne sauvegarde que les données
// "acquises" (souplesse, profil, essais déjà validés) — pas les étapes de capture en
// cours (pendingTrial), qui redémarrent proprement depuis leur écran au rechargement.
export const SESSION_STORAGE_KEY = 'posture-aero-session-v1';

function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Historique (amélioration §3, prépare §1 boucle de feedback et §4 tendance) : jusqu'ici
// "Nouvelle session" effaçait purement et simplement les essais/résultats — impossible de
// comparer un bilan à un précédent, ou de rebrancher un feedback post-sortie sur un réglage
// déjà testé. Une session avec au moins un essai est maintenant archivée avant d'être remise
// à zéro (cf. archiveCurrentSession dans App()), dans une clé localStorage séparée pour ne
// jamais interférer avec la reprise de session en cours (SESSION_STORAGE_KEY) ni avec le
// nettoyage de secours de l'ErrorBoundary, qui ne doit toucher que la session cassée, pas
// l'historique déjà validé.
export const SESSION_HISTORY_KEY = 'posture-aero-history-v1';

function loadHistory() {
  try {
    const raw = localStorage.getItem(SESSION_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Boucle de feedback subjectif (amélioration §1, §7 du spec) : contrairement aux essais/bilans
// (mesures objectives, valables pour un seul bilan), les poids de pondération confort sont un
// état ATHLÈTE qui évolue au fil du temps — indépendant d'une session en particulier — donc
// stocké à part plutôt qu'attaché à une entrée précise de l'historique. feedbackLog garde
// l'historique complet des sorties déclarées (chacune liée au bilan archivé dont le réglage
// était utilisé, pour affichage/traçabilité) dans l'ordre chronologique : recalibrateWeights()
// (moteur) ne regarde que les 2 dernières, donc le conserver en entier ici est nécessaire pour
// qu'un appel ultérieur retrouve le bon contexte.
export const SUBJECTIVE_STATE_KEY = 'posture-aero-subjective-v1';

function loadSubjectiveState() {
  try {
    const raw = localStorage.getItem(SUBJECTIVE_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.weights && Array.isArray(parsed.feedbackLog)) return parsed;
  } catch {
    // ignoré, on retombe sur l'état neutre par défaut ci-dessous
  }
  return { weights: NEUTRAL_WEIGHTS, feedbackLog: [] };
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
          <div className="flex items-center gap-1.5 mt-2 text-xs text-neutral-400" style={{ fontFamily: 'ui-monospace, monospace' }}>
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

function WelcomeScreen({ onStart, historyCount, onViewHistory }) {
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
        <div className="max-w-md mx-auto w-full space-y-3">
          <button
            onClick={onStart}
            className="w-full py-3.5 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200 flex items-center justify-center gap-2"
          >
            Commencer le bilan <ArrowRight className="w-4 h-4" />
          </button>
          {historyCount > 0 && (
            <button
              onClick={onViewHistory}
              className="w-full flex items-center justify-center gap-2 py-2 text-sm text-neutral-400 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
            >
              <History className="w-3.5 h-3.5" /> Voir {historyCount > 1 ? `mes ${historyCount} bilans précédents` : 'mon bilan précédent'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, suffix, required, hint }) {
  return (
    <div>
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
      {hint && <p className="text-xs text-neutral-500 mt-1 pr-16 leading-relaxed">{hint}</p>}
    </div>
  );
}

function ProfileForm({ aslrAngle, aslrKneeAngle, onSubmit, onRetakeAslr }) {
  const [heightCm, setHeightCm] = useState('178');
  const [raceDurationHours, setRaceDurationHours] = useState('2.5');
  const [inseamCm, setInseamCm] = useState('');
  const [goal, setGoal] = useState('aero');
  const flexScore = aslrToFlexScore(aslrAngle);
  const heightValid = Number(heightCm) > 0;
  const referenceSaddleHeightCm = Number(inseamCm) > 0 ? computeReferenceSaddleHeightCm(Number(inseamCm)) : null;

  return (
    <ScreenShell
      eyebrow="Test de souplesse (ASLR)"
      eyebrowColor="text-cyan-400"
      title="Résultat"
      footer={
        <>
          <button
            onClick={() =>
              onSubmit(
                Number(heightCm),
                raceDurationHours ? Number(raceDurationHours) : undefined,
                Number(inseamCm) > 0 ? Number(inseamCm) : undefined,
                goal
              )
            }
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
        {aslrKneeAngle != null && (
          <p className="text-xs text-neutral-500 mt-2">
            Genou mesuré à {aslrKneeAngle}° au moment de la levée
            {aslrKneeAngle < KNEE_STRAIGHT_THRESHOLD ? ' (un peu plié — si le résultat te semble faux, refais le test).' : ' (bien tendu).'}
          </p>
        )}
      </div>

      <div className="space-y-4 mb-6">
        <NumberField label="Ta taille" value={heightCm} onChange={setHeightCm} suffix="cm" required />
        <NumberField label="Durée de course estimée" value={raceDurationHours} onChange={setRaceDurationHours} suffix="h" />
        <NumberField
          label="Entrejambe"
          value={inseamCm}
          onChange={setInseamCm}
          suffix="cm"
          hint="Debout, du sol à l'entrejambe (sans chaussures). Optionnel — sert juste à te suggérer une hauteur de selle de référence si tu ne connais pas déjà ton réglage habituel."
        />
      </div>

      <div className="mb-6">
        <div className="text-sm text-neutral-200 mb-1.5">Objectif de la position</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setGoal('aero')}
            className={`flex-1 py-2 rounded-lg border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              goal === 'aero' ? 'bg-amber-400 border-amber-400 text-neutral-950 font-medium' : 'border-neutral-700 text-neutral-300'
            }`}
          >
            Aéro
          </button>
          <button
            type="button"
            onClick={() => setGoal('comfort')}
            className={`flex-1 py-2 rounded-lg border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              goal === 'comfort' ? 'bg-amber-400 border-amber-400 text-neutral-950 font-medium' : 'border-neutral-700 text-neutral-300'
            }`}
          >
            Confort
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
          {goal === 'aero'
            ? "Position TT/tri très couchée : tronc entre 5° et 15°, genou entre 137° et 150° restent des critères qui excluent un essai s'ils ne sont pas respectés (plage sourcée, cf. spec)."
            : "Position route classique, plus redressée et facile à régler : tronc et genou deviennent des repères informatifs plutôt que des critères d'exclusion (pas de plage \"confort\" universelle à imposer). La hanche (plancher 40°, perte de puissance mesurée) reste, elle, un critère dur dans les deux cas."}
        </p>
      </div>

      {referenceSaddleHeightCm && (
        <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-cyan-300 uppercase mb-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Hauteur de selle de référence
          </div>
          <div className="text-2xl font-semibold text-cyan-200" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {referenceSaddleHeightCm} cm
          </div>
          <p className="text-xs text-cyan-100/70 mt-1 leading-relaxed">
            Du pédalier au haut de la selle, le long du tube de selle (formule LeMond, entrejambe × 0,883). Un point de
            départ documenté si tu pars de zéro — pas une prescription, ajuste ensuite selon ton ressenti.
          </p>
        </div>
      )}
    </ScreenShell>
  );
}

function SessionScreen({ profile, trials, athleteInseamCm, onNewTrial, onAnalyze, onNewSession }) {
  const minTrials = 3;
  const remaining = Math.max(0, minTrials - trials.length);
  const referenceSaddleHeightCm = athleteInseamCm > 0 ? computeReferenceSaddleHeightCm(athleteInseamCm) : null;
  const lastTrial = trials.length > 0 ? trials[trials.length - 1] : null;
  const nextAdjustment = lastTrial ? suggestNextAdjustment(lastTrial, profile) : null;

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
            onClick={() => {
              // Historique (§3 amélioration) : une session avec au moins un essai est maintenant
              // archivée avant d'être remise à zéro (cf. archiveCurrentSession dans App()), donc
              // "efface tout" n'est plus exact dès qu'il y a quelque chose à garder — le message
              // de confirmation reflète ce qui va réellement se passer.
              const msg =
                trials.length > 0
                  ? 'Nouvelle session ? Ce bilan sera archivé dans ton historique avant de repartir de zéro.'
                  : 'Nouvelle session et repartir de zéro ?';
              if (confirm(msg)) onNewSession();
            }}
            className="w-full text-xs text-neutral-400 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
          >
            Nouvelle session
          </button>
        </>
      }
    >
      <p className="text-neutral-400 text-sm mb-3">
        Souplesse {profile.hipFlexibilityScore}/5 · Objectif {profile.goal === 'comfort' ? 'confort' : 'aéro'}
      </p>

      {trials.length === 0 && referenceSaddleHeightCm && (
        <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-cyan-300 uppercase mb-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Avant ton premier essai
          </div>
          <p className="text-sm text-cyan-100">
            Hauteur de selle de référence suggérée : <span className="font-semibold">{referenceSaddleHeightCm} cm</span> (pédalier → haut de selle).
          </p>
          <p className="text-xs text-cyan-100/70 mt-1">
            Utile si tu ne connais pas déjà ton réglage habituel — sinon, garde le tien comme point de départ.
          </p>
        </div>
      )}

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
            {/* Le genou est un critère d'exclusion dur au même titre que hanche/tronc (validateTrial,
                cf. posture-aero-engine.ts) mais restait invisible ici — un essai pouvait être exclu
                pour un genou hors plage sans que rien dans cette liste ne le laisse deviner. */}
            <div className="text-xs text-neutral-500 mt-1">
              hanche {t.angles.hip.mean}° · tronc {t.angles.trunk.mean}° · genou {t.angles.knee.mean}° · pFSA {t.frontal.pFSA_cm2} cm²
            </div>
            {t.deltas && <div className="text-xs text-amber-400/70 mt-1">{formatDeltas(t.deltas)}</div>}
          </div>
        ))}
      </div>

      {lastTrial && (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-amber-300 uppercase mb-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
            Suggestion pour le prochain essai
          </div>
          {nextAdjustment ? (
            <p className="text-sm text-amber-100">{nextAdjustment.message}</p>
          ) : (
            <p className="text-sm text-amber-100">
              Hanche, tronc et genou de {lastTrial.id} sont tous dans leur zone cible — rien à corriger côté angles pour l'instant.
            </p>
          )}
          <p className="text-xs text-amber-100/60 mt-1.5">
            Basé sur le paramètre le plus loin de sa zone cible sur ton dernier essai — indicatif, change un seul réglage à la fois et re-teste.
          </p>
        </div>
      )}

      <p className="text-neutral-400 text-xs mb-6">
        Reprend automatiquement ici si tu quittes ou si le navigateur plante.
      </p>
    </ScreenShell>
  );
}

// `deltas` reste le nom du champ (données déjà persistées côté utilisateurs en localStorage,
// cf. commentaire sur Trial['deltas'] dans posture-aero-engine.ts) mais représente les mesures
// RÉELLES et ABSOLUES du vélo pour cet essai, pas une différence — donc pas de signe +/-.
function formatSetupValue(value) {
  return `${value}mm`;
}

function formatDeltas(deltas) {
  const parts = [`selle ${formatSetupValue(deltas.saddleHeightMm)}`];
  if (deltas.saddleSetbackMm !== undefined) parts.push(`recul ${formatSetupValue(deltas.saddleSetbackMm)}`);
  parts.push(`reach ${formatSetupValue(deltas.reachMm)}`, `drop ${formatSetupValue(deltas.dropMm)}`);
  if (deltas.hasAeroBars !== undefined) parts.push(deltas.hasAeroBars ? 'prolongateurs' : 'sans prolongateurs');
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
      <ChevronRight className="w-4 h-4 text-neutral-400 shrink-0" />
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
          consigne="Mesures actuelles : hauteur/recul de selle, reach, drop"
          done={deltasDone}
          summary={deltasDone ? formatDeltas(pendingTrial.deltas) : ''}
          onClick={onOpenDeltas}
        />
      </div>
    </ScreenShell>
  );
}

// Retour terrain : "le nom des points rend la lecture impossible" — chip à côté (pas sous) le
// point, réduite, pour ne plus masquer l'image ni le point voisin (même correction que TapImage
// dans PostureCaptureFlow.jsx, qui a le même souci sur les points en cours de pose).
//
// Point et étiquette positionnés INDÉPENDAMMENT, tous deux ancrés au même left/top — retour
// terrain suivant "bug d'affichage du point" : les regrouper dans un conteneur flex puis centrer
// CE conteneur avec translate(-50%,-50%) décalait le point lui-même (pas juste l'étiquette) de
// la vraie coordonnée mesurée, d'une distance proportionnelle à la largeur du texte du label.
function ReviewMarker({ point, size, label }) {
  if (!size) return null;
  const left = `${(point.x / size.width) * 100}%`;
  const top = `${(point.y / size.height) * 100}%`;
  return (
    <div className="pointer-events-none">
      <div className="absolute w-3 h-3 rounded-full bg-cyan-400 border-2 border-neutral-950" style={{ left, top, transform: 'translate(-50%,-50%)' }} />
      {label && (
        <span className="absolute px-1 rounded bg-black/50 text-[8px] leading-tight text-cyan-200 whitespace-nowrap" style={{ left, top, transform: 'translate(10px, -50%)' }}>
          {label}
        </span>
      )}
    </div>
  );
}

// Relecture d'une étape déjà validée (image + points tapés + résultat), sans avoir à tout
// refaire — retour terrain : "j'ai pas pu revérifier les mesures que j'avais faites une fois
// validé". Ne couvre que l'essai en cours (pendingTrial n'est pas persisté, cf. commentaire
// sur SESSION_STORAGE_KEY) — une fois l'essai enregistré, seul le résumé chiffré reste
// disponible dans la liste des essais (voir formatDeltas/SessionScreen).
function TrialReviewScreen({ step, pendingTrial, onClose, onRedo }) {
  const videoReview = pendingTrial?.videoReview ?? [];

  return (
    <ScreenShell
      eyebrow={step === 'video' ? 'Vidéo profil' : 'Photo frontale'}
      title="Relecture de la mesure"
      footer={
        <>
          <button onClick={onClose} className="w-full py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-amber-200">
            Fermer
          </button>
          <button onClick={onRedo} className="w-full flex items-center justify-center gap-2 py-2 text-sm text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded">
            <RotateCcw className="w-3.5 h-3.5" /> Refaire cette étape
          </button>
        </>
      }
    >
      <div className="space-y-4 mt-4 mb-6">
        {step === 'video' &&
          videoReview.map((r, i) => (
            <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden">
              <div className="relative bg-black">
                <img src={r.stillUrl} alt={`Image mesurée — ${r.key}`} className="w-full h-auto block" />
                {r.points.map((p, j) => (
                  <ReviewMarker key={j} point={p} size={r.stillSize} label={r.pointLabels[j]} />
                ))}
              </div>
              <div className="p-3 text-sm text-neutral-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {r.key === 'pmh' && `Hanche ${r.result.hipAngle}° · Tronc ${r.result.trunkAngle}°`}
                {r.key === 'pmb' && `Genou ${r.result.kneeAngle}°`}
                {r.key === 'raise' && `Angle ${r.result.angle}° · Genou ${r.result.kneeAngle}°`}
              </div>
            </div>
          ))}
        {step === 'photo' && pendingTrial?.photoReviewUrl && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden">
            <div className="bg-black">
              <img src={pendingTrial.photoReviewUrl} alt="Photo frontale mesurée" className="w-full h-auto block" />
            </div>
            <div className="p-3 text-sm text-neutral-300" style={{ fontFamily: 'ui-monospace, monospace' }}>
              pFSA {pendingTrial.frontal?.pFSA_cm2} cm²
            </div>
          </div>
        )}
      </div>
    </ScreenShell>
  );
}

// Schéma statique (pas à l'échelle) pour rendre "hauteur de selle / recul de selle / reach /
// drop" concrets pour un débutant qui ne maîtrise pas le jargon bikefitting — retour terrain :
// "il faut expliciter ces termes pour les débutants et même un petit schéma". Couleur ambre =
// mesures liées à la selle (cohérent avec l'eyebrow ambre de cet écran), cyan = mesures liées
// au cintre, pour que la légende texte et le schéma se répondent visuellement.
function BikeDeltasDiagram() {
  const bb = { x: 155, y: 200 };
  const saddle = { x: 95, y: 80 };
  const bar = { x: 260, y: 115 };
  const headBase = { x: 260, y: 175 };
  const rearHub = { x: 70, y: 240 };
  const frontHub = { x: 280, y: 240 };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 mb-6">
      <svg viewBox="0 0 360 290" className="w-full h-auto" role="img" aria-label="Schéma des mesures de réglage du vélo : hauteur et recul de selle, reach, drop">
        <defs>
          <marker id="arrow-amber" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#fbbf24" />
          </marker>
          <marker id="arrow-cyan" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#22d3ee" />
          </marker>
        </defs>

        {/* Silhouette du vélo, simplifiée, pas à l'échelle */}
        <g stroke="#525252" strokeWidth="3" fill="none" strokeLinecap="round">
          <line x1={bb.x} y1={bb.y} x2={rearHub.x} y2={rearHub.y} />
          <line x1={saddle.x} y1={saddle.y} x2={rearHub.x} y2={rearHub.y} />
          <line x1={bb.x} y1={bb.y} x2={saddle.x} y2={saddle.y} />
          <line x1={bb.x} y1={bb.y} x2={headBase.x} y2={headBase.y} />
          <line x1={headBase.x} y1={headBase.y} x2={frontHub.x} y2={frontHub.y} />
          <line x1={headBase.x} y1={headBase.y} x2={bar.x} y2={bar.y} />
          <line x1={saddle.x} y1={saddle.y} x2={bar.x} y2={bar.y} />
        </g>
        <circle cx={rearHub.x} cy={rearHub.y} r="30" fill="none" stroke="#404040" strokeWidth="3" />
        <circle cx={frontHub.x} cy={frontHub.y} r="30" fill="none" stroke="#404040" strokeWidth="3" />
        <circle cx={bb.x} cy={bb.y} r="4" fill="#a3a3a3" />
        <ellipse cx={saddle.x} cy={saddle.y} rx="16" ry="5" fill="#737373" />
        <circle cx={bar.x} cy={bar.y} r="5" fill="#737373" />

        {/* Hauteur de selle (ambre, verticale, à gauche) */}
        <g stroke="#fbbf24" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="2,2">
          <line x1={bb.x} y1={bb.y} x2="30" y2={bb.y} />
          <line x1={saddle.x} y1={saddle.y} x2="30" y2={saddle.y} />
        </g>
        <line x1="30" y1={bb.y} x2="30" y2={saddle.y} stroke="#fbbf24" strokeWidth="2" markerStart="url(#arrow-amber)" markerEnd="url(#arrow-amber)" />
        <text x="14" y={(bb.y + saddle.y) / 2} fill="#fbbf24" fontSize="11" textAnchor="middle" transform={`rotate(-90 14 ${(bb.y + saddle.y) / 2})`}>hauteur selle</text>

        {/* Recul de selle (ambre, horizontale, en bas) */}
        <g stroke="#fbbf24" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="2,2">
          <line x1={saddle.x} y1={saddle.y} x2={saddle.x} y2="272" />
          <line x1={bb.x} y1={bb.y} x2={bb.x} y2="272" />
        </g>
        <line x1={saddle.x} y1="272" x2={bb.x} y2="272" stroke="#fbbf24" strokeWidth="2" markerStart="url(#arrow-amber)" markerEnd="url(#arrow-amber)" />
        <text x={(saddle.x + bb.x) / 2} y="285" fill="#fbbf24" fontSize="11" textAnchor="middle">recul selle</text>

        {/* Reach (cyan, horizontale, en haut) */}
        <g stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="2,2">
          <line x1={saddle.x} y1={saddle.y} x2={saddle.x} y2="16" />
          <line x1={bar.x} y1={bar.y} x2={bar.x} y2="16" />
        </g>
        <line x1={saddle.x} y1="16" x2={bar.x} y2="16" stroke="#22d3ee" strokeWidth="2" markerStart="url(#arrow-cyan)" markerEnd="url(#arrow-cyan)" />
        <text x={(saddle.x + bar.x) / 2} y="12" fill="#22d3ee" fontSize="11" textAnchor="middle">reach</text>

        {/* Drop (cyan, verticale, à droite) */}
        <g stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="2,2">
          <line x1={saddle.x} y1={saddle.y} x2="335" y2={saddle.y} />
          <line x1={bar.x} y1={bar.y} x2="335" y2={bar.y} />
        </g>
        <line x1="335" y1={saddle.y} x2="335" y2={bar.y} stroke="#22d3ee" strokeWidth="2" markerStart="url(#arrow-cyan)" markerEnd="url(#arrow-cyan)" />
        <text x="351" y={(saddle.y + bar.y) / 2} fill="#22d3ee" fontSize="11" textAnchor="middle" transform={`rotate(-90 351 ${(saddle.y + bar.y) / 2})`}>drop</text>
      </svg>
    </div>
  );
}

// Retour terrain : "peux-tu donner des consignes aussi pour la modification entre 2 essais ?"
// — connaître les 4 champs (cf. BikeDeltasDiagram) ne dit pas quoi changer ni de combien pour
// que la comparaison ait un sens. Incréments choisis pour se sentir sur le vélo sans dérégler
// toute la position d'un coup (cohérents avec les plages KNEE_MIN/MAX, TRUNK_MIN/MAX du moteur
// — un changement plus gros a de bonnes chances de sortir de la plage validée et d'exclure l'essai).
// NB : ce formulaire demande les mesures RÉELLES du vélo (pas une différence à calculer soi-même,
// cf. retour terrain "ça marche pas" — les utilisateurs entraient naturellement leurs mesures
// absolues, ce que confirme aussi BikeDeltasDiagram qui a toujours représenté des distances
// absolues). L'app compare les essais entre eux automatiquement.
function TrialDeltasGuidance() {
  return (
    <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-4 mb-6">
      <h2 className="text-xs tracking-widest text-cyan-300 uppercase mb-2" style={{ fontFamily: 'ui-monospace, monospace' }}>
        Entre 2 essais, quoi changer ?
      </h2>
      <ul className="text-xs text-cyan-100/80 space-y-1.5 leading-relaxed">
        <li>• Mesure et note tes valeurs actuelles, telles quelles sur le vélo — pas besoin de calculer une différence, l'app s'en charge.</li>
        <li>• D'un essai à l'autre, change un seul réglage à la fois — sinon impossible de savoir lequel a fait la différence.</li>
        <li>• Changements qui se sentent sans dérégler toute la position : selle ±5 mm, reach ±10 mm, drop ±10-15 mm.</li>
        <li>• Cherches plus de confort ? Commence par la selle (hauteur/recul) — c'est ce qui joue le plus sur le genou et la hanche.</li>
        <li>• Cherches plus d'aéro ? Commence par le cintre (reach/drop) — c'est ce qui réduit le plus ta surface frontale.</li>
        <li>• Laisse quelques tours de pédale pour t'habituer à la nouvelle position avant de filmer.</li>
      </ul>
    </div>
  );
}

function TrialDeltasForm({ initialDeltas, onSubmit, onCancel }) {
  const [saddleHeightMm, setSaddleHeightMm] = useState(initialDeltas?.saddleHeightMm !== undefined ? String(initialDeltas.saddleHeightMm) : '');
  const [saddleSetbackMm, setSaddleSetbackMm] = useState(initialDeltas?.saddleSetbackMm !== undefined ? String(initialDeltas.saddleSetbackMm) : '');
  const [reachMm, setReachMm] = useState(initialDeltas?.reachMm !== undefined ? String(initialDeltas.reachMm) : '');
  const [dropMm, setDropMm] = useState(initialDeltas?.dropMm !== undefined ? String(initialDeltas.dropMm) : '');
  const [hasAeroBars, setHasAeroBars] = useState(initialDeltas?.hasAeroBars ?? false);

  // Audit fiabilité/ergonomie : le bouton n'était jamais désactivé et Number('') vaut 0, donc un
  // champ laissé vide (recul de selle mis à part, volontairement optionnel — cf. Trial['deltas']
  // dans posture-aero-engine.ts) était silencieusement enregistré comme "0mm mesuré" — une
  // fabrication qui a l'air d'une vraie mesure nulle. Seuls les 3 champs non-optionnels du type
  // sont requis ici ; recul de selle reste facultatif.
  const requiredFieldsValid = [saddleHeightMm, reachMm, dropMm].every((v) => v.trim() !== '' && Number.isFinite(Number(v)));

  return (
    <ScreenShell
      eyebrow="Réglages du vélo"
      title="Quelles sont les mesures actuelles du vélo ?"
      subtitle={
        <p className="text-neutral-400 text-sm mb-6">Mesure directement sur le vélo pour cet essai — pas besoin de calculer une différence, l'app compare pour toi.</p>
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
                hasAeroBars,
              })
            }
            disabled={!requiredFieldsValid}
            className="w-full py-3 rounded-lg bg-amber-400 text-neutral-950 font-medium disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-200"
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
      <BikeDeltasDiagram />

      <TrialDeltasGuidance />

      <div className="space-y-5 mb-8">
        <NumberField
          label="Hauteur de selle"
          value={saddleHeightMm}
          onChange={setSaddleHeightMm}
          suffix="mm"
          required
          hint="Distance entre l'axe du pédalier et le haut de la selle, le long du tube de selle (valeur mesurée, pas une différence)."
        />
        <NumberField
          label="Recul de selle"
          value={saddleSetbackMm}
          onChange={setSaddleSetbackMm}
          suffix="mm"
          hint="Distance horizontale entre l'axe du pédalier et le nez de la selle."
        />
        <NumberField
          label="Reach"
          value={reachMm}
          onChange={setReachMm}
          suffix="mm"
          required
          hint="Distance horizontale entre le nez de la selle et le cintre."
        />
        <NumberField
          label="Drop"
          value={dropMm}
          onChange={setDropMm}
          suffix="mm"
          required
          hint="Différence de hauteur entre le haut de la selle et le cintre (cintre plus bas = drop plus grand)."
        />

        <div>
          <div className="text-sm text-neutral-200 mb-1.5">Prolongateurs</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setHasAeroBars(true)}
              className={`flex-1 py-2 rounded-lg border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400 ${
                hasAeroBars ? 'bg-amber-400 border-amber-400 text-neutral-950 font-medium' : 'border-neutral-700 text-neutral-300'
              }`}
            >
              Oui
            </button>
            <button
              type="button"
              onClick={() => setHasAeroBars(false)}
              className={`flex-1 py-2 rounded-lg border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400 ${
                !hasAeroBars ? 'bg-amber-400 border-amber-400 text-neutral-950 font-medium' : 'border-neutral-700 text-neutral-300'
              }`}
            >
              Non
            </button>
          </div>
          <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
            Le vélo est-il équipé de prolongateurs (guidon aéro/triathlon) pour cet essai ? Ça change beaucoup l'aérodynamisme et la position des mains.
          </p>
        </div>
      </div>
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
        <div className="text-xs text-amber-400 mt-2 space-y-0.5">
          {profile.warnings.map((w, i) => (
            <div key={i}>{formatViolation(w)} — avertissement, pas exclusoire</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Retour terrain : un essai exclu ("0 essai(s) valide(s)") ne disait jamais POURQUOI — l'app
// avait déjà la raison (validateTrial retourne violations[].param/value/bound) mais ne
// l'affichait pas, forçant l'utilisateur à deviner. Traduit chaque violation en phrase concrète,
// avec la valeur mesurée et le seuil, pour que l'utilisateur sache exactement quoi corriger.
function formatViolation(v) {
  switch (v.param) {
    case 'hip_floor':
      return `hanche trop fermée (${v.value}° < ${v.bound}° mini)`;
    case 'trunk_min':
      return `tronc trop couché (${v.value}° < ${v.bound}° mini)`;
    case 'trunk_max':
      return `tronc pas assez couché pour une position aéro (${v.value}° > ${v.bound}° maxi)`;
    case 'knee_range':
      return v.value < v.bound
        ? `genou trop plié à un moment du cycle de pédalage (${v.value}° < ${v.bound}° mini)`
        : `genou trop tendu à un moment du cycle de pédalage (${v.value}° > ${v.bound}° maxi)`;
    case 'invalid_measurement':
      return 'mesure invalide (deux points tapés au même endroit) — refais cette étape';
    default:
      return `${v.param} (${v.value})`;
  }
}

function ExcludedTrialsList({ excludedTrials }) {
  if (excludedTrials.length === 0) return null;
  return (
    <div className="space-y-2 mb-6">
      {excludedTrials.map((e) => (
        <div key={e.trial_id} className="text-xs text-neutral-500" style={{ fontFamily: 'ui-monospace, monospace' }}>
          {e.trial_id} : {e.violations.map(formatViolation).join(', ')}
        </div>
      ))}
    </div>
  );
}

// Historique : cf. commentaire sur SESSION_HISTORY_KEY dans App.jsx.
function formatSessionDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

function HistoryCard({ entry, feedbackCount, onOpen, onDelete, onOpenFeedback }) {
  const nbTrials = entry.trials?.length ?? 0;
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <button
        onClick={() => onOpen(entry)}
        className="w-full text-left focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
      >
        <div className="text-sm text-neutral-100 font-medium">{formatSessionDate(entry.archivedAt)}</div>
        <div className="text-xs text-neutral-500 mt-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
          {nbTrials} essai{nbTrials > 1 ? 's' : ''} · objectif {entry.profile?.goal === 'comfort' ? 'confort' : 'aéro'} · souplesse{' '}
          {entry.profile?.hipFlexibilityScore ?? '?'}/5
        </div>
      </button>
      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-neutral-800">
        <button
          onClick={() => onOpenFeedback(entry)}
          className="text-xs text-cyan-300 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-cyan-400 rounded px-1"
        >
          Retour post-sortie{feedbackCount > 0 ? ` (${feedbackCount})` : ''}
        </button>
        <button
          onClick={() => { if (confirm('Supprimer ce bilan de l’historique ?')) onDelete(entry.id); }}
          className="text-xs text-neutral-500 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded px-1"
        >
          Supprimer
        </button>
      </div>
    </div>
  );
}

function HistoryScreen({ history, feedbackLog, onOpen, onDelete, onOpenFeedback, onBack }) {
  // Le plus récent en premier — spread avant reverse() : reverse() mute en place, et `history`
  // est le state React de App(), le muter directement casserait la détection de changement.
  const sorted = [...history].reverse();
  return (
    <ScreenShell
      eyebrow="Historique"
      eyebrowColor="text-cyan-400"
      title="Tes bilans précédents"
      footer={
        <button onClick={onBack} className="w-full py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
          Retour
        </button>
      }
    >
      {sorted.length === 0 ? (
        <p className="text-neutral-400 text-sm my-6">Aucun bilan archivé pour l'instant.</p>
      ) : (
        <div className="space-y-3 my-4">
          {sorted.map((entry) => (
            <HistoryCard
              key={entry.id}
              entry={entry}
              feedbackCount={feedbackLog.filter((f) => f.sessionId === entry.id).length}
              onOpen={onOpen}
              onDelete={onDelete}
              onOpenFeedback={onOpenFeedback}
            />
          ))}
        </div>
      )}
    </ScreenShell>
  );
}

// Boucle de feedback subjectif : cf. commentaire sur SUBJECTIVE_STATE_KEY dans App.jsx.
const FEEDBACK_ZONES = [
  { key: 'neck', label: 'Nuque' },
  { key: 'lowerBack', label: 'Bas du dos' },
  { key: 'hands', label: 'Mains' },
  { key: 'knees', label: 'Genoux' },
];

function FeedbackForm({ sessionEntry, onSubmit, onCancel }) {
  const [scores, setScores] = useState({ neck: 1, lowerBack: 1, hands: 1, knees: 1 });

  return (
    <ScreenShell
      eyebrow="Retour post-sortie"
      eyebrowColor="text-cyan-400"
      title="Comment ça s'est passé ?"
      subtitle={
        <p className="text-neutral-400 text-sm mb-6 leading-relaxed">
          Sur le réglage du bilan du {formatSessionDate(sessionEntry.archivedAt)}. Une douleur qui revient sur 2 sorties de suite pèsera un
          peu plus dans le score confort de ton prochain bilan — 1 sortie isolée ne change rien.
        </p>
      }
      footer={
        <>
          <button
            onClick={() => onSubmit(FEEDBACK_ZONES.map((z) => ({ zone: z.key, painScore: scores[z.key] })))}
            className="w-full py-3 rounded-lg bg-cyan-400 text-neutral-950 font-medium focus:outline-none focus:ring-2 focus:ring-cyan-200"
          >
            Enregistrer cette sortie
          </button>
          <button
            onClick={onCancel}
            className="w-full text-xs text-neutral-400 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-400 rounded"
          >
            Annuler
          </button>
        </>
      }
    >
      <div className="space-y-5 mt-4">
        {FEEDBACK_ZONES.map((z) => (
          <div key={z.key}>
            <div className="text-sm text-neutral-200 mb-1.5">{z.label}</div>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScores((prev) => ({ ...prev, [z.key]: n }))}
                  className={`flex-1 py-2 rounded-lg border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 ${
                    scores[z.key] === n ? 'bg-cyan-400 border-cyan-400 text-neutral-950 font-medium' : 'border-neutral-700 text-neutral-300'
                  }`}
                  style={{ fontFamily: 'ui-monospace, monospace' }}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-neutral-500 mt-1">
              <span>aucune douleur</span>
              <span>intense</span>
            </div>
          </div>
        ))}
      </div>
    </ScreenShell>
  );
}

function ResultsScreen({ result, onBack, backLabel = 'Retour à la session' }) {
  return (
    <ScreenShell
      eyebrow="Résultats"
      eyebrowColor="text-cyan-400"
      footer={
        <button onClick={onBack} className="w-full py-3 rounded-lg border border-neutral-700 text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-400">
          {backLabel}
        </button>
      }
    >
      <div className="mt-4">
        {result.status === 'insufficient_valid_trials' ? (
          <>
            <h1 className="text-xl font-semibold mb-4">Pas encore assez d’essais valides</h1>
            <p className="text-neutral-400 text-sm mb-6">{result.message}</p>
            <ExcludedTrialsList excludedTrials={result.excluded_trials} />
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-1">
              {result.trials_valid} essai(s) valide(s)
              {result.trials_excluded > 0 && `, ${result.trials_excluded} exclu(s)`}
            </h1>
            {result.profiles ? (
              <div className="space-y-3 my-6">
                {/* Audit visuel : convention couleur de l'appli — ambre = selle/confort,
                    cyan = cintre/aéro (cf. TapImage, ASLR...). Ces 3 cartes utilisaient un
                    mappage sans rapport (confort en cyan, aéro en rose) qui contredisait cette
                    convention partout ailleurs dans l'app. */}
                <ProfileCard title="Confort max" accent="text-amber-400" profile={result.profiles.confort_max} />
                <ProfileCard title="Équilibré" accent="text-pink-400" profile={result.profiles.equilibre} />
                <ProfileCard title="Aéro max" accent="text-cyan-400" profile={result.profiles.aero_max} />
              </div>
            ) : (
              <p className="text-neutral-400 text-sm my-6">Aucun front Pareto disponible.</p>
            )}
            <ExcludedTrialsList excludedTrials={result.excluded_trials} />
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
  const [aslrKneeAngle, setAslrKneeAngle] = useState(null);
  const [profile, setProfile] = useState(() => persisted?.profile ?? null);
  const [athleteHeightCm, setAthleteHeightCm] = useState(() => persisted?.athleteHeightCm ?? null);
  const [athleteInseamCm, setAthleteInseamCm] = useState(() => persisted?.athleteInseamCm ?? null);
  const [trials, setTrials] = useState(() => persisted?.trials ?? []);
  const [pendingTrial, setPendingTrial] = useState(null);
  const [captureKey, setCaptureKey] = useState(0);
  const [busy, setBusy] = useState(null);
  const [busyProgress, setBusyProgress] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  // Historique : cf. commentaire sur SESSION_HISTORY_KEY. 'session' | 'history' — pour que le
  // bouton Retour de ResultsScreen ramène au bon endroit selon qu'on regarde le résultat de la
  // session en cours ou celui d'un bilan archivé.
  const [history, setHistory] = useState(() => loadHistory());
  const [resultsOrigin, setResultsOrigin] = useState('session');
  // Boucle de feedback subjectif : cf. commentaire sur SUBJECTIVE_STATE_KEY. feedbackTarget
  // (bilan archivé concerné) pilote l'écran 'feedback-form', null quand cet écran n'est pas actif.
  const [subjective, setSubjective] = useState(() => loadSubjectiveState());
  const [feedbackTarget, setFeedbackTarget] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ aslrAngle, profile, athleteHeightCm, athleteInseamCm, trials }));
    } catch {
      // stockage indisponible (navigation privée, quota) — pas bloquant, juste pas de reprise possible
    }
  }, [aslrAngle, profile, athleteHeightCm, athleteInseamCm, trials]);

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(history));
    } catch {
      // stockage indisponible — pas bloquant, l'historique reste juste non persistant pour cette session navigateur
    }
  }, [history]);

  useEffect(() => {
    try {
      localStorage.setItem(SUBJECTIVE_STATE_KEY, JSON.stringify(subjective));
    } catch {
      // stockage indisponible — pas bloquant, la recalibration repart juste de zéro à la prochaine visite
    }
  }, [subjective]);

  // Audit fiabilité : photoReviewUrl (URL.createObjectURL) est recréée à chaque photo frontale
  // analysée avec succès, y compris en refaisant l'étape (redoTrialPhoto) — jamais révoquée.
  // Cf. le même correctif dans PostureCaptureFlow.jsx : la révocation suit l'état plutôt que
  // chaque site d'appel, donc couvre uniformément "refaire la photo" / "nouvel essai" / démontage.
  useEffect(() => () => { if (pendingTrial?.photoReviewUrl) URL.revokeObjectURL(pendingTrial.photoReviewUrl); }, [pendingTrial?.photoReviewUrl]);

  const startNewSession = useCallback(() => {
    // Archive avant de tout effacer, cf. commentaire sur SESSION_HISTORY_KEY. Un profil sans
    // aucun essai (ASLR + taille remplis puis abandon) n'a rien d'utile à revisiter plus tard,
    // donc pas archivé — seule une session avec au moins un essai l'est.
    if (trials.length > 0) {
      setHistory((prev) => [
        ...prev,
        { id: `s${Date.now()}`, archivedAt: new Date().toISOString(), aslrAngle, profile, athleteHeightCm, athleteInseamCm, trials },
      ]);
    }
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignoré
    }
    setAslrAngle(null);
    setAslrKneeAngle(null);
    setProfile(null);
    setAthleteHeightCm(null);
    setAthleteInseamCm(null);
    setTrials([]);
    setPendingTrial(null);
    setResult(null);
    setError(null);
    setStage('welcome');
  }, [trials, aslrAngle, profile, athleteHeightCm, athleteInseamCm]);

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

  // Mesure manuelle (3 taps hanche/genou/cheville, cf. PostureCaptureFlow.jsx) — l'angle est
  // déjà calculé par le composant de capture, pas de pipeline MediaPipe à attendre ici, donc
  // pas d'écran d'attente nécessaire pour cette étape.
  const handleAslrCaptured = useCallback((payload) => {
    setAslrAngle(payload.angle);
    setAslrKneeAngle(payload.kneeAngle ?? null);
    setStage('profile-form');
  }, []);

  const handleProfileSubmit = useCallback((heightCm, raceDurationHours, inseamCm, goal) => {
    setAthleteHeightCm(heightCm);
    setAthleteInseamCm(inseamCm ?? null);
    setProfile({ hipFlexibilityScore: aslrToFlexScore(aslrAngle), raceDurationHours, goal });
    setStage('session');
  }, [aslrAngle]);

  const retakeAslr = useCallback(() => {
    setAslrAngle(null);
    setAslrKneeAngle(null);
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

  // Retour terrain : "j'ai pas pu revérifier les mesures que j'avais faites une fois validé" —
  // cliquer une étape déjà complétée forçait à tout refaire (ré-enregistrer/ré-importer, re-
  // choisir les images, re-taper les points) juste pour la regarder. Maintenant, cliquer une
  // étape déjà faite ouvre une relecture (image + points + résultat) au lieu de la relancer ;
  // "Refaire cette étape" sur cet écran déclenche le vrai redémarrage (redoTrialVideo/Photo).
  const [reviewStep, setReviewStep] = useState(null); // 'video' | 'photo'

  const redoTrialVideo = useCallback(() => {
    setCaptureKey((k) => k + 1);
    setStage('trial-video');
  }, []);

  const redoTrialPhoto = useCallback(() => {
    setCaptureKey((k) => k + 1);
    setStage('trial-photo');
  }, []);

  const openTrialVideo = useCallback(() => {
    if (pendingTrial?.angles) {
      setReviewStep('video');
      setStage('trial-review');
      return;
    }
    redoTrialVideo();
  }, [pendingTrial, redoTrialVideo]);

  const openTrialPhoto = useCallback(() => {
    if (pendingTrial?.frontal) {
      setReviewStep('photo');
      setStage('trial-review');
      return;
    }
    redoTrialPhoto();
  }, [pendingTrial, redoTrialPhoto]);

  const closeReview = useCallback(() => setStage('trial-overview'), []);

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

  // Mesure manuelle (points mort haut/bas, cf. PostureCaptureFlow.jsx) — angles déjà calculés,
  // pas de pipeline MediaPipe à attendre ici, donc pas d'écran d'attente pour cette étape.
  const handleTrialVideoCaptured = useCallback((payload) => {
    setPendingTrial((prev) => ({ ...prev, angles: payload.angles, videoReview: payload.review }));
    setStage('trial-overview');
  }, []);

  const handleTrialPhotoCaptured = useCallback(
    async (payload) => {
      if (!payload.blob || !payload.calibration) return fail(new Error("Il manque l'étalonnage : touche 2 points sur la photo (ex. les extrémités du cintre) avant de valider."));
      setBusy('Analyse de la photo frontale…');
      setBusyProgress(null);
      try {
        // Le masque de segmentation MediaPipe n'a pas forcément la même résolution que la
        // photo où la calibration (2 taps) a été mesurée — cf. le commentaire sur
        // CalibrationRef dans capture-processing.ts. payload.meta porte la résolution native
        // de la photo (capturedMeta dans PostureCaptureFlow.jsx), indispensable pour que
        // computePFSA_cm2 remette le masque à la bonne échelle.
        const calibration = { ...payload.calibration, photoWidthPx: payload.meta?.width, photoHeightPx: payload.meta?.height };
        const pfsaCm2 = await processFrontalPhoto(payload.blob, calibration);
        const photoReviewUrl = URL.createObjectURL(payload.blob);
        setPendingTrial((prev) => ({
          ...prev,
          frontal: { pFSA_cm2: pfsaCm2, athleteHeight_cm: athleteHeightCm, headOffset_cm: 0 },
          photoReviewUrl,
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

  // subjective.weights (plutôt que NEUTRAL_WEIGHTS en dur) : cf. commentaire sur
  // SUBJECTIVE_STATE_KEY — la recalibration issue des retours post-sortie s'applique au bilan
  // suivant, qu'il s'agisse de la session en cours ou de la relecture d'un bilan archivé.
  const runAnalysis = useCallback(() => {
    setResult(runEngine(trials, profile, subjective.weights));
    setResultsOrigin('session');
    setStage('results');
  }, [trials, profile, subjective.weights]);

  // Historique : runEngine est une fonction pure (trials/profile/weights -> résultat), donc pas
  // besoin de persister le résultat calculé d'un bilan archivé — on le recalcule à la demande,
  // exactement comme pour la session en cours (runAnalysis ci-dessus). Ça évite aussi qu'un
  // résultat archivé devienne incohérent si la logique de scoring évolue plus tard.
  const viewHistoryEntry = useCallback((entry) => {
    setResult(runEngine(entry.trials, entry.profile, subjective.weights));
    setResultsOrigin('history');
    setStage('results');
  }, [subjective.weights]);

  const deleteHistoryEntry = useCallback((id) => {
    setHistory((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const openFeedbackForm = useCallback((entry) => {
    setFeedbackTarget(entry);
    setStage('feedback-form');
  }, []);

  const cancelFeedbackForm = useCallback(() => {
    setFeedbackTarget(null);
    setStage('history');
  }, []);

  // entries : FeedbackEntry[] pour CETTE sortie (une valeur par zone, cf. FeedbackForm). On
  // recalibre à partir des poids courants (pas neutres à chaque fois) pour que l'effet des
  // sorties précédentes s'accumule dans le temps — cf. test moteur "2 sorties consécutives".
  const submitFeedback = useCallback(
    (entries) => {
      setSubjective((prev) => {
        const feedbackLog = [...prev.feedbackLog, { id: `f${Date.now()}`, date: new Date().toISOString(), sessionId: feedbackTarget?.id, entries }];
        return { weights: recalibrateWeights(prev.weights, feedbackLog.map((f) => f.entries)), feedbackLog };
      });
      setFeedbackTarget(null);
      setStage('history');
    },
    [feedbackTarget]
  );

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
      return (
        <WelcomeScreen
          onStart={() => setStage('aslr-capture')}
          historyCount={history.length}
          onViewHistory={() => setStage('history')}
        />
      );
    case 'history':
      return (
        <HistoryScreen
          history={history}
          feedbackLog={subjective.feedbackLog}
          onOpen={viewHistoryEntry}
          onDelete={deleteHistoryEntry}
          onOpenFeedback={openFeedbackForm}
          onBack={() => setStage(profile ? 'session' : 'welcome')}
        />
      );
    case 'feedback-form':
      return <FeedbackForm sessionEntry={feedbackTarget} onSubmit={submitFeedback} onCancel={cancelFeedbackForm} />;
    case 'aslr-capture':
      return <PostureCaptureFlow key="aslr" initialMode="aslr_test" onCaptured={handleAslrCaptured} onCancel={cancelAslrCapture} />;
    case 'profile-form':
      return <ProfileForm aslrAngle={aslrAngle} aslrKneeAngle={aslrKneeAngle} onSubmit={handleProfileSubmit} onRetakeAslr={retakeAslr} />;
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
    case 'trial-review':
      return (
        <TrialReviewScreen
          step={reviewStep}
          pendingTrial={pendingTrial}
          onClose={closeReview}
          onRedo={reviewStep === 'video' ? redoTrialVideo : redoTrialPhoto}
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
      return resultsOrigin === 'history' ? (
        <ResultsScreen result={result} onBack={() => setStage('history')} backLabel="Retour à l'historique" />
      ) : (
        <ResultsScreen result={result} onBack={() => setStage('session')} />
      );
    case 'session':
    default:
      return (
        <SessionScreen
          profile={profile}
          trials={trials}
          athleteInseamCm={athleteInseamCm}
          onNewTrial={startNewTrial}
          onAnalyze={runAnalysis}
          onNewSession={startNewSession}
        />
      );
  }
}

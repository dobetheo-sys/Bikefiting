import { useState, useEffect, useCallback, Component } from 'react';
import { ArrowRight, RotateCcw, Plus, AlertTriangle, Loader2, CheckCircle2, Watch, Video } from 'lucide-react';
import PrivacyNote from './components/PrivacyNote.jsx';
import { getSwimVisionFileset } from './swim-capture/mediapipe-vision';
import { createSwimPoseLandmarker, toPoseFrame } from './swim-capture/swim-pose-integration';
import { sampleVideoFrames } from './swim-capture/video-frame-sampler';
import { computeRollProxy } from './swim-capture/swim-capture-processing';
import { runSwimEngine } from './swim-engine/swim-analysis-engine';

// SwimApp.jsx — orchestre le bilan nage : profil (bassin/niveau) -> longueurs (saisie
// manuelle) -> résultats (runSwimEngine). Implémente SPEC_ANALYSE_NAGE_MOTEUR.md.
//
// DÉCISION DE CONCEPTION CENTRALE, à ne pas re-questionner sans relire d'abord le handoff
// vélo : côté vélo, la détection automatique de landmarks sur vraie vidéo a produit 3 bugs
// réels coup sur coup (HANDOFF_CLAUDE_CODE.md) avant que l'équipe ne pivote vers une mesure
// MANUELLE (l'utilisateur pointe lui-même les angles sur son image) pour tout ce qui compte
// vraiment dans le score — la détection auto n'est restée câblée que pour la segmentation
// (problème mieux posé, silhouette entière sur fond fixe). Ici, la couche 1 du moteur nage
// (SR/DPS/SWOLF/respiration — cf. §3 du spec) ne dépend d'AUCUN modèle de vision : ce sont
// des comptages qu'un nageur peut faire lui-même (chrono + comptage de brasses/respirations),
// exactement comme TrialDeltasForm côté vélo demande une mesure directe plutôt qu'un calcul
// automatique. La vidéo + MediaPipe reste disponible mais UNIQUEMENT pour le signal optionnel
// couche 2 (roulis, confiance faible par nature, cf. §4 du spec) — jamais pour les métriques
// qui alimentent le score. Ce choix évite de reproduire le même cycle de bugs, sans même
// pouvoir tester sur vrai appareil dans ce sandbox (audit professionnels, point 7).

const SWIM_SESSION_STORAGE_KEY = 'swim-analysis-session-v1';

function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(SWIM_SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistSession(profile, lengths) {
  try {
    localStorage.setItem(SWIM_SESSION_STORAGE_KEY, JSON.stringify({ profile, lengths }));
  } catch {
    // best-effort, cf. même choix côté vélo (SESSION_STORAGE_KEY)
  }
}

function initialStageFor(saved) {
  if (!saved) return 'welcome';
  if (saved.profile) return 'session';
  return 'welcome';
}

// ---------- Erreur non rattrapée : garde-fou indépendant de celui du vélo (pas d'import
// croisé, cf. §8 du spec nage) — nettoie sa propre clé localStorage, pas SESSION_STORAGE_KEY.
class SwimErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(error) {
    console.error('Crash non rattrapé (swim) :', error);
  }
  handleReset = () => {
    try {
      localStorage.removeItem(SWIM_SESSION_STORAGE_KEY);
    } catch {
      // best-effort
    }
    window.location.reload();
  };
  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="w-full h-full min-h-screen bg-bg text-text font-sans flex flex-col items-center justify-center px-6 text-center">
        <AlertTriangle className="w-8 h-8 text-gold mb-3" />
        <h1 className="text-lg font-semibold mb-2">Un problème inattendu est survenu</h1>
        <p className="text-text-dim text-sm max-w-xs mb-6">
          Les données de ta session précédente semblent corrompues. Tu peux repartir de zéro — tes longueurs déjà
          enregistrées seront perdues.
        </p>
        <button
          onClick={this.handleReset}
          className="flex items-center justify-center gap-2 py-3 px-6 rounded-control bg-gold text-ink font-semibold focus:outline-none focus:ring-2 focus:ring-cyan"
        >
          <RotateCcw className="w-4 h-4" /> Effacer la session et redémarrer
        </button>
      </div>
    );
  }
}

// ---------- Vision optionnelle (couche 2 uniquement, cf. commentaire en tête de fichier) ----------
// Extrait uniquement le roulis proxy depuis une vidéo — jamais le comptage de brasses/
// respirations, qui reste toujours une saisie manuelle (source de vérité, couche 1).
const ROLL_PROXY_SAMPLE_COUNT = 60; // [DEFAULT] compromis coût/précision, non calibré sur vraie vidéo

async function extractRollProxyFromVideo(blob) {
  const fileset = await getSwimVisionFileset();
  const landmarker = await createSwimPoseLandmarker(fileset);
  try {
    const frames = [];
    await sampleVideoFrames(blob, ROLL_PROXY_SAMPLE_COUNT, (sampled) => {
      const result = landmarker.detectForVideo(sampled.video, sampled.timestampMs);
      const frame = toPoseFrame(result, sampled.timestampMs);
      if (frame) frames.push(frame);
    });
    if (frames.length === 0) return null;
    return computeRollProxy(frames);
  } finally {
    landmarker.close();
  }
}

// ---------- UI ----------

function ScreenShell({ eyebrow, eyebrowColor = 'text-gold', title, subtitle, children, footer }) {
  return (
    <div className="w-full h-screen bg-bg text-text font-sans flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-10 pb-8 max-w-md mx-auto w-full">
          {eyebrow && <div className={`text-xs tracking-widest uppercase mb-2 font-mono ${eyebrowColor}`}>{eyebrow}</div>}
          {title && <h1 className="text-xl font-semibold mb-1">{title}</h1>}
          {subtitle}
          {children}
        </div>
      </div>
      {footer && (
        <div className="px-6 py-5 border-t border-border bg-bg">
          <div className="max-w-md mx-auto w-full space-y-3">{footer}</div>
        </div>
      )}
    </div>
  );
}

function StepCard({ icon: Icon, step, title, children, accent }) {
  return (
    <div className="rounded-card border border-border bg-surface p-4 flex gap-4">
      <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold font-mono ${accent}`}>{step}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="w-4 h-4 text-text-faint shrink-0" />
          <h3 className="font-medium text-text">{title}</h3>
        </div>
        <p className="text-sm text-text-dim leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function WelcomeScreen({ onStart }) {
  return (
    <ScreenShell
      eyebrow="Bilan technique de nage"
      title=""
      footer={
        <button
          onClick={onStart}
          className="w-full py-3.5 rounded-control bg-gold text-ink font-semibold focus:outline-none focus:ring-2 focus:ring-cyan flex items-center justify-center gap-2"
        >
          Commencer <ArrowRight className="w-4 h-4" />
        </button>
      }
    >
      <h1 className="font-display text-4xl -skew-x-[4deg] inline-block leading-snug mb-2 mt-1">Crawl, V0</h1>
      <p className="text-text-dim text-sm leading-relaxed mb-8">
        Ce bilan mesure ce qu'on peut mesurer de façon fiable sans équipement spécial : rythme de nage, distance par
        brasse, SWOLF, symétrie de respiration. Rien de sous-marin (attaque, traction) — voir pourquoi ci-dessous.
      </p>

      <h2 className="text-xs tracking-widest text-text-faint uppercase mb-3 font-mono">Comment ça marche</h2>
      <div className="space-y-3 mb-8">
        <StepCard icon={Watch} step="1" title="Chronomètre une longueur" accent="bg-cyan/10 text-cyan">
          Départ au premier mouvement, arrêt au mur. Compte tes brasses (chaque entrée de bras, gauche ET droite) et
          note de quel côté tu respires.
        </StepCard>
        <StepCard icon={Plus} step="2" title="Répète" accent="bg-orange/10 text-orange-tint">
          Au moins 3 longueurs pour un score fiable — 1 seule reste possible mais le moteur le signale comme un
          agrégat fragile.
        </StepCard>
        <StepCard icon={CheckCircle2} step="3" title="Résultats" accent="bg-gold/10 text-gold">
          Rythme, distance par brasse, SWOLF, symétrie de respiration, score d'efficacité relatif à tes propres
          longueurs — pas une comparaison à l'élite.
        </StepCard>
      </div>

      <div className="rounded-card border border-border bg-surface/50 p-4 mb-4">
        <p className="text-xs text-text-faint leading-relaxed">
          Pourquoi pas de vidéo automatique par défaut ? La détection de pose sous-marine grand public n'est pas
          fiable (réfraction, bulles) — et même hors de l'eau, ce genre de détection automatique s'est révélé fragile
          sur vraie vidéo dans un projet précédent. Le comptage manuel est la source de vérité ici ; une vidéo reste
          possible plus tard pour un signal de roulis expérimental, en complément, jamais à la place.
        </p>
      </div>

      <PrivacyNote className="mb-8" />
    </ScreenShell>
  );
}

function ToggleGroup({ label, value, options, onChange }) {
  return (
    <div>
      <div className="text-sm text-text mb-1.5">{label}</div>
      <div className="flex gap-2 flex-wrap">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex-1 py-2 px-2 rounded-control border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-gold ${
              value === opt.value ? 'bg-gold border-gold text-ink font-semibold' : 'border-border text-text-dim'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const LEVEL_OPTIONS = [
  { value: 'debutant', label: 'Débutant' },
  { value: 'intermediaire', label: 'Intermédiaire' },
  { value: 'confirme', label: 'Confirmé' },
  { value: 'competition', label: 'Compétition' },
];

function ProfileForm({ onSubmit }) {
  const [poolLengthM, setPoolLengthM] = useState(25);
  const [level, setLevel] = useState('intermediaire');
  const [dominantBreathingSide, setDominantBreathingSide] = useState('');

  return (
    <ScreenShell
      eyebrow="Avant de commencer"
      title="Ton profil"
      footer={
        <button
          onClick={() => onSubmit({ poolLengthM, level, dominantBreathingSide: dominantBreathingSide || undefined })}
          className="w-full py-3 rounded-control bg-gold text-ink font-semibold focus:outline-none focus:ring-2 focus:ring-cyan flex items-center justify-center gap-2"
        >
          Continuer <ArrowRight className="w-4 h-4" />
        </button>
      }
    >
      <div className="space-y-6 mt-4 mb-6">
        <ToggleGroup
          label="Longueur du bassin"
          value={poolLengthM}
          onChange={setPoolLengthM}
          options={[
            { value: 25, label: '25 m' },
            { value: 50, label: '50 m' },
          ]}
        />
        <ToggleGroup label="Ton niveau" value={level} onChange={setLevel} options={LEVEL_OPTIONS} />
        <p className="text-xs text-text-faint -mt-4 leading-relaxed">
          Sert uniquement à contextualiser l'affichage — aucun seuil "bon DPS par niveau" n'est appliqué ici (pas de
          base fiable trouvée, cf. spec §9 : à calibrer avec un entraîneur).
        </p>
        <ToggleGroup
          label="Côté de respiration habituel (optionnel)"
          value={dominantBreathingSide}
          onChange={setDominantBreathingSide}
          options={[
            { value: '', label: 'Pas de préférence' },
            { value: 'left', label: 'Gauche' },
            { value: 'right', label: 'Droite' },
          ]}
        />
      </div>
    </ScreenShell>
  );
}

function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div className="h-full bg-gold transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

function LengthCard({ length, index }) {
  const breathing = length.breathingSides ?? [];
  const left = breathing.filter((s) => s === 'left').length;
  const right = breathing.length - left;
  return (
    <div className="p-4 text-sm font-mono">
      <div className="text-text">Longueur {index + 1}</div>
      <div className="text-xs text-text-faint mt-1">
        {length.durationS}s · {length.strokeCount} brasses
        {breathing.length > 0 && ` · resp. G${left}/D${right}`}
        {length.rollProxyDeg && ` · roulis ~${length.rollProxyDeg.value}° (${length.rollProxyDeg.confidence})`}
      </div>
    </div>
  );
}

function SessionScreen({ profile, lengths, onAddLength, onAnalyze, onNewSession }) {
  const minLengths = 3;
  const remaining = Math.max(0, minLengths - lengths.length);
  return (
    <ScreenShell
      eyebrow="Session"
      title="Tes longueurs"
      footer={
        <>
          <button
            onClick={onAddLength}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-control border border-border text-text focus:outline-none focus:ring-2 focus:ring-gold"
          >
            <Plus className="w-4 h-4" /> Ajouter une longueur
          </button>
          <button
            onClick={onAnalyze}
            disabled={lengths.length === 0}
            className="w-full py-3 rounded-control bg-gold text-ink font-semibold disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-cyan"
          >
            Voir les résultats
          </button>
          <button
            onClick={() => {
              if (confirm('Nouvelle session et repartir de zéro ?')) onNewSession();
            }}
            className="w-full text-xs text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded"
          >
            Nouvelle session
          </button>
        </>
      }
    >
      <p className="text-text-dim text-sm mb-3">
        Bassin {profile.poolLengthM} m · Niveau {LEVEL_OPTIONS.find((o) => o.value === profile.level)?.label ?? profile.level}
      </p>

      <div className="mb-1 mt-3">
        <ProgressBar value={lengths.length} max={minLengths} />
      </div>
      <p className="text-xs text-text-faint mb-1 font-mono">
        {lengths.length}/{minLengths} longueurs
      </p>
      <p className="text-text-faint text-xs mb-6">
        {remaining > 0
          ? `Encore ${remaining} longueur${remaining > 1 ? 's' : ''} pour un agrégat que le moteur considère fiable (en dessous, le score reste calculable mais ramené vers neutre).`
          : 'Tu peux déjà voir tes résultats — ajoute d\'autres longueurs pour affiner la tendance.'}
      </p>

      <div className="rounded-card border border-border bg-surface divide-y divide-border mb-6">
        {lengths.length === 0 && <p className="text-sm text-text-faint p-4">Aucune longueur enregistrée pour l'instant.</p>}
        {lengths.map((l, i) => (
          <LengthCard key={l.id} length={l} index={i} />
        ))}
      </div>

      <p className="text-text-faint text-xs mb-6">Reprend automatiquement ici si tu quittes ou si le navigateur plante.</p>
    </ScreenShell>
  );
}

function NumberField({ label, value, onChange, suffix, required, hint }) {
  return (
    <div>
      <label className="flex items-center justify-between gap-3 text-sm text-text">
        <span>
          {label}
          {required && <span className="text-gold"> *</span>}
        </span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-24 bg-surface-2 border border-border rounded px-2 py-1.5 text-text text-right focus:outline-none focus:ring-2 focus:ring-gold"
          />
          {suffix && <span className="text-xs text-text-faint w-10">{suffix}</span>}
        </span>
      </label>
      {hint && <p className="text-xs text-text-faint mt-1 pr-16 leading-relaxed">{hint}</p>}
    </div>
  );
}

function AddLengthScreen({ lengthNumber, onSave, onCancel }) {
  const [durationS, setDurationS] = useState('');
  const [strokeCount, setStrokeCount] = useState('');
  const [breathLeft, setBreathLeft] = useState('');
  const [breathRight, setBreathRight] = useState('');
  const [videoStatus, setVideoStatus] = useState('idle'); // idle | processing | done | error
  const [rollProxy, setRollProxy] = useState(null);
  const [videoError, setVideoError] = useState('');

  const requiredValid = Number(durationS) > 0 && Number(strokeCount) > 0;

  const handleVideoChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoStatus('processing');
    setVideoError('');
    try {
      const roll = await extractRollProxyFromVideo(file);
      setRollProxy(roll);
      setVideoStatus('done');
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : String(err));
      setVideoStatus('error');
    }
  }, []);

  const handleSave = () => {
    const breathingSides = [];
    for (let i = 0; i < Number(breathLeft || 0); i++) breathingSides.push('left');
    for (let i = 0; i < Number(breathRight || 0); i++) breathingSides.push('right');
    const length = {
      id: `l${lengthNumber}-${Date.now()}`,
      durationS: Number(durationS),
      strokeCount: Number(strokeCount),
      breathingSides,
    };
    if (rollProxy) length.rollProxyDeg = rollProxy;
    onSave(length);
  };

  return (
    <ScreenShell
      eyebrow={`Longueur ${lengthNumber}`}
      title="Ce que tu as chronométré"
      footer={
        <>
          <button
            onClick={handleSave}
            disabled={!requiredValid}
            className="w-full py-3 rounded-control bg-gold text-ink font-semibold disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-cyan"
          >
            Enregistrer cette longueur
          </button>
          <button onClick={onCancel} className="w-full text-sm text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded">
            Annuler
          </button>
        </>
      }
    >
      <div className="space-y-5 mt-4 mb-6">
        <NumberField label="Durée" value={durationS} onChange={setDurationS} suffix="s" required hint="Chronométrée du premier mouvement au mur." />
        <NumberField label="Nombre de brasses" value={strokeCount} onChange={setStrokeCount} suffix="brasses" required hint="Chaque entrée de bras compte, gauche et droite (convention non universelle, cf. spec §9 — adapte si ton entraîneur compte autrement)." />
        <div className="flex gap-3">
          <div className="flex-1">
            <NumberField label="Resp. gauche" value={breathLeft} onChange={setBreathLeft} />
          </div>
          <div className="flex-1">
            <NumberField label="Resp. droite" value={breathRight} onChange={setBreathRight} />
          </div>
        </div>
        <p className="text-xs text-text-faint -mt-3 leading-relaxed">Optionnel — laisse à 0 si tu n'as pas compté.</p>
      </div>

      <div className="rounded-card border border-border bg-surface p-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Video className="w-4 h-4 text-text-faint" />
          <h3 className="text-sm font-medium text-text">Vidéo (optionnel, expérimental)</h3>
        </div>
        <p className="text-xs text-text-faint leading-relaxed mb-3">
          Ajoute un signal de roulis approximatif à partir d'une vidéo de cette longueur, caméra fixe au bord du
          bassin. Confiance toujours faible (cf. spec §4) — n'affecte jamais le comptage ci-dessus ni le score
          d'efficacité.
        </p>
        <label className="flex items-center justify-center gap-2 py-2.5 rounded-control border border-border text-sm text-text cursor-pointer focus-within:ring-2 focus-within:ring-gold">
          <input type="file" accept="video/*" capture="environment" className="hidden" onChange={handleVideoChange} />
          Choisir une vidéo
        </label>
        {videoStatus === 'processing' && (
          <div className="flex items-center gap-2 mt-3 text-xs text-text-faint">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyse en cours…
          </div>
        )}
        {videoStatus === 'done' && rollProxy && (
          <p className="text-xs text-cyan mt-3">Roulis estimé : {rollProxy.value}° (confiance {rollProxy.confidence})</p>
        )}
        {videoStatus === 'done' && !rollProxy && (
          <p className="text-xs text-text-faint mt-3">Aucun cycle de bras détecté sur cette vidéo — longueur enregistrée sans signal de roulis.</p>
        )}
        {videoStatus === 'error' && <p className="text-xs text-danger mt-3">Échec de l'analyse : {videoError} — la longueur reste enregistrable sans ce signal.</p>}
      </div>
    </ScreenShell>
  );
}

function MetricTile({ value, unit, label }) {
  return (
    <div>
      <div className="font-display text-4xl text-text">
        {value}
        <span className="text-base text-text-faint ml-1">{unit}</span>
      </div>
      <div className="text-xs text-text-faint mt-0.5">{label}</div>
    </div>
  );
}

function ResultsScreen({ result, onBack }) {
  return (
    <ScreenShell
      eyebrow="Résultats"
      title="Ton bilan"
      footer={
        <button onClick={onBack} className="w-full py-3 rounded-control bg-gold text-ink font-semibold focus:outline-none focus:ring-2 focus:ring-cyan">
          Retour à la session
        </button>
      }
    >
      <div className="rounded-card border border-border bg-surface p-4 mb-6 mt-4">
        <div className="text-xs tracking-widest text-gold uppercase mb-2 font-mono">Score d'efficacité (relatif à toi)</div>
        <div className="font-display text-5xl text-gold">{result.efficiency_score}</div>
        <p className="text-xs text-text-faint mt-2">Sur {result.lengths_analyzed} longueur(s) analysée(s) — compare tes séances entre elles, pas à une référence absolue (cf. spec §5/§9).</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <MetricTile value={result.measured.stroke_rate_avg} unit="c/min" label="Rythme moyen" />
        <MetricTile value={result.measured.dps_avg_m} unit="m" label="Distance/brasse" />
        <MetricTile value={result.measured.swolf_avg} unit="" label="SWOLF moyen" />
      </div>

      {result.flags.length > 0 && (
        <div className="rounded-card border border-gold/20 bg-gold/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-gold uppercase mb-1 font-mono">À noter</div>
          {result.flags.map((f, i) => (
            <p key={i} className="text-sm text-gold">{f.detail}</p>
          ))}
        </div>
      )}

      {result.shoulder_vigilance && (
        <div className="rounded-card border border-danger/30 bg-danger/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-danger uppercase mb-1 font-mono">Vigilance épaule</div>
          <p className="text-sm text-danger/90">
            Pattern répété sur tes derniers retours — pas un diagnostic, mais une consultation kiné/médecin du sport
            peut valoir le coup (cf. spec §6).
          </p>
        </div>
      )}

      {(result.vision_signals.roll_proxy_deg || result.vision_signals.kick_index) && (
        <div className="rounded-card border border-cyan/20 bg-cyan/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-cyan uppercase mb-2 font-mono">Signaux vision (expérimental)</div>
          {result.vision_signals.roll_proxy_deg && (
            <p className="text-sm text-cyan">Roulis ~{result.vision_signals.roll_proxy_deg.value}° (confiance {result.vision_signals.roll_proxy_deg.confidence})</p>
          )}
          {result.vision_signals.kick_index && (
            <p className="text-sm text-cyan">Indice de battement {result.vision_signals.kick_index.value} (confiance {result.vision_signals.kick_index.confidence})</p>
          )}
        </div>
      )}

      <div className="rounded-card border border-border bg-surface/50 p-4 mb-8">
        <p className="text-xs text-text-faint leading-relaxed">{result.out_of_scope_note}</p>
      </div>
    </ScreenShell>
  );
}

// ---------- App ----------

function SwimAppInner() {
  const saved = loadPersistedSession();
  const [stage, setStage] = useState(initialStageFor(saved));
  const [profile, setProfile] = useState(saved?.profile ?? null);
  const [lengths, setLengths] = useState(saved?.lengths ?? []);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (profile) persistSession(profile, lengths);
  }, [profile, lengths]);

  const handleProfileSubmit = useCallback((p) => {
    setProfile(p);
    setStage('session');
  }, []);

  const handleLengthSaved = useCallback((length) => {
    setLengths((prev) => [...prev, length]);
    setStage('session');
  }, []);

  const handleAnalyze = useCallback(() => {
    setResult(runSwimEngine(lengths, profile));
    setStage('results');
  }, [lengths, profile]);

  const handleNewSession = useCallback(() => {
    setProfile(null);
    setLengths([]);
    setResult(null);
    try {
      localStorage.removeItem(SWIM_SESSION_STORAGE_KEY);
    } catch {
      // best-effort
    }
    setStage('welcome');
  }, []);

  if (stage === 'welcome') return <WelcomeScreen onStart={() => setStage('profile-form')} />;
  if (stage === 'profile-form') return <ProfileForm onSubmit={handleProfileSubmit} />;
  if (stage === 'add-length')
    return <AddLengthScreen lengthNumber={lengths.length + 1} onSave={handleLengthSaved} onCancel={() => setStage('session')} />;
  if (stage === 'results' && result) return <ResultsScreen result={result} onBack={() => setStage('session')} />;
  return (
    <SessionScreen
      profile={profile}
      lengths={lengths}
      onAddLength={() => setStage('add-length')}
      onAnalyze={handleAnalyze}
      onNewSession={handleNewSession}
    />
  );
}

export default function SwimApp() {
  return (
    <SwimErrorBoundary>
      <SwimAppInner />
    </SwimErrorBoundary>
  );
}

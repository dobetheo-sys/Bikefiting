import { useState, useCallback, useEffect } from 'react';
import {
  ArrowRight,
  Plus,
  Check,
  ChevronRight,
  Circle,
  CheckCircle2,
  Footprints,
  Gauge,
  Smartphone,
  ShieldCheck,
  Timer,
  Video,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import PostureCaptureFlow from './PostureCaptureFlow.jsx';
import PrivacyNote from './PrivacyNote.jsx';
import { ScreenShell, StepCard, GearItem, NumberField } from './ui.jsx';
import {
  buildRunTrialMetrics,
  computeCadenceSpm,
  describeFootStrike,
  RUN_MEASUREMENT_RESOLUTION_DEG,
} from '../capture/running-capture-processing';
import {
  cadenceGainPct,
  cadenceTargetSpm,
  runRunningEngine,
  suggestNextRunTrial,
} from '../engine/running-gait-engine';

// RunningSession.jsx — parcours complet d'analyse de foulée : introduction -> profil (dont la
// cadence spontanée, obligatoire) -> essais (vidéo + 6 taps, puis cadence) -> runRunningEngine.
// Voir docs/SPEC_MOTEUR_COURSE.md pour le protocole et les limites.
//
// Volontairement autonome vis-à-vis d'App.jsx (son état, sa clé de persistance, son moteur) :
// un profil athlète course et un profil bike-fit n'ont ni les mêmes champs ni la même durée de
// validité, et les essais ne sont pas comparables. Les deux parcours ne partagent que les
// primitives d'écran (ui.jsx) et le flux de capture (PostureCaptureFlow).

const STORAGE_KEY = 'posture-run-session-v1';

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.profile && Array.isArray(parsed.trials)) return parsed;
  } catch {
    // stockage indisponible ou données corrompues — on repart d'une session vierge
  }
  return null;
}

// ---------- Saisie de cadence ----------

// Deux modes plutôt qu'un seul champ : compter ses appuis sur une durée est faisable par tout le
// monde sans matériel, mais quiconque a une montre qui affiche déjà la cadence n'a aucune raison
// de refaire le calcul à la main. Le piège que les deux modes doivent éviter est le même —
// confondre appuis et foulées — d'où le rappel explicite, cf. computeCadenceSpm.
function CadenceInput({ value, onChange, label }) {
  const [mode, setMode] = useState('count'); // 'count' | 'direct'
  const [steps, setSteps] = useState('');
  const [durationS, setDurationS] = useState('30');

  const computed = (() => {
    const s = Number(steps);
    const d = Number(durationS);
    if (!(s > 0) || !(d > 0)) return null;
    return computeCadenceSpm(s, d);
  })();

  // Remonte la valeur calculée dès qu'elle change, pour que le parent n'ait pas à connaître le
  // mode de saisie choisi.
  useEffect(() => {
    if (mode === 'count') onChange(computed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, mode]);

  return (
    <div className="rounded-card border border-border bg-surface p-4 space-y-3">
      <div className="text-sm text-text">{label}</div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('count')}
          className={`flex-1 py-2 rounded-control border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-gold ${
            mode === 'count' ? 'bg-gold border-gold text-ink font-semibold' : 'border-border text-text-dim'
          }`}
        >
          Compter mes appuis
        </button>
        <button
          type="button"
          onClick={() => setMode('direct')}
          className={`flex-1 py-2 rounded-control border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-gold ${
            mode === 'direct' ? 'bg-gold border-gold text-ink font-semibold' : 'border-border text-text-dim'
          }`}
        >
          Saisie directe
        </button>
      </div>

      {mode === 'count' ? (
        <>
          <NumberField label="Appuis comptés" value={steps} onChange={setSteps} required />
          <NumberField label="Sur une durée de" value={durationS} onChange={setDurationS} suffix="s" required />
          <p className="text-xs text-text-faint leading-relaxed">
            Compte <strong className="text-text-dim">chaque</strong> pied qui touche le tapis, pas les foulées — une
            foulée fait deux appuis. Compter les foulées donnerait une cadence deux fois trop basse et fausserait tout
            le reste de l'analyse.
          </p>
          <div className="rounded border border-border bg-surface-2 px-3 py-2 min-h-[3.25rem] flex flex-col justify-center">
            {computed ? (
              <>
                <div className="font-display text-2xl text-cyan">{computed} pas/min</div>
                <div className="text-xs text-text-faint">
                  {steps} appuis ÷ {durationS} s × 60
                </div>
              </>
            ) : (
              <div className="text-xs text-text-faint">Renseigne les deux champs pour obtenir ta cadence.</div>
            )}
          </div>
        </>
      ) : (
        <>
          <NumberField
            label="Cadence"
            value={value ?? ''}
            onChange={(v) => onChange(Number(v) > 0 ? Number(v) : null)}
            suffix="spm"
            required
          />
          <p className="text-xs text-text-faint leading-relaxed">
            En pas par minute (et non en foulées par minute) — c'est ce qu'affichent la plupart des montres sous le nom
            « cadence de course ». Un ordre de grandeur courant se situe entre 150 et 190.
          </p>
        </>
      )}
    </div>
  );
}

// ---------- Introduction ----------

function RunIntroScreen({ onStart, onExit }) {
  return (
    <ScreenShell
      eyebrow="Analyse de foulée"
      eyebrowColor="text-cyan"
      title="Ce qui va se passer"
      subtitle={
        <p className="text-text-dim text-sm leading-relaxed mb-6 mt-1">
          Compte 20 à 30 minutes sur un tapis de course. On va comparer ta foulée à trois cadences différentes, à
          vitesse constante, et regarder ce que chacune coûte et rapporte.
        </p>
      }
      footer={
        <>
          <button
            onClick={onStart}
            className="w-full py-3.5 rounded-control bg-cyan text-ink font-semibold focus:outline-none focus:ring-2 focus:ring-gold flex items-center justify-center gap-2"
          >
            Commencer <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={onExit}
            className="w-full py-2 text-sm text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded"
          >
            Retour à l'accueil
          </button>
        </>
      }
    >
      <h2 className="text-xs tracking-widest text-text-faint uppercase mb-3 font-mono">Le déroulé</h2>
      <div className="space-y-3 mb-8">
        <StepCard icon={Gauge} step="1" title="Ta cadence spontanée" duration="~3 min" accent="bg-cyan/10 text-cyan">
          Tu cours à allure confortable sans y penser, et tu comptes tes appuis. Tout le reste de l'analyse se mesure
          par rapport à cette valeur — il n'y a pas de « bonne » cadence universelle, seulement la tienne et ce qui se
          passe quand tu t'en écartes.
        </StepCard>
        <StepCard icon={Footprints} step="2" title="Trois essais" duration="~10 min par essai" accent="bg-orange/10 text-orange-tint">
          À ta cadence spontanée, puis +5 %, puis +10 % — les trois écarts dont les effets ont été mesurés en
          laboratoire. Même vitesse de tapis à chaque fois. Pour chacun : une vidéo de profil, puis tu mesures
          5 appuis (6 points chacun) et 2 images de bassin. C'est long, et c'est voulu : une mesure sur un seul
          appui a autant d'incertitude que l'écart entre deux coureurs différents.
        </StepCard>
        <StepCard icon={CheckCircle2} step="3" title="Résultats" accent="bg-gold/10 text-gold">
          Un score de charge et un score d'économie par essai. Ils s'opposent : monter la cadence allège les
          articulations, mais s'éloigner de ta foulée naturelle coûte en économie. L'app te montre le compromis,
          elle ne choisit pas à ta place.
        </StepCard>
      </div>

      <h2 className="text-xs tracking-widest text-text-faint uppercase mb-3 font-mono">Matériel nécessaire</h2>
      <div className="rounded-card border border-border bg-surface px-4 mb-8">
        <GearItem icon={Gauge} title="Un tapis de course">
          Indispensable en V1 : il garantit une vitesse constante entre les essais, sans quoi ils ne sont pas
          comparables. En extérieur, tu ne serais visible que sur 1 ou 2 appuis par passage et les angles seraient
          faussés par la perspective.
        </GearItem>
        <GearItem icon={Smartphone} title="Un smartphone">
          Posé sur le côté du tapis, pas devant ni derrière — c'est une vue de profil qu'il faut.
        </GearItem>
        <GearItem icon={ShieldCheck} title="Un support fixe">
          Trépied, étagère, machine voisine. À hauteur de hanche et bien perpendiculaire au tapis.
        </GearItem>
        <GearItem icon={Timer} title="Un métronome">
          Une appli gratuite suffit. C'est le seul moyen fiable de tenir une cadence cible pendant un essai.
        </GearItem>
      </div>

      <PrivacyNote className="mb-4" />

      <div className="rounded-card border border-gold/20 bg-gold/5 p-4 mb-4">
        <p className="text-xs text-gold/80 leading-relaxed">
          Cet outil estime une charge mécanique, il ne prédit pas une blessure : le lien entre cadence et charge est
          documenté, celui entre charge et blessure chez une personne donnée ne l'est pas. Il ne remplace ni un avis
          médical ni l'accompagnement d'un entraîneur. Change ta cadence progressivement.
        </p>
      </div>
    </ScreenShell>
  );
}

// ---------- Profil ----------

function RunProfileForm({ initial, onSubmit, onCancel }) {
  const [heightCm, setHeightCm] = useState(initial?.heightCm ? String(initial.heightCm) : '178');
  const [testSpeedKmh, setTestSpeedKmh] = useState(initial?.testSpeedKmh ? String(initial.testSpeedKmh) : '12');
  const [cadence, setCadence] = useState(initial?.selfSelectedCadenceSpm ?? null);
  const [goal, setGoal] = useState(initial?.goal ?? null);

  const valid = Number(heightCm) > 0 && Number(testSpeedKmh) > 0 && cadence > 0;

  return (
    <ScreenShell
      eyebrow="Analyse de foulée"
      eyebrowColor="text-cyan"
      title="Ta référence"
      subtitle={
        <p className="text-text-dim text-sm leading-relaxed mb-6 mt-1">
          Cours 3 à 5 minutes à allure confortable, sans chercher à modifier ta foulée, puis compte tes appuis. C'est
          cette cadence spontanée qui sert de référence à toute l'analyse.
        </p>
      }
      footer={
        <>
          <button
            onClick={() =>
              onSubmit({
                heightCm: Number(heightCm),
                testSpeedKmh: Number(testSpeedKmh),
                selfSelectedCadenceSpm: cadence,
                goal: goal ?? undefined,
              })
            }
            disabled={!valid}
            className="w-full py-3 rounded-control bg-cyan text-ink font-semibold disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gold flex items-center justify-center gap-2"
          >
            Continuer <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2 text-sm text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded"
          >
            Retour
          </button>
        </>
      }
    >
      <div className="space-y-4 mb-6">
        <NumberField label="Ta taille" value={heightCm} onChange={setHeightCm} suffix="cm" required />
        <NumberField
          label="Vitesse du tapis"
          value={testSpeedKmh}
          onChange={setTestSpeedKmh}
          suffix="km/h"
          required
          hint="Elle devra rester identique pour tous les essais de la session : un essai filmé à une autre vitesse mesurerait l'effet de la vitesse, pas celui de la cadence, et sera écarté de l'analyse."
        />
      </div>

      <div className="mb-6">
        <CadenceInput value={cadence} onChange={setCadence} label="Ta cadence spontanée à cette vitesse" />
      </div>

      {cadence > 0 && (
        <div className="rounded-card border border-cyan/20 bg-cyan/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-cyan uppercase mb-1 font-mono">Tes essais seront</div>
          <div className="font-mono text-sm text-cyan space-y-0.5 mt-2">
            <div>{cadence} pas/min — cadence spontanée</div>
            <div>{cadenceTargetSpm({ selfSelectedCadenceSpm: cadence }, 5)} pas/min — +5 %</div>
            <div>{cadenceTargetSpm({ selfSelectedCadenceSpm: cadence }, 10)} pas/min — +10 %</div>
          </div>
          <p className="text-xs text-cyan/70 mt-2 leading-relaxed">
            Ces trois points ne sont pas arbitraires : ce sont les écarts effectivement testés dans l'étude de
            référence sur la manipulation de cadence. Au-delà de +10 %, il n'y a plus de données pour dire quoi que ce
            soit.
          </p>
        </div>
      )}

      <div className="mb-6">
        <div className="text-sm text-text mb-1.5">Ce que tu cherches (optionnel)</div>
        <div className="flex gap-2">
          {[
            ['charge', 'Moins de charge'],
            ['economy', 'Plus d’économie'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setGoal(goal === key ? null : key)}
              className={`flex-1 py-2 rounded-control border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-gold ${
                goal === key ? 'bg-gold border-gold text-ink font-semibold' : 'border-border text-text-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-faint mt-1 leading-relaxed">
          Ne change aucun calcul : sélectionne seulement lequel des trois résultats est mis en avant. Sans choix, c'est
          le compromis équilibré qui est proposé.
        </p>
      </div>
    </ScreenShell>
  );
}

// ---------- Session ----------

function RunTrialRow({ trial, profile }) {
  const gain = cadenceGainPct(trial.metrics.cadenceSpm, profile.selfSelectedCadenceSpm);
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-sm text-text">{trial.metrics.cadenceSpm} pas/min</div>
        <div className={`font-mono text-xs ${gain > 0 ? 'text-cyan' : 'text-text-faint'}`}>
          {gain > 0 ? '+' : ''}
          {gain}%
        </div>
      </div>
      <div className="text-xs text-text-faint font-mono mt-1.5">
        {trial.speedKmh} km/h · tibia {trial.metrics.tibiaAngleDeg}° · genou {trial.metrics.kneeFlexionICDeg}° · tronc{' '}
        {trial.metrics.trunkLeanDeg}°
      </div>
      <div className="text-xs text-text-faint font-mono mt-0.5">
        overstriding {trial.metrics.overstrideRatio} · attaque {describeFootStrike(trial.metrics.footStrikeAngleDeg)}
      </div>
    </div>
  );
}

function RunSessionScreen({ profile, trials, onNewTrial, onAnalyze, onEditProfile, onExit }) {
  const minTrials = 3;
  const remaining = Math.max(0, minTrials - trials.length);
  const suggestion = suggestNextRunTrial(trials, profile);

  return (
    <ScreenShell
      eyebrow="Analyse de foulée"
      eyebrowColor="text-cyan"
      title="Tes essais"
      footer={
        <>
          <button
            onClick={onNewTrial}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-control border border-border text-text focus:outline-none focus:ring-2 focus:ring-gold"
          >
            <Plus className="w-4 h-4" /> Nouvel essai
          </button>
          <button
            onClick={onAnalyze}
            disabled={trials.length < minTrials}
            className="w-full py-3 rounded-control bg-cyan text-ink font-semibold disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gold flex items-center justify-center gap-2"
          >
            Analyser <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={onExit}
            className="w-full py-2 text-sm text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded"
          >
            Retour à l'accueil
          </button>
        </>
      }
    >
      <div className="rounded-card border border-border bg-surface p-4 mb-6 mt-4">
        <div className="text-xs tracking-widest text-text-faint uppercase mb-2 font-mono">Référence</div>
        <div className="font-mono text-sm text-text">
          {profile.selfSelectedCadenceSpm} pas/min à {profile.testSpeedKmh} km/h
        </div>
        <button
          onClick={onEditProfile}
          className="text-xs text-text-faint underline underline-offset-4 mt-2 focus:outline-none focus:ring-2 focus:ring-gold rounded"
        >
          Modifier
        </button>
      </div>

      {suggestion && (
        <div className="rounded-card border border-cyan/20 bg-cyan/5 p-4 mb-6">
          <div className="text-xs tracking-widest text-cyan uppercase mb-1 font-mono">Prochain essai</div>
          <p className="text-sm text-cyan/90 leading-relaxed">{suggestion.message}</p>
        </div>
      )}

      <div className="space-y-3 mb-6">
        {trials.length === 0 && (
          <p className="text-sm text-text-dim leading-relaxed">Aucun essai enregistré pour l'instant.</p>
        )}
        {trials.map((t) => (
          <RunTrialRow key={t.id} trial={t} profile={profile} />
        ))}
      </div>

      {remaining > 0 && (
        <p className="text-xs text-text-faint leading-relaxed">
          Encore {remaining} essai{remaining > 1 ? 's' : ''} avant de pouvoir analyser. Il en faut au moins 3 : avec
          moins, il n'y a pas de compromis à montrer, juste des valeurs isolées.
        </p>
      )}
    </ScreenShell>
  );
}

// ---------- Essai en cours ----------

function RunTrialStepRow({ icon: Icon, title, consigne, done, summary, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-card border border-border bg-surface p-4 flex gap-3 items-start focus:outline-none focus:ring-2 focus:ring-gold"
    >
      {done ? (
        <CheckCircle2 className="w-5 h-5 text-cyan shrink-0 mt-0.5" />
      ) : (
        <Circle className="w-5 h-5 text-text-faint shrink-0 mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-text-faint shrink-0" />
          <span className="text-text font-medium">{title}</span>
        </div>
        <p className="text-xs text-text-faint mt-1 leading-relaxed">{done ? summary : consigne}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-text-faint shrink-0 mt-1" />
    </button>
  );
}

function RunTrialOverview({ trialNumber, profile, pendingTrial, onOpenVideo, onOpenCadence, onSave, onCancel }) {
  const hasContact = !!pendingTrial?.contact;
  const hasCadence = pendingTrial?.cadenceSpm > 0;
  const complete = hasContact && hasCadence;

  return (
    <ScreenShell
      eyebrow={`Essai ${trialNumber}`}
      eyebrowColor="text-cyan"
      title="Deux étapes"
      subtitle={
        <p className="text-text-dim text-sm leading-relaxed mb-6 mt-1">
          Dans l'ordre que tu veux. L'essai n'est enregistré qu'une fois les deux faites.
        </p>
      }
      footer={
        <>
          <button
            onClick={onSave}
            disabled={!complete}
            className="w-full py-3 rounded-control bg-cyan text-ink font-semibold disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gold flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" /> Enregistrer l'essai
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2 text-sm text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded"
          >
            Annuler cet essai
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <RunTrialStepRow
          icon={Gauge}
          title="Cadence et vitesse"
          consigne={`Règle ton métronome, cours à la cadence visée à ${profile.testSpeedKmh} km/h, puis compte tes appuis.`}
          done={hasCadence}
          summary={`${pendingTrial?.cadenceSpm} pas/min à ${pendingTrial?.speedKmh} km/h`}
          onClick={onOpenCadence}
        />
        <RunTrialStepRow
          icon={Video}
          title="Vidéo de profil"
          consigne="Filme 10-15 s de profil, puis mesure 5 appuis (6 points chacun) et 2 images de bassin."
          done={hasContact}
          summary={
            hasContact
              ? `Médiane de 5 appuis — tibia ${pendingTrial.contact.tibiaAngleDeg}° · genou ${pendingTrial.contact.kneeFlexionICDeg}° · tronc ${pendingTrial.contact.trunkLeanDeg}°` +
                (pendingTrial.verticalOscillationRatio != null ? ` · oscillation ${pendingTrial.verticalOscillationRatio}` : '')
              : ''
          }
          onClick={onOpenVideo}
        />
      </div>
    </ScreenShell>
  );
}

function RunCadenceForm({ profile, initial, onSubmit, onCancel }) {
  const [cadence, setCadence] = useState(initial?.cadenceSpm ?? null);
  const [speedKmh, setSpeedKmh] = useState(String(initial?.speedKmh ?? profile.testSpeedKmh));

  const valid = cadence > 0 && Number(speedKmh) > 0;

  return (
    <ScreenShell
      eyebrow="Essai en cours"
      eyebrowColor="text-cyan"
      title="Cadence de cet essai"
      footer={
        <>
          <button
            onClick={() => onSubmit({ cadenceSpm: cadence, speedKmh: Number(speedKmh) })}
            disabled={!valid}
            className="w-full py-3 rounded-control bg-cyan text-ink font-semibold disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gold flex items-center justify-center gap-2"
          >
            Valider <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2 text-sm text-text-faint underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-gold rounded"
          >
            Retour
          </button>
        </>
      }
    >
      <div className="mb-6 mt-4">
        <CadenceInput value={cadence} onChange={setCadence} label="Cadence tenue pendant cet essai" />
      </div>

      <div className="space-y-4 mb-6">
        <NumberField
          label="Vitesse du tapis"
          value={speedKmh}
          onChange={setSpeedKmh}
          suffix="km/h"
          required
          hint={`Référence de la session : ${profile.testSpeedKmh} km/h. Saisis la vitesse réellement utilisée — si elle diffère, l'essai sera écarté de l'analyse plutôt que comparé à tort.`}
        />
      </div>

      {cadence > 0 && (
        <p className="text-xs text-text-faint leading-relaxed">
          Soit {cadenceGainPct(cadence, profile.selfSelectedCadenceSpm) > 0 ? '+' : ''}
          {cadenceGainPct(cadence, profile.selfSelectedCadenceSpm)}% par rapport à ta cadence spontanée (
          {profile.selfSelectedCadenceSpm} pas/min).
        </p>
      )}
    </ScreenShell>
  );
}

// ---------- Résultats ----------

const VIOLATION_LABELS = {
  invalid_measurement: (v) => 'Mesure invalide (deux points confondus sur l’image)',
  speed_mismatch: (v) => `Filmé à ${v.value} km/h au lieu de ${v.bound} km/h — non comparable aux autres essais`,
  cadence_implausible: (v) => `Cadence de ${v.value} pas/min invraisemblable — appuis ou durée probablement mal comptés`,
};

const WARNING_LABELS = {
  tibia_forward: (v) => `Tibia à ${v.value}° vers l'avant à l'attaque (repère : sous ${v.bound}°)`,
  overstride: (v) => `Pied posé loin devant le bassin (${v.value}, repère : sous ${v.bound})`,
  stiff_landing: (v) => `Genou peu fléchi à l'attaque (${v.value}°, repère : au moins ${v.bound}°)`,
  trunk_upright: (v) => `Buste très droit (${v.value}°, repère : au moins ${v.bound}°)`,
  trunk_overleaned: (v) => `Buste très penché (${v.value}°, repère : sous ${v.bound}°)`,
};

function formatEntry(labels, v) {
  return labels[v.param] ? labels[v.param](v) : `${v.param} : ${v.value}`;
}

function RunProfileCard({ title, accent, profile, recommended }) {
  if (!profile) return null;
  return (
    <div className={`rounded-card border p-4 ${recommended ? 'border-cyan bg-cyan/5' : 'border-border bg-surface'}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className={`text-xs tracking-widest uppercase font-mono ${accent}`}>{title}</div>
        {recommended && <div className="text-xs text-cyan font-mono">recommandé</div>}
      </div>
      <div className="font-display text-3xl text-text">
        {profile.cadence_spm} <span className="text-lg text-text-dim">pas/min</span>
      </div>
      <div className="text-xs text-text-faint font-mono mt-0.5">
        {profile.cadence_gain_pct > 0 ? '+' : ''}
        {profile.cadence_gain_pct}% vs cadence spontanée
      </div>
      <div className="flex gap-4 mt-3">
        <div>
          <div className="text-xs text-text-faint font-mono uppercase tracking-wide">Charge</div>
          <div className="font-mono text-lg text-text">{profile.charge_score}</div>
        </div>
        <div>
          <div className="text-xs text-text-faint font-mono uppercase tracking-wide">Économie</div>
          <div className="font-mono text-lg text-text">{profile.economy_score}</div>
        </div>
      </div>
      {profile.warnings?.length > 0 && (
        <ul className="mt-3 space-y-1">
          {profile.warnings.map((w, i) => (
            <li key={i} className="text-xs text-text-faint flex gap-2 leading-relaxed">
              <span className="text-gold shrink-0">·</span>
              {formatEntry(WARNING_LABELS, w)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PROFILE_SLOTS = [
  { key: 'charge_min', title: 'Charge minimale', accent: 'text-cyan' },
  { key: 'equilibre', title: 'Équilibré', accent: 'text-gold' },
  { key: 'economie_max', title: 'Économie maximale', accent: 'text-orange-tint' },
];

function groupProfiles(profiles, recommendedKey) {
  if (!profiles) return [];
  const byTrial = new Map();
  for (const slot of PROFILE_SLOTS) {
    const profile = profiles[slot.key];
    if (!profile) continue;
    const existing = byTrial.get(profile.trial_id);
    if (existing) {
      existing.titles.push(slot.title);
      existing.recommended = existing.recommended || recommendedKey === slot.key;
    } else {
      byTrial.set(profile.trial_id, {
        profile,
        titles: [slot.title],
        accent: slot.accent,
        recommended: recommendedKey === slot.key,
      });
    }
  }
  return [...byTrial.values()];
}

function RunResultsScreen({ result, profile, onBack }) {
  const footer = (
    <button
      onClick={onBack}
      className="w-full py-3 rounded-control border border-border text-text focus:outline-none focus:ring-2 focus:ring-gold"
    >
      Retour à la session
    </button>
  );

  if (result.status === 'missing_self_selected_cadence') {
    return (
      <ScreenShell eyebrow="Analyse de foulée" eyebrowColor="text-cyan" title="Référence manquante" footer={footer}>
        <div className="rounded-card border border-gold/20 bg-gold/5 p-4 mt-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-gold shrink-0 mt-0.5" />
          <p className="text-sm text-gold/90 leading-relaxed">{result.message}</p>
        </div>
      </ScreenShell>
    );
  }

  if (result.status === 'insufficient_valid_trials') {
    return (
      <ScreenShell eyebrow="Analyse de foulée" eyebrowColor="text-cyan" title="Pas encore assez d'essais" footer={footer}>
        <p className="text-sm text-text-dim leading-relaxed mt-4 mb-6">{result.message}</p>
        {result.next_trial && (
          <div className="rounded-card border border-cyan/20 bg-cyan/5 p-4 mb-6">
            <div className="text-xs tracking-widest text-cyan uppercase mb-1 font-mono">Prochain essai</div>
            <p className="text-sm text-cyan/90 leading-relaxed">{result.next_trial.message}</p>
          </div>
        )}
        <ExcludedList excluded={result.excluded_trials} />
      </ScreenShell>
    );
  }

  const p = result.profiles;
  return (
    <ScreenShell
      eyebrow="Analyse de foulée"
      eyebrowColor="text-cyan"
      title="Ton compromis"
      subtitle={
        <p className="text-text-dim text-sm leading-relaxed mb-6 mt-1">
          {result.trials_valid} essais retenus. Aucun n'est « le bon » dans l'absolu : monter la cadence allège la
          charge et coûte en économie, la baisser fait l'inverse.
        </p>
      }
      footer={footer}
    >
      {/* Les trois profils peuvent désigner le MÊME essai — c'est même fréquent depuis que la
          courbe d'économie est corrigée, un essai pouvant être à la fois le moins chargé et le
          plus équilibré. Afficher trois cartes identiques donnerait l'impression d'un bug, et
          surtout ferait croire à trois options quand il n'y en a qu'une. On regroupe donc par
          essai en cumulant les titres, ce qui dit la vraie information : « cet essai gagne sur
          ces deux critères à la fois ». */}
      <div className="space-y-3 mb-6">
        {groupProfiles(p, result.recommended).map((g) => (
          <RunProfileCard
            key={g.profile.trial_id}
            title={g.titles.join(' · ')}
            accent={g.accent}
            profile={g.profile}
            recommended={g.recommended}
          />
        ))}
      </div>

      {/* Garde-fou de session (cf. audit §1.2) : sans étalement de cadence suffisant, les écarts
          entre profils sont du bruit de mesure. Affiché en tête des résultats plutôt qu'en note
          de bas de page — c'est une raison de ne pas croire ce qui est au-dessus. */}
      {result.cadence_spread_sufficient === false && (
        <div className="rounded-card border border-gold/30 bg-gold/5 p-4 mb-6 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-gold shrink-0 mt-0.5" />
          <div>
            <div className="text-sm text-gold/90 leading-relaxed">
              Tes essais ne couvrent que {result.cadence_spread_pct}% d'écart de cadence.
            </div>
            <p className="text-xs text-gold/70 mt-1 leading-relaxed">
              Compter les appuis sur 30 s a une précision d'environ ±2 pas/min. En dessous de ~4%
              d'étalement, l'écart entre ces profils est du bruit de mesure, pas un compromis.
              Refais un essai à une cadence nettement différente.
            </p>
          </div>
        </div>
      )}

      <ExcludedList excluded={result.excluded_trials} />

      <div className="rounded-card border border-border bg-surface/50 p-4 mb-4">
        <div className="text-xs tracking-widest text-text-faint uppercase mb-2 font-mono">À garder en tête</div>
        <ul className="space-y-2">
          {[
            'Ces scores classent tes essais du jour entre eux. Un score de 100 veut dire « le meilleur de tes essais », pas « foulée optimale » — il n’y a aucune comparaison à d’autres coureurs.',
            'La foulée sur tapis diffère de la foulée au sol. Les écarts entre tes essais restent exploitables, les valeurs absolues ne se transposent pas telles quelles.',
            'L’app estime une charge mécanique, elle ne prédit pas une blessure : le lien cadence → charge est documenté, le lien charge → blessure chez une personne donnée ne l’est pas.',
            `Les angles sont des médianes de 5 appuis, mesurées à la main sur vidéo : compte environ ±${RUN_MEASUREMENT_RESOLUTION_DEG}° d’incertitude. Un écart plus petit que ça entre deux essais ne veut rien dire.`,
            'Ne compare pas ces angles à ceux d’une autre session : en vidéo 2D, la reproductibilité d’un jour à l’autre est de l’ordre de 10°, bien plus large que les écarts que tu cherches.',
            'Si tu changes de cadence, fais-le progressivement et sur des sorties courtes d’abord : ton corps a besoin de s’y adapter.',
            !result.vertical_oscillation_used &&
              'L’oscillation verticale n’a pas été mesurée sur tous les essais, elle a donc été ignorée pour tous. Le score d’économie ne repose alors que sur l’écart de cadence — aucune mesure vidéo n’y contribue.',
          ]
            .filter(Boolean)
            .map((line, i) => (
              <li key={i} className="text-xs text-text-faint flex gap-2 leading-relaxed">
                <span className="text-text-faint shrink-0">·</span>
                {line}
              </li>
            ))}
        </ul>
      </div>
    </ScreenShell>
  );
}

function ExcludedList({ excluded }) {
  if (!excluded || excluded.length === 0) return null;
  return (
    <div className="rounded-card border border-border bg-surface p-4 mb-6">
      <div className="text-xs tracking-widest text-text-faint uppercase mb-2 font-mono">
        Essais écartés ({excluded.length})
      </div>
      <ul className="space-y-2">
        {excluded.map((e) => (
          <li key={e.trial_id} className="text-xs text-text-faint leading-relaxed">
            <span className="font-mono text-text-dim">{e.trial_id}</span> — {formatEntry(VIOLATION_LABELS, e.violations[0])}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Orchestration ----------

export default function RunningSession({ onExit }) {
  const [persisted] = useState(loadPersisted);
  const [profile, setProfile] = useState(() => persisted?.profile ?? null);
  const [trials, setTrials] = useState(() => persisted?.trials ?? []);
  const [stage, setStage] = useState(() => (persisted?.profile ? 'session' : 'intro'));
  const [pendingTrial, setPendingTrial] = useState(null);
  const [captureKey, setCaptureKey] = useState(0);
  const [result, setResult] = useState(null);

  useEffect(() => {
    try {
      if (profile) localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile, trials }));
    } catch {
      // stockage indisponible — pas bloquant, la reprise de session est juste perdue
    }
  }, [profile, trials]);

  const handleProfileSubmit = useCallback((p) => {
    setProfile(p);
    setStage('session');
  }, []);

  const startNewTrial = useCallback(() => {
    setPendingTrial({});
    setStage('trial-overview');
  }, []);

  const openVideo = useCallback(() => {
    setCaptureKey((k) => k + 1);
    setStage('trial-video');
  }, []);

  const handleVideoCaptured = useCallback((payload) => {
    setPendingTrial((prev) => ({
      ...prev,
      contact: payload.contact,
      verticalOscillationRatio: payload.verticalOscillationRatio,
      review: payload.review,
    }));
    setStage('trial-overview');
  }, []);

  const handleCadenceSubmit = useCallback(({ cadenceSpm, speedKmh }) => {
    setPendingTrial((prev) => ({ ...prev, cadenceSpm, speedKmh }));
    setStage('trial-overview');
  }, []);

  const saveTrial = useCallback(() => {
    setTrials((prev) => [
      ...prev,
      {
        id: `r${prev.length + 1}`,
        speedKmh: pendingTrial.speedKmh,
        label: `${pendingTrial.cadenceSpm} pas/min`,
        metrics: buildRunTrialMetrics(
          pendingTrial.contact,
          pendingTrial.cadenceSpm,
          pendingTrial.verticalOscillationRatio
        ),
      },
    ]);
    setPendingTrial(null);
    setStage('session');
  }, [pendingTrial]);

  const cancelTrial = useCallback(() => {
    // Ne demander confirmation que s'il y a vraiment quelque chose à perdre — même parti pris
    // que le parcours vélo : un essai tout juste commencé n'a rien à confirmer.
    const hasProgress = pendingTrial && (pendingTrial.contact || pendingTrial.cadenceSpm);
    if (hasProgress && !confirm('Abandonner cet essai ? Les étapes déjà complétées seront perdues.')) return;
    setPendingTrial(null);
    setStage('session');
  }, [pendingTrial]);

  const runAnalysis = useCallback(() => {
    setResult(runRunningEngine(trials, profile));
    setStage('results');
  }, [trials, profile]);

  switch (stage) {
    case 'intro':
      return <RunIntroScreen onStart={() => setStage('profile')} onExit={onExit} />;
    case 'profile':
      return (
        <RunProfileForm
          initial={profile}
          onSubmit={handleProfileSubmit}
          onCancel={() => setStage(profile ? 'session' : 'intro')}
        />
      );
    case 'trial-overview':
      return (
        <RunTrialOverview
          trialNumber={trials.length + 1}
          profile={profile}
          pendingTrial={pendingTrial}
          onOpenVideo={openVideo}
          onOpenCadence={() => setStage('trial-cadence')}
          onSave={saveTrial}
          onCancel={cancelTrial}
        />
      );
    case 'trial-video':
      return (
        <PostureCaptureFlow
          key={`rv-${captureKey}`}
          initialMode="run_video"
          onCaptured={handleVideoCaptured}
          onCancel={() => setStage('trial-overview')}
        />
      );
    case 'trial-cadence':
      return (
        <RunCadenceForm
          profile={profile}
          initial={pendingTrial}
          onSubmit={handleCadenceSubmit}
          onCancel={() => setStage('trial-overview')}
        />
      );
    case 'results':
      return <RunResultsScreen result={result} profile={profile} onBack={() => setStage('session')} />;
    case 'session':
    default:
      return (
        <RunSessionScreen
          profile={profile}
          trials={trials}
          onNewTrial={startNewTrial}
          onAnalyze={runAnalysis}
          onEditProfile={() => setStage('profile')}
          onExit={onExit}
        />
      );
  }
}

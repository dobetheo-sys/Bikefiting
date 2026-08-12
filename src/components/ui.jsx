import { Loader2, AlertTriangle, RotateCcw, Timer } from 'lucide-react';

// ui.jsx
// Primitives d'écran partagées entre les parcours (bilan position vélo, analyse de foulée).
//
// Même raison d'être que src/shared/geometry.ts côté calcul : ces composants vivaient dans
// App.jsx alors qu'ils n'ont rien de spécifique au vélo. Les dupliquer dans le parcours course
// aurait garanti une dérive visuelle entre les deux (un padding corrigé d'un côté seulement),
// et les importer depuis App.jsx aurait créé un cycle — App.jsx monte le parcours course.
//
// Les commentaires d'origine sur les choix de mise en page sont conservés : ils documentent des
// corrections issues de retours terrain, pas des préférences esthétiques.

export function Shell({ children }) {
  return <div className="w-full h-full min-h-screen bg-bg text-text font-sans flex flex-col">{children}</div>;
}

export function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div className="h-full bg-gold transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Busy({ label, progress }) {
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;
  return (
    <Shell>
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-xs mx-auto w-full">
        <Loader2 className="w-6 h-6 text-gold animate-spin mb-4" />
        <p className="text-sm text-text-dim mb-4">{label}</p>
        {pct !== null && (
          <>
            <ProgressBar value={progress.current} max={progress.total} />
            <p className="text-xs text-text-faint font-mono mt-2">
              {progress.current}/{progress.total} images analysées · {pct}%
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}

export function ErrorScreen({ message, onRetry }) {
  return (
    <Shell>
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-md mx-auto w-full">
        <AlertTriangle className="w-8 h-8 text-gold mb-3" />
        <p className="text-text text-sm">{message}</p>
        <p className="text-xs text-text-faint mt-2">Pas de souci, ce que tu as déjà rempli est conservé.</p>
        <button
          onClick={onRetry}
          className="mt-6 flex items-center gap-2 py-3 px-5 rounded-control border border-border text-text focus:outline-none focus:ring-2 focus:ring-gold"
        >
          <RotateCcw className="w-4 h-4" /> Réessayer
        </button>
      </div>
    </Shell>
  );
}

// Écrans "formulaire/liste" (profil, session, essai, réglages, résultats) : contenu
// potentiellement plus long qu'un écran (liste d'essais qui grandit, checklist d'un
// essai) — même pattern que WelcomeScreen (h-screen + zone scrollable + CTA ancré en
// bas) plutôt que Shell/min-h-screen + centrage vertical, pour que le bouton principal
// reste toujours atteignable sans avoir à scroller d'abord (retour d'audit ergonomique :
// "CTA ancré en bas partout").
//
// Restyle Zenna : le h1 générique reste en Inter (font-sans), pas en Bebas Neue — ce slot
// accueille aussi bien des titres courts ("Résultat") que des phrases longues ("Quelles
// sont les mesures actuelles du vélo ?"), et Bebas Neue (police display condensée) casse
// la lisibilité sur du texte long. Réservé aux vrais titres héros courts, au cas par cas.
export function ScreenShell({ eyebrow, eyebrowColor = 'text-gold', title, subtitle, children, footer }) {
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

export function StepCard({ icon: Icon, step, title, duration, children, accent }) {
  return (
    <div className="rounded-card border border-border bg-surface p-4 flex gap-4">
      <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold font-mono ${accent}`}>{step}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="w-4 h-4 text-text-faint shrink-0" />
          <h3 className="font-medium text-text">{title}</h3>
        </div>
        <p className="text-sm text-text-dim leading-relaxed">{children}</p>
        {duration && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-text-faint font-mono">
            <Timer className="w-3 h-3" /> {duration}
          </div>
        )}
      </div>
    </div>
  );
}

export function GearItem({ icon: Icon, title, children }) {
  return (
    <div className="flex gap-3 py-3 border-b border-border last:border-b-0">
      <Icon className="w-4 h-4 text-cyan shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sm text-text">{title}</div>
        <p className="text-xs text-text-faint mt-0.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

export function NumberField({ label, value, onChange, suffix, required, hint }) {
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
          {suffix && <span className="text-xs text-text-faint w-6">{suffix}</span>}
        </span>
      </label>
      {hint && <p className="text-xs text-text-faint mt-1 pr-16 leading-relaxed">{hint}</p>}
    </div>
  );
}

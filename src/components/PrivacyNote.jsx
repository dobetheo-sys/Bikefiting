import { Lock } from 'lucide-react';

// Audit visuel : App.jsx et PostureCaptureFlow.jsx définissaient chacun leur propre
// PrivacyNote, avec un texte et un style légèrement différents (taille de texte, icône,
// alignement) — un changement de wording dans l'un ne se propageait jamais dans l'autre.
// Composant partagé unique, utilisé aux deux endroits.
export default function PrivacyNote({ className = '' }) {
  return (
    <div className={`flex items-start gap-2 text-xs text-neutral-500 ${className}`}>
      <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>Traité entièrement sur ton téléphone — aucune vidéo ni photo n’est envoyée en ligne.</span>
    </div>
  );
}

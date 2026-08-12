import { Component } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { SESSION_STORAGE_KEY } from './App.jsx';

// Audit fiabilité : aucun ErrorBoundary n'existait nulle part dans l'appli. loadPersistedSession()
// ne protège que contre un JSON.parse invalide, pas contre une session dont la forme a changé
// entre deux versions de l'appli (ex. deltas devenu absolu, saddleSetbackMm/hasAeroBars ajoutés
// après coup, goal ajouté au profil) — un accès du genre t.angles.hip.mean sur un essai partiel
// jette une exception non rattrapée pendant le rendu, et React démonte tout l'arbre : écran
// blanc permanent à chaque rechargement, puisque la donnée corrompue reste en localStorage et
// que le seul bouton "Nouvelle session (efface tout)" vit justement dans l'écran qui plante
// avant de pouvoir s'afficher.
export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error) {
    // console.error volontairement conservé : seul moyen de diagnostiquer un crash réel une
    // fois que l'UI de secours ci-dessous a pris le relais.
    console.error('Crash non rattrapé :', error);
  }

  handleReset = () => {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignoré — best-effort
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
          Les données de ta session précédente semblent corrompues ou incompatibles avec cette version de l'appli. Tu peux
          repartir de zéro — tes essais déjà enregistrés seront perdus.
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

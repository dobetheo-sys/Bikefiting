# posture-aero

Moteur d'analyse posturale pour position aéro (prolongateurs) en cyclisme/triathlon.
Projet parallèle, indépendant d'EnduraBuild — même méthode de travail (spec écrite,
handoff structuré pour Claude Code, tests réels avant de considérer une brique "faite").

**Statut : V1, position aéro uniquement.** Le module position guidon n'est pas commencé
(réutilisera ce pipeline, cf. `docs/SPEC_POSTURE_AERO_MOTEUR.md` §10).

## Ce qui est fait et testé

| Brique | Fichier | Testé comment |
|---|---|---|
| Moteur (validation, scores, Pareto, feedback) | `src/engine/posture-aero-engine.ts` | 24 tests `node:test`, tous passants |
| Extraction d'angles (landmarks MediaPipe Pose → angles) | `src/capture/capture-processing.ts` | Géométrie vérifiée à la main (calcul manuel vs sortie code) |
| Mesure pFSA (masque calibré → surface frontale) | `src/capture/capture-processing.ts` | Testé, méthode terrain publiée (Debraux et al. 2009) |
| Intégration segmentation (filtrage classes personne+vélo) | `src/capture/segmentation-integration.ts` | Testé sur masque simulé — le vrai modèle MediaPipe n'a pas pu être exécuté (pas de navigateur dans l'environnement de dev où ce repo a été initié) |
| Flux de capture caméra (UI) | `src/components/PostureCaptureFlow.jsx` | Syntaxe vérifiée (parseur TS), **jamais exécuté dans un vrai navigateur** — à tester en priorité |

`npm test` fait tourner tous les tests. `npm run typecheck` type-checke tout `src/`.

## Ce qui n'est PAS fait (voir HANDOFF_CLAUDE_CODE.md pour le détail)

- Init réelle de `ImageSegmenter` (MediaPipe) — la forme de l'API est vérifiée contre la doc
  officielle mais rien n'a tourné contre un vrai modèle
- Déviation poignet réelle — MediaPipe Pose n'a pas les landmarks de main, stub à 0 actuellement
- Intégration du flux de capture caméra dans une vraie app (pas de bundler configuré ici)
- Module position guidon (V2)

## Structure

```
docs/
  SPEC_POSTURE_AERO_MOTEUR.md   # spec fonctionnelle complète, table de confiance des sources
src/
  engine/
    posture-aero-engine.ts      # logique pure : validation, scores, Pareto, feedback
    posture-aero-engine.test.ts
  capture/
    capture-processing.ts       # landmarks -> angles, masque -> pFSA
    capture-processing.test.ts
    segmentation-integration.ts # intégration MediaPipe ImageSegmenter (forme non exécutée)
    segmentation-integration.test.ts
  components/
    PostureCaptureFlow.jsx      # UI de capture caméra (React) — à tester en vrai
```

## Développement

```bash
npm install
npm test          # 24 tests, tous passants au moment de l'écriture de ce README
npm run typecheck
```

`PostureCaptureFlow.jsx` n'est pas branché à un bundler ici (pas de Vite/webpack configuré) —
à intégrer dans une app React existante, ou demander à Claude Code de poser un shell minimal
autour si besoin d'un aperçu standalone.

## Pourquoi ce repo existe

Contexte complet dans `docs/SPEC_POSTURE_AERO_MOTEUR.md` : décisions de conception, sources
vérifiées vs hypothèses d'ingénierie (table de confiance §9), portée V1 (§10).

// mediapipe-vision.ts (swim-capture)
// Point d'entrée navigateur pour MediaPipe Tasks Vision côté moteur nage. Même pattern que
// src/capture/mediapipe-vision.ts (vélo) — fileset WASM chargé une fois, servi en local
// (public/mediapipe-wasm/, copié par scripts/copy-mediapipe-wasm.mjs, partagé entre les deux
// modules car c'est un binaire générique, pas de la logique métier).
//
// Singleton séparé de celui du vélo (pas d'import croisé, cf. §8 du spec nage) : si les deux
// modules tournent un jour dans la même app, ça double le chargement du fileset (~12 Mo) —
// acceptable pour deux projets pensés comme indépendants, à unifier plus tard si besoin réel.
import { FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe-wasm`;

let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

// Même garde-fou que côté vélo : ne jamais mettre en cache une promesse rejetée, sinon un
// simple accroc réseau casse la fonctionnalité pour le reste de la session.
export function getSwimVisionFileset() {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(WASM_BASE).catch((e) => {
      filesetPromise = null;
      throw e;
    });
  }
  return filesetPromise;
}

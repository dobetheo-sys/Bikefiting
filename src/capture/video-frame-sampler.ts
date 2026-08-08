// video-frame-sampler.ts
// Échantillonne des frames régulièrement espacées d'une vidéo (Blob) en pilotant un
// <video> caché hors-DOM, pour nourrir PoseLandmarker.detectForVideo() image par image.
//
// Browser-only (HTMLVideoElement, URL.createObjectURL) — aucun test node:test possible
// ici (pas de DOM).
//
// Bug réel trouvé sur un vrai vidéo ASLR (retour terrain, 08/08/2026) : `video.currentTime
// = t` sur un webm produit par MediaRecorder ne seek pas réellement — `onseeked` se
// déclenche mais currentTime reste bloqué à 0 pour TOUTES les cibles (confirmé en rejouant
// exactement cette boucle contre le fichier réel dans Chromium : 40/40 échantillons à
// 0.00s). Ce webm n'a pas d'index Cues/SeekHead (MediaRecorder n'en écrit pas), donc le
// seek vers un temps arbitraire n'est pas fiable. Résultat observé : angle ASLR = 0
// (toutes les frames analysées étaient en fait la même, prise avant le mouvement).
// Remplacé par un échantillonnage en lecture réelle via `requestVideoFrameCallback` (vraies
// frames décodées dans l'ordre, pas de seek) — repli sur l'ancienne méthode par seek si
// l'API n'est pas supportée (mieux que rien, régression possible sur ces navigateurs précis).

export interface SampledFrame {
  video: HTMLVideoElement;
  timestampMs: number;
}

function sampleByPlayback(
  video: HTMLVideoElement,
  duration: number,
  sampleCount: number,
  onFrame: (frame: SampledFrame) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const steps = Math.max(1, sampleCount - 1);
    let nextIndex = 0;

    function cleanup() {
      video.removeEventListener('ended', onEnded);
      video.pause();
    }
    function onEnded() {
      // Vidéo plus courte que prévu ou dernière cible jamais atteinte pile : on prend ce
      // qu'on a plutôt que de bloquer indéfiniment.
      cleanup();
      resolve();
    }
    function step(_now: number, metadata: VideoFrameCallbackMetadata) {
      const t = metadata.mediaTime;
      while (nextIndex < sampleCount && t >= (nextIndex / steps) * duration) {
        onFrame({ video, timestampMs: Math.round(t * 1000) });
        nextIndex += 1;
      }
      if (nextIndex >= sampleCount) {
        cleanup();
        resolve();
        return;
      }
      video.requestVideoFrameCallback(step);
    }

    video.addEventListener('ended', onEnded);
    video.requestVideoFrameCallback(step);
    video.play().catch(reject);
  });
}

async function sampleBySeeking(
  video: HTMLVideoElement,
  duration: number,
  sampleCount: number,
  onFrame: (frame: SampledFrame) => void
): Promise<void> {
  const steps = Math.max(1, sampleCount - 1);
  for (let i = 0; i < sampleCount; i++) {
    const t = (i / steps) * duration;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = t;
    });
    onFrame({ video, timestampMs: Math.round(t * 1000) });
  }
}

export async function sampleVideoFrames(
  blob: Blob,
  sampleCount: number,
  onFrame: (frame: SampledFrame) => void
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('sampleVideoFrames: échec de chargement de la vidéo'));
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('sampleVideoFrames: durée vidéo invalide ou non disponible');
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      await sampleByPlayback(video, duration, sampleCount, onFrame);
    } else {
      await sampleBySeeking(video, duration, sampleCount, onFrame);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

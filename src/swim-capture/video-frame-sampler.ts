// video-frame-sampler.ts (swim-capture)
// Échantillonne des frames régulièrement espacées d'une vidéo (Blob) en pilotant un <video>
// caché hors-DOM, pour nourrir PoseLandmarker.detectForVideo() image par image.
//
// Browser-only (HTMLVideoElement, URL.createObjectURL) — aucun test node:test possible ici
// (pas de DOM), même limite que src/capture/video-frame-sampler.ts côté vélo.
//
// Leçon reprise directement du projet vélo (pas du code partagé, cf. §8 du spec nage — une
// leçon opérationnelle, pas une dépendance) : `video.currentTime = t` (seek) ne fonctionne
// PAS sur un webm produit par MediaRecorder (pas d'index Cues/SeekHead) — `onseeked` se
// déclenche mais currentTime reste bloqué à 0, ce qui a produit un bug réel côté vélo
// (HANDOFF_CLAUDE_CODE.md, "Bug réel trouvé et corrigé... angle ASLR à 0°"). Ce fichier part
// donc directement de l'échantillonnage par lecture réelle (`requestVideoFrameCallback`),
// avec repli sur le seek uniquement si l'API n'est pas supportée par le navigateur — pas
// besoin de redécouvrir ce bug une deuxième fois.
//
// Différence avec le vélo : la vidéo nage V0 filme un nageur qui TRAVERSE un champ fixe (§1
// du spec) — la portion utile peut être plus courte que la vidéo entière (avant/après que le
// nageur soit dans le cadre). `startS`/`endS` optionnels permettent de ne échantillonner que
// la portion pertinente si l'appelant l'a déjà identifiée (ex. sélection manuelle) ; par
// défaut, toute la vidéo est échantillonnée et les frames sans pose détectable en amont
// (nageur hors champ) seront simplement filtrées plus loin dans le pipeline (toPoseFrame
// renvoie null pour ces cas, cf. swim-pose-integration.ts).

export interface SampledFrame {
  video: HTMLVideoElement;
  timestampMs: number;
}

export interface SampleVideoFramesOptions {
  playbackRate?: number;
  onProgress?: (done: number, total: number) => void;
  startS?: number;
  endS?: number;
}

function sampleByPlayback(
  video: HTMLVideoElement,
  startS: number,
  endS: number,
  sampleCount: number,
  onFrame: (frame: SampledFrame) => void,
  options: SampleVideoFramesOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const span = endS - startS;
    const steps = Math.max(1, sampleCount - 1);
    let nextIndex = 0;
    video.playbackRate = options.playbackRate ?? 1;

    function cleanup() {
      video.removeEventListener('ended', onEnded);
      video.pause();
    }
    function onEnded() {
      cleanup();
      resolve();
    }
    function step(_now: number, metadata: VideoFrameCallbackMetadata) {
      const t = metadata.mediaTime;
      while (nextIndex < sampleCount && t >= startS + (nextIndex / steps) * span) {
        onFrame({ video, timestampMs: Math.round(t * 1000) });
        nextIndex += 1;
        options.onProgress?.(nextIndex, sampleCount);
      }
      if (nextIndex >= sampleCount || t >= endS) {
        cleanup();
        resolve();
        return;
      }
      video.requestVideoFrameCallback(step);
    }

    // Ne PAS faire `video.currentTime = startS` ici : ce serait exactement le seek qui casse
    // sur un webm MediaRecorder (cf. commentaire en tête de fichier) — même un seek unique
    // avant lecture n'est pas garanti fiable sans index Cues/SeekHead. On joue depuis le
    // début et on ignore simplement les frames avant startS via la condition de step()
    // ci-dessus — plus lent si startS est grand, mais jamais silencieusement bloqué à 0.00s.
    video.addEventListener('ended', onEnded);
    video.requestVideoFrameCallback(step);
    video.play().catch(reject);
  });
}

async function sampleBySeeking(
  video: HTMLVideoElement,
  startS: number,
  endS: number,
  sampleCount: number,
  onFrame: (frame: SampledFrame) => void,
  options: SampleVideoFramesOptions
): Promise<void> {
  const span = endS - startS;
  const steps = Math.max(1, sampleCount - 1);
  for (let i = 0; i < sampleCount; i++) {
    const t = startS + (i / steps) * span;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = t;
    });
    onFrame({ video, timestampMs: Math.round(t * 1000) });
    options.onProgress?.(i + 1, sampleCount);
  }
}

export async function sampleVideoFrames(
  blob: Blob,
  sampleCount: number,
  onFrame: (frame: SampledFrame) => void,
  options: SampleVideoFramesOptions = {}
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

    const startS = Math.max(0, options.startS ?? 0);
    const endS = Math.min(duration, options.endS ?? duration);
    if (endS <= startS) {
      throw new Error('sampleVideoFrames: plage startS/endS invalide (endS doit être > startS)');
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      await sampleByPlayback(video, startS, endS, sampleCount, onFrame, options);
    } else {
      await sampleBySeeking(video, startS, endS, sampleCount, onFrame, options);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

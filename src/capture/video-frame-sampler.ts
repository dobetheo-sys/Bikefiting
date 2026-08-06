// video-frame-sampler.ts
// Échantillonne des frames régulièrement espacées d'une vidéo (Blob) en pilotant un
// <video> caché hors-DOM, pour nourrir PoseLandmarker.detectForVideo() image par image.
//
// Browser-only (HTMLVideoElement, URL.createObjectURL) — aucun test node:test possible
// ici (pas de DOM). À vérifier sur un vrai appareil avec une vraie vidéo profil
// (cf. HANDOFF_CLAUDE_CODE.md, tâche 3) : que le seek/lecture frame-par-frame ne dérive
// pas trop sur les codecs vidéo réellement produits par MediaRecorder sur mobile.

export interface SampledFrame {
  video: HTMLVideoElement;
  timestampMs: number;
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

    const steps = Math.max(1, sampleCount - 1);
    for (let i = 0; i < sampleCount; i++) {
      const t = (i / steps) * duration;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = t;
      });
      onFrame({ video, timestampMs: Math.round(t * 1000) });
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Sound effects for trade lifecycle events. Files live under public/sounds/
// and are served verbatim by the dev-server and prod nginx (see Dockerfile).
//
// A fresh Audio instance is created per play call so concurrent triggers
// (multiple bots opening at the same poll tick) don't step on each other —
// reusing a single Audio element would cut off the previous playback when
// currentTime is reset. Browsers cache the underlying file, so the second
// instantiation is effectively free.
//
// Autoplay policy: browsers reject play() until the user has interacted with
// the page. After login the user has clicked, so playback works in practice.
// We swallow the rejection silently to avoid noisy console errors during the
// brief cold-start window before any interaction.

const OPEN_SRC = '/sounds/open_p.wav';
const CLOSE_SRC = '/sounds/close_p.mp3';

const playSource = (src: string): void => {
  try {
    const audio = new Audio(src);
    void audio.play().catch(() => {
      /* autoplay blocked or unsupported — ignore */
    });
  } catch {
    /* Audio constructor unavailable (very old environments) — ignore */
  }
};

export const playTradeOpen = (): void => playSource(OPEN_SRC);
export const playTradeClose = (): void => playSource(CLOSE_SRC);

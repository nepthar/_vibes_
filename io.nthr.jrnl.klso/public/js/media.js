import { api, mediaURL } from './api.js';
import { icon } from './icons.js';

/**
 * Media blocks: each item is its own paragraph, rendered at
 * the full available width with the aspect-correct height capped to the
 * viewport, and replaced by a quiet placeholder when the asset can't be
 * resolved. Videos show a play glyph and play on tap.
 */

/** Reads pixel dimensions (and video duration) before upload, for layout. */
function probe(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () =>
        done({
          pixelWidth: video.videoWidth,
          pixelHeight: video.videoHeight,
          duration: video.duration,
        });
      video.onerror = () => done({ pixelWidth: 0, pixelHeight: 0 });
      video.src = url;
      return;
    }
    const image = new Image();
    image.onload = () => done({ pixelWidth: image.naturalWidth, pixelHeight: image.naturalHeight });
    image.onerror = () => done({ pixelWidth: 0, pixelHeight: 0 });
    image.src = url;
  });
}

/** Uploads the picked files and returns the blocks to insert at the caret. */
export async function uploadPicked(files) {
  const picks = [];
  for (const file of files) {
    try {
      const dimensions = await probe(file);
      const uploaded = await api.uploadMedia(file, dimensions);
      picks.push({
        kind: 'media',
        assetId: uploaded.assetId,
        mediaType: uploaded.mediaType,
        pixelWidth: dimensions.pixelWidth ?? 0,
        pixelHeight: dimensions.pixelHeight ?? 0,
        duration: dimensions.duration ?? null,
      });
    } catch {
      // Quiet failure: a rejected upload simply doesn't become a block.
    }
  }
  return picks;
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);

/**
 * A pasted http(s) URL that is itself a photo or video, by file extension.
 * Anything else stays ordinary text — an article link is not a media block.
 */
export function parseMediaUrl(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  const filename = parsed.pathname.split('/').pop() ?? '';
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return { url: parsed.href, mediaType: 'photo' };
  if (VIDEO_EXT.has(ext)) return { url: parsed.href, mediaType: 'video' };
  return null;
}

const placeholder = () => {
  const element = document.createElement('div');
  element.className = 'media-missing';
  element.innerHTML = `${icon('photo-missing')}<span>media no longer available</span>`;
  return element;
};

/**
 * One media block. `capPx` is the viewport height the aspect-fit height is
 * capped to, so an extremely tall asset still fits within one screen.
 */
export function mediaFigure(block, { editable = false, capPx } = {}) {
  const figure = document.createElement('figure');
  figure.className = 'media';
  if (block.url) figure.dataset.url = block.url;
  if (block.assetId) figure.dataset.assetId = block.assetId;
  figure.dataset.mediaType = block.mediaType ?? 'photo';
  figure.dataset.pixelWidth = String(block.pixelWidth ?? 0);
  figure.dataset.pixelHeight = String(block.pixelHeight ?? 0);
  if (block.duration) figure.dataset.duration = String(block.duration);
  if (editable) figure.contentEditable = 'false';
  if (capPx) figure.style.setProperty('--media-cap', `${Math.round(capPx)}px`);

  // Hold the block's final shape while the bytes load, so the surface doesn't
  // grow underneath the caret once the image renders.
  const pending = document.createElement('div');
  pending.className = 'media-pending';
  if (block.pixelWidth > 0 && block.pixelHeight > 0) {
    pending.style.height = 'auto';
    pending.style.aspectRatio = `${block.pixelWidth} / ${block.pixelHeight}`;
    pending.style.maxHeight = figure.style.getPropertyValue('--media-cap') || '60vh';
  }
  figure.append(pending);

  hydrate(figure, block);
  return figure;
}

async function hydrate(figure, block) {
  const url = block.url ?? (block.assetId ? await mediaURL(block.assetId) : null);
  figure.querySelector('.media-pending')?.remove();

  if (!url) {
    figure.append(placeholder());
    return;
  }

  if ((block.mediaType ?? 'photo') === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.preload = 'metadata';
    video.playsInline = true;
    video.referrerPolicy = 'no-referrer';
    figure.append(video);

    const glyph = document.createElement('span');
    glyph.className = 'media-play';
    glyph.innerHTML = icon('play');
    figure.append(glyph);

    figure.addEventListener('click', (event) => {
      event.preventDefault();
      playFullScreen(url);
    });
    return;
  }

  const image = document.createElement('img');
  image.src = url;
  image.alt = '';
  image.draggable = false;
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => settled(figure));
  image.addEventListener('error', () => {
    image.remove();
    figure.append(placeholder());
    settled(figure);
  });
  figure.append(image);
}

/**
 * An asset whose real height differs from the space reserved for it shifts
 * everything below — including the caret's line. The editor listens for this
 * to re-settle the typewriter position once the block's height is final.
 */
const settled = (figure) =>
  figure.dispatchEvent(new CustomEvent('media-settled', { bubbles: true }));

/** Tap-to-play, standard controls, sound per system rules. */
function playFullScreen(url) {
  const player = document.createElement('div');
  player.className = 'player';

  const video = document.createElement('video');
  video.src = url;
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.referrerPolicy = 'no-referrer';

  const close = document.createElement('button');
  close.className = 'player-close';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = icon('close');

  player.append(video, close);

  const dismiss = () => {
    player.querySelector('video')?.pause();
    player.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss();
    }
  }

  player.querySelector('.player-close').addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey, true);
  document.body.append(player);
}

/** Reads a block back out of a figure the editor is holding. */
export const blockFromFigure = (figure) => ({
  kind: 'media',
  ...(figure.dataset.url ? { url: figure.dataset.url } : { assetId: figure.dataset.assetId }),
  mediaType: figure.dataset.mediaType === 'video' ? 'video' : 'photo',
  pixelWidth: Number(figure.dataset.pixelWidth) || 0,
  pixelHeight: Number(figure.dataset.pixelHeight) || 0,
  duration: figure.dataset.duration ? Number(figure.dataset.duration) : null,
});

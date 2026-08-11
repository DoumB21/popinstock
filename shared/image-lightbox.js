'use strict';
/* Shared click-to-fullscreen viewer for a page's main asset image/video —
   used by asset.html, template.html, sale.html's .tpl-main-img-wrap. Owns
   its own overlay DOM (#imgLightboxOverlay, injected into <body> on first
   use) and CSS (.img-lightbox-*, shared/global.css) — same pattern as
   shared/asset-popup.js.

   Usage: ImageLightbox.wire(wrapEl) once per page, right after the wrap
   element exists. wire() reads whatever <img>/<video> is inside the wrap
   at click time, so thumbnail switches (setMainMedia() replacing the
   wrap's innerHTML) never need a re-wire. */
window.ImageLightbox = (function () {
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'img-lightbox-overlay';
    overlay.innerHTML =
      '<button class="img-lightbox-close" aria-label="Close">✕</button>' +
      '<div class="img-lightbox-body"></div>';
    document.body.appendChild(overlay);
    // See shared/make-offer-modal.js's identical comment — a plain
    // e.target===overlay click check also fires on a drag that starts
    // inside the body and releases on the backdrop (e.g. an image
    // drag-select), not just a genuine backdrop click. No text inputs live
    // here, but the media itself is draggable in most browsers, so the same
    // mousedown-tracking fix applies.
    let _downOnOverlay = false;
    overlay.addEventListener('mousedown', e => { _downOnOverlay = (e.target === overlay); });
    overlay.addEventListener('click', e => { if (_downOnOverlay && e.target === overlay) close(); });
    overlay.querySelector('.img-lightbox-close').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    return overlay;
  }

  function open(mediaEl) {
    ensureOverlay();
    const body = overlay.querySelector('.img-lightbox-body');
    if (mediaEl.tagName === 'VIDEO') {
      const src = mediaEl.querySelector('source')?.src || mediaEl.currentSrc || mediaEl.src;
      // Click-to-open counts as a user gesture, so autoplay-with-sound is
      // allowed here unlike the muted thumbnail/hero preview elsewhere.
      body.innerHTML = `<video src="${src}" controls autoplay loop playsinline></video>`;
    } else {
      body.innerHTML = `<img src="${mediaEl.currentSrc || mediaEl.src}" alt="${mediaEl.alt || ''}">`;
    }
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.querySelector('.img-lightbox-body').innerHTML = ''; // stop video playback
    document.body.style.overflow = '';
  }

  function wire(wrapEl) {
    if (!wrapEl) return;
    wrapEl.classList.add('img-lightbox-zoomable');
    wrapEl.addEventListener('click', () => {
      const media = wrapEl.querySelector('img, video');
      if (media) open(media);
    });
  }

  return { wire, open, close };
})();

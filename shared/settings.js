'use strict';
/* Site-wide visitor preferences, stored per-browser (no wallet needed —
   this is a performance/accessibility setting, not collector data). Edited
   from profile.html; read by every page that autoplays NFT preview video. */
(function () {
  const KEY = 'hoardio_reduce_motion';
  window.getReduceMotion = () => localStorage.getItem(KEY) === '1';
  window.setReduceMotion = on => {
    localStorage.setItem(KEY, on ? '1' : '0');
    window.dispatchEvent(new CustomEvent('reduce-motion-change', { detail: { on: !!on } }));
  };
})();

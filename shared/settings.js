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

  // Chain RPC endpoint used to sign/push wallet transactions (src/wax-auth.js
  // reads this same key directly — no shared import, since that's a
  // standalone compiled bundle). Empty string = use the built-in default
  // (Greymass). Takes effect on next page load/login, not the live session.
  const RPC_KEY = 'hoardio_rpc_endpoint';
  window.getRpcEndpoint = () => localStorage.getItem(RPC_KEY) || '';
  window.setRpcEndpoint = url => {
    if (url) localStorage.setItem(RPC_KEY, url);
    else localStorage.removeItem(RPC_KEY);
  };
})();

// Single source of truth for every NHL Breakaway page's backend URL. On
// localhost specifically, point at the local dev-server instead of
// production (`npm run dev:nhlbreakaway`, port 8877 by default) so any page
// can be tested end-to-end against unpushed backend changes without
// pushing first — CORS is already wide open on the dev-server. Everywhere
// else (IIS via a real hostname, Vercel previews, production itself) this
// resolves to the same absolute hoardio.com URL as before.
//
// Set on `window`, not a bare top-level `const` — every page's own inline
// script (and nav.js) declares its own locally-named `API_BASE`/
// `NAV_API_BASE` reading this value, and a same-named top-level `const` in
// two classic <script> tags on one page collides and throws (see
// feedback_classic_script_const_collision memory for the exact bug this
// caused once already). Load this file before both nav.js and the page's
// own inline script.
window.NHL_API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? 'http://localhost:8877'
  : 'https://www.hoardio.com';

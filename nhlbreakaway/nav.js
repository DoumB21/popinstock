// NHL Breakaway runs on Sweet (not WAX) — no wallet widget, no WaxAuth.
// Add entries here as tool pages get built (plain filename, e.g. 'holder-lookup').
const NAV_LINKS = [
  { label: 'Packs', href: 'pack-stats' },
  { label: 'Sets', href: 'sets' },
  { label: 'Highlights', href: 'highlights' },
  { label: 'Wallet Look Up', href: 'wallet' },
  { label: 'Edition Rankings', href: 'edition-rankings' },
  { label: 'Leaderboard', href: 'leaderboard' },
];

const SECTION_NAME = 'NHL Breakaway';

// Absolute production URL, not a same-origin relative path — same pattern
// this site already uses for Supabase/WAX (real public APIs, called
// directly regardless of what domain the page itself loads from). NHL
// Breakaway's Postgres database has no browser-safe HTTP interface of its
// own, so api/route.js on hoardio.com IS that public API; a relative path
// only resolves correctly when Vercel itself serves the HTML, breaking
// local IIS testing (which can't run serverless functions at all). CORS is
// already open on the API, so this absolute URL works identically from
// localhost, IIS, Vercel previews, and production itself.
// Named NAV_API_BASE, not API_BASE — top-level `const` in separate classic
// <script> tags on the same page share one scope, so reusing the name each
// page's own inline script already uses collided and threw a SyntaxError
// that silently killed this entire script (nav disappeared everywhere
// except the hub, the one page with no API_BASE of its own). Never reuse a
// page-level const name here.
const NAV_API_BASE = 'https://www.hoardio.com';
const FRESHNESS_CACHE_KEY = 'nhlbreakaway_data_last_updated';
const FRESHNESS_CACHE_TTL_MS = 5 * 60 * 1000; // avoid re-querying on every page nav within a visit

// Every relative href in this file must stay RELATIVE (never a leading-slash
// absolute path) — an absolute path silently drops whatever prefix the site
// is mounted under on a local subpath-hosted dev server (confirmed: it
// dropped both that prefix AND "nhlbreakaway" for a real user). Site
// convention for this is entityHref()/collection.html's own `_p` trick:
// detect path SHAPE, then emit a relative "../"-style prefix, never "/".
//
// Three shapes this file can be loaded from:
//  - hub: nhlbreakaway/index.html's clean URL is "/nhlbreakaway" — ONE
//    segment shallower than every plain sibling page (see matching comment
//    in nhlbreakaway/index.html). Directory resolves to site root here.
//  - normal: any plain sibling page, e.g. "/nhlbreakaway/sets" — directory
//    is nhlbreakaway/ itself, no prefix needed for same-folder siblings.
//  - nested holders: holders.html's pretty clean URL is "/nhlbreakaway/
//    holders/:momentUuid" (a vercel.json rewrite) — ONE segment DEEPER than
//    every plain sibling, since the id is an extra path segment. Directory
//    is nhlbreakaway/holders/, so reaching a sibling needs "../" and
//    reaching site root needs "../../".
const _isHub = /\/nhlbreakaway$/.test(location.pathname);
const _isNestedHolders = /\/nhlbreakaway\/holders\/[^/]+\/?$/.test(location.pathname);
// _p: prefix to reach nhlbreakaway/ itself, for same-folder sibling links.
const _p = _isHub ? 'nhlbreakaway/' : (_isNestedHolders ? '../' : '');
// _toRoot: prefix to reach site root, for the nav-home logo link.
const _toRoot = _isHub ? '' : (_isNestedHolders ? '../../' : '../');

function buildNav() {
  const currentPage = location.pathname.split('/').pop();

  const links = NAV_LINKS.map(({ label, href }) => `
    <a href="${_p}${href}" class="nav-link${currentPage === href ? ' nav-link--active' : ''}">${label}</a>
  `).join('');

  // .nav-divider and .nav-section are NOT redeclared here — shared/
  // global.css owns both (base rules plus mobile/tablet `margin-right:
  // auto` overrides that flush-right the icon cluster while keeping this
  // section badge pinned next to the logo). Redeclaring either here,
  // injected after global.css loads, would silently win the cascade at
  // every width and defeat those overrides.
  const style = document.createElement('style');
  style.textContent = `
    .nav-freshness {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0.3rem 1.5rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-align: center;
      border-top: 1px solid var(--border);
    }
    @media (max-width: 700px) { .nav-freshness { padding: 0.3rem 0.75rem; } }
  `;
  document.head.appendChild(style);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.innerHTML = `
    <div class="nav-inner">
      <a href="${_toRoot}index" class="nav-home" title="Back to homepage">
        <img src="${_toRoot}images/Hoardio_fav.png" alt="Hoardio" />
      </a>
      <span class="nav-divider"></span>
      <a href="${_p || '.'}" class="nav-section">${SECTION_NAME}</a>
      <div class="nav-links">${links}</div>
      <button class="nav-burger" aria-label="Toggle menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div class="nav-mobile">${links}</div>
    <div class="nav-freshness" id="navFreshness" hidden></div>
  `;

  document.body.prepend(nav);
  loadFreshness();

  // Hamburger toggle
  const burger = nav.querySelector('.nav-burger');
  const mobile = nav.querySelector('.nav-mobile');
  burger.addEventListener('click', () => {
    const open = mobile.classList.toggle('nav-mobile--open');
    burger.classList.toggle('nav-burger--open', open);
    burger.setAttribute('aria-expanded', open);
  });

  // Close mobile menu when a link is clicked
  mobile.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      mobile.classList.remove('nav-mobile--open');
      burger.classList.remove('nav-burger--open');
      burger.setAttribute('aria-expanded', false);
    });
  });
}

function buildBackToTop() {
  const style = document.createElement('style');
  style.textContent = `
    .back-to-top {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 999;
      width: 40px; height: 40px; border-radius: 50%;
      background: rgba(192,120,40,0.85); border: 1px solid rgba(240,168,64,0.4);
      color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.3s, transform 0.2s;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    }
    .back-to-top.visible { opacity: 1; pointer-events: auto; }
    .back-to-top:hover { transform: translateY(-3px); background: rgba(240,168,64,0.9); }
    .back-to-top svg { width: 18px; height: 18px; }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'back-to-top';
  btn.setAttribute('aria-label', 'Back to top');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  document.body.appendChild(btn);

  // Sentinel 300px from the top — when it leaves the viewport, show the button
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:300px;left:0;height:1px;width:1px;pointer-events:none;visibility:hidden;';
  document.body.insertAdjacentElement('afterbegin', sentinel);

  new IntersectionObserver(([entry]) => {
    btn.classList.toggle('visible', !entry.isIntersecting);
  }, { threshold: 0 }).observe(sentinel);

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
}

async function buildFooter() {
  if (!window.buildSharedFooter) await _loadScriptOnce(_toRoot + 'shared/footer.js');
  buildSharedFooter();
}

function _loadScriptOnce(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// site_meta.data_last_updated, cached client-side so navigating between
// pages within one visit doesn't re-query it every time. Fails silently
// (element stays hidden) rather than showing a broken freshness line —
// this is a nice-to-have, not something worth an error state over.
async function loadFreshness() {
  const el = document.getElementById('navFreshness');
  if (!el) return;

  const cached = sessionStorage.getItem(FRESHNESS_CACHE_KEY);
  if (cached) {
    try {
      const { value, cachedAt } = JSON.parse(cached);
      if (Date.now() - cachedAt < FRESHNESS_CACHE_TTL_MS) return renderFreshness(el, value);
    } catch {}
  }

  try {
    const res = await fetch(`${NAV_API_BASE}/api/site-meta`);
    if (!res.ok) return;
    const { data_last_updated } = await res.json();
    if (!data_last_updated) return;
    sessionStorage.setItem(FRESHNESS_CACHE_KEY, JSON.stringify({ value: data_last_updated, cachedAt: Date.now() }));
    renderFreshness(el, data_last_updated);
  } catch {
    // Dev API not running, network hiccup, etc. — leave the line hidden.
  }
}

function renderFreshness(el, isoString) {
  const date = new Date(isoString);
  if (isNaN(date)) return;
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(date);
  el.textContent = `Last updated: ${formatted}`;
  el.hidden = false;
}

function _showMovedOverlay() {
  if (!location.hostname.includes('popinstock.com')) return;
  const newUrl = location.href.replace('popinstock.com', 'hoardio.com');
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a0f;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  el.innerHTML = `
    <img src="/images/Hoardio_logo.png" alt="Hoardio" style="height:64px;filter:invert(1);margin-bottom:2rem;">
    <h1 style="color:#f0f0f5;font-size:1.75rem;margin:0 0 1rem;">Pop In Stock has a new home.</h1>
    <p style="color:#8888aa;font-size:1.05rem;line-height:1.6;max-width:480px;margin:0 0 2rem;">
      We've moved to <strong style="color:#f0a840;">hoardio.com</strong><br>Please update your bookmark.
    </p>
    <a href="${newUrl}" style="display:inline-block;background:#c07828;color:#fff;font-weight:700;font-size:1rem;padding:.75rem 2rem;border-radius:8px;text-decoration:none;letter-spacing:.02em;" onmouseover="this.style.background='#f0a840'" onmouseout="this.style.background='#c07828'">Go to Hoardio →</a>
  `;
  document.body.appendChild(el);
}

document.addEventListener('DOMContentLoaded', () => {
  buildNav(); buildBackToTop(); buildFooter(); _showMovedOverlay();
});

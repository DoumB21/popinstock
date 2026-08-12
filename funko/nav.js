// Set to { message: 'Your text here.', type: 'warning' } to show the banner.
// type can be: 'warning' (amber) | 'info' (blue) | 'error' (red)
// Set to null to hide.
const SITE_BANNER = null;

// Defined synchronously here (not just inside shared/wallet-widget.js, which
// this page loads lazily) so pages calling window.getWaxAccount() from their
// own DOMContentLoaded handler never race the widget's dynamic script load —
// shared/wallet-widget.js redefines this identically once it loads, harmless.
window.getWaxAccount = () => window.WaxAuth ? WaxAuth.getAccount() : (localStorage.getItem('wax_account') || null);

const NAV_LINKS = [
  { label: 'Mint Rankings', href: 'mint-rankings' },
  { label: 'Wallet Look Up', href: 'wallet' },
  { label: 'Market Overview', href: 'market-overview' },
  { label: 'Set Tracker', href: 'set-tracker' },
];

const SECTION_NAME = 'Funko';

function buildSiteBanner() {
  if (!SITE_BANNER) return;
  const { message, type = 'warning' } = SITE_BANNER;
  const el = document.createElement('div');
  el.className = `site-banner site-banner--${type}`;
  el.innerHTML = `${message}<button class="site-banner-close" aria-label="Dismiss">&#x2715;</button>`;
  el.querySelector('.site-banner-close').addEventListener('click', () => el.remove());
  document.body.prepend(el);
}

function buildNav() {
  const currentPage = location.pathname.split('/').pop();

  const links = NAV_LINKS.map(({ label, href }) => `
    <a href="${href}" class="nav-link${currentPage === href ? ' nav-link--active' : ''}">${label}</a>
  `).join('');

  const navStyle = document.createElement('style');
  navStyle.textContent = `
    .nav-divider { width: 1px; height: 20px; background: rgba(255,255,255,0.15); margin: 0 0.5rem 0 0.25rem; flex-shrink: 0; }
    .nav-section { font-size: 0.75rem; font-weight: 700; color: var(--accent); flex-shrink: 0; letter-spacing: 0.08em; text-transform: uppercase; margin-right: 0.75rem; text-decoration: none; }
    .nav-section:hover { opacity: 0.75; }
  `;
  document.head.appendChild(navStyle);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.innerHTML = `
    <div class="nav-inner">
      <a href="../index" class="nav-home" title="Back to homepage">
        <img src="../images/Hoardio_fav.png" alt="Hoardio" />
      </a>
      <span class="nav-divider"></span>
      <a href="funko" class="nav-section">${SECTION_NAME}</a>
      <div class="nav-links">${links}</div>
      <button class="nav-burger" aria-label="Toggle menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div class="nav-mobile">${links}</div>
  `;

  document.body.prepend(nav);

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

function buildFooter() {
  const footer = document.createElement('footer');
  footer.innerHTML = `
    &copy; 2026 Hoardio &mdash; All rights reserved.
    <div>All images, logos, and trademarks displayed on this site are the property of their respective owners. No affiliation or endorsement is implied. Used for informational purposes only.</div>
  `;
  document.body.appendChild(footer);
}

/* ── WAX Auth ─────────────────────────────────────────────────────────────── */
const _SB_URL  = 'https://otzyszbbsuwoxupbpfju.supabase.co';
const _SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90enlzemJic3V3b3h1cGJwZmp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDU5ODMsImV4cCI6MjA5MDMyMTk4M30.s8XzcbpZ2PCwOvXJcN7LqPKhqyZop_hdUOFdvLbPCWU';

async function _fetchAndCacheTier(account) {
  try {
    const res = await fetch(
      `${_SB_URL}/rest/v1/funko_collector_tiers?wallet=eq.${encodeURIComponent(account)}&select=max_tier`,
      { headers: { 'apikey': _SB_ANON, 'Authorization': `Bearer ${_SB_ANON}`, 'Accept-Profile': 'funko' } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const tier = rows[0]?.max_tier ?? 0;
    if (tier >= 1) localStorage.setItem('wax_funko_tier', String(tier));
    else localStorage.removeItem('wax_funko_tier');
  } catch { /* network failure — leave cached value */ }
}

const _NAV_TIER_ICONS = { 1: '🌱', 2: '📚', 3: '🏛️', 4: '👑' };

function _loadScriptOnce(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

function _loadWalletWidget() {
  const need = [];
  if (!window.WalletWidget) need.push(_loadScriptOnce('../shared/wallet-widget.js'));
  if (!window.walletMenuItems) need.push(_loadScriptOnce('../shared/wallet-menu.js'));
  return Promise.all(need);
}

async function _initGlobalSearch() {
  if (!window.GlobalSearch) await _loadScriptOnce('../shared/global-search.js');
  GlobalSearch.mount(document.querySelector('.nav-inner'), {
    apiScript:      '../shared/wax-api.js',
    collectionHref: '../collection',
    exploreHref:    '../explore',
    walletHref:     '../inventory',
  });
}

async function _initWallet() {
  await _loadWalletWidget();
  // Exposed so pages that update localStorage.wax_funko_tier themselves
  // (e.g. profile.html on claiming a tier) can force an immediate nav
  // re-render instead of waiting for the next wax-auth-change event.
  window._walletWidget = WalletWidget.mount(document.querySelector('.nav-inner'), {
    authScript: '../shared/wax-auth.js',
    apiScript: '../shared/wax-api.js',
    exploreHref: '../explore',
    offersHref: '../trade-offers',
    buyOffersHref: '../buy-offers',
    profileHref: '../profile',
    menuItems: walletMenuItems('../', [
      { href: 'profile', label: 'Collector Profile', icon: '👤' },
    ]),
    // Reads the cached tier synchronously so the icon appears instantly —
    // onAccount below refreshes it in the background, never blocking paint.
    decorateName: () => {
      const tier = parseInt(localStorage.getItem('wax_funko_tier') || '0', 10);
      return tier >= 1 ? _NAV_TIER_ICONS[tier] + ' ' : '';
    },
    onAccount: acc => _fetchAndCacheTier(acc),
    onLogout: () => localStorage.removeItem('wax_funko_tier'),
  });
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

document.addEventListener('DOMContentLoaded', () => { buildNav(); buildSiteBanner(); buildBackToTop(); buildFooter(); _initWallet(); _initGlobalSearch(); _showMovedOverlay(); });

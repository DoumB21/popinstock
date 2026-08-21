const NAV_LINKS = [
  { label: 'Mint Rankings', href: 'mint-rankings' },
  { label: 'Wallet Look Up', href: 'wallet' },
];

const SECTION_NAME = 'Topps';

function buildNav() {
  const currentPage = location.pathname.split('/').pop();

  const links = NAV_LINKS.map(({ label, href }) => `
    <a href="${href}" class="nav-link${currentPage === href ? ' nav-link--active' : ''}">${label}</a>
  `).join('');

  // .nav-divider and .nav-section are NOT redeclared here — shared/
  // global.css owns both (base rules plus mobile/tablet `margin-right:
  // auto` overrides that flush-right the icon cluster while keeping this
  // section badge pinned next to the logo). Redeclaring either here,
  // injected after global.css loads, would silently win the cascade at
  // every width and defeat those overrides.
  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.innerHTML = `
    <div class="nav-inner">
      <a href="../index" class="nav-home" title="Back to homepage">
        <img src="../images/Hoardio_fav.png" alt="Hoardio" />
      </a>
      <span class="nav-divider"></span>
      <a href="topps" class="nav-section">${SECTION_NAME}</a>
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

async function buildFooter() {
  if (!window.buildSharedFooter) await _loadScriptOnce('../shared/footer.js');
  buildSharedFooter();
}

/* ── WAX Auth ─────────────────────────────────────────────────────────────── */
// Defined synchronously here (not just inside shared/wallet-widget.js, which
// this page loads lazily) so pages calling window.getWaxAccount() from their
// own DOMContentLoaded handler never race the widget's dynamic script load —
// shared/wallet-widget.js redefines this identically once it loads, harmless.
window.getWaxAccount = () => window.WaxAuth ? WaxAuth.getAccount() : (localStorage.getItem('wax_account') || null);

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
  WalletWidget.mount(document.querySelector('.nav-inner'), {
    authScript: '../shared/wax-auth.js',
    apiScript: '../shared/wax-api.js',
    exploreHref: '../explore',
    offersHref: '../trade-offers',
    buyOffersHref: '../buy-offers',
    profileHref: '../profile',
    menuItems: walletMenuItems('../'),
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

document.addEventListener('DOMContentLoaded', async () => {
  buildNav(); buildBackToTop(); buildFooter();
  // Wallet must mount before search — both insert immediately before the
  // burger, so whichever finishes its own lazy script load first wins the
  // DOM position. Awaiting wallet first pins the order deterministically
  // (search always ends up between the wallet controls and the burger),
  // instead of racing on network timing like the two lazy loads used to.
  await _initWallet();
  _initGlobalSearch();
  _showMovedOverlay();
});

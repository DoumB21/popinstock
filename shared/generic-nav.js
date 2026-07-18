// Populates the .nav-links (and mobile burger menu) on generic, non-project
// pages that share a common nav bar: Explore, Trade Analyzer.
// Add new generic pages here and every page picks up the new link automatically.
// Inventory is deliberately excluded — it's already reachable from the wallet
// widget menu (wallet-related page), so it stays out of the top-level nav.
// Bulk Buy is also deliberately excluded — narrow, low-frequency power-user
// feature that doesn't warrant permanent top-level exposure; reachable via a
// button on explore.html instead (same shape as inventory-bulk.html being
// reached from inventory.html rather than living in the nav).
const GENERIC_NAV_LINKS = [
  { label: 'Explore', href: 'explore.html' },
  { label: 'Trade Analyzer', href: 'trade-analyzer.html' },
];

(function buildGenericNav() {
  const nav = document.querySelector('.site-nav');
  const navInner = nav && nav.querySelector('.nav-inner');
  const linksContainer = navInner && navInner.querySelector('.nav-links');
  if (!nav || !navInner || !linksContainer) return;

  const currentPage = location.pathname.split('/').pop() || 'index.html';
  const linksHtml = GENERIC_NAV_LINKS.map(({ label, href }) => `
    <a href="${href}" class="nav-link${currentPage === href ? ' nav-link--active' : ''}">${label}</a>
  `).join('');

  linksContainer.innerHTML = linksHtml;

  // Burger must exist before shared/wallet-widget.js mounts, so it inserts
  // the wallet UI before the burger (nav-inner order: links, wallet, burger).
  const burger = document.createElement('button');
  burger.className = 'nav-burger';
  burger.setAttribute('aria-label', 'Toggle menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.innerHTML = '<span></span><span></span><span></span>';
  navInner.appendChild(burger);

  const mobile = document.createElement('div');
  mobile.className = 'nav-mobile';
  mobile.innerHTML = linksHtml;
  nav.appendChild(mobile);

  burger.addEventListener('click', () => {
    const open = mobile.classList.toggle('nav-mobile--open');
    burger.classList.toggle('nav-burger--open', open);
    burger.setAttribute('aria-expanded', open);
  });

  mobile.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      mobile.classList.remove('nav-mobile--open');
      burger.classList.remove('nav-burger--open');
      burger.setAttribute('aria-expanded', 'false');
    });
  });
})();

// Same "back to top" widget the project-specific nav.js files (funko/topps/
// wombat/twitch) build — ported here so every page loading generic-nav.js
// (Explore, Inventory, Inventory Bulk Actions, Trade Analyzer) gets it too.
(function buildBackToTop() {
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
})();

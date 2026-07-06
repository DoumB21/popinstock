// Populates the .nav-links (and mobile burger menu) on generic, non-project
// pages that share a common nav bar: Explore, Trade Analyzer.
// Add new generic pages here and every page picks up the new link automatically.
// Inventory is deliberately excluded — it's already reachable from the wallet
// widget menu (wallet-related page), so it stays out of the top-level nav.
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

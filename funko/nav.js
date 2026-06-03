const NAV_LINKS = [
  { label: 'Redemptions', href: 'redemptions.html' },
  { label: 'Trade Analyzer', href: 'trade-analyzer.html' },
  { label: 'Mint Rankings', href: 'mint-rankings.html' },
  { label: 'Wallet Look Up', href: 'wallet.html' },
  { label: 'Set Tracker', href: 'set-tracker.html' },
  { label: 'Market Overview', href: 'market-overview.html' },
];

const SECTION_NAME = 'Funko';

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
    .nav-wax-btn {
      font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em;
      padding: 5px 12px; border-radius: 999px; flex-shrink: 0;
      border: 1px solid rgba(240,168,64,0.35); background: rgba(240,168,64,0.07);
      color: var(--accent-light); cursor: pointer; white-space: nowrap;
      transition: background 0.15s, border-color 0.15s;
    }
    .nav-wax-btn:hover:not(:disabled) { background: rgba(240,168,64,0.16); border-color: rgba(240,168,64,0.55); }
    .nav-wax-btn:disabled { opacity: 0.55; cursor: default; }
    .nav-wax-connected-widget {
      display: none; align-items: center; gap: 6px;
      padding: 4px 6px 4px 11px; border-radius: 999px; flex-shrink: 0;
      border: 1px solid rgba(74,222,128,0.35); background: rgba(74,222,128,0.07);
    }
    .nav-wax-name {
      font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em;
      color: #4ade80; white-space: nowrap; user-select: none;
    }
    .nav-wax-logout-btn {
      width: 17px; height: 17px; border-radius: 50%; flex-shrink: 0;
      border: 1px solid rgba(74,222,128,0.3); background: none;
      color: rgba(74,222,128,0.65); cursor: pointer;
      font-size: 0.62rem; display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .nav-wax-logout-btn:hover { background: rgba(224,82,82,0.15); border-color: rgba(224,82,82,0.5); color: #e05252; }
  `;
  document.head.appendChild(navStyle);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.innerHTML = `
    <div class="nav-inner">
      <a href="../index.html" class="nav-home" title="Back to homepage">
        <img src="../images/FoxLogo.png" alt="PopInStock" />
      </a>
      <span class="nav-divider"></span>
      <a href="funko.html" class="nav-section">${SECTION_NAME}</a>
      <div class="nav-links">${links}</div>
      <button id="navWaxBtn" class="nav-wax-btn" title="Connect your WAX wallet">Connect Wallet</button>
      <div id="navWaxConnected" class="nav-wax-connected-widget">
        <span id="navWaxName" class="nav-wax-name"></span>
        <button id="navWaxLogout" class="nav-wax-logout-btn" title="Logout">✕</button>
      </div>
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
    &copy; 2026 PopInStock &mdash; All rights reserved.
    <div>All images, logos, and trademarks displayed on this site are the property of their respective owners. No affiliation or endorsement is implied. Used for informational purposes only.</div>
  `;
  document.body.appendChild(footer);
}

/* ── WAX Auth ─────────────────────────────────────────────────────────────── */
window.getWaxAccount = () => window.WaxAuth ? WaxAuth.getAccount() : (localStorage.getItem('wax_account') || null);

function _loadWaxAuth() {
  if (window.WaxAuth) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '../shared/wax-auth.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

function _waxShort(acc) {
  return acc.length > 13 ? acc.slice(0, 6) + '…' + acc.slice(-4) : acc;
}

function _updateNavWaxBtn() {
  const connectBtn   = document.getElementById('navWaxBtn');
  const connectedEl  = document.getElementById('navWaxConnected');
  const nameEl       = document.getElementById('navWaxName');
  const acc = window.getWaxAccount();
  if (acc) {
    if (connectBtn)  { connectBtn.style.display = 'none'; connectBtn.disabled = false; }
    if (connectedEl) connectedEl.style.display = 'flex';
    if (nameEl)      { nameEl.textContent = _waxShort(acc); nameEl.title = acc; }
  } else {
    if (connectBtn)  { connectBtn.style.display = ''; connectBtn.textContent = 'Connect Wallet'; connectBtn.disabled = false; }
    if (connectedEl) connectedEl.style.display = 'none';
  }
}

let _connectTimeout = null;

async function _handleWaxClick() {
  const btn = document.getElementById('navWaxBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  clearTimeout(_connectTimeout);
  // Failsafe: reset after 5 minutes if the wallet promise never settles
  _connectTimeout = setTimeout(() => _updateNavWaxBtn(), 300000);
  try {
    await _loadWaxAuth();
    await WaxAuth.login();
  } catch { /* cancelled or failed — no action needed */ } finally {
    clearTimeout(_connectTimeout);
    _updateNavWaxBtn();
  }
}

async function _handleWaxLogout() {
  const btn = document.getElementById('navWaxLogout');
  if (btn) btn.disabled = true;
  try {
    await _loadWaxAuth();
    await WaxAuth.logout();
  } catch { /* ignore */ } finally {
    _updateNavWaxBtn();
  }
}

async function _initWaxBtn() {
  const connectBtn = document.getElementById('navWaxBtn');
  const logoutBtn  = document.getElementById('navWaxLogout');
  if (connectBtn) connectBtn.addEventListener('click', _handleWaxClick);
  if (logoutBtn)  logoutBtn.addEventListener('click', _handleWaxLogout);
  window.addEventListener('wax-auth-change', _updateNavWaxBtn);
  try {
    await _loadWaxAuth();
    await WaxAuth.restore();
  } catch { /* no saved session */ }
  _updateNavWaxBtn();
}

document.addEventListener('DOMContentLoaded', () => { buildNav(); buildBackToTop(); buildFooter(); _initWaxBtn(); });

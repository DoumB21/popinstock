'use strict';
/* Shared Connect Wallet button + connected-account dropdown, used by every
   page's nav (site-wide, not just Funko/Topps). Wraps shared/wax-auth.js
   (WaxAuth) — this module only owns the DOM/UI, never the wallet SDK
   itself. CSS lives in shared/global.css (.nav-wax-*), not injected here,
   since every page already loads that stylesheet.

   Usage: WalletWidget.mount(navInnerEl, {
     authScript:   'shared/wax-auth.js' | '../shared/wax-auth.js',  // relative to the calling page
     menuItems:    [{ href, label }, ...],   // e.g. Inventory everywhere, Collector Profile on Funko only
     decorateName: (acc) => 'prefix ',       // optional — reads synchronously-available/cached data only (e.g. Funko's cached tier), never awaited — must not delay paint
     onAccount:    async (acc) => {},        // optional — fire-and-forget background refresh while acc is set (e.g. fetch+cache tier); triggers one re-render on completion, never blocks the current paint
     onLogout:     () => {},                 // optional — e.g. clear a cached tier
     onUpdate:     (acc|null) => {},          // optional — fires after every render, incl. logged-out state
   })
   Returns { render, connect, logout } so a page can trigger login/logout
   programmatically (e.g. a "Connect Wallet" prompt on a buy button). */
(function () {
  function _waxShort(acc) {
    return acc.length > 13 ? acc.slice(0, 6) + '…' + acc.slice(-4) : acc;
  }

  function _loadWaxAuth(authScript) {
    if (window.WaxAuth) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = authScript;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  window.getWaxAccount = () => window.WaxAuth ? WaxAuth.getAccount() : (localStorage.getItem('wax_account') || null);

  // Simple card/wallet glyph — stroke=currentColor so it always matches the button's text color.
  const _WALLET_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M2 10h20"/><circle cx="17" cy="14.5" r="1.3" fill="currentColor" stroke="none"/></svg>`;

  function mount(navInner, opts) {
    opts = opts || {};
    const authScript   = opts.authScript || 'shared/wax-auth.js';
    const menuItems    = opts.menuItems || [];
    const decorateName = opts.decorateName || (() => '');
    const onAccount    = opts.onAccount || null;
    const onLogout     = opts.onLogout || (() => {});
    const onUpdate      = opts.onUpdate || (() => {});

    const menuHtml = menuItems.map(m => `<a href="${m.href}" class="nav-wax-menu-item">${m.icon ? `<span class="nav-wax-menu-icon">${m.icon}</span>` : ''}${m.label}</a>`).join('');

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <button id="navWaxBtn" class="nav-wax-btn" title="Connect your WAX wallet">${_WALLET_ICON}<span id="navWaxBtnLabel">Connect Wallet</span></button>
      <div id="navWaxConnected" class="nav-wax-connected-widget">
        <span class="nav-wax-dot"></span>
        <button id="navWaxName" class="nav-wax-name" type="button"></button>
        <div id="navWaxMenu" class="nav-wax-menu" style="display:none;">
          ${menuHtml}
          <div class="nav-wax-menu-divider"></div>
          <button id="navWaxLogout" class="nav-wax-menu-item nav-wax-menu-logout" type="button"><span class="nav-wax-menu-icon">↪</span>Logout</button>
        </div>
      </div>
    `;
    const connectBtn  = wrap.querySelector('#navWaxBtn');
    const connectBtnLabel = wrap.querySelector('#navWaxBtnLabel');
    const connectedEl = wrap.querySelector('#navWaxConnected');
    const nameEl      = wrap.querySelector('#navWaxName');
    const menuEl      = wrap.querySelector('#navWaxMenu');
    const logoutBtn   = wrap.querySelector('#navWaxLogout');

    // Insert before the hamburger if this nav has one, so wallet UI always
    // sits between the nav links and the burger — matches every existing layout.
    const burger = navInner.querySelector('.nav-burger');
    while (wrap.firstChild) {
      if (burger) navInner.insertBefore(wrap.firstChild, burger);
      else navInner.appendChild(wrap.firstChild);
    }

    let _lastAccountRefreshed = undefined; // avoid re-firing onAccount on every re-render for the same account
    function render() {
      const acc = window.getWaxAccount();
      if (acc) {
        connectBtn.style.display = 'none';
        connectBtn.disabled = false;
        connectedEl.style.display = 'flex';
        // decorateName must read synchronously-available data only (e.g. a
        // previously-cached value) — never awaited, so it can never delay this paint.
        nameEl.innerHTML = decorateName(acc) + _waxShort(acc) + ' <span style="font-size:1rem;line-height:1;opacity:0.75">▾</span>';
        nameEl.title = 'Account options';
        if (onAccount && acc !== _lastAccountRefreshed) {
          _lastAccountRefreshed = acc;
          // Fire-and-forget: refreshes cached data (e.g. a tier) in the background,
          // then re-renders once so decorateName picks it up — never blocks this paint.
          Promise.resolve(onAccount(acc)).catch(() => {}).then(() => {
            if (window.getWaxAccount() === acc) render();
          });
        }
      } else {
        connectBtn.style.display = '';
        connectBtnLabel.textContent = 'Connect Wallet';
        connectBtn.disabled = false;
        connectedEl.style.display = 'none';
        menuEl.style.display = 'none';
        _lastAccountRefreshed = undefined;
      }
      onUpdate(acc);
    }

    let _connectTimeout = null;
    async function connect() {
      connectBtn.disabled = true;
      connectBtnLabel.textContent = 'Connecting…';
      clearTimeout(_connectTimeout);
      // Failsafe: reset after 5 minutes if the wallet promise never settles
      _connectTimeout = setTimeout(render, 300000);
      try {
        await _loadWaxAuth(authScript);
        await WaxAuth.login();
      } catch { /* cancelled or failed */ } finally {
        clearTimeout(_connectTimeout);
        render();
      }
    }

    async function logout() {
      menuEl.style.display = 'none';
      logoutBtn.disabled = true;
      try {
        await _loadWaxAuth(authScript);
        await WaxAuth.logout();
      } catch { /* ignore */ } finally {
        logoutBtn.disabled = false;
        onLogout();
        render();
      }
    }

    connectBtn.addEventListener('click', connect);
    logoutBtn.addEventListener('click', logout);
    nameEl.addEventListener('click', e => {
      e.stopPropagation();
      menuEl.style.display = menuEl.style.display === 'none' ? '' : 'none';
    });
    document.addEventListener('click', () => { menuEl.style.display = 'none'; });
    // restore() doesn't dispatch this, but login()/logout() (from this widget
    // or any other tab/page sharing the session) do — keep the UI in sync.
    window.addEventListener('wax-auth-change', render);

    // Flash prevention: render immediately, before WaxAuth even loads. Since
    // getWaxAccount() falls back to a raw localStorage read when WaxAuth isn't
    // loaded yet, a returning visitor sees their connected state right away
    // instead of a "Connect Wallet" flash while the SDK loads and restores.
    render();

    (async () => {
      try {
        await _loadWaxAuth(authScript);
        await WaxAuth.restore();
      } catch { /* no saved session */ }
      render();
    })();

    return { render, connect, logout };
  }

  window.WalletWidget = { mount };
})();

'use strict';
/* Shared Connect Wallet button + connected-account dropdown, used by every
   page's nav (site-wide, not just Funko/Topps). Wraps shared/wax-auth.js
   (WaxAuth) — this module only owns the DOM/UI, never the wallet SDK
   itself. CSS lives in shared/global.css (.nav-wax-*), not injected here,
   since every page already loads that stylesheet.

   Usage: WalletWidget.mount(navInnerEl, {
     authScript:   'shared/wax-auth.js' | '../shared/wax-auth.js',  // relative to the calling page
     apiScript:    'shared/wax-api.js'  | '../shared/wax-api.js',   // relative to the calling page — lazy-loaded only if window.WaxApi isn't already present, defaults to 'shared/wax-api.js'
     exploreHref:  'explore' | '../explore',              // relative to the calling page — cart icon link, defaults to 'explore'
     offersHref:   'trade-offers' | '../trade-offers',    // relative to the calling page — pending-offers icon link, defaults to 'trade-offers'
     menuItems:    [{ href, label }, ...],   // e.g. Inventory everywhere, Collector Profile on Funko only
     decorateName: (acc) => 'prefix ',       // optional — reads synchronously-available/cached data only (e.g. Funko's cached tier), never awaited — must not delay paint
     onAccount:    async (acc) => {},        // optional — fire-and-forget background refresh while acc is set (e.g. fetch+cache tier); triggers one re-render on completion, never blocks the current paint
     onLogout:     () => {},                 // optional — e.g. clear a cached tier
     onUpdate:     (acc|null) => {},          // optional — fires after every render, incl. logged-out state
   })
   Returns { render, connect, logout, refreshBalance, refreshOffersCount, setOffersBadge } so a
   page can trigger login/logout programmatically (e.g. a "Connect Wallet"
   prompt on a buy button), force an immediate WAX-balance/offers-count
   refresh right after a purchase completes instead of waiting for the next
   poll tick, or (setOffersBadge) push an already-known fresh offers count
   straight into the nav badge — e.g. trade-offers.html after an
   accept/decline, which knows the new count without another network call. */
(function () {
  function _waxShort(acc) {
    return acc.length > 13 ? acc.slice(0, 6) + '…' + acc.slice(-4) : acc;
  }

  function _loadScriptOnce(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  function _loadWaxAuth(authScript) {
    if (window.WaxAuth) return Promise.resolve();
    return _loadScriptOnce(authScript);
  }

  // WaxApi isn't guaranteed to already be on the page (several pages that
  // mount this widget — e.g. inventory.html, the funko/topps/twitch/wombat
  // hubs — never load shared/wax-api.js themselves), so the pending-offers
  // badge below loads it lazily, same as WaxAuth above.
  function _loadWaxApi(apiScript) {
    if (window.WaxApi) return Promise.resolve();
    return _loadScriptOnce(apiScript);
  }

  window.getWaxAccount = () => window.WaxAuth ? WaxAuth.getAccount() : (localStorage.getItem('wax_account') || null);

  /* ── WAX balance (nav pill) ──
     Public chain RPC, no wallet signature needed — just the account name we
     already have. A few known-good nodes tried in order (not the full
     health-check/rotation machinery WaxApi uses for AtomicAssets — this is
     one cheap call per refresh, a simple ordered fallback is enough). */
  const _WAX_RPC_ENDPOINTS = [
    'https://wax.greymass.com',
    'https://api.waxsweden.org',
    'https://wax.eu.eosamsterdam.net',
  ];
  const _RPC_TIMEOUT     = 5000;
  const _RATE_CACHE_KEY  = 'wax_usd_rate_cache_v1';
  const _RATE_TTL        = 2 * 60 * 1000; // CoinGecko is shared across every page nav — cache briefly rather than refetch each time
  const _BALANCE_POLL_MS = 60000;
  // This is a static multi-page site — every navigation is a full page load,
  // so in-memory state never survives it. Without this, the balance always
  // starts blank and pops in once the RPC/CoinGecko calls resolve, which
  // reads as a flicker on every click. Persist the last known value (like
  // wax_account/wax_funko_tier already do for the same reason) and paint it
  // synchronously before any network call, then quietly replace it once the
  // fresh fetch resolves.
  const _BALANCE_CACHE_KEY = 'wax_balance_cache_v1';

  function _readCachedBalance(acc) {
    try {
      const obj = JSON.parse(localStorage.getItem(_BALANCE_CACHE_KEY) || 'null');
      return obj && obj.acc === acc ? obj : null;
    } catch { return null; }
  }

  function _writeCachedBalance(acc, wax, rate) {
    try { localStorage.setItem(_BALANCE_CACHE_KEY, JSON.stringify({ acc, wax, rate })); } catch {}
  }

  function _fetchWithTimeout(url, fetchOpts, ms) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({}, fetchOpts, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
  }

  async function _fetchWaxBalance(acc) {
    for (const base of _WAX_RPC_ENDPOINTS) {
      try {
        const res = await _fetchWithTimeout(base + '/v1/chain/get_currency_balance', {
          method: 'POST',
          body: JSON.stringify({ code: 'eosio.token', account: acc, symbol: 'WAX' }),
        }, _RPC_TIMEOUT);
        if (!res.ok) continue;
        const rows = await res.json();
        return rows && rows[0] ? parseFloat(rows[0]) || 0 : 0;
      } catch { /* try next node */ }
    }
    return null; // every node failed
  }

  async function _fetchWaxUsdRate() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(_RATE_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.ts < _RATE_TTL) return cached.rate;
    } catch { /* sessionStorage unavailable or corrupt — just refetch */ }
    try {
      const res  = await _fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=wax&vs_currencies=usd', {}, _RPC_TIMEOUT);
      const json = await res.json();
      const rate = json?.wax?.usd ?? null;
      if (rate) { try { sessionStorage.setItem(_RATE_CACHE_KEY, JSON.stringify({ rate, ts: Date.now() })); } catch {} }
      return rate;
    } catch { return null; }
  }

  function _fmtBalance(wax, rate) {
    const waxStr = wax.toLocaleString(undefined, { maximumFractionDigits: wax >= 1000 ? 0 : 2 });
    if (!rate) return `${waxStr} WAX`;
    const usd    = wax * rate;
    const usdStr = usd.toLocaleString(undefined, { maximumFractionDigits: usd >= 100 ? 0 : 2 });
    return `${waxStr} WAX <span class="nav-wax-balance-usd">(~$${usdStr})</span>`;
  }

  // Simple card/wallet glyph — stroke=currentColor so it always matches the button's text color.
  const _WALLET_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M2 10h20"/><circle cx="17" cy="14.5" r="1.3" fill="currentColor" stroke="none"/></svg>`;

  /* ── Cart badge (nav icon) ──
     explore.html owns the cart itself (a plain localStorage array under
     CART_STORAGE_KEY there) — this widget only reads it to show a count.
     The key is duplicated here (not imported/shared) since it's a plain
     string constant; if explore.html's CART_STORAGE_KEY ever changes, this
     must be updated too. The cart isn't account-specific, so the badge
     shows regardless of connect state. */
  const _CART_STORAGE_KEY = 'explore_cart_v1';
  const _CART_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="21" r="1.4" fill="currentColor" stroke="none"/><path d="M2.5 3h2.6l2.7 12.9a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 2-1.6L22.5 8H6.2"/></svg>`;

  function _readCartCount() {
    try {
      const arr = JSON.parse(localStorage.getItem(_CART_STORAGE_KEY) || '[]');
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  }

  /* ── Pending trade offers badge (nav icon) ──
     Unlike the cart, this IS account-specific and needs a network call
     (AtomicAssets /offers), so it's cached per-account for flash-prevention
     (same reasoning as the WAX balance above) and only shown while connected.
     Counts "Received" offers only (state 0=PENDING + 1=INVALID, matching
     trade-offers.html's Received tab exactly) — a Sent offer awaiting the
     OTHER wallet's response isn't something this user needs to act on. */
  const _OFFERS_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"/><path d="M21 7H9a4 4 0 0 0-4 4v1"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h12a4 4 0 0 0 4-4v-1"/></svg>`;
  const _OFFERS_BADGE_CACHE_KEY = 'wax_offers_badge_cache_v1';

  /* ── Profile/settings icon (nav icon) ──
     Always visible, unlike the offers icon — the preferences on that page
     (starting with "pause NFT video previews") are localStorage-only and
     deliberately don't require a connected wallet, since the visitor most
     likely to want them (an old/slow computer) shouldn't have to connect a
     wallet first just to turn off video autoplay. */
  const _PROFILE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>`;

  function _readCachedOffersCount(acc) {
    try {
      const obj = JSON.parse(localStorage.getItem(_OFFERS_BADGE_CACHE_KEY) || 'null');
      return obj && obj.acc === acc ? obj.count : null;
    } catch { return null; }
  }
  function _writeCachedOffersCount(acc, count) {
    try { localStorage.setItem(_OFFERS_BADGE_CACHE_KEY, JSON.stringify({ acc, count })); } catch {}
  }

  async function _fetchPendingOffersCount(acc, apiScript) {
    try {
      await _loadWaxApi(apiScript);
      const url = `${WaxApi.aaBase()}/offers?recipient=${encodeURIComponent(acc)}&state=0,1&hide_contracts=true&limit=100&page=1`;
      const data = await WaxApi.apiFetch(url);
      return (data || []).length;
    } catch { return null; } // every node failed / script failed to load — leave whatever's showing
  }

  function mount(navInner, opts) {
    opts = opts || {};
    const authScript   = opts.authScript || 'shared/wax-auth.js';
    const apiScript    = opts.apiScript  || 'shared/wax-api.js';
    const exploreHref  = opts.exploreHref || 'explore';
    const offersHref   = opts.offersHref  || 'trade-offers';
    const profileHref  = opts.profileHref || 'profile';
    const menuItems    = opts.menuItems || [];
    const decorateName = opts.decorateName || (() => '');
    const onAccount    = opts.onAccount || null;
    const onLogout     = opts.onLogout || (() => {});
    const onUpdate      = opts.onUpdate || (() => {});

    // The Inventory link (site-wide, always the exact path segment
    // "inventory") gets the connected account appended as a clean /wallet
    // path segment so inventory.html can default to "my own inventory"
    // without the page itself needing to know or care where the click came
    // from. Detected by href shape rather than a per-caller flag so every
    // existing/future page's menuItems config picks this up automatically.
    const menuHtml = menuItems.map(m => {
      const isInventoryLink = /(^|\/)inventory$/.test(m.href);
      const attrs = isInventoryLink ? ` data-wallet-link data-base-href="${m.href}"` : '';
      return `<a href="${m.href}" class="nav-wax-menu-item"${attrs}>${m.icon ? `<span class="nav-wax-menu-icon">${m.icon}</span>` : ''}${m.label}</a>`;
    }).join('');

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <a id="navCartBtn" class="nav-cart-btn" href="${exploreHref}" title="View cart">${_CART_ICON}<span id="navCartBadge" class="nav-cart-badge" style="display:none;"></span></a>
      <a id="navOffersBtn" class="nav-cart-btn" href="${offersHref}" title="Pending trade offers" style="display:none;">${_OFFERS_ICON}<span id="navOffersBadge" class="nav-cart-badge" style="display:none;"></span></a>
      <a id="navProfileBtn" class="nav-cart-btn" href="${profileHref}" title="Profile & settings">${_PROFILE_ICON}</a>
      <button id="navWaxBtn" class="nav-wax-btn" title="Connect your WAX wallet">${_WALLET_ICON}<span id="navWaxBtnLabel">Connect Wallet</span></button>
      <div id="navWaxConnected" class="nav-wax-connected-widget">
        <span class="nav-wax-dot"></span>
        <span id="navWaxBalance" class="nav-wax-balance"></span>
        <button id="navWaxName" class="nav-wax-name" type="button"></button>
        <div id="navWaxMenu" class="nav-wax-menu" style="display:none;">
          <div id="navWaxMenuBalance" class="nav-wax-menu-balance"></div>
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
    const balanceEl   = wrap.querySelector('#navWaxBalance');
    const menuBalanceEl = wrap.querySelector('#navWaxMenuBalance');
    const cartBadge   = wrap.querySelector('#navCartBadge');
    const offersBtn   = wrap.querySelector('#navOffersBtn');
    const offersBadge = wrap.querySelector('#navOffersBadge');
    // Captured now (before the move-into-navInner loop below detaches them
    // from `wrap`) — the element references stay valid wherever they live.
    const walletLinkEls = Array.from(wrap.querySelectorAll('[data-wallet-link]'));

    // Pill balance is hidden below 480px (no room next to the name) — this
    // mirrors the same HTML into the dropdown menu instead, so it's still
    // one tap away on mobile. CSS shows only one of the two at a time.
    function _paintBalanceHtml(html) {
      balanceEl.innerHTML     = html;
      menuBalanceEl.innerHTML = html;
    }

    // Insert before the hamburger if this nav has one, so wallet UI always
    // sits between the nav links and the burger — matches every existing layout.
    const burger = navInner.querySelector('.nav-burger');
    while (wrap.firstChild) {
      if (burger) navInner.insertBefore(wrap.firstChild, burger);
      else navInner.appendChild(wrap.firstChild);
    }

    // Cart badge — independent of connect state, pure localStorage read (no
    // network, so no flash-prevention concern like the balance above).
    function _renderCartBadge() {
      const n = _readCartCount();
      cartBadge.textContent   = n > 99 ? '99+' : String(n);
      cartBadge.style.display = n > 0 ? '' : 'none';
    }
    _renderCartBadge();
    // 'storage' only fires in OTHER tabs; explore.html dispatches
    // 'explore-cart-change' itself so same-tab edits update this too.
    window.addEventListener('storage', e => { if (!e.key || e.key === _CART_STORAGE_KEY) _renderCartBadge(); });
    window.addEventListener('explore-cart-change', _renderCartBadge);

    let _lastAccountRefreshed = undefined; // avoid re-firing onAccount on every re-render for the same account
    let _lastBalanceAcc = undefined;       // avoid re-fetching the balance on every re-render for the same account
    let _haveLiveBalance = false;          // true once a real (non-cached) fetch has painted this page load
    let _balancePoll = null;

    // Synchronous, cache-only — same contract as decorateName: never blocks
    // paint, only ever shows a previously-fetched value. Skipped once a live
    // fetch has already painted, so a later render() (e.g. after restore())
    // can't stomp a fresher value back to the stale cached one.
    function _paintCachedBalance(acc) {
      if (_haveLiveBalance) return;
      const cached = _readCachedBalance(acc);
      if (cached) _paintBalanceHtml(_fmtBalance(cached.wax, cached.rate));
    }

    async function _refreshBalance(acc, force) {
      if (!force && acc === _lastBalanceAcc) return;
      _lastBalanceAcc = acc;
      const [wax, rate] = await Promise.all([_fetchWaxBalance(acc), _fetchWaxUsdRate()]);
      if (window.getWaxAccount() !== acc) return; // stale — account changed while this was in flight
      if (wax === null) return; // every RPC node failed — leave whatever's showing (cached or blank) rather than flicker it away
      _paintBalanceHtml(_fmtBalance(wax, rate));
      _haveLiveBalance = true;
      _writeCachedBalance(acc, wax, rate);
    }

    function refreshBalance() {
      const acc = window.getWaxAccount();
      if (acc) _refreshBalance(acc, true);
    }

    let _lastOffersAcc      = undefined; // avoid re-fetching the count on every re-render for the same account
    let _haveLiveOffersCount = false;    // true once a real (non-cached) fetch has painted this page load

    function _paintOffersBadge(n) {
      offersBadge.textContent   = n > 99 ? '99+' : String(n);
      offersBadge.style.display = n > 0 ? '' : 'none';
    }

    function _paintCachedOffersCount(acc) {
      if (_haveLiveOffersCount) return;
      const cached = _readCachedOffersCount(acc);
      if (cached != null) _paintOffersBadge(cached);
    }

    async function _refreshOffersCount(acc, force) {
      if (!force && acc === _lastOffersAcc) return;
      _lastOffersAcc = acc;
      const n = await _fetchPendingOffersCount(acc, apiScript);
      if (window.getWaxAccount() !== acc) return; // stale — account changed while this was in flight
      if (n === null) return; // fetch failed — leave whatever's showing (cached or blank) rather than flicker it away
      _paintOffersBadge(n);
      _haveLiveOffersCount = true;
      _writeCachedOffersCount(acc, n);
    }

    function refreshOffersCount() {
      const acc = window.getWaxAccount();
      if (acc) _refreshOffersCount(acc, true);
    }

    // Lets a page that already knows the fresh count (e.g. trade-offers.html
    // right after an accept/decline) update the badge instantly, without
    // waiting for the next poll tick or paying for a redundant network call —
    // the caller already paid for that fetch itself.
    function setOffersBadge(n) {
      const acc = window.getWaxAccount();
      if (!acc) return;
      _paintOffersBadge(n);
      _haveLiveOffersCount = true;
      _writeCachedOffersCount(acc, n);
    }

    function render() {
      const acc = window.getWaxAccount();
      walletLinkEls.forEach(a => {
        const base = a.getAttribute('data-base-href');
        a.href = acc ? `${base}/${encodeURIComponent(acc)}` : base;
      });
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
        _paintCachedBalance(acc);
        _refreshBalance(acc, false).catch(() => {});
        offersBtn.style.display = '';
        _paintCachedOffersCount(acc);
        _refreshOffersCount(acc, false).catch(() => {});
        if (!_balancePoll) {
          _balancePoll = setInterval(() => {
            const cur = window.getWaxAccount();
            if (cur) { _refreshBalance(cur, true); _refreshOffersCount(cur, true); }
          }, _BALANCE_POLL_MS);
        }
      } else {
        connectBtn.style.display = '';
        connectBtnLabel.textContent = 'Connect Wallet';
        connectBtn.disabled = false;
        connectedEl.style.display = 'none';
        menuEl.style.display = 'none';
        _lastAccountRefreshed = undefined;
        _lastBalanceAcc = undefined;
        _haveLiveBalance = false;
        _paintBalanceHtml('');
        offersBtn.style.display = 'none';
        _lastOffersAcc = undefined;
        _haveLiveOffersCount = false;
        offersBadge.style.display = 'none';
        clearInterval(_balancePoll);
        _balancePoll = null;
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

    return { render, connect, logout, refreshBalance, refreshOffersCount, setOffersBadge };
  }

  window.WalletWidget = { mount };
})();

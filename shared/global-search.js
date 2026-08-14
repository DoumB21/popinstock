'use strict';
/* Sitewide quick-search popup — magnifying-glass icon in the nav bar that
   opens a Collection/Wallet lookup, so getting to a collection or wallet
   page never requires typing the URL by hand (the main pain point this
   solves is on mobile, where there's no address bar shortcut for that).

   Deliberately two tabs only, not three — no Template tab. AtomicHub-style
   live-suggestion search only exists for Collections here because
   atomicmarket's stats/collections?search= is a real indexed full-text
   search (same query explore.html's own collection typeahead uses). WAX has
   no equivalent public index of account names to search by prefix, so the
   Wallet tab is a debounced exact-match existence check (chain
   get_account) instead of a suggestion list — confirming a typed name is
   real before sending the user to its inventory page, not pretending to
   autocomplete something we can't.

   Usage: GlobalSearch.mount(navInnerEl, {
     apiScript:      'shared/wax-api.js' | '../shared/wax-api.js',  // relative to the calling page, lazy-loaded only if window.WaxApi isn't already present
     collectionHref: 'collection' | '../collection',
     exploreHref:    'explore' | '../explore',
     walletHref:     'inventory' | '../inventory',
   }) */
(function () {
  const _SEARCH_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M21 21l-5.6-5.6"/></svg>`;
  const _OK_ICON  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const _ERR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const _WALLET_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M2 10h20"/><circle cx="17" cy="14.5" r="1.3" fill="currentColor" stroke="none"/></svg>`;

  const MIN_CHARS = 3;
  const DEBOUNCE_MS = 300;
  // Same 90-day window trick explore.html's own collection typeahead uses —
  // an unscoped stats/collections?search= is a genuine multi-second cold
  // aggregation over ALL-TIME sales for every match; bounding it to a
  // recent window is dramatically cheaper without hiding any collection
  // (after= only affects the volume figure used for sort order, never
  // which collections match the search text).
  const COL_SEARCH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

  // Recent-searches lists, same MRU-in-localStorage shape as explore.html's
  // own "Recently viewed collections" sidebar — but written only on an
  // actual click-through (a result row, the marketplace shortcut, or "View
  // Wallet"), never just from typing, so the list stays a record of places
  // actually visited rather than every half-typed query.
  const RECENTS_MAX        = 8;
  const RECENTS_COL_KEY    = 'gs_recent_collections_v1';
  const RECENTS_WALLET_KEY = 'gs_recent_wallets_v1';

  function loadRecentCollections() {
    try { return JSON.parse(localStorage.getItem(RECENTS_COL_KEY)) || []; } catch { return []; }
  }
  function addRecentCollection(c) {
    const list = loadRecentCollections().filter(r => r.collection_name !== c.collection_name);
    list.unshift({ collection_name: c.collection_name, name: c.name || c.collection_name, img: c.img || '' });
    try { localStorage.setItem(RECENTS_COL_KEY, JSON.stringify(list.slice(0, RECENTS_MAX))); } catch {}
  }
  function removeRecentCollection(collectionName) {
    const list = loadRecentCollections().filter(r => r.collection_name !== collectionName);
    try { localStorage.setItem(RECENTS_COL_KEY, JSON.stringify(list)); } catch {}
  }
  function clearRecentCollections() { try { localStorage.removeItem(RECENTS_COL_KEY); } catch {} }

  function loadRecentWallets() {
    try { return JSON.parse(localStorage.getItem(RECENTS_WALLET_KEY)) || []; } catch { return []; }
  }
  function addRecentWallet(name) {
    const list = loadRecentWallets().filter(w => w !== name);
    list.unshift(name);
    try { localStorage.setItem(RECENTS_WALLET_KEY, JSON.stringify(list.slice(0, RECENTS_MAX))); } catch {}
  }
  function removeRecentWallet(name) {
    const list = loadRecentWallets().filter(w => w !== name);
    try { localStorage.setItem(RECENTS_WALLET_KEY, JSON.stringify(list)); } catch {}
  }
  function clearRecentWallets() { try { localStorage.removeItem(RECENTS_WALLET_KEY); } catch {} }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Site convention (see vercel.json's rewrites) is a path segment, not a
  // query string, for every entity page that has one — /collection/:name,
  // /inventory/:wallet, etc. all rewrite internally to the ?query= form,
  // but every other page on the site links to the path form, so this does
  // too rather than the (equally functional, but inconsistent) query form.
  function entityHref(base, id) {
    return `${base}/${encodeURIComponent(id)}`;
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

  function _loadWaxApi(apiScript) {
    if (window.WaxApi) return Promise.resolve();
    return _loadScriptOnce(apiScript);
  }

  function mount(navInner, opts) {
    opts = opts || {};
    // `let`, not `const` — collection.html/template.html/schema.html/
    // asset.html/sale.html/inventory.html can all be reached via a pretty,
    // path-segment URL one (or, for schema, two) directories "deeper" than
    // their own file, and inventory.html additionally *becomes* nested
    // after the fact by pinning the connected wallet into the address bar
    // post-load. Same problem WalletWidget.reprefix() exists for — see its
    // doc comment in shared/wallet-widget.js — solved the same way: a
    // caller that knows its prefix changed calls GlobalSearch.reprefix()
    // (attached below) to correct these in place.
    let apiScript      = opts.apiScript || 'shared/wax-api.js';
    let collectionHref = opts.collectionHref || 'collection';
    let exploreHref    = opts.exploreHref || 'explore';
    let walletHref      = opts.walletHref || 'inventory';
    const chainRpc        = () => localStorage.getItem('hoardio_rpc_endpoint') || 'https://wax.greymass.com';

    const btn = document.createElement('button');
    btn.id = 'navSearchBtn';
    btn.className = 'nav-cart-btn';
    btn.type = 'button';
    btn.title = 'Search collections & wallets';
    btn.innerHTML = _SEARCH_ICON;
    const burger = navInner.querySelector('.nav-burger');
    if (burger) navInner.insertBefore(btn, burger);
    else navInner.appendChild(btn);

    let overlay = document.getElementById('gsOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'gsOverlay';
      overlay.className = 'gs-overlay';
      overlay.style.display = 'none';
      overlay.innerHTML = `
        <div class="gs-panel" role="dialog" aria-modal="true">
          <div class="gs-header">
            <div class="gs-input-wrap">
              <span class="gs-input-icon">${_SEARCH_ICON}</span>
              <input type="text" id="gsInput" class="gs-input" placeholder="Search collections or wallets…" autocomplete="off" spellcheck="false" />
              <button type="button" id="gsClear" class="gs-clear" style="display:none;">&times;</button>
            </div>
            <button type="button" id="gsClose" class="gs-close" aria-label="Close">&#x2715;</button>
          </div>
          <div class="gs-tabs">
            <button type="button" class="gs-tab active" data-tab="collection">Collections</button>
            <button type="button" class="gs-tab" data-tab="wallet">Wallets</button>
          </div>
          <div class="gs-body" id="gsBody"></div>
        </div>`;
      document.body.appendChild(overlay);
    }
    const panel  = overlay.querySelector('.gs-panel');
    const input  = overlay.querySelector('#gsInput');
    const clearBtn = overlay.querySelector('#gsClear');
    const closeBtn = overlay.querySelector('#gsClose');
    const tabs   = Array.from(overlay.querySelectorAll('.gs-tab'));
    const body   = overlay.querySelector('#gsBody');

    let _activeTab = 'collection';
    let _debT = null;
    let _colGen = 0, _walletGen = 0;
    let _colVisible = []; // whatever collection list is currently rendered (search results OR recents) — data-i indexes into this
    const _col    = { query: null, results: [] };    // query===null means "never fetched"
    const _wallet = { query: null, status: 'idle', account: '' }; // status: idle|checking|valid|invalid|error

    function renderHint(msg) {
      body.innerHTML = `<div class="gs-hint">${esc(msg)}</div>`;
    }

    function recentHeadHtml(kind) {
      return `<div class="gs-recent-head"><span>Recent</span><button type="button" class="gs-recent-clear" data-clear="${kind}">Clear all</button></div>`;
    }

    // Labels the row's two separate destinations (the row itself vs. the
    // small action icon) — without this, the icon alone reads as
    // decoration rather than a second, different link. The trailing empty
    // spacer always matches .gs-result-remove-col's width below — present
    // in every row (live results just leave it empty) so the Marketplace
    // column's x-position never shifts depending on whether a remove
    // button happens to be showing next to it.
    const _COL_HEAD_HTML = `<div class="gs-col-head"><span class="gs-col-head-main">Collection page</span><span class="gs-col-head-action">Marketplace</span><span class="gs-col-head-remove-spacer"></span></div>`;

    // `removable` is only true for the Recent list — live search results
    // aren't something you'd ever "remove", so the column is always
    // reserved (keeps the Marketplace column's position fixed either way)
    // but only actually holds a button when removable.
    function collectionRowHtml(c, i, removable) {
      const ipfs = window.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
      const img = c.img
        ? `<img class="gs-result-img" src="${ipfs}${esc(c.img)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'gs-result-ph'}))">`
        : '<div class="gs-result-ph"></div>';
      const removeBtn = removable
        ? `<button type="button" class="gs-result-remove" data-remove-collection="${esc(c.collection_name)}" title="Remove from recent">&times;</button>`
        : '';
      // exploreHref stays a query param (?col=) — that's explore.html's own
      // preselect param, not one of vercel.json's path-segment rewrites.
      return `<div class="gs-result" data-i="${i}">
        <div class="gs-result-main">
          ${img}
          <div class="gs-result-info">
            <span class="gs-result-name">${esc(c.name || c.collection_name)}</span>
            <span class="gs-result-slug">${esc(c.collection_name)}</span>
          </div>
        </div>
        <div class="gs-result-action-col">
          <a class="gs-result-action" href="${exploreHref}?col=${encodeURIComponent(c.collection_name)}" title="View in marketplace" data-explore>Explore</a>
        </div>
        <div class="gs-result-remove-col">${removeBtn}</div>
      </div>`;
    }

    function renderCollectionPanel() {
      const q = input.value.trim();
      if (!q) {
        const recents = loadRecentCollections();
        _colVisible = recents;
        if (!recents.length) { renderHint(`Type at least ${MIN_CHARS} characters to search collections.`); return; }
        body.innerHTML = recentHeadHtml('collection') + _COL_HEAD_HTML + recents.map((c, i) => collectionRowHtml(c, i, true)).join('');
        return;
      }
      if (q.length < MIN_CHARS) { _colVisible = []; renderHint(`Type at least ${MIN_CHARS} characters to search collections.`); return; }
      if (_col.query !== q) { _colVisible = []; renderHint('Searching…'); return; } // fetch in flight, not painted yet
      if (!_col.results.length) { _colVisible = []; renderHint(`No collections found matching "${q}".`); return; }
      _colVisible = _col.results;
      body.innerHTML = _COL_HEAD_HTML + _colVisible.map((c, i) => collectionRowHtml(c, i)).join('');
    }

    function renderWalletPanel() {
      const q = input.value.trim();
      if (!q) {
        const recents = loadRecentWallets();
        if (!recents.length) { renderHint(`Type at least ${MIN_CHARS} characters to look up a wallet.`); return; }
        body.innerHTML = recentHeadHtml('wallet') + recents.map(name => `<div class="gs-result" data-wallet="${esc(name)}">
          <div class="gs-result-main">
            <div class="gs-result-ph gs-result-ph--wallet">${_WALLET_ICON}</div>
            <div class="gs-result-info"><span class="gs-result-name">${esc(name)}</span></div>
          </div>
          <div class="gs-result-remove-col"><button type="button" class="gs-result-remove" data-remove-wallet="${esc(name)}" title="Remove from recent">&times;</button></div>
        </div>`).join('');
        return;
      }
      if (q.length < MIN_CHARS) { renderHint(`Type at least ${MIN_CHARS} characters to look up a wallet.`); return; }
      if (_wallet.query !== q || _wallet.status === 'checking') {
        body.innerHTML = `<div class="gs-wallet-status"><div class="gs-spin"></div><div class="gs-wallet-sub">Checking chain for "${esc(q)}"…</div></div>`;
        return;
      }
      const href = entityHref(walletHref, q);
      if (_wallet.status === 'valid') {
        body.innerHTML = `<div class="gs-wallet-status">
          <div class="gs-wallet-icon gs-wallet-icon--ok">${_OK_ICON}</div>
          <div class="gs-wallet-msg"><b>${esc(q)}</b> is a real WAX wallet.</div>
          <a class="gs-wallet-go" href="${href}">View Wallet →</a>
        </div>`;
      } else if (_wallet.status === 'invalid') {
        body.innerHTML = `<div class="gs-wallet-status">
          <div class="gs-wallet-icon gs-wallet-icon--err">${_ERR_ICON}</div>
          <div class="gs-wallet-msg">No wallet named <b>${esc(q)}</b> exists on WAX.</div>
        </div>`;
      } else { // error — chain RPC unreachable; don't block the user, just skip the confirmation
        body.innerHTML = `<div class="gs-wallet-status">
          <div class="gs-wallet-sub">Couldn't verify "${esc(q)}" right now — you can still try viewing it.</div>
          <a class="gs-wallet-go" href="${href}">View Wallet →</a>
        </div>`;
      }
    }

    function render() {
      clearBtn.style.display = input.value ? '' : 'none';
      if (_activeTab === 'collection') renderCollectionPanel();
      else renderWalletPanel();
    }

    async function searchCollections(q) {
      const myGen = ++_colGen;
      try {
        await _loadWaxApi(apiScript);
        const after = Date.now() - COL_SEARCH_WINDOW_MS;
        const data = await WaxApi.apiFetch(`${WaxApi.marketBase()}/stats/collections?symbol=WAX&search=${encodeURIComponent(q)}&sort=volume&order=desc&limit=10&after=${after}`);
        if (myGen !== _colGen) return;
        _col.query   = q;
        _col.results = (data?.results || []).map(r => ({ collection_name: r.collection_name, name: r.name || r.collection_name, img: r.img || '' }));
      } catch {
        if (myGen !== _colGen) return;
        _col.query   = q;
        _col.results = [];
      }
      if (_activeTab === 'collection') render();
    }

    async function checkWallet(q) {
      const myGen = ++_walletGen;
      _wallet.query  = q;
      _wallet.status = 'checking';
      if (_activeTab === 'wallet') render();
      try {
        const res = await fetch(`${chainRpc()}/v1/chain/get_account`, {
          method: 'POST',
          body: JSON.stringify({ account_name: q }),
        });
        if (myGen !== _walletGen) return;
        _wallet.status = res.ok ? 'valid' : 'invalid';
      } catch {
        if (myGen !== _walletGen) return;
        _wallet.status = 'error';
      }
      if (_activeTab === 'wallet') render();
    }

    function runActiveTabSearch() {
      const q = input.value.trim();
      if (q.length < MIN_CHARS) { render(); return; }
      if (_activeTab === 'collection') {
        if (_col.query !== q) searchCollections(q);
        render();
      } else {
        if (_wallet.query !== q) checkWallet(q);
        else render();
      }
    }

    function setTab(tab) {
      if (tab === _activeTab) return;
      _activeTab = tab;
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      runActiveTabSearch();
    }

    tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

    input.addEventListener('input', () => {
      // Lowercase in place (same convention as every other wallet-input
      // field site-wide, e.g. funko/wallet.html's walletInput) — mobile
      // keyboards auto-capitalize the first character, and WAX account
      // names are case-sensitive, so an uncorrected capital silently
      // breaks the Wallets tab's exact-match lookup. Harmless for the
      // Collections tab too since that search is already case-insensitive.
      const { selectionStart, selectionEnd } = input;
      input.value = input.value.toLowerCase();
      input.setSelectionRange(selectionStart, selectionEnd);
      clearBtn.style.display = input.value ? '' : 'none';
      clearTimeout(_debT);
      _debT = setTimeout(runActiveTabSearch, DEBOUNCE_MS);
    });

    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = input.value.trim();
      if (q.length < MIN_CHARS) return;
      if (_activeTab === 'collection') {
        if (_col.query === q && _col.results[0]) location.href = entityHref(collectionHref, _col.results[0].collection_name);
      } else {
        location.href = entityHref(walletHref, q);
      }
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      render();
      input.focus();
    });

    body.addEventListener('click', e => {
      const clearEl = e.target.closest('[data-clear]');
      if (clearEl) {
        if (clearEl.dataset.clear === 'collection') clearRecentCollections();
        else clearRecentWallets();
        render();
        return;
      }

      const removeEl = e.target.closest('.gs-result-remove');
      if (removeEl) {
        if (removeEl.dataset.removeCollection) removeRecentCollection(removeEl.dataset.removeCollection);
        else if (removeEl.dataset.removeWallet) removeRecentWallet(removeEl.dataset.removeWallet);
        render();
        return;
      }

      const goBtn = e.target.closest('.gs-wallet-go');
      if (goBtn) { addRecentWallet(_wallet.query); return; } // its own <a href> handles navigation

      const walletRow = e.target.closest('.gs-result[data-wallet]');
      if (walletRow) {
        const name = walletRow.dataset.wallet;
        addRecentWallet(name);
        location.href = entityHref(walletHref, name);
        return;
      }

      const row = e.target.closest('.gs-result[data-i]');
      if (!row) return;
      const c = _colVisible[+row.dataset.i];
      if (!c) return;
      if (e.target.closest('[data-explore]')) { addRecentCollection(c); return; } // its own <a href> handles navigation
      addRecentCollection(c);
      location.href = entityHref(collectionHref, c.collection_name);
    });

    function open() {
      overlay.style.display = 'flex';
      setTimeout(() => input.focus(), 0);
      render();
    }
    function close() {
      overlay.style.display = 'none';
    }

    // Corrects the four relative hrefs in place after the host page's own
    // prefix changes post-load (currently only inventory.html's wallet-pin
    // flow). Nothing needs re-rendering: the nav button itself carries no
    // href, and the popup body is rebuilt fresh from these variables every
    // time it's opened (render()), so the next open() already picks up the
    // corrected values — same "self-corrects for free" reasoning inventory.html's
    // own comment gives for its live _p reads. Attached onto the module
    // singleton (mirrors WalletWidget.reprefix) since callers never capture
    // mount()'s return value.
    function reprefix(prefix) {
      if (!apiScript.startsWith(prefix))      apiScript      = prefix + apiScript;
      if (!collectionHref.startsWith(prefix)) collectionHref = prefix + collectionHref;
      if (!exploreHref.startsWith(prefix))    exploreHref    = prefix + exploreHref;
      if (!walletHref.startsWith(prefix))     walletHref     = prefix + walletHref;
    }
    GlobalSearch.reprefix = reprefix;

    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    let _downOnOverlay = false;
    overlay.addEventListener('mousedown', e => { _downOnOverlay = (e.target === overlay); });
    overlay.addEventListener('click', e => { if (_downOnOverlay && e.target === overlay) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display !== 'none') close(); });

    renderHint(`Type at least ${MIN_CHARS} characters to search collections.`);

    return { open, close };
  }

  window.GlobalSearch = { mount };
})();

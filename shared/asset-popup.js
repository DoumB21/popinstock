'use strict';
/* Shared hover tooltip + click-persisted info popup for an NFT card —
   Attributes/Supply/You/Backed tokens, used by inventory.html and
   explore.html's asset grids. Owns its own DOM (#assetPopupHover/
   #assetPopupInfo, injected into <body> on mount), positioning, the
   Supply/Owned network fetches, and rendering. CSS (.hover-tooltip/
   .info-popup/.tt-*) lives in shared/global.css, same as every other
   shared component on this site — every page that would use this module
   already loads that stylesheet.

   Usage: const popup = AssetPopup.mount({
     aaBase:   () => atomicApi() | WaxApi.aaBase(),                 // required — AtomicAssets REST base
     apiFetch: url => fetchWithRetry(url).then(r=>r.json()) | WaxApi.apiFetch(url), // required — returns parsed JSON
     collectionHref: name => `collection/${name}` | `../collection/${name}`,        // optional, defaults shown
     templateHref:   id   => `template/${id}`     | `../template/${id}`,            // optional, defaults shown
     walletHref:     acc  => `inventory/${acc}`   | `../inventory/${acc}`,      // optional, defaults shown
     schemaHref:     (collection, schema) => `schema/${collection}/${schema}` | `../schema/${collection}/${schema}`, // optional, defaults shown
     assetHref:      id   => `asset/${id}`        | `../asset/${id}`,               // optional, defaults shown
   });

   Per card: popup.wire(cardEl, data, { hoverEl, shouldSuppressHover, onCardClick });
   `onCardClick`, if given, replaces the default click-to-toggle-the-info-
   popup behavior entirely (e.g. explore.html navigates to the sale page on
   click instead) — hover still works as usual either way.
   `data` — plain object each page builds from its own asset representation:
   { assetId, templateId, collection, collectionName, schema, rarity,
     rarityClass, cardid, name, owner, backedTokens }
   `backedTokens` is the raw AtomicAssets `backed_tokens` array (or absent);
   `rarityClass` is the page's own rarity->CSS-class lookup result (pages
   use different rarity taxonomies, so this module never guesses one).

   Lower-level controls (`schedule`/`cancel`/`open`/`close`) are also
   returned for pages that need custom hover suppression around a card's own
   sub-elements (e.g. a select-checkbox that should pause the hover timer
   while itself hovered) — wire() covers the common case, these compose.

   `AssetPopup.fetchDropppLocked(templateId)` is a standalone module-level
   export (no mount() needed) — resolves to `{ isFunko, dpLocked }` or
   `null` for a non-Funko template. Only needs Supabase, so any page
   wanting just the Droppp-locked figure (e.g. template.html's own supply
   breakdown, which already fetches issued/burned itself) can call this
   directly instead of going through the full popup-fetching flow. */
window.AssetPopup = (function () {
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Trailing-zero-trimmed token amount, no unit suffix (fmtBackedTokens
  // appends the symbol separately since a backed token isn't always WAX).
  function fmtTok(n) {
    return n.toFixed(8)
      .replace(/(\.\d{2}.*[1-9])0+$/, '$1')
      .replace(/(\.\d{2})0+$/, '$1');
  }

  // AtomicAssets' /assets response always includes backed_tokens (empty
  // array when there's none) regardless of any query param — no extra
  // fetch needed, same field is nested inside AtomicMarket sale records too.
  function fmtBackedTokens(tokens) {
    if (!tokens || !tokens.length) return 'None';
    return tokens.map(t => `${fmtTok(Number(t.amount) / (10 ** t.token_precision))} ${t.token_symbol}`).join(', ');
  }

  const _copyIconSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  function copyVal(btn, text) {
    navigator.clipboard.writeText(String(text)).then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1200);
    }).catch(() => {});
  }

  // Bare references, not window.SUPABASE_URL/window.SUPABASE_ANON_KEY —
  // shared/supabase-config.js declares these with `const`, which never
  // attaches to `window` (only `var` does). All classic <script> tags in a
  // document share one top-level lexical scope for const/let, so the bare
  // identifiers resolve correctly here as long as supabase-config.js loads
  // first (it does, on every page that uses this module).
  function sbHeaders() {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Accept-Profile': 'funko',
    };
  }

  // funko.templates is the authoritative Funko catalog — if the
  // template_id is there, it's a Funko card and Droppp-locked supply
  // applies. Same dp_locked_count precedence as marketplace.html
  // (funko_market_prices' own value is fresher when present, falling back
  // to funko.templates'). Standalone module-level export (not tied to
  // mount()/aaBase/apiFetch) since it only needs Supabase — usable by any
  // page that just wants the Droppp-locked figure without wiring the full
  // hover/click popup (e.g. template.html's own supply breakdown).
  async function fetchDropppLocked(templateId) {
    try {
      const tUrl = `${SUPABASE_URL}/rest/v1/templates?select=template_id,dp_locked_count&template_id=eq.${templateId}&limit=1`;
      const tRes = await fetch(tUrl, { headers: sbHeaders() });
      if (!tRes.ok) return null;
      const tRows = await tRes.json();
      if (!tRows.length) return null; // not a Funko template

      const mUrl = `${SUPABASE_URL}/rest/v1/funko_market_prices?select=dp_locked_count&template_id=eq.${templateId}&limit=1`;
      const mRows = await fetch(mUrl, { headers: sbHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []);
      const dpLocked = mRows[0]?.dp_locked_count ?? tRows[0]?.dp_locked_count ?? null;
      return { isFunko: true, dpLocked: dpLocked != null ? Number(dpLocked) : 0 };
    } catch { return null; }
  }

  function mount(opts) {
    const aaBase   = opts.aaBase;
    const apiFetch = opts.apiFetch;
    const collectionHref = opts.collectionHref || (name => `collection/${encodeURIComponent(name)}`);
    const templateHref   = opts.templateHref   || (id   => `template/${encodeURIComponent(id)}`);
    const walletHref     = opts.walletHref     || (acc  => `inventory/${encodeURIComponent(acc)}`);
    const schemaHref     = opts.schemaHref     || ((collection, schema) => `schema/${encodeURIComponent(collection)}/${encodeURIComponent(schema)}`);
    const assetHref      = opts.assetHref      || (id   => `asset/${encodeURIComponent(id)}`);

    let hover = document.getElementById('assetPopupHover');
    if (!hover) {
      hover = document.createElement('div');
      hover.id = 'assetPopupHover';
      hover.className = 'hover-tooltip';
      hover.style.display = 'none';
      document.body.appendChild(hover);
    }
    let info = document.getElementById('assetPopupInfo');
    if (!info) {
      info = document.createElement('div');
      info.id = 'assetPopupInfo';
      info.className = 'info-popup';
      info.style.display = 'none';
      document.body.appendChild(info);
    }

    const _supplyCache = {};
    const _ownedCache = {};

    // Droppp-locked supply (if any) via the shared module-level lookup —
    // see fetchDropppLocked() above. issued/burned always come straight
    // from AtomicAssets (not a Supabase column) specifically so "In
    // circulation" can subtract locked without double-counting. Falls back
    // to the generic on-chain /stats-only path for any non-Funko collection.
    function fetchSupply(templateId, collectionName) {
      if (_supplyCache[templateId]) return _supplyCache[templateId];
      _supplyCache[templateId] = (async () => {
        try {
          const funko = await fetchDropppLocked(templateId);
          if (funko) {
            const [tplRows, stats] = await Promise.all([
              apiFetch(`${aaBase()}/templates?ids=${templateId}&limit=1`),
              collectionName
                ? apiFetch(`${aaBase()}/templates/${encodeURIComponent(collectionName)}/${templateId}/stats`)
                : Promise.resolve(null),
            ]);
            const issued = tplRows?.[0]?.issued_supply != null ? Number(tplRows[0].issued_supply) : null;
            const burned = stats?.burned != null ? Number(stats.burned) : 0;
            const locked = funko.dpLocked;
            const circ   = issued != null ? Math.max(0, issued - burned - locked) : null;
            return { issued, circ, locked, burned, funko: true };
          }
        } catch { /* fall through */ }
        try {
          if (!collectionName) return null;
          const s = await apiFetch(`${aaBase()}/templates/${encodeURIComponent(collectionName)}/${templateId}/stats`);
          const issued = s?.assets != null ? Number(s.assets) : null;
          const burned = s?.burned != null ? Number(s.burned) : 0;
          const circ   = issued != null ? issued - burned : null;
          return issued != null ? { issued, circ, burned, locked: 0, showBurned: true } : null;
        } catch { return null; }
      })();
      return _supplyCache[templateId];
    }

    function fetchOwned(wallet, templateId) {
      const key = `${wallet}:${templateId}`;
      if (_ownedCache[key]) return _ownedCache[key];
      _ownedCache[key] = (async () => {
        try {
          const data = await apiFetch(`${aaBase()}/assets?owner=${encodeURIComponent(wallet)}&template_id=${templateId}&sort=template_mint&order=asc&limit=500`);
          const rows = data || [];
          return { count: rows.length, lowestMint: rows[0]?.template_mint ?? null };
        } catch { return { count: 0, lowestMint: null }; }
      })();
      return _ownedCache[key];
    }

    function renderBody(d, supply, owned) {
      const loading = !supply && !owned;
      const dash    = loading ? '…' : '—';
      const fmt     = n => n != null ? Number(n).toLocaleString() : dash;

      const issued = supply?.issued ?? null;
      const circ   = supply?.circ   ?? null;
      const locked = supply?.locked ?? 0;
      // fetchSupply always returns burned directly now — falling back to
      // issued-circ would double-count `locked` once circ already
      // subtracts it (Funko templates only).
      const burned = supply?.burned ?? (issued != null && circ != null ? issued - circ : null);

      return `
        <div class="tt-heading">Attributes</div>
        <div class="tt-section" style="margin-bottom:0.5rem">
          ${d.collectionName ? `<div class="tt-row"><span class="tt-label">Collection</span><span class="tt-val">${d.collection ? `<a href="${esc(collectionHref(d.collection))}" style="color:var(--accent-light);text-decoration:none" title="View collection page">${esc(d.collectionName)}</a>` : esc(d.collectionName)}</span></div>` : ''}
          ${d.schema ? `<div class="tt-row"><span class="tt-label">Schema</span><span class="tt-val">${d.collection ? `<a href="${esc(schemaHref(d.collection, d.schema))}" style="color:var(--accent-light);text-decoration:none" title="View schema page">${esc(d.schema)}</a>` : esc(d.schema)}</span></div>` : ''}
          ${d.rarity ? `<div class="tt-row"><span class="tt-label">Rarity</span><span><span class="rarity-pill ${d.rarityClass || ''}" style="font-size:0.62rem;padding:1px 7px">${esc(d.rarity)}</span></span></div>` : ''}
          ${d.cardid ? `<div class="tt-row"><span class="tt-label">Card ID</span><span class="tt-val">${esc(d.cardid)}</span></div>` : ''}
          ${d.assetId ? `<div class="tt-row"><span class="tt-label">Asset</span><span class="tt-val tt-val-copiable"><a href="${esc(assetHref(d.assetId))}" style="color:var(--accent-light);text-decoration:none" title="View asset page">#${esc(d.assetId)}</a><button class="copy-btn" onclick="AssetPopup.copyVal(this,'${esc(d.assetId)}')" title="Copy asset ID">${_copyIconSvg}</button></span></div>` : ''}
          ${d.templateId ? `<div class="tt-row"><span class="tt-label">Template</span><span class="tt-val tt-val-copiable"><a href="${esc(templateHref(d.templateId))}" style="color:var(--accent-light);text-decoration:none" title="View template page">#${esc(d.templateId)}</a><button class="copy-btn" onclick="AssetPopup.copyVal(this,'${esc(d.templateId)}')" title="Copy template ID">${_copyIconSvg}</button></span></div>` : ''}
          ${d.owner ? `<div class="tt-row"><span class="tt-label">Owner</span><span class="tt-val tt-orange"><a href="${esc(walletHref(d.owner))}" style="color:inherit;text-decoration:none" title="View this wallet's inventory">${esc(d.owner)}</a></span></div>` : ''}
          <div class="tt-row"><span class="tt-label">Backed tokens</span><span class="tt-val">${esc(fmtBackedTokens(d.backedTokens))}</span></div>
        </div>
        <div class="tt-divider"></div>
        <div class="tt-heading">Supply</div>
        <div class="tt-section">
          <div class="tt-row"><span class="tt-label">Issued</span><span class="tt-val">${fmt(issued)}</span></div>
          ${burned > 0 || supply?.showBurned || supply?.funko || loading ? `<div class="tt-row"><span class="tt-label">Burned</span><span class="tt-val tt-red">${fmt(burned)}</span></div>` : ''}
          ${locked > 0 || supply?.funko ? `<div class="tt-row"><span class="tt-label">Locked (Droppp)</span><span class="tt-val tt-purple">${fmt(locked)}</span></div>` : ''}
          <div class="tt-row"><span class="tt-label">In circulation</span><span class="tt-val">${fmt(circ)}</span></div>
        </div>
        <div class="tt-divider"></div>
        <div class="tt-heading">You</div>
        <div class="tt-section">
          <div class="tt-row"><span class="tt-label">Owned</span><span class="tt-val tt-orange">${owned != null ? fmt(owned.count) : '…'}</span></div>
          ${owned?.count > 0 ? `<div class="tt-row"><span class="tt-label">Lowest mint</span><span class="tt-val tt-orange">#${Number(owned.lowestMint).toLocaleString()}</span></div>` : ''}
        </div>`;
    }

    function renderHover(d, supply, owned) {
      return `<div style="font-size:0.85rem;font-weight:700;color:var(--text-primary);line-height:1.3;margin-bottom:0.55rem">${esc(d.name || 'Unknown')}</div>${renderBody(d, supply, owned)}`;
    }
    // Header (name + close button) is rendered once and kept stable across
    // the loading->loaded transition — see open()'s use of #assetPopupInfoBody.
    // A mobile WebKit quirk drops the 'click' event entirely if its target
    // element is removed from the DOM between touchstart and dispatch; a full
    // innerHTML replace on every re-render (as this used to do) recreates the
    // close button as a new node, so a tap landing mid-fetch could highlight
    // the button (touchstart) but never actually close the popup (click never
    // fires because the original node is already gone).
    function renderInfo(d, supply, owned) {
      return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.55rem">
        <div style="font-size:0.85rem;font-weight:700;color:var(--text-primary);line-height:1.3;padding-right:0.5rem">${esc(d.name || 'Unknown')}</div>
        <button class="info-popup-close" onclick="AssetPopup.close()" aria-label="Close">✕</button>
      </div><div id="assetPopupInfoBody">${renderBody(d, supply, owned)}</div>`;
    }

    // Dynamic, not hardcoded — the popup's real rendered size varies with
    // content (a long attribute list, "Backed tokens" wrapping, etc.), and
    // it's already visible (display:'') by the time this runs.
    function positionNear(el, popupEl) {
      const rect = el.getBoundingClientRect();
      const PW = popupEl.offsetWidth  || 360;
      const PH = popupEl.offsetHeight || 320;
      let left = rect.right + 10;
      if (left + PW > window.innerWidth - 8) left = rect.left - PW - 10;
      if (left < 8) left = 8;
      let top = rect.top;
      if (top + PH > window.innerHeight - 8) top = window.innerHeight - PH - 8;
      if (top < 8) top = 8;
      popupEl.style.left = left + 'px';
      popupEl.style.top  = top  + 'px';
    }

    let _hoverTimer = null;
    let _hoverAssetId = null;
    let _infoAssetId = null;

    function cancel() {
      clearTimeout(_hoverTimer);
      _hoverTimer = null;
      _hoverAssetId = null;
      hover.style.display = 'none';
    }

    async function showHover(cardEl, d) {
      _hoverAssetId = d.assetId;
      const wallet = window.getWaxAccount ? window.getWaxAccount() : null;

      hover.innerHTML = renderHover(d, null, null);
      hover.style.display = '';
      positionNear(cardEl, hover);

      const [supply, owned] = await Promise.all([
        d.templateId ? fetchSupply(d.templateId, d.collection) : Promise.resolve(null),
        d.templateId && wallet ? fetchOwned(wallet, d.templateId) : Promise.resolve(null),
      ]);
      if (_hoverAssetId !== d.assetId) return; // moved on to a different card (or dismissed) since this fetch started
      hover.innerHTML = renderHover(d, supply, owned);
      positionNear(cardEl, hover);
    }

    function schedule(cardEl, d) {
      cancel();
      _hoverTimer = setTimeout(() => showHover(cardEl, d), 350);
    }

    function close() {
      _infoAssetId = null;
      info.style.display = 'none';
    }

    async function open(cardEl, d) {
      cancel(); // don't show both at once
      _infoAssetId = d.assetId;
      const wallet = window.getWaxAccount ? window.getWaxAccount() : null;

      info.innerHTML = renderInfo(d, null, null);
      info.style.display = '';
      positionNear(cardEl, info);

      const [supply, owned] = await Promise.all([
        d.templateId ? fetchSupply(d.templateId, d.collection) : Promise.resolve(null),
        d.templateId && wallet ? fetchOwned(wallet, d.templateId) : Promise.resolve(null),
      ]);
      if (_infoAssetId !== d.assetId) return;
      const bodyEl = info.querySelector('#assetPopupInfoBody');
      if (bodyEl) bodyEl.innerHTML = renderBody(d, supply, owned);
      positionNear(cardEl, info);
    }

    function isOpenFor(assetId) {
      return info.style.display !== 'none' && _infoAssetId === assetId;
    }

    // The "You" section's Owned/Lowest-mint numbers are wallet-scoped
    // (cache key already includes the wallet, so a new login never sees a
    // different wallet's stale numbers) — pages call this on logout mainly
    // for memory hygiene, not correctness.
    function clearOwnedCache() {
      Object.keys(_ownedCache).forEach(k => delete _ownedCache[k]);
    }

    // Convenience wiring for the common case — hover on `hoverEl` (defaults
    // to the whole card), click-to-toggle on `cardEl` itself (ignoring
    // clicks on any nested <a>/<button>, which handle their own actions).
    function wire(cardEl, d, wireOpts) {
      wireOpts = wireOpts || {};
      const hoverEl = wireOpts.hoverEl || cardEl;
      const suppressed = wireOpts.shouldSuppressHover || (() => false);

      const maybeSchedule = () => {
        if (info.style.display !== 'none') return; // click popup already open — don't also pop the hover one
        if (suppressed()) return;
        schedule(cardEl, d);
      };
      hoverEl.addEventListener('mouseenter', maybeSchedule);
      hoverEl.addEventListener('mouseleave', cancel);

      // Elements nested inside hoverEl (e.g. a select-checkbox) that should
      // pause the hover timer while themselves hovered, resuming once the
      // cursor moves back onto plain hoverEl — reaching a checkbox sitting
      // inside the image would otherwise pop the tooltip right as you're
      // about to click it.
      (wireOpts.pauseElements || []).forEach(el => {
        el.addEventListener('mouseenter', cancel);
        el.addEventListener('mouseleave', maybeSchedule);
      });

      // Marks cardEl so the document-level outside-click listener below can
      // tell "clicked a different wired card" (that card's own listener
      // above already opens the right popup — don't also close it again on
      // the same click as it bubbles up) apart from "clicked truly outside
      // any card" (which should close whatever's open).
      cardEl.setAttribute('data-asset-popup-card', '');

      cardEl.addEventListener('click', e => {
        if (e.target.closest('a, button')) return;
        if (wireOpts.onCardClick) { wireOpts.onCardClick(e); return; }
        if (isOpenFor(d.assetId)) close();
        else open(cardEl, d);
      });
    }

    document.addEventListener('click', e => {
      if (info.style.display === 'none') return;
      if (info.contains(e.target)) return;
      if (e.target.closest('[data-asset-popup-card]')) return;
      close();
    });

    // The rendered popup's close button can only call back through a global
    // (inline onclick="AssetPopup.close()" — no way to reach mount()'s local
    // closure from an HTML string), but the outer module object returned
    // below only ever exposed {mount, copyVal, fmtBackedTokens,
    // fetchDropppLocked} — so AssetPopup.close() was calling a function that
    // never existed on every page, on every platform (silently throwing,
    // swallowed by the inline handler). Each page mounts this module exactly
    // once, so attaching this instance's close() onto the module singleton
    // here is safe, and matches how copyVal already works the same way.
    AssetPopup.close = close;

    return { wire, schedule, cancel, open, close, isOpenFor, clearOwnedCache, copyVal };
  }

  return { mount, copyVal, fmtBackedTokens, fetchDropppLocked };
})();

'use strict';
/* Shared "Make an Offer" popup — creates an AtomicMarket buy offer, either
   on one specific asset (createbuyo, targeted at its current owner) or on a
   template as a whole (createtbuyo, open for any holder of that template to
   accept). Used by sale.html, asset.html, and template.html.

   Both actions deduct from the buyer's AtomicMarket *internal* balance, not
   a direct wallet transfer — same balance the existing buy flow tops up via
   an eosio.token transfer with memo "deposit" (see sale.html/explore.html's
   buySale/buyListing). This module checks the buyer's current balance
   on-chain first (get_table_rows on atomicmarket/balances, same table the
   /balances page reads) and only deposits the shortfall, so an existing
   balance (e.g. left over from a cancelled offer) isn't deposited twice —
   worst case, if the balance check itself fails, it falls back to
   depositing the full amount, which is safe (funds land in the buyer's own
   withdrawable AtomicMarket balance either way, never lost).

   createtbuyo (template offers) has no memo field on-chain at all — the
   "Memo" input only appears in asset mode.

   Template offers cap at 100, executed BATCH_SIZE (50) at a time — one
   transact() call (one wallet signature) per batch, e.g. a 55-offer
   request signs twice (50 + 5). The AtomicMarket balance shortfall is
   computed once up front and deposited only in the first batch; since
   each batch spends exactly its own share, whatever's left over after
   that first batch already covers every later one.

   Usage: const offerModal = MakeOfferModal.mount({
     apiFetch:         url => fetchWithRetry(url).then(r=>r.json()) | WaxApi.apiFetch(url),  // required
     marketBase:       () => WaxApi.marketBase(),                                            // required
     makerMarketplace: 'hoardiostore',                                                        // optional, defaults shown
     getWallet:        () => window.getWaxAccount(),                                          // optional, defaults shown
     connectWallet:    () => _wallet.connect(),                                                // required to support the logged-out state
     transact:         actions => WaxAuth.transact(actions),                                   // optional, defaults shown
     refreshBalance:   () => _wallet.refreshBalance(),                                          // optional, called after a successful offer
     ramPrefix:        _p,                                                                     // optional, same convention as tx-error.js's txErrorHtml/applyResourceErrorToBuyBtn
   });

   offerModal.open({
     templateId, collectionName, name, imageUrl, isVideo,   // always required
     assetId, owner, mint, issuedSupply,                    // optional — presence of assetId enables the toggle and
                                                             // defaults the popup to Asset mode; omit entirely (template.html)
                                                             // to lock the popup to Template mode with no toggle shown
     onSuccess: (mode) => {},                                // optional, called after a successful offer so the caller can
                                                              // refresh its own already-existing offers table
   }); */
window.MakeOfferModal = (function () {
  const MAX_OFFERS  = 100;
  const BATCH_SIZE  = 50; // createtbuyo actions per transact() call — a 100-offer request signs twice (50 + 50), a 55-offer request signs twice (50 + 5), a 35-offer request signs once
  const MAX_PRICE   = 10000000; // same per-listing cap explore.html's Edit Listing price input uses (min="0.01" max="10000000")

  // [50] for 35, [50, 5] for 55, [50, 50] for 100, etc. — only the first
  // batch ever carries the deposit action (see submit()), so batch order
  // doesn't matter for correctness, just for how many signatures show up.
  function splitIntoBatches(total) {
    const batches = [];
    let remaining = total;
    while (remaining > 0) {
      const n = Math.min(BATCH_SIZE, remaining);
      batches.push(n);
      remaining -= n;
    }
    return batches;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function mount(opts) {
    const apiFetch         = opts.apiFetch;
    const marketBase       = opts.marketBase;
    const maker             = opts.makerMarketplace || 'hoardiostore';
    const getWallet         = opts.getWallet || (() => (window.getWaxAccount ? window.getWaxAccount() : null));
    const connectWallet     = opts.connectWallet || (() => {});
    const transact           = opts.transact || (actions => window.WaxAuth.transact(actions));
    const refreshBalance     = opts.refreshBalance || (() => {});
    const ramPrefix          = opts.ramPrefix || '';

    let overlay = document.getElementById('moOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'moOverlay';
      overlay.className = 'mo-overlay';
      overlay.style.display = 'none';
      overlay.innerHTML = '<div class="mo-panel" id="moPanel" role="dialog" aria-modal="true"></div>';
      document.body.appendChild(overlay);
    }
    const panel = overlay.querySelector('#moPanel');

    let _ctx    = null;
    let _mode   = 'asset';
    let _busy   = false;
    let _openId = 0; // guards against a stale in-flight open()'s fetch re-rendering after close()/a newer open()

    function close() {
      if (_busy) return; // don't let a stray click abandon an in-flight transaction's UI mid-sign
      overlay.style.display = 'none';
      _ctx = null;
      _openId++; // invalidate any still-in-flight open() fetch
    }
    // A plain `click` listener checking e.target===overlay closes on a
    // simple backdrop click, but ALSO closes on a text-selection drag that
    // starts inside the price/memo input and ends up released outside the
    // panel — the mouseup lands on the backdrop, so the resulting click's
    // target is the overlay either way. Tracking whether the mousedown
    // itself also started on the overlay (not a drag out of a child
    // element) is the standard fix — only a genuine press-and-release on
    // the backdrop itself closes the popup.
    let _downOnOverlay = false;
    overlay.addEventListener('mousedown', e => { _downOnOverlay = (e.target === overlay); });
    overlay.addEventListener('click', e => { if (_downOnOverlay && e.target === overlay) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display !== 'none') close(); });

    // Same query template.html/asset.html already use for their own "Lowest
    // Listing" figure — min/max_assets=1 keeps a bundle sale from
    // contaminating a single-asset floor price.
    async function fetchLowestListing(templateId) {
      try {
        const rows = await apiFetch(`${marketBase()}/sales?template_id=${templateId}&symbol=WAX&state=1&min_assets=1&max_assets=1&sort=price&order=asc&limit=1`);
        return rows?.[0] || null;
      } catch { return null; }
    }
    // Same query template.html/asset.html already use for "Top Active Offers".
    async function fetchHighestOffer(templateId) {
      try {
        const rows = await apiFetch(`${marketBase()}/template_buyoffers?template_id=${templateId}&state=0&symbol=WAX&sort=price&order=desc&limit=1`);
        return rows?.[0] || null;
      } catch { return null; }
    }
    // Buyer's current AtomicMarket internal balance — the table createbuyo/
    // createtbuyo actually deduct from. Any failure here (RPC hiccup, no
    // row yet for a buyer who's never deposited) safely resolves to 0,
    // which just means the full offer amount gets deposited fresh.
    async function fetchMarketBalance(account) {
      try {
        const rpc = localStorage.getItem('hoardio_rpc_endpoint') || 'https://wax.greymass.com';
        const res = await fetch(`${rpc}/v1/chain/get_table_rows`, {
          method: 'POST',
          body: JSON.stringify({ json: true, code: 'atomicmarket', scope: 'atomicmarket', table: 'balances', lower_bound: account, upper_bound: account, limit: 1 }),
        });
        const data = await res.json();
        const row = (data.rows || [])[0];
        if (!row || row.owner !== account) return 0;
        const waxEntry = (row.quantities || []).find(q => q.endsWith(' WAX'));
        return waxEntry ? parseFloat(waxEntry) : 0;
      } catch { return 0; }
    }

    function fmtListingLike(row) {
      if (!row) return '—';
      const wax = Number(row.price.amount) / (10 ** (row.price.token_precision || 8));
      const usd = window._waxUsdRate ? ` <span class="mo-usd">≈ $${(wax * window._waxUsdRate).toFixed(2)}</span>` : '';
      return `${wax.toLocaleString(undefined, { maximumFractionDigits: 2 })} WAX${usd}`;
    }

    function mediaHtml(ctx) {
      if (!ctx.imageUrl) return '<div class="mo-media-ph">?</div>';
      return ctx.isVideo
        ? `<video autoplay loop muted playsinline><source src="${esc(ctx.imageUrl)}" type="video/mp4"></video>`
        : `<img alt="" src="${esc(ctx.imageUrl)}">`;
    }

    function toggleHtml() {
      if (!_ctx.assetId) return '';
      return `<div class="mo-toggle">
        <button type="button" class="mo-toggle-btn${_mode === 'asset' ? ' active' : ''}" data-mode="asset">Specific Asset</button>
        <button type="button" class="mo-toggle-btn${_mode === 'template' ? ' active' : ''}" data-mode="template">Template</button>
      </div>`;
    }

    function assetRowsHtml() {
      const mintLabel = _ctx.mint != null
        ? (_ctx.issuedSupply != null ? `#${_ctx.mint} of ${Number(_ctx.issuedSupply).toLocaleString()}` : `#${_ctx.mint}`)
        : '—';
      return `
        <div class="mo-row"><span class="mo-row-label">Owner</span><span class="mo-row-val">${esc(_ctx.owner || '—')}</span></div>
        <div class="mo-row"><span class="mo-row-label">Mint</span><span class="mo-row-val">${mintLabel}</span></div>
        <div class="mo-row"><span class="mo-row-label">Lowest listing</span><span class="mo-row-val">${fmtListingLike(_ctx._lowest)}</span></div>`;
    }

    function templateRowsHtml() {
      return `
        <div class="mo-row"><span class="mo-row-label">Template ID</span><span class="mo-row-val">#${esc(_ctx.templateId)}</span></div>
        <div class="mo-row"><span class="mo-row-label">Lowest listing</span><span class="mo-row-val">${fmtListingLike(_ctx._lowest)}</span></div>
        <div class="mo-row"><span class="mo-row-label">Highest offer</span><span class="mo-row-val">${fmtListingLike(_ctx._highest)}</span></div>`;
    }

    function render(preservedPrice) {
      const wallet = getWallet();
      panel.innerHTML = `
        <div class="mo-header">
          <span class="mo-title">Make an Offer</span>
          <button type="button" class="mo-close" id="moClose" aria-label="Close">✕</button>
        </div>
        <div class="mo-body">
          ${toggleHtml()}
          <div class="mo-media">${mediaHtml(_ctx)}</div>
          <div class="mo-name">${esc(_ctx.name || 'Unknown')}</div>
          <div class="mo-meta">${esc(_ctx.collectionName || '')}</div>
          ${_mode === 'asset' ? assetRowsHtml() : templateRowsHtml()}
          <div class="mo-row mo-row--price">
            <span class="mo-row-label">Your offer${_mode === 'template' ? ' (per copy)' : ''}</span>
            <div class="mo-price-row">
              <input id="moPriceInput" type="number" class="mo-input" placeholder="0.00" min="0.01" max="${MAX_PRICE}" step="0.01" autocomplete="off" value="${preservedPrice ? esc(preservedPrice) : ''}" />
              <span class="mo-unit">WAX</span>
            </div>
          </div>
          ${_mode === 'template' ? `
          <div class="mo-row mo-row--price">
            <span class="mo-row-label">Number of offers</span>
            <div class="mo-price-row">
              <input id="moCountInput" type="number" class="mo-input mo-input--num" min="1" max="${MAX_OFFERS}" step="1" value="1" autocomplete="off" />
            </div>
          </div>
          <div class="mo-row mo-total"><span class="mo-row-label">Total</span><span class="mo-row-val" id="moTotalVal">—</span></div>
          <div class="mo-hint">Max ${MAX_OFFERS} offers at once.</div>
          <div class="mo-batch-note">1 wallet signature per ${BATCH_SIZE} items</div>
          ` : `
          <div class="mo-field">
            <span class="mo-row-label">Memo (optional)</span>
            <div class="mo-memo-box">
              <input id="moMemoInput" type="text" class="mo-input mo-input--text" maxlength="256" placeholder="Add a note for the owner…" autocomplete="off" spellcheck="false" />
            </div>
          </div>
          `}
          <div id="moMsg" class="mo-msg" style="display:none;"></div>
          <div class="mo-actions">
            <button type="button" class="mo-btn mo-btn--cancel" id="moCancel">Cancel</button>
            <button type="button" class="mo-btn mo-btn--primary" id="moSubmit">${wallet ? 'Create offer' : 'Connect Wallet'}</button>
          </div>
          <p class="mo-note">Making an offer deposits WAX into your AtomicMarket balance to cover it. Unused balance can be withdrawn any time.</p>
          <div id="moResult" style="display:none;"></div>
        </div>`;
      wireEvents();
      updateTotal();
    }

    // Pre-submit validation only (invalid amount, over the cap) — small
    // inline text above the action buttons, no Close button. Distinct from
    // showResult() below, which is the terminal (post-transact) outcome.
    function showMsg(html, kind) {
      const el = panel.querySelector('#moMsg');
      if (!el) return;
      el.innerHTML = html;
      el.className = `mo-msg mo-msg--${kind}`;
      el.style.display = '';
    }

    // Terminal outcome after actually attempting the transaction — a
    // colored block below the action buttons with its own Close button,
    // same layout inventory.html's bulk-action modal uses for
    // #bulkProgress/.bl-progress-msg. The Cancel/Create offer buttons stay
    // as-is (already reset to their normal label by setBusy(false) before
    // this runs) so a failed offer can just be retried without reopening
    // the popup; Close (here) does exactly what the header ✕ does.
    function showResult(html, kind) {
      const el = panel.querySelector('#moResult');
      if (!el) return;
      el.className = `mo-msg mo-msg--${kind} mo-result`;
      el.innerHTML = `<span class="mo-result-text">${html}</span><button type="button" class="mo-result-close">Close</button>`;
      el.querySelector('.mo-result-close').addEventListener('click', close);
      el.style.display = '';
    }
    function clearResult() {
      const el = panel.querySelector('#moResult');
      if (el) { el.style.display = 'none'; el.innerHTML = ''; el.className = ''; }
    }

    function updateTotal() {
      if (_mode !== 'template') return;
      const totalEl = panel.querySelector('#moTotalVal');
      if (!totalEl) return;
      const price = parseFloat(panel.querySelector('#moPriceInput')?.value);
      const count = clampCount();
      if (isFinite(price) && price > 0) {
        totalEl.textContent = `${price.toLocaleString(undefined, { maximumFractionDigits: 2 })} × ${count} = ${(price * count).toLocaleString(undefined, { maximumFractionDigits: 2 })} WAX`;
      } else {
        totalEl.textContent = '—';
      }
    }

    function clampCount() {
      const input = panel.querySelector('#moCountInput');
      if (!input) return 1;
      let n = parseInt(input.value, 10);
      if (!isFinite(n) || n < 1) n = 1;
      if (n > MAX_OFFERS) n = MAX_OFFERS;
      input.value = String(n);
      return n;
    }

    function setBusy(busy) {
      _busy = busy;
      const submitBtn = panel.querySelector('#moSubmit');
      const cancelBtn = panel.querySelector('#moCancel');
      // Always restores the label when leaving the busy state — previously
      // this only ever set the "Creating…" text and never put it back,
      // so both a successful and a failed offer left the button stuck
      // reading "Creating…" (disabled, in the success case, since close()
      // also refuses to run while _busy stays true — see submit()).
      if (submitBtn) {
        submitBtn.disabled = busy;
        submitBtn.textContent = busy ? 'Creating…' : (getWallet() ? 'Create offer' : 'Connect Wallet');
      }
      if (cancelBtn) cancelBtn.disabled = busy;
    }

    // Multi-batch progress text — only ever used between transact() calls
    // while still busy, so it doesn't touch disabled state (setBusy(true)
    // already did that).
    function setSubmitText(text) {
      const submitBtn = panel.querySelector('#moSubmit');
      if (submitBtn) submitBtn.textContent = text;
    }

    // A specific-asset offer only ever needs to be made once — nothing
    // stops a second one, but there's no reason to invite it, so the
    // button is disabled after success instead of reverting to "Create
    // offer". Template offers stay active on success (see setBusy) since
    // stacking a second, different-priced offer on the same template is a
    // reasonable thing to want (e.g. a low "floor" offer plus a higher one).
    function disableAfterAssetOffer() {
      const submitBtn = panel.querySelector('#moSubmit');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Offer sent'; }
    }

    async function switchMode(mode) {
      if (mode === _mode) return;
      const preservedPrice = panel.querySelector('#moPriceInput')?.value;
      _mode = mode;
      render(preservedPrice);
    }

    async function submit() {
      const buyer = getWallet();
      if (!buyer) { connectWallet(); return; }

      const priceVal = parseFloat(panel.querySelector('#moPriceInput')?.value);
      if (!isFinite(priceVal) || priceVal <= 0) { showMsg('Enter a valid WAX amount.', 'error'); return; }
      if (priceVal > MAX_PRICE) { showMsg(`Offer can't exceed ${MAX_PRICE.toLocaleString()} WAX.`, 'error'); return; }

      const count       = _mode === 'template' ? clampCount() : 1;
      const totalNeeded = priceVal * count;
      const priceAsset  = priceVal.toFixed(8) + ' WAX';
      const memo        = _mode === 'asset' ? (panel.querySelector('#moMemoInput')?.value.trim() || '') : '';
      // Asset mode is always exactly one createbuyo action — no batching
      // needed. Template mode splits the requested count into BATCH_SIZE-
      // sized createtbuyo groups, one transact() (one wallet signature) per
      // group, e.g. [50, 5] for a 55-offer request.
      const batchSizes  = _mode === 'template' ? splitIntoBatches(count) : [1];

      setBusy(true);
      const msgEl = panel.querySelector('#moMsg');
      if (msgEl) msgEl.style.display = 'none'; // clear any previous validation message while we work
      clearResult(); // clear any previous terminal outcome (e.g. retrying after an error)

      let created = 0; // offers actually confirmed on-chain so far — only incremented after a batch's transact() resolves
      try {
        // Computed once up front and deposited entirely in the first batch
        // — after that batch spends its own share, whatever's left over
        // exactly covers the remaining batches, so no further deposits
        // are needed (see module doc comment for the full reasoning).
        let shortfall = Math.max(0, totalNeeded - await fetchMarketBalance(buyer));

        for (let b = 0; b < batchSizes.length; b++) {
          const n = batchSizes[b];
          const actions = [];
          if (shortfall > 0) {
            actions.push({
              account: 'eosio.token', name: 'transfer',
              authorization: [{ actor: buyer, permission: 'active' }],
              data: { from: buyer, to: 'atomicmarket', quantity: shortfall.toFixed(8) + ' WAX', memo: 'deposit' },
            });
            shortfall = 0;
          }
          if (_mode === 'asset') {
            actions.push({
              account: 'atomicmarket', name: 'createbuyo',
              authorization: [{ actor: buyer, permission: 'active' }],
              data: { buyer, recipient: _ctx.owner, price: priceAsset, asset_ids: [String(_ctx.assetId)], memo, maker_marketplace: maker },
            });
          } else {
            for (let i = 0; i < n; i++) {
              actions.push({
                account: 'atomicmarket', name: 'createtbuyo',
                authorization: [{ actor: buyer, permission: 'active' }],
                data: { buyer, price: priceAsset, collection_name: _ctx.collectionName, template_id: String(_ctx.templateId), maker_marketplace: maker },
              });
            }
          }

          if (batchSizes.length > 1) setSubmitText(`Signing ${b + 1} of ${batchSizes.length}…`);
          await transact(actions);
          created += n;
        }

        refreshBalance();
        if (_ctx.onSuccess) _ctx.onSuccess(_mode);
        setBusy(false);
        if (_mode === 'asset') disableAfterAssetOffer();
        showResult(`Offer${created > 1 ? 's' : ''} created!`, 'success');
      } catch (e) {
        setBusy(false);
        // A batch that ran before the failing one already landed on-chain —
        // reflect that instead of implying nothing happened.
        if (created > 0) {
          refreshBalance();
          if (_ctx.onSuccess) _ctx.onSuccess(_mode);
        }
        const info = window.describeTxError ? window.describeTxError(e) : { kind: 'generic' };
        const base = info.kind === 'cancelled'
          ? 'Offer cancelled.'
          : (window.txErrorHtml ? window.txErrorHtml(info, 'Could not create the offer — please try again.', ramPrefix) : 'Could not create the offer — please try again.');
        const prefix = created > 0 ? `${created} of ${count} offer${count > 1 ? 's' : ''} created. ` : '';
        showResult(prefix + base, 'error');
      }
    }

    function wireEvents() {
      panel.querySelector('#moClose').addEventListener('click', close);
      panel.querySelector('#moCancel').addEventListener('click', close);
      panel.querySelector('#moSubmit').addEventListener('click', () => (getWallet() ? submit() : connectWallet()));
      panel.querySelectorAll('.mo-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => switchMode(btn.dataset.mode));
      });
      panel.querySelector('#moPriceInput')?.addEventListener('input', updateTotal);
      panel.querySelector('#moCountInput')?.addEventListener('input', updateTotal);
    }

    async function open(ctx) {
      const myOpenId = ++_openId;
      _ctx  = Object.assign({ _lowest: null, _highest: null }, ctx);
      _mode = ctx.assetId ? 'asset' : 'template';
      _busy = false;
      overlay.style.display = '';
      render();

      const [lowest, highest] = await Promise.all([
        fetchLowestListing(_ctx.templateId),
        fetchHighestOffer(_ctx.templateId),
      ]);
      if (myOpenId !== _openId) return; // closed, or a newer open() superseded this one — don't clobber it
      _ctx._lowest  = lowest;
      _ctx._highest = highest;
      const preservedPrice = panel.querySelector('#moPriceInput')?.value;
      render(preservedPrice);
    }

    return { open, close };
  }

  return { mount };
})();

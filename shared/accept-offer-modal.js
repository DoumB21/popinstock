'use strict';
/* Shared "Accept Offer" confirmation popup — shows the fee breakdown and the
   exact WAX amount you'd actually receive before accepting an AtomicMarket
   buy offer, so there's no surprise after signing. Used by buy-offers.html's
   Received tab (accepting an asset-specific offer as its seller) and
   inventory.html's per-asset Buy Offers flow (fulfilling a template-wide
   offer as a holder) — same underlying action from the seller's point of
   view, so both now render from this one component instead of two
   differently-laid-out popups.

   Both accept paths (acceptbuyo for an asset-specific offer, fulfilltbuyo for
   a template offer) route through the same on-chain internal_payout_sale —
   confirmed live against the atomicmarket contract source
   (pinknetworkx/atomicmarket-contract, src/atomicmarket.cpp). The seller's
   net cut is price minus THREE fee categories, all summed there:
     1. maker_market_fee — global AtomicMarket config (currently 1%), paid to
        whichever marketplace facilitated the offer's creation.
     2. taker_market_fee — global AtomicMarket config (currently 1%), paid to
        whichever marketplace facilitates the acceptance (Hoardio, here).
     3. Any active "bonus fee" — a SEPARATE on-chain table (`bonusfees`, not
        part of /v1/config at all) that applies an extra fee on top when the
        offer's own buyoffer_id falls inside one of that bonus fee's
        configured [start_id, end_id) ranges for the "buyoffer" counter. Live
        right now: a 1% "Ecosystem Fee" (recipient eco.atomic) applies to
        every buyoffer_id from 2574502 onward — i.e. effectively all current
        offers.
   Plus the offer's own collection royalty (current_collection_fee on the
   buyoffer record itself, already known per-offer, no extra fetch).

   The display groups maker+taker into one "Market Fee" line (matching
   inventory.html's own 3-line Ecosystem/Market/Collection presentation) —
   the math above still sums all three real categories, this is purely a
   display-grouping choice.

   Usage: const acceptModal = AcceptOfferModal.mount({
     marketBase: () => WaxApi.marketBase(),   // required
   });

   acceptModal.open({
     name, imageUrl, isVideo, collectionName, mintLabel,  // display only
     buyofferId,        // the offer's buyoffer_id — needed to match bonus-fee ranges, also shown as an "Offer #" row
     buyer,             // optional — wallet name shown as a "Buyer" row
     buyerHref,         // optional — link target for the buyer row (plain text if omitted)
     priceWax,          // number — the raw offer price, before fees
     collectionFeePct,  // number 0-1 — the offer's own stored collection royalty rate
     onBack,            // optional — shows a "← Back" header button instead of closing; called once the popup has already hidden itself
     onClose,           // optional — called whenever the popup closes for real (X / overlay / Escape / Cancel-or-Close button), NOT on Back
     onConfirm(ctl),    // called once the user confirms — ctl = { setBusy(label), setError(msg,{html}), setSuccess(label), close }.
                         // The popup stays open and shows busy/error/success state itself; the caller owns the actual
                         // accept transaction and drives ctl through it (mirrors inventory.html's original in-modal UX).
   }); */
window.AcceptOfferModal = (function () {
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function pct(n) { return (n * 100).toFixed(2).replace(/\.?0+$/, '') + '%'; }
  // Always 2 decimals ("1.00%") — matches inventory.html's own per-fee-item
  // display exactly, unlike pct() above (used for the "Total Fees" summary).
  function pctFixed(n) { return (n * 100).toFixed(2) + '%'; }
  // Same trailing-zero trim as shared/asset-popup.js's fmtTok / buy-offers.html's own.
  function fmtWax(n) {
    return n.toFixed(8).replace(/(\.\d{2}.*[1-9])0+$/, '$1').replace(/(\.\d{2})0+$/, '$1');
  }

  function mount(opts) {
    const marketBase = opts.marketBase;

    let overlay = document.getElementById('aoOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'aoOverlay';
      overlay.className = 'ao-overlay';
      overlay.style.display = 'none';
      overlay.innerHTML = '<div class="ao-panel" id="aoPanel" role="dialog" aria-modal="true"></div>';
      document.body.appendChild(overlay);
    }
    const panel = overlay.querySelector('#aoPanel');

    let _ctx   = null;
    // _busy: true only while the caller's async onConfirm is in flight —
    // blocks every close path (X / overlay / Escape / Cancel / Back) so a
    // stray click can't abandon the popup mid-transaction. Reset to false
    // by both setError (so the user can retry or back out) and setSuccess
    // (closing after success is always fine — nothing left to lose).
    let _busy   = false;
    // _locked: true once setSuccess() fires — keeps the Confirm button from
    // re-submitting a second transaction if clicked again, independent of
    // _busy (which is already false by then so closing still works).
    let _locked = false;

    function close() {
      const ctx = _ctx;
      overlay.style.display = 'none';
      _ctx = null; _busy = false; _locked = false;
      if (ctx && ctx.onClose) ctx.onClose();
    }
    function guardedClose() { if (!_busy) close(); }
    // See shared/make-offer-modal.js's identical comment — a plain
    // e.target===overlay click check also fires (and closes) on a drag that
    // starts inside the panel and releases on the backdrop, not just a
    // genuine backdrop click. This popup has no text inputs today, but it
    // shares the exact same overlay-wraps-panel shape, so the same fix
    // applies defensively.
    let _downOnOverlay = false;
    overlay.addEventListener('mousedown', e => { _downOnOverlay = (e.target === overlay); });
    overlay.addEventListener('click', e => { if (_downOnOverlay && e.target === overlay) guardedClose(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display !== 'none') guardedClose(); });

    // Global, not per-offer — fetched once and cached for the page's lifetime
    // (fee config changes are rare and not time-sensitive the way a price is).
    let _configPromise = null;
    function fetchMarketConfig() {
      if (_configPromise) return _configPromise;
      _configPromise = (async () => {
        try {
          const res = await fetch(`${marketBase()}/config`);
          const json = await res.json();
          if (!json.success) throw new Error('config fetch failed');
          return { maker: Number(json.data.maker_market_fee) || 0, taker: Number(json.data.taker_market_fee) || 0 };
        } catch (e) {
          console.error('Could not fetch AtomicMarket config:', e);
          return null;
        }
      })();
      return _configPromise;
    }

    // bonusfees isn't exposed by the REST API at all — read straight from
    // the chain, same get_table_rows pattern make-offer-modal.js/
    // buy-offers.html already use for balance checks. Also cached — the
    // table itself rarely changes; the per-offer part is just matching
    // buyofferId against each entry's ranges, done fresh per open().
    let _bonusFeesPromise = null;
    function fetchBonusFees() {
      if (_bonusFeesPromise) return _bonusFeesPromise;
      _bonusFeesPromise = (async () => {
        try {
          const rpc = localStorage.getItem('hoardio_rpc_endpoint') || 'https://wax.greymass.com';
          const res = await fetch(`${rpc}/v1/chain/get_table_rows`, {
            method: 'POST',
            body: JSON.stringify({ json: true, code: 'atomicmarket', scope: 'atomicmarket', table: 'bonusfees', limit: 100 }),
          });
          const data = await res.json();
          return data.rows || [];
        } catch (e) {
          console.error('Could not fetch AtomicMarket bonus fees:', e);
          return [];
        }
      })();
      return _bonusFeesPromise;
    }

    // Same matching rule as internal_payout_sale's bonus-fee loop in the
    // contract source: sum every bonusfee entry that has a counter_ranges
    // row for the "buyoffer" counter whose [start_id, end_id) window
    // contains this offer's buyoffer_id. end_id is often the uint64 max
    // (as a string, too large for exact JS precision) — fine here since
    // it's only ever compared against a real buyoffer_id, many orders of
    // magnitude smaller.
    function matchingBonusFees(rows, buyofferId) {
      const id = Number(buyofferId);
      const matches = [];
      for (const row of rows || []) {
        const hit = (row.counter_ranges || []).find(r =>
          r.counter_name === 'buyoffer' && id >= Number(r.start_id) && id < Number(r.end_id)
        );
        if (hit) matches.push({ name: row.fee_name || 'Bonus Fee', pct: Number(row.fee) || 0 });
      }
      return matches;
    }

    function mediaHtml(ctx) {
      if (!ctx.imageUrl) return '<div class="ao-media-ph">?</div>';
      return ctx.isVideo
        ? `<video autoplay loop muted playsinline><source src="${esc(ctx.imageUrl)}" type="video/mp4"></video>`
        : `<img alt="" src="${esc(ctx.imageUrl)}">`;
    }

    function els() {
      return {
        confirm: panel.querySelector('#aoConfirm'),
        cancel:  panel.querySelector('#aoCancel'),
        back:    panel.querySelector('#aoBack'),
        msg:     panel.querySelector('#aoMsg'),
      };
    }

    function showMsg(text, type, html) {
      const { msg } = els();
      if (!msg) return;
      msg.className = `ao-msg ao-msg--${type}`;
      if (html) msg.innerHTML = text; else msg.textContent = text;
      msg.style.display = '';
    }
    function hideMsg() {
      const { msg } = els();
      if (msg) msg.style.display = 'none';
    }

    // The three controller methods below are the only thing a caller's
    // onConfirm needs to drive the popup through busy → error/success —
    // matches inventory.html's original stay-open-and-show-inline UX.
    function setBusy(label) {
      if (!_ctx) return;
      _busy = true;
      hideMsg();
      const { confirm, cancel, back } = els();
      if (confirm) { confirm.disabled = true; confirm.textContent = label || 'Accepting…'; }
      if (cancel) cancel.disabled = true;
      if (back) back.disabled = true;
    }
    function setError(msg, msgOpts) {
      if (!_ctx) return;
      _busy = false;
      const { confirm, cancel, back } = els();
      if (confirm) { confirm.disabled = false; confirm.textContent = 'Accept Offer'; }
      if (cancel) cancel.disabled = false;
      if (back) back.disabled = false;
      showMsg(msg, 'error', msgOpts && msgOpts.html);
    }
    function setSuccess(label) {
      if (!_ctx) return;
      _busy = false;
      _locked = true;
      const { confirm, cancel, back } = els();
      if (confirm) confirm.textContent = label || 'Accepted!';
      if (cancel) { cancel.disabled = false; cancel.textContent = 'Close'; }
      if (back) back.style.visibility = 'hidden';
    }

    function render(config, bonusFees) {
      const price = _ctx.priceWax;
      // Maker + taker combined into one "Market Fee" line, matching
      // inventory.html's own 3-line presentation (Ecosystem / Market /
      // Collection) rather than splitting them out — they're both real,
      // separately-configured rates, but shown as one line since the split
      // isn't something the seller can act on either way.
      const marketPct    = config ? (config.maker + config.taker) : 0;
      const ecosystemPct = bonusFees.reduce((sum, f) => sum + f.pct, 0);
      const royaltyPct   = _ctx.collectionFeePct || 0;
      const totalPct     = marketPct + ecosystemPct + royaltyPct;
      const net = price * (1 - totalPct);

      // Labels/descriptions match inventory.html's own fee-breakdown popup
      // verbatim, per the user's exact wording.
      const feeItems = [
        ecosystemPct > 0 ? { label: 'Ecosystem Fee', desc: 'A blockchain-specific fee for processing the transaction.', p: ecosystemPct } : null,
        config ? { label: 'Market Fee', desc: 'A flat fee to maintain & improve marketplaces.', p: marketPct } : null,
        royaltyPct > 0 ? { label: 'Collection Fee', desc: 'A % set by the collection creator, received on every secondary market transaction.', p: royaltyPct } : null,
      ].filter(Boolean);

      const hasBack  = typeof _ctx.onBack === 'function';
      const offerRow = _ctx.buyofferId != null
        ? `<div class="ao-row"><span class="ao-row-label">Offer #</span><span class="ao-row-val">${esc(_ctx.buyofferId)}</span></div>`
        : '';
      const buyerRow = _ctx.buyer
        ? `<div class="ao-row"><span class="ao-row-label">Buyer</span><span class="ao-row-val">${_ctx.buyerHref ? `<a href="${esc(_ctx.buyerHref)}" class="wallet-link">${esc(_ctx.buyer)}</a>` : esc(_ctx.buyer)}</span></div>`
        : '';

      panel.innerHTML = `
        <div class="ao-header">
          ${hasBack ? `<button type="button" class="ao-back" id="aoBack" aria-label="Back">←</button>` : ''}
          <span class="ao-title"${hasBack ? ' style="flex:1;text-align:center"' : ''}>Accept Offer</span>
          <button type="button" class="ao-close" id="aoClose" aria-label="Close">✕</button>
        </div>
        <div class="ao-body">
          <div class="ao-media">${mediaHtml(_ctx)}</div>
          <div class="ao-name">${esc(_ctx.name || 'Unknown')}</div>
          <div class="ao-meta">${esc(_ctx.collectionName || '')}${_ctx.mintLabel ? ' · ' + esc(_ctx.mintLabel) : ''}</div>
          <div class="ao-row"><span class="ao-row-label">Buy offer</span><span class="ao-row-val">${fmtWax(price)} WAX</span></div>
          <div class="ao-row ao-row--total"><span class="ao-row-label">You receive</span><span class="ao-row-val ao-receive">${fmtWax(net)} WAX</span></div>
          ${offerRow}
          ${buyerRow}
          ${feeItems.length ? `
          <details class="ao-fee-details">
            <summary><span>Total Fees: ${pct(totalPct)}</span><span class="ao-fee-arrow">▾</span></summary>
            <div class="ao-fee-items">
              ${feeItems.map(f => `
                <div class="ao-fee-item">
                  <span class="ao-fee-item-pct">${pctFixed(f.p)}</span>
                  <div class="ao-fee-item-info">
                    <span class="ao-fee-item-name">${f.label}</span>
                    <span class="ao-fee-item-desc">${f.desc}</span>
                  </div>
                </div>`).join('')}
            </div>
          </details>` : `
          <div class="ao-fee-unavailable">Marketplace fee rates unavailable right now — the amount below may be a little high; the collection royalty is already accounted for.</div>`}
          <div id="aoMsg" class="ao-msg" style="display:none;"></div>
          <div class="ao-actions">
            <button type="button" class="ao-btn ao-btn--cancel" id="aoCancel">Cancel</button>
            <button type="button" class="ao-btn ao-btn--primary" id="aoConfirm">Accept Offer</button>
          </div>
        </div>`;

      panel.querySelector('#aoClose').addEventListener('click', guardedClose);
      panel.querySelector('#aoCancel').addEventListener('click', guardedClose);
      if (hasBack) {
        panel.querySelector('#aoBack').addEventListener('click', () => {
          if (_busy) return;
          const ctx = _ctx;
          overlay.style.display = 'none';
          _ctx = null; _locked = false;
          ctx.onBack();
        });
      }
      panel.querySelector('#aoConfirm').addEventListener('click', () => {
        if (_busy || _locked || !_ctx.onConfirm) return;
        setBusy('Accepting…');
        try {
          Promise.resolve(_ctx.onConfirm({ setBusy, setError, setSuccess, close })).catch(err => {
            console.error('AcceptOfferModal onConfirm rejected:', err);
          });
        } catch (err) {
          console.error('AcceptOfferModal onConfirm threw:', err);
        }
      });
    }

    async function open(ctx) {
      _ctx = ctx; _busy = false; _locked = false;
      overlay.style.display = 'flex';
      panel.innerHTML = '<div class="ao-loading">Loading fee details…</div>';
      const [config, bonusFeeRows] = await Promise.all([fetchMarketConfig(), fetchBonusFees()]);
      if (_ctx !== ctx) return; // closed (or a newer open() superseded this) while the fetch was in flight
      render(config, matchingBonusFees(bonusFeeRows, ctx.buyofferId));
    }

    return { open, close };
  }

  return { mount };
})();

'use strict';
/* Translates a caught WaxAuth.transact() error into a message a non-technical
   buyer can actually act on. Every purchase/accept/claim flow site-wide was
   showing a bare "failed, try again" (or nothing at all) for RAM/CPU/NET
   exhaustion — the two real failures that prompted this:
     - Anchor auto-sponsors a short-on-resources transaction via Greymass
       Fuel; when that cosignature fails to attach, the chain's raw
       "declares authority {actor:greymassfuel,permission:cosign}, does not
       have signatures for it" error leaks straight to the user, and says
       nothing about RAM/CPU/NET at all.
     - A NET/CPU shortfall instead surfaces as "transaction net usage is too
       high: 280 > 0" / a "billable cpu time" message — technically clearer,
       but still not something a collector buying a card knows how to fix.
   A buyer who can't tell what went wrong just leaves and buys elsewhere —
   this exists to catch that before it happens again.

   Usage:
     const info = describeTxError(err);
     if (info.kind !== 'cancelled') {
       statusEl.innerHTML = txErrorHtml(info, 'Purchase failed — please try again.', ramPrefix);
       statusEl.className = '...is-error';
       statusEl.style.display = 'block';
     }
   ramPrefix — relative path prefix to the root-level ram.html, same
   convention as walletMenuItems()'s prefix param: '' for root pages,
   '../' for a section page (funko/topps/wombat/twitch), or a page's own
   computed `_p` for the clean-URL wallet-segment pages. */
(function () {
  window.describeTxError = function (err) {
    const msg = String((err && err.message) || err || '');
    const lower = msg.toLowerCase();

    if (lower.includes('cancel') || lower.includes('abort') || lower.includes('user')) {
      return { kind: 'cancelled' };
    }
    if (lower.includes('greymassfuel') && (lower.includes('does not have signatures') || lower.includes('cosign'))) {
      return {
        kind: 'resources',
        text: "This wallet doesn't have enough RAM, CPU, or NET for this transaction, and the wallet's automatic resource sponsor failed to cover it.",
      };
    }
    if (lower.includes('net usage is too high') || (/\bnet\b/.test(lower) && lower.includes('exceed'))) {
      return { kind: 'net', text: "This wallet is out of NET (network bandwidth) — that's why this failed." };
    }
    if (lower.includes('billable cpu time') || (/\bcpu\b/.test(lower) && lower.includes('exceed'))) {
      return { kind: 'cpu', text: "This wallet is out of CPU (processing power) — that's why this failed." };
    }
    if (/\bram\b/.test(lower) && (lower.includes('insufficient') || lower.includes('exceed'))) {
      return { kind: 'ram', text: "This wallet is out of RAM — that's why this failed." };
    }
    return { kind: 'generic' };
  };

  const RAM_CTA      = p => `<a href="${p}ram" class="tx-err-link">Buy RAM →</a>`;
  const RESOURCES_CTA = `<a href="https://waxblock.io/wallet/resources" target="_blank" rel="noopener" class="tx-err-link">Manage resources ↗</a>`;

  window.txErrorHtml = function (info, genericMessage, ramPrefix) {
    const p = ramPrefix || '';
    switch (info.kind) {
      case 'ram':       return `${info.text} ${RAM_CTA(p)}`;
      case 'net':
      case 'cpu':       return `${info.text} ${RESOURCES_CTA}`;
      case 'resources':  return `${info.text} ${RAM_CTA(p)} ${RESOURCES_CTA}`;
      default:          return genericMessage;
    }
  };

  /* For a plain "Buy" button with no status area next to it (explore.html's
     and sale.html's per-card/per-listing buttons) — a resource failure isn't
     something a "retry" click ever fixes, so instead of the usual
     auto-reverting "Failed — retry" text, this turns the button itself into
     the fix: it explains what's wrong, and the next click takes the buyer
     straight to the page that solves it (RAM stays in-site since we can
     buy/sell it directly; CPU/NET need staking, which we don't have a page
     for, so that goes to waxblock.io's resource manager in a new tab).
     No auto-revert — they need time to read it, and clicking navigates away
     rather than retrying. errorClass is the page's own "failed" button
     class (kept fully caller-owned since every page styles it differently). */
  window.applyResourceErrorToBuyBtn = function (btn, info, errorClass, ramPrefix) {
    const p = ramPrefix || '';
    const isRam = info.kind === 'ram';
    // Several callers wire their buttons with addEventListener (or a
    // delegated container listener keyed off data-action) rather than an
    // inline onclick — just setting .onclick would leave that original
    // listener attached, so the old action (buy/claim/accept…) would fire
    // right alongside this fix-it navigation on the next click. Clone+
    // replace strips every existing listener before attaching this one.
    const fresh = btn.cloneNode(true);
    fresh.disabled = false;
    fresh.removeAttribute('data-action');
    fresh.textContent = isRam ? '⚠ Low RAM — tap to fix' : '⚠ Low resources — tap to fix';
    fresh.className   = errorClass;
    fresh.title       = info.text;
    fresh.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (isRam) window.location.href = p + 'ram';
      else window.open('https://waxblock.io/wallet/resources', '_blank', 'noopener');
    };
    btn.replaceWith(fresh);
    return fresh;
  };
})();

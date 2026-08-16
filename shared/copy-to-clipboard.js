'use strict';
/* Small reusable "copy to clipboard" icon button — for any raw ID/address/
   value across the site that's more useful copied than read (Template ID,
   Asset ID, wallet address, tx id, etc). Pulled out as a shared module
   (rather than copied per-page) because the plan is to drop it into many
   pages, not just one. Revives the look/feel of the copy button that used
   to live inline in the pre-merge inventory.html info popup (see
   archive/pre-merge-2026-07-21/inventory.html's copyVal + .copy-btn CSS,
   which global.css still carries) — same icon, same "✓ for 1.2s" feedback,
   same .copy-btn/.tt-val-copiable classes, just centralized and reusable.

   Unlike that original, the button carries NO inline onclick — the value
   goes into a properly-escaped data-copy-value attribute instead, read by
   one delegated document-level listener below. Inline onclick="...'${value}'"
   only works safely for values guaranteed not to contain a quote (numeric
   IDs); this version is meant for anything, including names/addresses that
   might. */
(function () {
  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // title also doubles as the accessible label — always pass something
  // specific ("Copy template ID"), not just "Copy", so screen readers and
  // hover tooltips both say what's actually being copied.
  function copyIconHtml(value, title) {
    const t = title || 'Copy';
    return `<button type="button" class="copy-btn" data-copy-value="${_esc(value)}" title="${_esc(t)}" aria-label="${_esc(t)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
  }

  function copyToClipboard(btn, text) {
    navigator.clipboard.writeText(String(text)).then(() => {
      if (btn._copyTimer) clearTimeout(btn._copyTimer);
      if (btn._copyOrig == null) btn._copyOrig = btn.innerHTML;
      btn.innerHTML = '✓';
      btn.classList.add('copied');
      btn._copyTimer = setTimeout(() => {
        btn.innerHTML = btn._copyOrig;
        btn._copyOrig = null;
        btn.classList.remove('copied');
      }, 1200);
    }).catch(() => { /* clipboard permission denied/unavailable — silently do nothing */ });
  }

  // Delegated so copyIconHtml's output works the moment it's inserted via
  // innerHTML, no per-instance wiring needed. stopPropagation so a copy
  // click sitting inside a whole-row/card click target (see
  // feedback_whole_card_click_blocks_text_selection) never also triggers
  // that row's own navigation.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.copy-btn[data-copy-value]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(btn, btn.getAttribute('data-copy-value'));
  });

  window.copyIconHtml = copyIconHtml;
  window.copyToClipboard = copyToClipboard;
})();

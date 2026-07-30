'use strict';
/* Canonical wallet-widget dropdown menu (shared/wallet-widget.js's
   `menuItems` option) — one definition instead of a hand-copied array per
   caller. Every page/section that mounts the widget calls this instead of
   hardcoding the list, so adding/renaming a sitewide item is a one-file
   change instead of touching every page.

   window.walletMenuItems(prefix, extraItems)
     prefix     — relative path prefix applied to every base item's href:
                  '' for root pages, '../' for a section page (funko/topps/
                  wombat/twitch), or a page's own computed `_p` for the
                  clean-URL wallet-segment pages (inventory.html,
                  collection.html, template.html — see their `_p` comments).
     extraItems — section-specific items prepended as-is, in their own path
                  space (this function never touches their hrefs) — e.g.
                  Funko's Collector Profile link, the only such item today. */
(function () {
  const BASE_ITEMS = [
    { href: 'inventory', label: 'Inventory', icon: '📦' },
    { href: 'inventory-activity', label: 'Activity', icon: '🕒' },
    { href: 'trade-offers', label: 'Trade Offers', icon: '🔄' },
    { href: 'gift-links', label: 'Gift Links', icon: '🎁' },
    { href: 'balances', label: 'Contract Balances', icon: '💰' },
  ];

  window.walletMenuItems = function (prefix, extraItems) {
    const p = prefix || '';
    const base = BASE_ITEMS.map(item => Object.assign({}, item, { href: p + item.href }));
    return (extraItems || []).concat(base);
  };
})();

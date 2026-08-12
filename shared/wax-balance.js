'use strict';
/* WAX balance fetch/format for the Linked Wallets list on profile.html —
   up to 10 accounts, each fetched once per page load (not polled). A
   self-contained copy of the same logic shared/wallet-widget.js keeps
   privately for its single nav-pill account; not shared as a module since
   wallet-widget.js's version is tangled up with its own caching/polling
   state for "the one currently connected account", which doesn't fit this
   page's "N linked wallets, fetch once" shape. */
(function () {
  const _WAX_RPC_ENDPOINTS = [
    'https://wax.greymass.com',
    'https://api.waxsweden.org',
    'https://wax.eu.eosamsterdam.net',
  ];
  const _RPC_TIMEOUT    = 5000;
  // Same sessionStorage key shared/wallet-widget.js uses for its CoinGecko
  // rate cache — reusing it here (not importing it) avoids a redundant
  // CoinGecko call when both scripts are on the page within the same 2 min.
  const _RATE_CACHE_KEY = 'wax_usd_rate_cache_v1';
  const _RATE_TTL       = 2 * 60 * 1000;

  function _fetchWithTimeout(url, fetchOpts, ms) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({}, fetchOpts, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
  }

  async function fetchBalance(acc) {
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

  async function fetchUsdRate() {
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

  function format(wax, rate) {
    const waxStr = wax.toLocaleString(undefined, { maximumFractionDigits: wax >= 1000 ? 0 : 2 });
    if (!rate) return `${waxStr} WAX`;
    const usd    = wax * rate;
    const usdStr = usd.toLocaleString(undefined, { maximumFractionDigits: usd >= 100 ? 0 : 2 });
    return `${waxStr} WAX <span class="nav-wax-balance-usd">(~$${usdStr})</span>`;
  }

  window.WaxBalance = { fetchBalance, fetchUsdRate, format };
})();

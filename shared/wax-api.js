'use strict';
(function () {
  /* AtomicAssets community nodes, ordered by measured real-world latency
     (health + assets query response time, 2026-07 spot check) — fastest
     first, since _idx starts at 0 and the first request of a session
     hits that node with no upfront health probing.
     atomicmarket is only reliably hosted on the official node — market
     URLs are detected and excluded from rotation automatically, so this
     ordering only affects atomicassets calls (aaBase). */
  const AA_ENDPOINTS = [
    'https://wax.eosusa.io',              // ~300-400ms
    'https://atomic.wax.eosrio.io',       // ~700-750ms
    'https://wax.api.atomicassets.io',    // ~750-1000ms — official node, kept high as the reliable reference
    'https://wax-aa.eu.eosamsterdam.net', // 2.3-7s but works; best block freshness of the group
    'https://atomic.hivebp.io',           // slow/flaky health, but usable once connected
    'https://aa.dapplica.io',             // untested — kept as fallback
    'https://wax-atomic.alcor.exchange',
    'https://wax-atomic-api.eosphere.io',
    'https://atomic.sentnl.io',
    'https://atomic.wax.detroitledger.tech',
  ];

  const RETRY          = new Set([429, 503, 408]);
  const TIMEOUT        = 12000; // ms — abort a hung real request and rotate to a different node
  const MARKET_TIMEOUT = 6000;  // ms — shorter: a hung market request retries the *same* node, so a long timeout just multiplies
  const HEALTH_TIMEOUT = 10000; // ms — abort a hung health check
  const HEALTH_TTL     = 2 * 60 * 1000; // cache block_num results for 2 min
  const MAX_BLOCK_GAP  = 1000; // blocks — ~8 min on WAX; anything further is considered lagging
  const MARKET_RETRIES = 3; // same-endpoint retries for atomicmarket URLs, which never rotate

  let _idx = 0;
  const _blockCache = new Map(); // base → { block: number|null, ts: number }

  function _cur()     { return AA_ENDPOINTS[_idx % AA_ENDPOINTS.length]; }
  function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _fetchWithTimeout(url, ms) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  function _canRotate(url) {
    return !url.includes('/atomicmarket/') && AA_ENDPOINTS.some(ep => url.startsWith(ep));
  }

  function _swapBase(url) {
    const old = AA_ENDPOINTS.find(ep => url.startsWith(ep));
    return old ? _cur() + url.slice(old.length) : url;
  }

  /* Fetch block_num from a single endpoint's /health. Returns null on any failure.
     Results are cached for HEALTH_TTL so parallel calls to _rotateToHealthy
     within the same session are cheap. */
  async function _fetchBlockNum(base) {
    const cached = _blockCache.get(base);
    if (cached && Date.now() - cached.ts < HEALTH_TTL) return cached.block;

    let block = null;
    try {
      const res = await _fetchWithTimeout(base + '/health', HEALTH_TIMEOUT);
      if (res.ok) {
        const json = await res.json();
        if (json?.success) {
          const b = json?.data?.postgres?.readers?.[0]?.block_num;
          if (typeof b === 'number') block = b;
        }
      }
    } catch { /* unreachable, timed out, or CORS blocked — stays null */ }

    _blockCache.set(base, { block, ts: Date.now() });
    return block;
  }

  /* Health-check all endpoints in parallel, pick the highest block_num as
     the reference, and select the first candidate that:
       • is not the endpoint that just failed
       • has a block_num within MAX_BLOCK_GAP of the reference
     If no healthy candidate exists, throw rather than silently use a lagging node. */
  async function _rotateToHealthy(failedUrl) {
    const failedBase = AA_ENDPOINTS.find(ep => failedUrl.startsWith(ep));

    const checks = await Promise.all(
      AA_ENDPOINTS.map(async base => ({ base, block: await _fetchBlockNum(base) }))
    );

    const maxBlock = Math.max(...checks.map(c => c.block ?? -Infinity));

    if (maxBlock === -Infinity) {
      // Nothing responded at all — simple advance so the real request can fail properly
      _idx = (_idx + 1) % AA_ENDPOINTS.length;
      return _swapBase(failedUrl);
    }

    const healthy = checks.filter(c =>
      c.block !== null &&
      maxBlock - c.block <= MAX_BLOCK_GAP &&
      c.base !== failedBase
    );

    if (healthy.length === 0) {
      throw new Error('No healthy WAX endpoint available');
    }

    _idx = AA_ENDPOINTS.indexOf(healthy[0].base);
    return _swapBase(failedUrl);
  }

  /* Fetch a WAX AtomicAssets URL, rotating to the next healthy endpoint on 429/503/408.
     atomicmarket URLs can't rotate (only reliable on the official node), so they get
     same-endpoint retries with backoff instead — still resilient to transient hiccups.
     Returns json.data on success; throws on non-retryable errors or no healthy fallback. */
  async function apiFetch(url) {
    let cur = url;
    const rotatable   = _canRotate(url);
    const maxAttempts = rotatable ? AA_ENDPOINTS.length : MARKET_RETRIES;
    for (let i = 0; i < maxAttempts; i++) {
      let res;
      try {
        res = await _fetchWithTimeout(cur, rotatable ? TIMEOUT : MARKET_TIMEOUT);
      } catch (err) {
        if (i === maxAttempts - 1) throw err;
        if (rotatable) { cur = await _rotateToHealthy(cur); await _delay(300); }
        else await _delay(400 * (i + 1));
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        if (!json.success) throw new Error('API error');
        return json.data;
      }
      if (RETRY.has(res.status) && i < maxAttempts - 1) {
        if (rotatable) { cur = await _rotateToHealthy(cur); await _delay(i === 0 ? 300 : 600); }
        else await _delay(400 * (i + 1));
        continue;
      }
      throw new Error('API ' + res.status);
    }
  }

  /* Like apiFetch but returns the raw Response, for callers that inspect
     the response themselves (e.g. handle non-success gracefully). */
  async function rawFetch(url) {
    let cur = url;
    const rotatable   = _canRotate(url);
    const maxAttempts = rotatable ? AA_ENDPOINTS.length : MARKET_RETRIES;
    for (let i = 0; i < maxAttempts; i++) {
      let res;
      try {
        res = await _fetchWithTimeout(cur, rotatable ? TIMEOUT : MARKET_TIMEOUT);
      } catch (err) {
        if (i === maxAttempts - 1) throw err;
        if (rotatable) { cur = await _rotateToHealthy(cur); await _delay(300); }
        else await _delay(400 * (i + 1));
        continue;
      }
      if (!RETRY.has(res.status) || i === maxAttempts - 1) return res;
      if (rotatable) { cur = await _rotateToHealthy(cur); await _delay(i === 0 ? 300 : 600); }
      else await _delay(400 * (i + 1));
    }
  }

  /* Base URL helpers — always reflect the current (possibly rotated) endpoint. */
  function aaBase()     { return _cur() + '/atomicassets/v1'; }
  function marketBase() { return 'https://wax.api.atomicassets.io/atomicmarket/v1'; }

  /* Returns `count` distinct AtomicAssets base URLs (atomicassets/v1),
     starting from the current preferred endpoint and wrapping through the
     pool. Lets a batch of independent parallel calls fan out across
     multiple nodes instead of serializing on one origin's browser
     connection limit (~6 concurrent per host). */
  function aaBases(count) {
    const n = Math.max(1, Math.min(count, AA_ENDPOINTS.length));
    const out = [];
    for (let i = 0; i < n; i++) out.push(AA_ENDPOINTS[(_idx + i) % AA_ENDPOINTS.length] + '/atomicassets/v1');
    return out;
  }

  /* ── Shared endpoint ordering, refreshed at most once per REFRESH_TTL ──
     A row in Supabase (public.wax_endpoint_health) holds the current
     fastest-to-slowest order and when it was last measured. Every page load
     reads it (cheap, one row) and reorders AA_ENDPOINTS to match. If it's
     older than REFRESH_TTL, this visitor's browser times every endpoint in
     the background and writes the new order back — the update only takes
     effect server-side if the row is *still* stale by then, so many
     visitors doing this at once is harmless; at most one write per window
     actually changes anything. Any failure here (table not created yet,
     Supabase unreachable, etc.) is silent — the hardcoded order above is
     always a safe fallback. */
  const REFRESH_TTL = 6 * 60 * 60 * 1000; // 6 hours

  function _applyOrder(order) {
    if (!Array.isArray(order) || !order.length) return;
    const incoming = order.filter(ep => AA_ENDPOINTS.includes(ep));
    const missing  = AA_ENDPOINTS.filter(ep => !incoming.includes(ep));
    AA_ENDPOINTS.length = 0;
    AA_ENDPOINTS.push(...incoming, ...missing);
    _idx = 0;
  }

  async function _measureFastestOrder() {
    const timed = await Promise.all(AA_ENDPOINTS.map(async base => {
      const start = Date.now();
      try {
        const res = await _fetchWithTimeout(base + '/health', 6000);
        return { base, ms: res.ok ? Date.now() - start : Infinity };
      } catch { return { base, ms: Infinity }; }
    }));
    const reachable   = timed.filter(t => t.ms !== Infinity).sort((a, b) => a.ms - b.ms).map(t => t.base);
    const unreachable = timed.filter(t => t.ms === Infinity).map(t => t.base);
    return [...reachable, ...unreachable]; // unreachable ones kept at the end as last-resort fallbacks
  }

  async function _syncEndpointOrder() {
    // supabase-config.js declares these with `const`, so — unlike `var` —
    // they never become window properties. Only a bare reference sees them.
    const url = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : null;
    const key = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : null;
    if (!url || !key) return; // this page doesn't load supabase-config.js — skip silently
    const headers = { apikey: key, Authorization: 'Bearer ' + key };

    try {
      const res = await fetch(url + '/rest/v1/wax_endpoint_health?id=eq.1&select=endpoint_order,checked_at', { headers });
      if (!res.ok) return; // table not created yet, or unreachable — keep the built-in order
      const rows = await res.json();
      const row = rows && rows[0];
      if (!row) return;

      _applyOrder(row.endpoint_order);

      const age = Date.now() - new Date(row.checked_at).getTime();
      if (age < REFRESH_TTL) return; // fresh enough — nothing else to do

      const freshOrder = await _measureFastestOrder();
      _applyOrder(freshOrder);

      await fetch(url + '/rest/v1/rpc/update_wax_endpoint_health', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ p_order: freshOrder }),
      }).catch(() => {});
    } catch {} // any failure — the page keeps working with whatever order it already has
  }

  // Deferred so it never delays this page's own first request: by the time
  // this fires, every synchronous <script> on the page (including
  // supabase-config.js, regardless of tag order) has already run.
  if (typeof window !== 'undefined') setTimeout(_syncEndpointOrder, 0);

  window.WaxApi = { apiFetch, rawFetch, aaBase, aaBases, marketBase };
})();

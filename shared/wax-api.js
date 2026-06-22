'use strict';
(function () {
  /* AtomicAssets community nodes in priority order.
     The official endpoint leads; community nodes are fallbacks.
     atomicmarket is only reliably hosted on the official node — market
     URLs are detected and excluded from rotation automatically. */
  const AA_ENDPOINTS = [
    'https://wax.api.atomicassets.io',
    'https://aa.dapplica.io',
    'https://atomic.wax.eosrio.io',
    'https://wax-aa.eu.eosamsterdam.net',
    'https://wax.eosusa.io',
    'https://atomic.hivebp.io',
    'https://wax-atomic.alcor.exchange',
    'https://wax-atomic-api.eosphere.io',
    'https://atomic.sentnl.io',
    'https://atomic.wax.detroitledger.tech',
  ];

  const RETRY          = new Set([429, 503, 408]);
  const TIMEOUT        = 12000; // ms — abort a hung real request and rotate
  const HEALTH_TIMEOUT = 10000; // ms — abort a hung health check
  const HEALTH_TTL     = 2 * 60 * 1000; // cache block_num results for 2 min
  const MAX_BLOCK_GAP  = 1000; // blocks — ~8 min on WAX; anything further is considered lagging

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
     Returns json.data on success; throws on non-retryable errors or no healthy fallback. */
  async function apiFetch(url) {
    let cur = url;
    for (let i = 0; i < AA_ENDPOINTS.length; i++) {
      let res;
      try {
        res = await _fetchWithTimeout(cur, TIMEOUT);
      } catch (err) {
        if (!_canRotate(cur) || i === AA_ENDPOINTS.length - 1) throw err;
        cur = await _rotateToHealthy(cur);
        await _delay(300);
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        if (!json.success) throw new Error('API error');
        return json.data;
      }
      if (RETRY.has(res.status) && _canRotate(cur) && i < AA_ENDPOINTS.length - 1) {
        cur = await _rotateToHealthy(cur);
        await _delay(i === 0 ? 300 : 600);
        continue;
      }
      throw new Error('API ' + res.status);
    }
  }

  /* Like apiFetch but returns the raw Response, for callers that inspect
     the response themselves (e.g. handle non-success gracefully). */
  async function rawFetch(url) {
    let cur = url;
    for (let i = 0; i < AA_ENDPOINTS.length; i++) {
      let res;
      try {
        res = await _fetchWithTimeout(cur, TIMEOUT);
      } catch (err) {
        if (!_canRotate(cur) || i === AA_ENDPOINTS.length - 1) throw err;
        cur = await _rotateToHealthy(cur);
        await _delay(300);
        continue;
      }
      if (!RETRY.has(res.status) || !_canRotate(cur) || i === AA_ENDPOINTS.length - 1) return res;
      cur = await _rotateToHealthy(cur);
      await _delay(i === 0 ? 300 : 600);
    }
  }

  /* Base URL helpers — always reflect the current (possibly rotated) endpoint. */
  function aaBase()     { return _cur() + '/atomicassets/v1'; }
  function marketBase() { return 'https://wax.api.atomicassets.io/atomicmarket/v1'; }

  window.WaxApi = { apiFetch, rawFetch, aaBase, marketBase };
})();

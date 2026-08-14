'use strict';
(function () {
  /* AtomicAssets community nodes — this is ONLY the bootstrap default, used
     synchronously before the Supabase read below resolves (or if Supabase
     is ever unreachable). The real, authoritative list — both which
     endpoints exist and their order — lives in Supabase
     (public.wax_endpoint_health) and fully REPLACES this array on every
     page load via _syncEndpointOrder/_applyOrder. That row is populated by
     an external health-check agent (not this codebase), so this array does
     not need to be kept in sync with it by hand going forward.
     atomicmarket is only reliably hosted on the official node — market
     URLs are detected and excluded from rotation automatically, so this
     ordering only affects atomicassets calls (aaBase). */
  const AA_ENDPOINTS = [
    'https://atomic.wax.detroitledger.tech',
    'https://wax-atomic.alcor.exchange',
    'https://wax.api.atomicassets.io',    // official node, kept as the reliable reference
    'https://api.waxsweden.org',
    'https://wax-aa.eu.eosamsterdam.net',
    'https://atomic.wax.eosrio.io',
    'https://wax-atomic-api.eosphere.io',
    'https://wax.eosusa.io',              // fast /health, but real queries 429 heavily — see note above
  ];

  const RETRY          = new Set([429, 503, 408]);
  const TIMEOUT        = 12000; // ms — abort a hung real request and rotate to a different node
  const MARKET_TIMEOUT = 6000;  // ms — shorter: a hung market request retries the *same* node, so a long timeout just multiplies
  const HEALTH_TIMEOUT = 10000; // ms — abort a hung health check
  const HEALTH_TTL     = 2 * 60 * 1000; // cache block_num results for 2 min
  const MAX_BLOCK_GAP  = 1000; // blocks — ~8 min on WAX; anything further is considered lagging
  const MARKET_RETRIES = 3; // same-endpoint retries for atomicmarket URLs, which never rotate

  /* The official market node enforces a real 240-request/60-second budget —
     confirmed repeatedly via `curl -sD -`, which shows genuine
     ratelimit-limit/ratelimit-remaining/ratelimit-reset response headers
     (IETF draft convention) on every response. An earlier version of this
     module tried to read those same headers from `fetch()` in the browser
     and track live remaining/reset state from them. That never actually
     worked: confirmed live (2026-08-10) that `res.headers.get('ratelimit-
     remaining')` is always `null` in a real browser response, because the
     server never sends `Access-Control-Expose-Headers` for its custom
     ratelimit-* headers — CORS only exposes a small safelisted set
     (Cache-Control/Content-Type/Last-Modified/etc.) to page JS by default,
     and curl isn't subject to CORS at all, which is exactly why curl saw
     the headers and the running site never did. The only reason the
     previous "verified live" test of that logic passed is that it
     monkeypatched `window.fetch` to return a hand-built Response with fake
     headers, which bypasses real CORS restrictions entirely — it proved the
     gating math was correct, not that the browser could ever see the data
     driving it. In production `_marketRemaining` stayed `null` forever, so
     that "proactive" gate never actually fired; whatever improvement was
     measured that session came from the flat per-request pacing that sat
     alongside it, not from this header logic.

     Replaced with a window we track ourselves, purely client-side — no
     server cooperation needed. First built as a SLIDING window (each
     request's own slot individually expiring 60s after it fired) — wrong
     model, caught by direct experiment: fired 30 requests back-to-back via
     `curl -sD -` and watched `ratelimit-reset` count straight down in
     lockstep with wall-clock time regardless of request volume (60→59→58…),
     with `remaining` dropping by exactly 1 per request and never partially
     recovering mid-window. That's a FIXED window — the whole 240-request
     budget refills at once, all at the same shared reset instant, not
     continuously as individual old requests "age out." A sliding-window
     client model on top of a fixed-window server produces exactly the
     symptom reported live: waiting for just one tracked entry to expire
     frees a slot that doesn't actually exist yet server-side (the real
     budget hasn't refilled at all until the true reset instant), so
     concurrent workers kept re-tripping the gate every few seconds instead
     of the clean single burst-wait-burst this fix now produces.

     Tracked as {windowStart, count} in localStorage (not an in-memory
     object) so multiple tabs of this site share one window — a bulk fetch
     running in one tab should back off if the user is also doing a normal
     buy/accept-offer in another tab, not just track its own traffic in
     isolation. This can't see traffic from other sites/users hitting the
     same public node, which real server-side headers would have caught in
     theory — the existing 429 retry/backoff in apiFetch/rawFetch remains
     the real backstop for that blind spot.

     An earlier version also hard-corrected this tracked state on a real 429
     — pinning it to "fully exhausted, restart the 60s clock from right now,"
     treating any 429 as proof the whole window was blown. That was built for
     the PER-REQUEST-GATE design this module used to have, where drifted,
     timer-delayed admissions really could burst into a window that hadn't
     actually reset. It doesn't fit the current batch design: a batch is
     already sized conservatively up front from this exact tracked count, so
     a stray 429 slipping through is far more likely a brief blip from some
     OTHER consumer of this shared public node (or a transient hiccup) than
     proof our own 240-budget is really at 0. Confirmed live: this "hard
     correction" outlived its own usefulness and started actively lying —
     one run's stray 429 poisoned the shared tracked state for a full 60s,
     and a LATER, unrelated run inherited "0 remaining" and sat waiting even
     though the real server (checked directly in the browser's Network
     panel, not subject to the CORS restriction that blocks page JS from
     reading the same header) showed 183 of 240 still available the whole
     time. Removed — `_recordMarketRequest` below, called on every real
     attempt regardless of outcome, is accurate enough on its own now that
     the timer-drift failure mode this correction existed for no longer
     applies, and the existing per-request retry/backoff already absorbs an
     occasional real 429 without needing to poison shared state over it.

     This module deliberately does NOT gate individual requests anymore —
     three straight rewrites of a per-request gate here (sliding-window,
     then fixed-window-with-throttle-stage, then a paced-admission version)
     each fixed one live-reproduced bug and introduced or left another
     (a stutter, then a genuine deadlock, then an infinite loop that
     silently stopped firing ANY requests while a "slowing down" label sat
     there implying progress that wasn't happening). The actual insight that
     ends this cycle, from the user directly: this doesn't need to be a
     per-request decision at all. `getMarketBudget()` below is precise
     (it's our own exact count, not an estimate that needs live headers),
     so a CALLER that already knows how many requests it's about to make
     (inventory.html's premium-unlock batch fetchers) can decide, per BATCH,
     whether the whole batch fits under the remaining budget or not — and
     if not, run only as many as safely fit, then stop cleanly and wait for
     a real reset before continuing. That orchestration now lives in
     inventory.html, not here — this module just tracks and exposes the
     count. See inventory.html's runMarketBudgetedBatches(). */
  const MARKET_WINDOW_MS = 60 * 1000;
  const MARKET_LIMIT      = 240; // fixed constant, not read live — see above for why it can't be read live; re-verify with curl if the node's policy ever seems to have changed
  const MARKET_STATE_KEY  = 'wax_market_window_v1';

  function _readMarketWindow(now) {
    let state;
    try { state = JSON.parse(localStorage.getItem(MARKET_STATE_KEY) || 'null'); } catch { state = null; }
    if (!state || typeof state.windowStart !== 'number' || typeof state.count !== 'number' || now - state.windowStart >= MARKET_WINDOW_MS) {
      return { windowStart: now, count: 0 }; // no tracked window, or the tracked one has fully elapsed — start fresh
    }
    return state;
  }

  // Called once per actual market request attempt (including retries — each
  // one really does spend budget on the server). Read-modify-write is not
  // atomic across tabs, so two tabs can race and both increment from the
  // same stale snapshot — acceptable, callers batching against this count
  // (see inventory.html's runMarketBudgetedBatches) already leave their own
  // stop-threshold slack for exactly this, not a guarantee of perfect
  // cross-tab ordering.
  function _recordMarketRequest() {
    const now = Date.now();
    const state = _readMarketWindow(now);
    state.count++;
    try { localStorage.setItem(MARKET_STATE_KEY, JSON.stringify(state)); } catch {}
  }

  /* Read-only snapshot of the tracked market budget, for a caller that wants
     to make its own batching decisions (e.g. inventory.html's premium-unlock
     fetchers — see runMarketBudgetedBatches there) or reflect state in its
     own UI. Purely observational — reading this never affects the tracked
     window itself. */
  function getMarketBudget() {
    const now = Date.now();
    const state = _readMarketWindow(now);
    return {
      remaining: Math.max(0, MARKET_LIMIT - state.count),
      resetAt:   state.windowStart + MARKET_WINDOW_MS,
    };
  }

  /* A node can pass /health (fast, not rate-limited) while its real
     /atomicassets/v1 queries 429 constantly (seen on wax.eosusa.io,
     2026-07) — the external health-check agent behind wax_endpoint_health
     may not catch that instantly either. This penalty box is the fast
     local backstop: any 429/503/408 a page actually hits gets remembered
     so the *next* page load (not just the current session, since _idx
     resets on every navigation) skips that node too, without waiting for
     the shared list to be updated. */
  const PENALTY_KEY = 'wax_node_penalty_v1';
  const PENALTY_TTL = 10 * 60 * 1000; // 10 min — long enough to skip a hot node, short enough to retry once it cools down

  let _idx = 0;
  const _blockCache = new Map(); // base → { block: number|null, ts: number }

  function _baseOf(url) { return AA_ENDPOINTS.find(ep => url.startsWith(ep)); }
  function _delay(ms)   { return new Promise(r => setTimeout(r, ms)); }

  function _readPenalties() {
    try {
      const raw = localStorage.getItem(PENALTY_KEY);
      if (!raw) return {};
      const map = JSON.parse(raw);
      const now = Date.now();
      let changed = false;
      for (const base in map) {
        if (!(map[base] > now)) { delete map[base]; changed = true; }
      }
      if (changed) localStorage.setItem(PENALTY_KEY, JSON.stringify(map));
      return map;
    } catch { return {}; }
  }

  function _penalize(base) {
    if (!base) return;
    try {
      const map = _readPenalties();
      map[base] = Date.now() + PENALTY_TTL;
      localStorage.setItem(PENALTY_KEY, JSON.stringify(map));
    } catch { /* localStorage unavailable (privacy mode, etc.) — penalty just won't persist */ }
  }

  function _isPenalized(base, penalties) { return !!(penalties || _readPenalties())[base]; }

  /* Preferred endpoint, skipping any currently-penalized node. Walks
     forward from _idx rather than mutating it, so the underlying
     preference order (and aaBases' fan-out) is untouched once a penalty
     expires. */
  function _cur() {
    const n = AA_ENDPOINTS.length;
    const penalties = _readPenalties();
    for (let i = 0; i < n; i++) {
      const cand = AA_ENDPOINTS[(_idx + i) % n];
      if (!_isPenalized(cand, penalties)) return cand;
    }
    return AA_ENDPOINTS[_idx % n]; // everything penalized — use the preferred one anyway
  }

  function _fetchWithTimeout(url, ms) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  function _canRotate(url) {
    return !url.includes('/atomicmarket/') && AA_ENDPOINTS.some(ep => url.startsWith(ep));
  }

  function _swapBase(url) {
    const old = _baseOf(url);
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

  const ROTATE_DEADLINE = 2500; // ms — cap how long picking a healthy node can stall on one hung endpoint;
                                 // _fetchBlockNum keeps running past this and still populates _blockCache for next time

  // Resolves to `block` if it arrives within `ms`, otherwise null — without
  // cancelling the underlying check (it finishes on its own and caches).
  function _withDeadline(promise, ms) {
    return Promise.race([
      promise,
      new Promise(r => setTimeout(() => r(null), ms)),
    ]);
  }

  /* Health-check all endpoints in parallel, pick the highest block_num as
     the reference, and select the first candidate that:
       • is not the endpoint that just failed
       • has a block_num within MAX_BLOCK_GAP of the reference
     If no healthy candidate exists, throw rather than silently use a lagging node. */
  async function _rotateToHealthy(failedUrl) {
    const failedBase = _baseOf(failedUrl);

    const checks = await Promise.all(
      AA_ENDPOINTS.map(async base => ({ base, block: await _withDeadline(_fetchBlockNum(base), ROTATE_DEADLINE) }))
    );

    const maxBlock = Math.max(...checks.map(c => c.block ?? -Infinity));

    if (maxBlock === -Infinity) {
      // Nothing responded at all — simple advance so the real request can fail properly
      _idx = (_idx + 1) % AA_ENDPOINTS.length;
      return _swapBase(failedUrl);
    }

    const blockHealthy = checks.filter(c =>
      c.block !== null &&
      maxBlock - c.block <= MAX_BLOCK_GAP &&
      c.base !== failedBase
    );

    if (blockHealthy.length === 0) {
      throw new Error('No healthy WAX endpoint available');
    }

    // Prefer a candidate that isn't also currently rate-limit-penalized, but
    // fall back to ignoring the penalty rather than throwing — a node that
    // 429'd 10 minutes ago may well be fine again even if the box hasn't expired.
    const penalties = _readPenalties();
    const preferred = blockHealthy.filter(c => !_isPenalized(c.base, penalties));
    const pick = (preferred.length ? preferred : blockHealthy)[0];

    _idx = AA_ENDPOINTS.indexOf(pick.base);
    return _swapBase(failedUrl);
  }

  /* Fetch a WAX AtomicAssets URL, rotating to the next healthy endpoint on 429/503/408.
     atomicmarket URLs can't rotate (only reliable on the official node), so they get
     same-endpoint retries with backoff instead — still resilient to transient hiccups.
     Returns json.data on success; throws on non-retryable errors or no healthy fallback.
     `opts.timeout` overrides the market timeout for callers who know a specific query
     is unusually heavy (e.g. a huge collection_name IN-list) — ignored for rotatable
     (atomicassets) URLs since TIMEOUT is already tuned for those. */
  async function apiFetch(url, opts) {
    let cur = url;
    const rotatable   = _canRotate(url);
    const maxAttempts = rotatable ? AA_ENDPOINTS.length : MARKET_RETRIES;
    for (let i = 0; i < maxAttempts; i++) {
      if (!rotatable) _recordMarketRequest();
      let res;
      try {
        res = await _fetchWithTimeout(cur, rotatable ? TIMEOUT : (opts?.timeout || MARKET_TIMEOUT));
      } catch (err) {
        if (i === maxAttempts - 1) throw err;
        if (rotatable) { _penalize(_baseOf(cur)); cur = await _rotateToHealthy(cur); await _delay(300); }
        else await _delay(400 * (i + 1));
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        if (!json.success) throw new Error('API error');
        return json.data;
      }
      if (RETRY.has(res.status) && i < maxAttempts - 1) {
        if (rotatable) { _penalize(_baseOf(cur)); cur = await _rotateToHealthy(cur); await _delay(i === 0 ? 300 : 600); }
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
      if (!rotatable) _recordMarketRequest();
      let res;
      try {
        res = await _fetchWithTimeout(cur, rotatable ? TIMEOUT : MARKET_TIMEOUT);
      } catch (err) {
        if (i === maxAttempts - 1) throw err;
        if (rotatable) { _penalize(_baseOf(cur)); cur = await _rotateToHealthy(cur); await _delay(300); }
        else await _delay(400 * (i + 1));
        continue;
      }
      if (!RETRY.has(res.status) || i === maxAttempts - 1) return res;
      if (rotatable) { _penalize(_baseOf(cur)); cur = await _rotateToHealthy(cur); await _delay(i === 0 ? 300 : 600); }
      else await _delay(400 * (i + 1));
    }
  }

  /* Base URL helpers — always reflect the current (possibly rotated) endpoint. */
  function aaBase()     { return _cur() + '/atomicassets/v1'; }
  function marketBase() { return 'https://wax.api.atomicassets.io/atomicmarket/v1'; }

  /* Best-effort: a caller that pinned itself to one node for consistency
     (e.g. explore.html's paginated collection search) and found that node
     unusable calls this to move the shared preferred node elsewhere, using
     the same health-based selection apiFetch's automatic rotation uses.
     Returns the new aaBase()-equivalent URL (same path suffix as the one
     passed in), or null if no healthy alternative could be found. */
  async function rotateAwayFrom(url) {
    try { return await _rotateToHealthy(url); } catch { return null; }
  }

  /* Returns `count` distinct AtomicAssets base URLs (atomicassets/v1),
     starting from the current preferred endpoint and wrapping through the
     pool. Lets a batch of independent parallel calls fan out across
     multiple nodes instead of serializing on one origin's browser
     connection limit (~6 concurrent per host). */
  function aaBases(count) {
    const n = Math.max(1, Math.min(count, AA_ENDPOINTS.length));
    const penalties = _readPenalties();
    const ordered = [];
    for (let i = 0; i < AA_ENDPOINTS.length; i++) ordered.push(AA_ENDPOINTS[(_idx + i) % AA_ENDPOINTS.length]);
    const ranked = [...ordered.filter(ep => !_isPenalized(ep, penalties)), ...ordered.filter(ep => _isPenalized(ep, penalties))];
    return ranked.slice(0, n).map(ep => ep + '/atomicassets/v1');
  }

  /* ── Shared endpoint list, read-only from the site's side ──
     A row in Supabase (public.wax_endpoint_health) holds the current
     endpoint list, kept fresh by an external health-check agent (not this
     codebase). Every page load reads it (cheap, one row) and REPLACES
     AA_ENDPOINTS with it wholesale — both membership and order. The site
     never writes to this table: adding/removing/reordering endpoints is
     managed entirely in Supabase, no code change or deploy needed. Any
     failure here (table not created yet, Supabase unreachable, this page
     not loading supabase-config.js, etc.) is silent — the hardcoded
     bootstrap list above is used for that page load instead. */
  function _applyOrder(order) {
    if (!Array.isArray(order) || !order.length) return; // malformed/empty row — keep current list
    AA_ENDPOINTS.length = 0;
    AA_ENDPOINTS.push(...order);
    _idx = 0;
  }

  async function _syncEndpointOrder() {
    // supabase-config.js declares these with `const`, so — unlike `var` —
    // they never become window properties. Only a bare reference sees them.
    const url = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : null;
    const key = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : null;
    if (!url || !key) return; // this page doesn't load supabase-config.js — skip silently
    const headers = { apikey: key, Authorization: 'Bearer ' + key };

    try {
      const res = await fetch(url + '/rest/v1/wax_endpoint_health?id=eq.1&select=endpoint_order', { headers });
      if (!res.ok) return; // table not created yet, or unreachable — keep the built-in list
      const rows = await res.json();
      const row = rows && rows[0];
      if (!row) return;
      _applyOrder(row.endpoint_order);
    } catch {} // any failure — the page keeps working with whatever list it already has
  }

  // Deferred so it never delays this page's own first request: by the time
  // this fires, every synchronous <script> on the page (including
  // supabase-config.js, regardless of tag order) has already run.
  if (typeof window !== 'undefined') setTimeout(_syncEndpointOrder, 0);

  window.WaxApi = { apiFetch, rawFetch, aaBase, aaBases, marketBase, rotateAwayFrom, getMarketBudget };
})();

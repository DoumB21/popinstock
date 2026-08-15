'use strict';
/* Pack detection + actions for the "Unpack" feature (inventory.html's per-
   card menu, asset.html's Unpack button, unpack.html). Two completely
   separate mechanisms exist in the wild, with no way to detect one from the
   other's data:

   1. Custom "unpack_url"-shaped attribute (older/off-chain packs) — the
      asset's own merged AtomicAssets `data` already has everything needed,
      no network call required. See resolveUnpackUrl(). Relocated here from
      inventory.html/asset.html, which duplicated it verbatim — this is now
      the single home for "how do we know an asset is an openable pack."

   2. The official AtomicPacks contract (atomicpacksx) — no attribute on the
      asset at all; pack-ness can only be determined by checking the
      atomicpacksx::packs table for a matching pack_template_id. Confirmed
      live on-chain and against two real user-signed transactions:
        a. Unbox:  atomicassets::transfer(from, to: atomicpacksx,
                    asset_ids: [id], memo: "unbox") — triggers atomicpacksx
                    to request randomness from orng.wax.
        b. Wait:   usually 2-5s for the oracle callback, not always reliable
                    (a real pack sat unboxed 3+ months without resolving).
        c. Claim:  atomicpacksx::claimunboxed(pack_asset_id, origin_roll_ids).
                    origin_roll_ids is NOT looked up anywhere — it's just
                    [0..roll_counter-1], built from the pack's own
                    definition (confirmed: a roll_counter:1 pack's claim
                    used origin_roll_ids:[0]).

   unboxpacks (one row per unboxed-but-unclaimed pack) has a secondary index
   on unboxer, confirmed working live — that's what fetchUnclaimedPacks uses,
   always live, never cached, since it's the "what do I need to claim right
   now" signal.

   The packs table ALSO has a secondary index on pack_template_id, which
   looks like the natural way to check "is this one template a pack" — but
   confirmed live on a real large wallet (10,674 assets / 3,517 distinct
   templates) that doing one indexed lookup per distinct owned template
   would mean thousands of individual chain RPC calls, on the order of
   minutes. Since the packs table itself is a fixed cost regardless of
   wallet size (~13k rows, paginated in parallel by pack_id range below —
   confirmed ~1s/1000-row page), pulling the WHOLE table once and doing
   lookups against an in-memory Map is cheaper for any wallet with more than
   a handful of distinct templates, and only a little more than one lookup
   would've cost for a small wallet. Cached 30 min in localStorage (not
   indefinitely — unlike a single row, the SET of registered packs grows as
   new ones launch) and shared in-memory for the rest of the page's
   lifetime via _registryPromise, so every lookup after the first page load
   is free. */
(function () {
  // Same key every other page already reads/writes for its own chain RPC
  // calls (token-transfer.html, profile.html's Balances/RAM tabs,
  // gift-claim.html) and what src/wax-auth.js's WharfKit session uses for
  // its own endpoint — staying consistent means a user's RPC choice in
  // Settings applies here too. No existing shared multi-node pool/rotation
  // (unlike wax-api.js's AtomicAssets one) exists for chain RPC anywhere in
  // this codebase, and building one is overkill for one feature — just a
  // small fallback list tried in order if the primary fails.
  const CHAIN_RPC_FALLBACKS = [
    'https://wax.greymass.com',
    'https://api.waxsweden.org',
    'https://wax.eosdac.io',
  ];

  function _chainRpcBase() {
    return localStorage.getItem('hoardio_rpc_endpoint') || CHAIN_RPC_FALLBACKS[0];
  }

  async function _getTableRows(params) {
    const primary = _chainRpcBase();
    const bases = [primary].concat(CHAIN_RPC_FALLBACKS.filter(b => b !== primary));
    let lastErr;
    for (const base of bases) {
      try {
        const res = await fetch(base + '/v1/chain/get_table_rows', {
          method: 'POST',
          body: JSON.stringify(Object.assign({ json: true }, params)),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('All chain RPC nodes failed');
  }

  /* ── Pack registry (packs table) — whole table, cached 30 min ──
     Keyed both ways (by template_id AND by pack_id) since the two tabs on
     unpack.html need different lookups: the Packs tab starts from owned
     assets (has template_id), the Unclaimed Packs tab starts from
     unboxpacks rows (has only pack_id). byTemplate stores only a pointer
     (the pack_id) rather than a full duplicate row — confirmed live this
     halves the cached payload (~11.6k packs was ~2.9MB storing full rows
     both ways, well within quota but pointless waste). display_data is
     deliberately NOT stored at all — confirmed live it's wildly
     inconsistent in shape across collections (sometimes absent, sometimes
     plain JSON, sometimes nested animation config) and unnecessary anyway:
     the pack's own AtomicAssets asset data (name/img, already fetched
     wherever this is used) is a far more reliable source for display than
     parsing that blob. */
  // v2: bumped to force-invalidate any cache written before the partial-
  // fetch-failure fix above — a v1 cache could be silently missing rows
  // from a page that failed and got cached anyway.
  const REGISTRY_CACHE_KEY = 'hoardio_atomicpacks_registry_v2';
  const REGISTRY_TTL_MS = 30 * 60 * 1000;
  const REGISTRY_PAGE = 1000;

  function _packRow(r) {
    return {
      pack_id: Number(r.pack_id),
      pack_template_id: Number(r.pack_template_id),
      collection_name: r.collection_name,
      roll_counter: Number(r.roll_counter) || 1,
      unlock_time: Number(r.unlock_time) || 0,
    };
  }

  function _readRegistryCache() {
    try {
      const obj = JSON.parse(localStorage.getItem(REGISTRY_CACHE_KEY) || 'null');
      if (obj && obj.fetchedAt && Date.now() - obj.fetchedAt < REGISTRY_TTL_MS && obj.byTemplate && obj.byPackId) return obj;
    } catch { /* corrupt/missing — refetch */ }
    return null;
  }

  function _writeRegistryCache(byTemplate, byPackId) {
    try { localStorage.setItem(REGISTRY_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), byTemplate, byPackId })); } catch { /* storage full/unavailable — just won't persist */ }
  }

  // pack_id is the table's primary key, assigned sequentially — fetch the
  // highest one first so every page can be requested in parallel by pack_id
  // range instead of following `more`/next_key one page at a time
  // (confirmed live: ~1s per 1000-row page: 14 pages in parallel beats 14
  // pages sequential by roughly an order of magnitude).
  //
  // A transient failure on even one of those ~14 parallel pages must NOT
  // silently produce an incomplete registry that then gets cached as if it
  // were the full picture for 30 minutes — confirmed live: this is exactly
  // what made a real, still-on-chain unclaimed pack vanish from the
  // Unclaimed Packs tab (its pack_id happened to fall in the one page that
  // failed). Each page gets a couple of retries before giving up, and if a
  // page is still missing after that, the result is returned for immediate
  // use but deliberately NOT persisted to the cache — the next visit gets a
  // clean refetch instead of repeating the same gap for the rest of the TTL.
  async function _fetchPageWithRetry(params, attempts) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return (await _getTableRows(params)).rows || []; }
      catch (err) { lastErr = err; if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1))); }
    }
    throw lastErr;
  }

  async function _fetchFullRegistry() {
    const head = await _getTableRows({ code: 'atomicpacksx', scope: 'atomicpacksx', table: 'packs', limit: 1, reverse: true });
    const maxId = (head.rows && head.rows[0]) ? Number(head.rows[0].pack_id) : -1;
    const starts = [];
    for (let start = 0; start <= maxId; start += REGISTRY_PAGE) starts.push(start);
    let complete = true;
    const pages = await Promise.all(starts.map(start =>
      _fetchPageWithRetry({
        code: 'atomicpacksx', scope: 'atomicpacksx', table: 'packs',
        lower_bound: start, upper_bound: start + REGISTRY_PAGE - 1, limit: REGISTRY_PAGE,
      }, 3).catch(() => { complete = false; return []; }) // still failed after retries — note it, don't sink the whole registry
    ));
    const byTemplate = {}, byPackId = {};
    for (const rows of pages) {
      for (const r of rows) {
        const row = _packRow(r);
        byPackId[String(row.pack_id)] = row;
        byTemplate[String(row.pack_template_id)] = row.pack_id; // pointer, not a duplicate row
      }
    }
    return { byTemplate, byPackId, complete };
  }

  let _registryPromise = null; // shared in-memory across every lookup this page load

  function _getRegistry() {
    const cached = _readRegistryCache();
    if (cached) return Promise.resolve(cached);
    if (!_registryPromise) {
      _registryPromise = _fetchFullRegistry().then(reg => {
        if (reg.complete) _writeRegistryCache(reg.byTemplate, reg.byPackId);
        return reg;
      }).catch(err => { _registryPromise = null; throw err; });
    }
    return _registryPromise;
  }

  async function lookupPackByTemplateId(templateId) {
    if (templateId == null) return null;
    try {
      const reg = await _getRegistry();
      const packId = reg.byTemplate[String(templateId)];
      return packId != null ? (reg.byPackId[String(packId)] || null) : null;
    } catch { return null; }
  }

  async function lookupPackByPackId(packId) {
    if (packId == null) return null;
    try {
      const reg = await _getRegistry();
      return reg.byPackId[String(packId)] || null;
    } catch { return null; }
  }

  /* ── Unclaimed packs (unboxpacks table) — always live, never cached ── */
  async function fetchUnclaimedPacks(walletAccount) {
    if (!walletAccount) return [];
    let json;
    try {
      json = await _getTableRows({
        code: 'atomicpacksx', scope: 'atomicpacksx', table: 'unboxpacks',
        index_position: 'secondary', key_type: 'i64',
        lower_bound: walletAccount, upper_bound: walletAccount, limit: 100,
      });
    } catch { return []; }
    return (json.rows || []).filter(r => r.unboxer === walletAccount);
  }

  /* ── Action builders ── */
  function buildUnboxAction(walletAccount, packAssetId) {
    return {
      account: 'atomicassets', name: 'transfer',
      authorization: [{ actor: walletAccount, permission: 'active' }],
      data: { from: walletAccount, to: 'atomicpacksx', asset_ids: [String(packAssetId)], memo: 'unbox' },
    };
  }

  function buildClaimAction(walletAccount, packAssetId, rollCounter) {
    const n = Math.max(1, Number(rollCounter) || 1);
    const originRollIds = Array.from({ length: n }, (_, i) => i);
    return {
      account: 'atomicpacksx', name: 'claimunboxed',
      authorization: [{ actor: walletAccount, permission: 'active' }],
      data: { pack_asset_id: String(packAssetId), origin_roll_ids: originRollIds },
    };
  }

  /* ── URL-attribute packs (older/off-chain) ──
     Pack collections don't agree on how they name this custom attribute, OR
     whether the value includes a URL scheme — confirmed live: mlb.topps/packs
     uses key "unpack_url" with value "toppsmlb.com/unpack" (no scheme, which
     window.open() would otherwise resolve relative to the CURRENT page
     instead of navigating away), while tmnt.funko/packs.drop uses key
     "unpack url" (a literal space) with a full https:// URL already. Matches
     the key by normalized shape rather than one fixed name, and always forces
     a scheme onto the value. */
  function resolveUnpackUrl(data) {
    if (!data) return null;
    for (const k in data) {
      if (!/^unpack[\s_-]*url$/i.test(k)) continue;
      const v = String(data[k] || '').trim();
      if (!v) continue;
      return /^https?:\/\//i.test(v) ? v : 'https://' + v;
    }
    return null;
  }

  // Distinct collection_names with at least one registered pack, derived
  // from the same cached registry the two lookups above already share — no
  // extra network call beyond whatever first populated it. Lets a page
  // scope its own owned-asset queries to just these collections instead of
  // scanning a wallet's entire inventory (confirmed live: scanning a large
  // wallet's full inventory to find its packs ran the tab out of memory).
  async function getPackCollections() {
    try {
      const reg = await _getRegistry();
      return [...new Set(Object.values(reg.byPackId).map(r => r.collection_name))];
    } catch { return []; }
  }

  // Distinct pack_template_ids for one collection, derived from the same
  // cached registry — lets a caller cheaply confirm "does this wallet
  // actually own a PACK in this collection" (via an AtomicAssets
  // template_whitelist filter) rather than assuming ownership of anything
  // in a pack-bearing collection means owning a pack specifically.
  async function getPackTemplateIdsByCollection(collectionName) {
    try {
      const reg = await _getRegistry();
      return Object.values(reg.byPackId)
        .filter(r => r.collection_name === collectionName)
        .map(r => r.pack_template_id);
    } catch { return []; }
  }

  /* ── Reading the claimed cards straight off the claim transaction ──
     claimunboxed triggers inline atomicassets::mintasset calls (one per
     rolled result), each of which notifies atomicassets::logmint with the
     new asset_id plus the template's immutable_template_data (name/img/
     etc. as [type,value] pairs) — confirmed live against a real recent
     claimunboxed transaction on-chain.

     WharfKit's SessionKit broadcasts every wallet plugin's signed
     transaction through the SAME session.transact() → send_transaction
     call (confirmed in @wharfkit/session's own source — wallet plugins only
     produce signatures, they don't broadcast), so the resolved
     TransactResult's `.response.processed.action_traces` is the real
     nodeos trace tree, complete with every inline action, regardless of
     which of the 3 supported wallets signed it. That means the claimed
     cards can be read directly from the SAME transact() call that claims
     them — no follow-up indexer query, so no indexing-lag window (this is
     what made "show claimed contents inline" unreliable via AtomicAssets'
     own REST indexer in earlier design discussion; reading the broadcast's
     own trace sidesteps that entirely). */
  function _flattenTraces(traces) {
    const out = [];
    for (const t of traces || []) {
      out.push(t);
      if (t.inline_traces && t.inline_traces.length) out.push(..._flattenTraces(t.inline_traces));
    }
    return out;
  }

  function _traceDataValue(entry) {
    return Array.isArray(entry.value) ? entry.value[1] : entry.value;
  }

  function extractMintedAssets(transactResult) {
    const traces = transactResult?.response?.processed?.action_traces;
    if (!traces) return [];
    const minted = [];
    for (const t of _flattenTraces(traces)) {
      const act = t.act;
      if (!act || act.account !== 'atomicassets' || act.name !== 'logmint') continue;
      const d = act.data || {};
      const fields = {};
      for (const entry of d.immutable_template_data || []) fields[entry.key] = _traceDataValue(entry);
      for (const entry of d.immutable_data || []) if (!(entry.key in fields)) fields[entry.key] = _traceDataValue(entry);
      minted.push({
        asset_id: d.asset_id,
        collection_name: d.collection_name,
        schema_name: d.schema_name,
        template_id: d.template_id,
        name: fields.name || '',
        img: fields.img || fields.image || '',
        video: fields.video || '',
      });
    }
    return minted;
  }

  window.AtomicPacks = {
    resolveUnpackUrl,
    lookupPackByTemplateId,
    lookupPackByPackId,
    fetchUnclaimedPacks,
    getPackCollections,
    getPackTemplateIdsByCollection,
    buildUnboxAction,
    buildClaimAction,
    extractMintedAssets,
  };
})();

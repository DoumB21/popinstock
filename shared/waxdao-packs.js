'use strict';
/* Pack detection + actions for the WAXDAO contract (waxdaomarket) — third
   companion to shared/atomic-packs.js / shared/nefty-packs.js, same public-
   API shape where it applies. The website "WAXDAO" itself is shut down (no
   way to browse/open packs there anymore), but the contract behind it is
   still live on-chain, and its "premint.pack" drops are still fully
   functional — confirmed against 3 real historical opens across the user's
   own theonlineinn boxes (templates 785003, 746158, 686736), all still
   showing live remaining inventory (total_left > 0) in the drops table.

   This is a COMPLETELY different mechanism from AtomicPacks/NeftyBlocks —
   not a "blend" (waxdaomarket also has a real, separate blend system under
   newblend/assertblend/the `blends` table, which was the first, wrong guess
   while reverse-engineering this — a blend_ID matching the site's old
   /unbox/<N> URL turned out to be pure coincidence, an unrelated blend from
   a different collection). The real mechanism:

   1. Registry: the `drops` table, filtered to rows where
      drop_type === "premint.pack". Each such row's `ID` is the drop_id —
      confirmed to be the SAME number as the old site's /unbox/<ID> URL
      (exact match on all 3 real examples checked). `template_id` is the box
      asset's template; `collection` is the real collection slug (this
      table's own field name for it, unlike `blends`/`packs` which both use
      `collection_name`). `other[0]` points at a `premintpools` row holding
      the actual pre-minted reward NFTs, but that pool is never read
      directly here — resolving it is entirely the contract's own job.

   2. Unbox is a SINGLE transaction, fully synchronous — no oracle, no
      second claim signature. atomicassets::transfer(from: user,
      to: waxdaomarket, asset_ids:[pack_asset_id],
      memo: "|unbox|<drop_id>|<nonce>|") — confirmed against 3 real
      historical transactions: the box gets burned AND a real pre-minted
      reward asset gets transferred back, both inline in the SAME
      transaction as the unbox transfer itself. `<nonce>` looks like an
      opaque per-request random number (real observed values: 123905828,
      162707958, 112104126 — all under 1e9, no evident structure); a fresh
      random number is generated per call here, matching that shape.

   Because unbox and reward are the same transaction, there is no
   "unclaimed"/pending state this contract can ever leave a pack in — unlike
   AtomicPacks/NeftyBlocks, nothing here needs an Unclaimed-Packs-style
   recovery path. */
(function () {
  // Same fallback list / localStorage key convention as the other two pack
  // modules — see their own top-of-file notes for why this stays a small
  // per-module copy rather than a shared helper.
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

  /* ── Pack registry (drops table, premint.pack rows only) — whole table,
     cached 30 min. Same byTemplate(pointer)/byDropId(full row) shape as the
     other two modules' registries, same reasoning. The `drops` table is
     small (~2,700 rows max ID as of this writing — a quarter the size of
     the AtomicPacks registry), so this is a 2-3 page fetch, not 13-14. */
  const REGISTRY_CACHE_KEY = 'hoardio_waxdao_registry_v1';
  const REGISTRY_TTL_MS = 30 * 60 * 1000;
  const REGISTRY_PAGE = 1000;

  function _dropRow(r) {
    return {
      drop_id: Number(r.ID),
      template_id: Number(r.template_id),
      collection_name: r.collection, // this table's own field name — NOT collection_name, unlike blends/packs
      unlock_time: Number(r.start_time) || 0, // reused verbatim by buildPackCard's existing "locked" check
    };
  }

  function _readRegistryCache() {
    try {
      const obj = JSON.parse(localStorage.getItem(REGISTRY_CACHE_KEY) || 'null');
      if (obj && obj.fetchedAt && Date.now() - obj.fetchedAt < REGISTRY_TTL_MS && obj.byTemplate && obj.byDropId) return obj;
    } catch { /* corrupt/missing — refetch */ }
    return null;
  }

  function _writeRegistryCache(byTemplate, byDropId) {
    try { localStorage.setItem(REGISTRY_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), byTemplate, byDropId })); } catch { /* storage full/unavailable — just won't persist */ }
  }

  async function _fetchPageWithRetry(params, attempts) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return (await _getTableRows(params)).rows || []; }
      catch (err) { lastErr = err; if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1))); }
    }
    throw lastErr;
  }

  async function _fetchFullRegistry() {
    const head = await _getTableRows({ code: 'waxdaomarket', scope: 'waxdaomarket', table: 'drops', limit: 1, reverse: true });
    const maxId = (head.rows && head.rows[0]) ? Number(head.rows[0].ID) : -1;
    const starts = [];
    for (let start = 0; start <= maxId; start += REGISTRY_PAGE) starts.push(start);
    let complete = true;
    const pages = await Promise.all(starts.map(start =>
      _fetchPageWithRetry({
        code: 'waxdaomarket', scope: 'waxdaomarket', table: 'drops',
        lower_bound: start, upper_bound: start + REGISTRY_PAGE - 1, limit: REGISTRY_PAGE,
      }, 3).catch(() => { complete = false; return []; })
    ));
    const byTemplate = {}, byDropId = {};
    for (const rows of pages) {
      for (const r of rows) {
        if (r.drop_type !== 'premint.pack') continue; // the only drop_type this feature knows how to open
        const row = _dropRow(r);
        if (row.template_id <= 0) continue; // "na"/placeholder templates seen on non-pack drop rows
        byDropId[String(row.drop_id)] = row;
        byTemplate[String(row.template_id)] = row.drop_id; // pointer, not a duplicate row
      }
    }
    return { byTemplate, byDropId, complete };
  }

  let _registryPromise = null;

  function _getRegistry() {
    const cached = _readRegistryCache();
    if (cached) return Promise.resolve(cached);
    if (!_registryPromise) {
      _registryPromise = _fetchFullRegistry().then(reg => {
        if (reg.complete) _writeRegistryCache(reg.byTemplate, reg.byDropId);
        return reg;
      }).catch(err => { _registryPromise = null; throw err; });
    }
    return _registryPromise;
  }

  async function lookupPackByTemplateId(templateId) {
    if (templateId == null) return null;
    try {
      const reg = await _getRegistry();
      const dropId = reg.byTemplate[String(templateId)];
      return dropId != null ? (reg.byDropId[String(dropId)] || null) : null;
    } catch { return null; }
  }

  async function lookupPackByDropId(dropId) {
    if (dropId == null) return null;
    try {
      const reg = await _getRegistry();
      return reg.byDropId[String(dropId)] || null;
    } catch { return null; }
  }

  async function getPackCollections() {
    try {
      const reg = await _getRegistry();
      return [...new Set(Object.values(reg.byDropId).map(r => r.collection_name))];
    } catch { return []; }
  }

  async function getPackTemplateIdsByCollection(collectionName) {
    try {
      const reg = await _getRegistry();
      return Object.values(reg.byDropId)
        .filter(r => r.collection_name === collectionName)
        .map(r => r.template_id);
    } catch { return []; }
  }

  /* ── Action builder ──
     Single action, no separate claim — the burn and the reward transfer both
     happen inline, in the same transaction as this one signature. */
  function buildUnboxAction(walletAccount, packAssetId, dropId) {
    const nonce = Math.floor(Math.random() * 1e9);
    return {
      account: 'atomicassets', name: 'transfer',
      authorization: [{ actor: walletAccount, permission: 'active' }],
      data: { from: walletAccount, to: 'waxdaomarket', asset_ids: [String(packAssetId)], memo: `|unbox|${dropId}|${nonce}|` },
    };
  }

  /* ── Reading the reward asset straight off the unbox transaction's own
     trace — same reasoning as AtomicPacks.extractMintedAssets (WharfKit's
     session.transact() always broadcasts itself regardless of which wallet
     plugin signed, so result.response.processed.action_traces is the real
     trace tree). The reward here is a PRE-EXISTING pooled asset (transferred,
     not minted), so this reads atomicassets::logtransfer rather than
     logmint — same require_recipient-fanout risk applies (a collection's
     notify_accounts can turn one real transfer into several identical trace
     entries), deduped by asset_id for the same reason extractMintedAssets
     dedupes mints. Filtered to from:waxdaomarket/to:walletAccount so the
     INBOUND leg of the same transaction (the box going the other way) is
     never mistaken for a reward. */
  function _flattenTraces(traces) {
    const out = [];
    for (const t of traces || []) {
      out.push(t);
      if (t.inline_traces && t.inline_traces.length) out.push(..._flattenTraces(t.inline_traces));
    }
    return out;
  }

  function extractRewardAssetIds(transactResult, walletAccount) {
    const traces = transactResult?.response?.processed?.action_traces;
    if (!traces) return [];
    const seen = new Set();
    const out = [];
    for (const t of _flattenTraces(traces)) {
      const act = t.act;
      if (!act || act.account !== 'atomicassets' || act.name !== 'logtransfer') continue;
      const d = act.data || {};
      if (d.from !== 'waxdaomarket' || d.to !== walletAccount) continue;
      for (const id of d.asset_ids || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  window.WaxdaoPacks = {
    lookupPackByTemplateId,
    lookupPackByDropId,
    getPackCollections,
    getPackTemplateIdsByCollection,
    buildUnboxAction,
    extractRewardAssetIds,
  };
})();

'use strict';
/* Pack detection + actions for the NeftyBlocks pack contract (neftyblocksp) —
   companion to shared/atomic-packs.js, same public-API shape, so unpack.html
   can treat both providers close to uniformly (each pack entry just carries
   which module built it). The website "NeftyBlocks" itself is shut down, but
   its pack SMART CONTRACT is still live and actively used by real, active
   collections (confirmed live: romanpunksio alone has 3,500+ real pack opens
   across its two packs) — this was previously scoped OUT of the Unpack
   feature on the wrong assumption that the whole mechanism was dead; revisited
   once real usage numbers surfaced.

   Every fact below was confirmed live against the real chain/ABI/history
   before writing any code (same discipline that caught the atomicpacksx
   origin_roll_ids bug — never assume, always verify a real example):

   1. Unbox: atomicassets::transfer(from, to: neftyblocksp, asset_ids:[id],
      memo: "unbox") — IDENTICAL mechanism to AtomicPacks, confirmed via 3
      real recent inbound transfers (including one from bw2vy.wam, the same
      fixture wallet used throughout this feature's testing).

   2. claim_id (the claim action's own primary parameter) IS the pack's own
      asset_id — confirmed by matching two real historical `claim` actions'
      claim_id against the asset_id of their own preceding unbox transfer,
      byte for byte identical in both cases.

   3. roll_indexes (the claim action's other parameter) is a plain 0-indexed
      RANGE over however many entries are in the resolved claimassets row —
      confirmed against two real submitted transactions (roll_indexes
      [0..14] for a 15-entry claim, [0..4] for a 5-entry claim). Unlike
      AtomicPacks' origin_roll_ids, this is NOT a fragile global counter —
      it only needs to match the LENGTH of what's actually resolved, so it's
      safe to derive locally rather than needing a separate lookup, though
      buildClaimAction below still reads the live row rather than trusting a
      caller-supplied count, for the same defense-in-depth reason.

   4. Two-stage resolution, same shape as AtomicPacks' unboxpacks/
      unboxassets pair: `orngjobs` (pending oracle callback, keyed AND
      secondary-indexed by `recipient`) holds a row from the moment of
      Unbox; once the oracle resolves, that row is replaced by a `claimassets`
      row (primary key = claim_id, ALSO secondary-indexed by `recipient`) —
      confirmed live finding bw2vy.wam's own real still-unclaimed pack this
      way (skunkychunks, claim_id 1099923722778, 3 pooled cards waiting).

   5. Unlike AtomicPacks, the claimassets row tells you exactly what you're
      about to receive BEFORE you claim — each `claims[]` entry is a
      {claim: [VARIANT_TYPE, {...}], is_claimed} pair. The two variants that
      matter here: POOL_NFT_CLAIM {asset_id} — an already-existing asset the
      contract TRANSFERS to you (no minting, no indexing lag, asset_id known
      upfront) — and ON_DEMAND_NFT_CLAIM {template_id} — freshly minted at
      claim time via an inline atomicassets::mintasset, same as every
      AtomicPacks card; its real new asset_id only exists after the claim tx
      broadcasts, same indexing-lag caveat as AtomicPacks. FT_CLAIM (a
      fungible token reward) and EMPTY_CLAIM (nothing — confirmed live via a
      real "Raffle Packet" pack's own description text, which warns openers
      it may contain nothing) also exist as real variants and are decoded
      here, though neither is an NFT card to show in a results grid. */
(function () {
  // Same fallback list / localStorage key convention as shared/atomic-packs.js
  // — kept as its own small copy rather than a shared helper, matching this
  // codebase's existing convention of small per-module helpers over a
  // premature shared abstraction (see atomic-packs.js's own top-of-file note).
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
     Same byTemplate(pointer)/byPackId(full row) shape as atomic-packs.js's
     registry, same reasoning (halves cache payload vs storing full rows
     both ways). pack_template_id <= 0 rows are dropped at the source — the
     same -1-as-"no real template" sentinel confirmed live on atomicpacksx
     turned out to exist here too (this contract has its own void/proxy-pool
     pack concepts per its createvoidpp/createproxyp actions), and no real
     AtomicAssets template can ever be <= 0, so keeping such rows would only
     ever produce guaranteed-zero template_whitelist queries downstream. */
  // v2: bumped to force-invalidate any cache written before this fix — a
  // real user hit a live case (confirmed via their own browser console)
  // where their cached registry was missing a genuine on-chain pack
  // (digitalducks template 544047, pack_id 912) despite it being present in
  // both the raw chain data AND a completely fresh fetch — the exact same
  // class of bug atomic-packs.js's own v1->v2 bump addressed. Root cause
  // not conclusively pinned down (a transient partial-page fetch SHOULD
  // have been caught by the `complete` guard below and never written to
  // localStorage at all, yet their cache clearly lacked this entry) — the
  // version bump sidesteps needing to know exactly how, by guaranteeing
  // every existing cache gets one guaranteed-fresh refetch regardless.
  const REGISTRY_CACHE_KEY = 'hoardio_neftyblocks_registry_v2';
  const REGISTRY_TTL_MS = 30 * 60 * 1000;
  const REGISTRY_PAGE = 1000;

  function _packRow(r) {
    return {
      pack_id: Number(r.pack_id),
      pack_template_id: Number(r.pack_template_id),
      collection_name: r.collection_name,
      recipe_id: Number(r.recipe_id),
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

  async function _fetchPageWithRetry(params, attempts) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return (await _getTableRows(params)).rows || []; }
      catch (err) { lastErr = err; if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1))); }
    }
    throw lastErr;
  }

  async function _fetchFullRegistry() {
    const head = await _getTableRows({ code: 'neftyblocksp', scope: 'neftyblocksp', table: 'packs', limit: 1, reverse: true });
    const maxId = (head.rows && head.rows[0]) ? Number(head.rows[0].pack_id) : -1;
    const starts = [];
    for (let start = 0; start <= maxId; start += REGISTRY_PAGE) starts.push(start);
    let complete = true;
    const pages = await Promise.all(starts.map(start =>
      _fetchPageWithRetry({
        code: 'neftyblocksp', scope: 'neftyblocksp', table: 'packs',
        lower_bound: start, upper_bound: start + REGISTRY_PAGE - 1, limit: REGISTRY_PAGE,
      }, 3).catch(() => { complete = false; return []; })
    ));
    const byTemplate = {}, byPackId = {};
    for (const rows of pages) {
      for (const r of rows) {
        const row = _packRow(r);
        if (row.pack_template_id <= 0) continue; // see the big comment above
        byPackId[String(row.pack_id)] = row;
        byTemplate[String(row.pack_template_id)] = row.pack_id;
      }
    }
    return { byTemplate, byPackId, complete };
  }

  let _registryPromise = null;

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

  async function getPackCollections() {
    try {
      const reg = await _getRegistry();
      return [...new Set(Object.values(reg.byPackId).map(r => r.collection_name))];
    } catch { return []; }
  }

  async function getPackTemplateIdsByCollection(collectionName) {
    try {
      const reg = await _getRegistry();
      return Object.values(reg.byPackId)
        .filter(r => r.collection_name === collectionName)
        .map(r => r.pack_template_id);
    } catch { return []; }
  }

  /* ── Unclaimed packs, both pre-and-post oracle-resolution ──
     Always live, never cached — same reasoning as AtomicPacks' own
     fetchUnclaimedPacks (this is the "what do I need to claim right now"
     signal). Unlike AtomicPacks (whose unboxpacks row exists across the
     WHOLE unboxed-to-claimed window), NeftyBlocks splits that window across
     two different tables — orngjobs while the oracle roll is still pending,
     claimassets once it's resolved and actually claimable — so both need
     checking to get the full picture. Each entry is tagged `ready` so a
     caller can distinguish "show it, but claiming will need to wait" from
     "show it, Claim will work right now" without a second round-trip. */
  async function fetchUnclaimedEntries(walletAccount) {
    if (!walletAccount) return [];
    const [pendingJson, readyJson] = await Promise.all([
      _getTableRows({
        code: 'neftyblocksp', scope: 'neftyblocksp', table: 'orngjobs',
        index_position: 'secondary', key_type: 'i64',
        lower_bound: walletAccount, upper_bound: walletAccount, limit: 100,
      }).catch(() => ({ rows: [] })),
      _getTableRows({
        code: 'neftyblocksp', scope: 'neftyblocksp', table: 'claimassets',
        index_position: 'secondary', key_type: 'i64',
        lower_bound: walletAccount, upper_bound: walletAccount, limit: 100,
      }).catch(() => ({ rows: [] })),
    ]);
    const pending = (pendingJson.rows || [])
      .filter(r => r.recipient === walletAccount)
      .map(r => ({ pack_asset_id: r.claim_id, collection_name: r.collection_name, ready: false }));
    const ready = (readyJson.rows || [])
      .filter(r => r.recipient === walletAccount)
      .map(r => ({ pack_asset_id: r.claim_id, collection_name: r.collection_name, ready: true, claims: _decodeClaims(r.claims) }));
    return pending.concat(ready);
  }

  /* ── Action builders ── */
  function buildUnboxAction(walletAccount, packAssetId) {
    return {
      account: 'atomicassets', name: 'transfer',
      authorization: [{ actor: walletAccount, permission: 'active' }],
      data: { from: walletAccount, to: 'neftyblocksp', asset_ids: [String(packAssetId)], memo: 'unbox' },
    };
  }

  // Decodes the claimassets row's variant-typed `claims[]` into a flat,
  // page-friendly shape. `claim` on-chain is `[VARIANT_TYPE_NAME, {...}]` —
  // see the big top-of-file comment for what each variant means.
  function _decodeClaims(rawClaims) {
    return (rawClaims || []).map(c => {
      const [kind, data] = c.claim || [];
      const out = { isClaimed: !!c.is_claimed, kind };
      if (kind === 'POOL_NFT_CLAIM') out.asset_id = data.asset_id;
      else if (kind === 'ON_DEMAND_NFT_CLAIM') out.template_id = data.template_id;
      else if (kind === 'FT_CLAIM') { out.collection_name = data.collection_name; out.amount = data.amount; }
      // EMPTY_CLAIM carries no data — out.kind alone is enough to render "nothing this time".
      return out;
    });
  }

  // The claimassets row IS the readiness signal (mirrors AtomicPacks'
  // unboxassets-emptiness check) — absent means the oracle hasn't resolved
  // yet (still sitting in orngjobs). Exported standalone since it's also the
  // correct thing to poll after Unbox, same role as AtomicPacks'
  // fetchOriginRollIds.
  async function fetchClaimRow(packAssetId) {
    const json = await _getTableRows({
      code: 'neftyblocksp', scope: 'neftyblocksp', table: 'claimassets',
      lower_bound: String(packAssetId), upper_bound: String(packAssetId), limit: 1,
    });
    const row = (json.rows || [])[0];
    if (!row) return null;
    return { claim_id: row.claim_id, recipient: row.recipient, recipe_id: row.recipe_id, collection_name: row.collection_name, claims: _decodeClaims(row.claims) };
  }

  async function buildClaimAction(walletAccount, packAssetId) {
    const row = await fetchClaimRow(packAssetId);
    if (!row) throw new Error('Not ready to claim yet — the reveal hasn’t finished. Try again in a moment.');
    const rollIndexes = row.claims.map((c, i) => i).filter(i => !row.claims[i].isClaimed);
    if (!rollIndexes.length) throw new Error('Nothing left to claim on this pack.');
    return {
      account: 'neftyblocksp', name: 'claim',
      authorization: [{ actor: walletAccount, permission: 'active' }],
      data: { claim_id: String(packAssetId), roll_indexes: rollIndexes },
    };
  }

  window.NeftyPacks = {
    lookupPackByTemplateId,
    lookupPackByPackId,
    fetchUnclaimedEntries,
    fetchClaimRow,
    getPackCollections,
    getPackTemplateIdsByCollection,
    buildUnboxAction,
    buildClaimAction,
  };
})();

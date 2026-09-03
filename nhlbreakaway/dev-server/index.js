// NHL Breakaway API — all query/handler logic for this section lives here.
// This file has TWO consumers, both importing/running the exact same code:
//  1. Standalone local dev server (`npm run dev:nhlbreakaway`, reads .env via
//     Node's --env-file flag) — for hand-testing queries against production
//     data without deploying.
//  2. api/[...route].js — the real Vercel serverless function that serves
//     this section to actual site visitors. It imports routeRequest() from
//     here; nothing is duplicated there.
// Both talk to the SAME live production Postgres (hosted on Raff
// Technologies) — there is no separate dev/prod database. `pg` picks up
// PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from process.env automatically
// (Vercel: Project Settings → Environment Variables; local: .env).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PORT = process.env.NHLBREAKAWAY_DEV_PORT || 8877;
const pool = new pg.Pool();

// moments backs the Highlights page (player/set/rarity/series/team filters +
// sort, every request) — add the indexes it needs once at startup rather
// than assuming they already exist. IF NOT EXISTS makes this safe to re-run.
const HIGHLIGHTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_moments_player ON moments (player)`,
  `CREATE INDEX IF NOT EXISTS idx_moments_set_uuid ON moments (set_uuid)`,
  `CREATE INDEX IF NOT EXISTS idx_moments_rarity ON moments (rarity)`,
  `CREATE INDEX IF NOT EXISTS idx_moments_series_label ON moments (series_label)`,
  `CREATE INDEX IF NOT EXISTS idx_moments_team ON moments (team)`,
];
async function ensureHighlightsIndexes() {
  for (const sql of HIGHLIGHTS_INDEXES) await pool.query(sql);
}

// Wallet Look Up scans cards/packs by owner_wallet on every request — neither
// table had any index on that column at all before this (idx_cards_owner is
// on owner_USERNAME, a different column). Functional LOWER() indexes match
// how every wallet-address comparison in this file is actually written (see
// the handoff note's CRITICAL GOTCHA on case-insensitive wallet comparisons).
const WALLET_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_cards_owner_wallet_lower ON cards (LOWER(owner_wallet))`,
  `CREATE INDEX IF NOT EXISTS idx_packs_owner_wallet_lower ON packs (LOWER(owner_wallet))`,
  // Backs the username->wallet reverse lookup (handleWalletResolve) — the
  // table's own PK is wallet_address, nothing indexes username at all yet.
  `CREATE INDEX IF NOT EXISTS idx_wallet_usernames_username_lower ON wallet_usernames (LOWER(username))`,
];
async function ensureWalletIndexes() {
  for (const sql of WALLET_INDEXES) await pool.query(sql);
}

// Collector Leaderboard's core query is a plain GROUP BY owner_wallet, COUNT(*)
// over unburned/non-system cards (optionally joined/filtered further) — a
// partial index scoped to exactly that WHERE clause turns it from a full
// table scan into an index-only scan. Verified live: dropped the unfiltered
// all-time leaderboard query from ~800ms to ~450ms.
const LEADERBOARD_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_cards_owner_moment_unburned ON cards (owner_wallet, moment_uuid) WHERE burned = 0`,
];
async function ensureLeaderboardIndexes() {
  for (const sql of LEADERBOARD_INDEXES) await pool.query(sql);
}

// Same tier order as nhlbreakaway/rarity-order.js's RARITY_ORDER (kept in
// sync by hand — this file runs under plain Node, not a browser, so it can't
// just <script src> that module). Used to sort the Rarity column/dropdown by
// game tier instead of alphabetically.
const RARITY_ORDER = ['Core', 'Fandom', 'Rare', 'Limited', 'Legendary', 'Epic', 'Heroic', 'Mythic'];
function rarityRankSqlCase(column) {
  const whens = RARITY_ORDER.map((r, i) => `WHEN ${column} = '${r}' THEN ${i}`).join(' ');
  return `CASE ${whens} ELSE ${RARITY_ORDER.length} END`;
}

// Two confirmed system wallets, DIFFERENT roles — do not lump them together
// (real bug, fixed 2026-08-26; the original single-bucket "In Packs" version
// of this formula is gone). Verified against nhlbreakaway.com's own
// Collectible Stats block on 2 independent moments (exact count matches on
// every bucket below, not approximate):
//   role = 'pack_escrow'         = genuine pack inventory
//   role = 'crafting_processing' = crafting-turn-in processing, NOT pack
//     inventory — despite the old generic "Secondary" label, its unburned
//     holdings must never be counted as "In Packs"
// Joined by system_wallets.role — never a hardcoded address. This dev-server
// isn't the authoritative owner of these wallets (that's the sibling "NHL
// Breakaway" project's scripts/seed-system-wallets.js); it only reads
// whatever role that seed already assigned.
//
// Corrected 5-way split (confirmed exhaustive 2026-08-26 — zero cards rows
// in the whole table have burned=1 with a burned_by_wallet that doesn't
// match one of these two roles, so there's no missing 6th "genuine holder
// burn" bucket to worry about for THIS project's data, unlike the sibling
// handoff note's general warning):
//   Distributed              = burned=0, owner has no system_wallets match at all
//   In Packs                 = burned=0, owner's role = 'pack_escrow'
//   Other                    = burned=0, owner's role = 'crafting_processing',
//                               AND crafting_turn_in is NOT 1 (exact meaning of
//                               "Other" beyond "not pack inventory" still
//                               unconfirmed — asked on the NHL Breakaway
//                               Discord, no answer yet, so labeled generically
//                               on purpose)
//   Used for Crafting        = (burned=1, burned_by's role = 'crafting_processing')
//                               OR (burned=0, owner's role = 'crafting_processing',
//                               AND crafting_turn_in = 1)
//   Removed from Circulation = burned=1, burned_by's role = 'pack_escrow'
//   Holders                  = COUNT(DISTINCT owner_wallet), same scope as Distributed
//
// Fixed 2026-08-26: Other was overcounting — Sweet marks a card "Used for
// Crafting" the moment it's submitted/locked into the crafting process
// (crafting_turn_in: true on Sweet's side), BEFORE the actual on-chain burn
// executes. Originally only `burned` was checked, so a card mid-crafting sat
// in "Other" until its burn landed on-chain. `cards.crafting_turn_in`
// (0/1/NULL) is synced for every card currently held unburned by the
// crafting_processing wallet — confirmed 23,028 of 43,108 "Other" cards were
// actually already mid-crafting. COALESCE(crafting_turn_in, 0) treats NULL
// (not synced / not applicable) the same as 0 (not yet submitted).
//
// CAVEAT carried over from the last fix, still true after this one: on
// roughly a quarter of moments, the In Packs/Other split itself diverges
// from Sweet's own numbers for reasons that couldn't be found in any public
// data (spot-checked multiple cards live — completely identical fields, no
// distinguishing signal). Don't expect exact parity with Sweet's official
// counts on every moment even after this fix.
// All 5 percentages are a fraction of EDITIONS (the catalog cap), matching
// the pre-existing In Packs %/Holders % convention — never of Distributed.
// Distributed/the split buckets are NEVER derived by subtracting from
// Editions — a moment can have zero cards rows at all if unminted (the "895"
// case). Cards are scoped to a set via moments (cards.moment_uuid ->
// moments.moment_uuid -> moments.series_label/set_name), not cards' own
// denormalized columns. Wallet comparisons stay case-insensitive (LOWER())
// per the handoff's CRITICAL GOTCHA.
// NOTE: this formula is Sets-specific — Packs pages need a different one
// (Distributed = Opened + Collected), don't reuse this there.
const SYSTEM_WALLET_OWNER_JOIN = `LEFT JOIN system_wallets sw ON LOWER(sw.wallet_address) = LOWER(c.owner_wallet)`;
const SYSTEM_WALLET_BURNER_JOIN = `LEFT JOIN system_wallets bw ON LOWER(bw.wallet_address) = LOWER(c.burned_by_wallet)`;

// dead_moments holds catalog entries confirmed dead (never resolve on
// Sweet's own API, zero real cards — some are exact-duplicate phantoms of a
// real moment, e.g. "Hometown History: Chicago Blackhawks" had 5 rows
// instead of the real 3). Any query that lists individual `moments` rows
// directly (Highlights, its filter dropdowns, a single-moment lookup) must
// exclude them explicitly. The Sets page doesn't need this — it aggregates
// through `collections.template_count`/a cards join, which a phantom moment
// with zero real cards doesn't affect.
const DEAD_MOMENTS_EXCLUSION = `moment_uuid NOT IN (SELECT moment_uuid FROM dead_moments)`;

const SETS_SQL = `
  SELECT
    col.set_uuid,
    col.collection_key,
    col.series_label,
    col.set_name,
    col.rarity,
    col.template_count AS moments,
    col.total_supply AS editions,
    ed.editions_live_sum,
    COALESCE(agg.distributed, 0) AS distributed,
    COALESCE(agg.in_packs, 0) AS in_packs,
    COALESCE(agg.other, 0) AS other,
    COALESCE(agg.used_for_crafting, 0) AS used_for_crafting,
    COALESCE(agg.removed_from_circulation, 0) AS removed_from_circulation,
    COALESCE(agg.holders, 0) AS holders
  FROM collections col
  LEFT JOIN (
    -- Scoped by set_uuid (== collection_key), NOT (series_label, set_name) —
    -- a collections row can share its set_name with sibling rarities/players
    -- (themed sets like "Hometown History: Detroit Red Wings" give each
    -- player+rarity combo its own distinct set_uuid), so grouping by the
    -- label alone summed every sibling's cards into one shared number. Also
    -- excludes dead_moments — a phantom duplicate sharing a real moment's
    -- set_uuid would otherwise inflate this row's stats right back up.
    SELECT
      m.set_uuid,
      COUNT(*) FILTER (WHERE c.burned = 0 AND sw.wallet_address IS NULL) AS distributed,
      COUNT(*) FILTER (WHERE c.burned = 0 AND sw.role = 'pack_escrow') AS in_packs,
      COUNT(*) FILTER (WHERE c.burned = 0 AND sw.role = 'crafting_processing' AND COALESCE(c.crafting_turn_in, 0) = 0) AS other,
      COUNT(*) FILTER (WHERE
        (c.burned = 1 AND bw.role = 'crafting_processing')
        OR (c.burned = 0 AND sw.role = 'crafting_processing' AND c.crafting_turn_in = 1)
      ) AS used_for_crafting,
      COUNT(*) FILTER (WHERE c.burned = 1 AND bw.role = 'pack_escrow') AS removed_from_circulation,
      COUNT(DISTINCT c.owner_wallet) FILTER (WHERE c.burned = 0 AND sw.wallet_address IS NULL) AS holders
    FROM cards c
    JOIN moments m ON c.moment_uuid = m.moment_uuid
    ${SYSTEM_WALLET_OWNER_JOIN}
    ${SYSTEM_WALLET_BURNER_JOIN}
    WHERE m.${DEAD_MOMENTS_EXCLUSION}
    GROUP BY m.set_uuid
  ) agg ON agg.set_uuid = col.set_uuid
  LEFT JOIN (
    -- Live sum of each moment's own displayed edition count (its cap, or a
    -- live COUNT(*) of cards for an uncapped/growing one — same per-moment
    -- rule the Highlights page uses), summed per set_uuid. Only actually
    -- needed when col.total_supply IS NULL (an uncapped collection, e.g. the
    -- "Signature X" sets — confirmed every one of their moments also has
    -- total_editions IS NULL), so the grid can show a live "X+" instead of a
    -- bare dash for those rows; harmless to compute for capped sets too
    -- (it just reproduces total_supply there).
    SELECT
      m.set_uuid,
      SUM(
        CASE WHEN m.total_editions IS NULL
             THEN (SELECT COUNT(*) FROM cards c WHERE c.moment_uuid = m.moment_uuid)
             ELSE m.total_editions
        END
      ) AS editions_live_sum
    FROM moments m
    WHERE m.${DEAD_MOMENTS_EXCLUSION}
    GROUP BY m.set_uuid
  ) ed ON ed.set_uuid = col.set_uuid
  ORDER BY col.series_label, col.set_name
`;

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 100; // two decimal places
}

// Packs use a DIFFERENT formula than Sets/Highlights (see SETS_SQL's own
// closing note above) — packs mint progressively over time rather than
// having their full total_editions cap already minted up front, so
// Distributed here is never derived from total_editions the way it can't be
// for cards either, but for a different reason: it's simply every row that
// currently exists in the `packs` table (Opened + Collected), per the
// handoff note's explicit "VERIFIED QUERY FORMULAS / Per-pack stats" section.
//   Moments   = pack_moments.highlights_in_pack (stored)
//   Opened    = COUNT(*) WHERE burned = 1 (opening a pack burns/consumes it)
//   Collected = COUNT(*) WHERE burned = 0 AND owner not a system wallet
//   Distributed = Opened + Collected
//   % Left = Collected / Distributed
// pack_moments has no dead-row/dedup problem the way moments/collections do
// (one row per pack_uuid, confirmed zero duplicate (series_label, pack_name,
// rarity) groups) — no DEAD_MOMENTS_EXCLUSION-equivalent needed here.
// A pack held unburned by the pack_escrow system wallet (3 rows total,
// campaign-wide — presumably still queued for distribution) is excluded from
// Collected the same way system-held cards are excluded from Sets'
// Distributed, per the system_wallets join convention.
const PACKS_SQL = `
  SELECT
    pm.pack_uuid,
    pm.series_label,
    pm.pack_name,
    pm.rarity,
    pm.highlights_in_pack AS moments,
    pm.total_editions AS editions,
    COALESCE(agg.opened, 0) AS opened,
    COALESCE(agg.collected, 0) AS collected
  FROM pack_moments pm
  LEFT JOIN (
    SELECT
      p.pack_uuid,
      COUNT(*) FILTER (WHERE p.burned = 1) AS opened,
      COUNT(*) FILTER (WHERE p.burned = 0 AND sw.wallet_address IS NULL) AS collected
    FROM packs p
    LEFT JOIN system_wallets sw ON LOWER(sw.wallet_address) = LOWER(p.owner_wallet)
    GROUP BY p.pack_uuid
  ) agg ON agg.pack_uuid = pm.pack_uuid
  ORDER BY pm.series_label, pm.pack_name
`;

async function handlePacks(res) {
  const { rows } = await pool.query(PACKS_SQL);
  const packs = rows.map(row => {
    const editions = row.editions === null ? null : Number(row.editions);
    const opened = Number(row.opened);
    const collected = Number(row.collected);
    const distributed = opened + collected;
    return {
      pack_uuid: row.pack_uuid,
      series_label: row.series_label,
      pack_name: row.pack_name,
      rarity: row.rarity,
      moments: row.moments,
      editions,
      // Only meaningful when `editions` is null (4 uncapped pack designs,
      // same "growing" concept as Sets/Highlights' editions_live_sum) — the
      // live distributed-so-far total doubles as the cap display, since for
      // an uncapped pack "how many editions exist" and "how many have been
      // distributed" are the same live number.
      editions_live_sum: distributed,
      opened,
      opened_pct: pct(opened, editions),
      collected,
      collected_pct: pct(collected, editions),
      distributed,
      pct_left: pct(collected, distributed),
    };
  });
  // Same shape/cost as handleSets' aggregation, same reasoning for caching.
  sendJson(res, 200, { packs }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

async function handleSets(res) {
  const { rows } = await pool.query(SETS_SQL);
  const sets = rows.map(row => {
    const editions = row.editions === null ? null : Number(row.editions);
    const distributed = row.distributed === null ? null : Number(row.distributed);
    const inPacks = Number(row.in_packs);
    const other = Number(row.other);
    const usedForCrafting = Number(row.used_for_crafting);
    const removedFromCirculation = Number(row.removed_from_circulation);
    const holders = Number(row.holders);
    return {
      set_uuid: row.set_uuid,
      collection_key: row.collection_key,
      series_label: row.series_label,
      set_name: row.set_name,
      rarity: row.rarity,
      moments: row.moments,
      editions,
      // Only meaningful when `editions` is null (uncapped) — the live sum of
      // every one of this set_uuid's moments' own displayed edition counts
      // (see the `ed` subquery's comment above). The frontend renders it as
      // "X+" in place of the bare dash it'd otherwise show.
      editions_live_sum: row.editions_live_sum === null ? null : Number(row.editions_live_sum),
      distributed,
      in_packs: inPacks,
      in_packs_pct: pct(inPacks, editions),
      other,
      other_pct: pct(other, editions),
      used_for_crafting: usedForCrafting,
      used_for_crafting_pct: pct(usedForCrafting, editions),
      removed_from_circulation: removedFromCirculation,
      removed_from_circulation_pct: pct(removedFromCirculation, editions),
      holders,
      holders_pct: pct(holders, editions),
    };
  });
  // Full aggregation over all 1.14M cards rows on every call, ~7-12s
  // uncached — cache it, since this result is identical for every visitor
  // and only actually changes when the data-refresh pipeline runs.
  sendJson(res, 200, { sets }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Wallet Look Up. Ethereum/Polygon addresses have no existence check the way
// a WAX account name does (any 0x + 40 hex string is syntactically valid
// whether or not it ever held anything) — a wallet with zero cards/packs is
// a normal, valid result here, not an error. Format validation (the 0x+40-hex
// shape) happens client-side before the request is even made; this endpoint
// just normalizes case and queries.
function normalizeWallet(w) {
  return (w || '').trim().toLowerCase();
}

const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// People don't know/type raw 0x addresses — Wallet Look Up's search box also
// accepts a Sweet username, resolved against wallet_usernames (wallet_address
// PK, username, updated_at — a periodic cache, NOT exhaustive; per the
// project_nhlbreakaway_highlights_holders memory's Holders-page note, the
// username-resolve pass is paused and plenty of real wallets have no cached
// username at all). The frontend calls this once before every other wallet
// endpoint and uses whatever wallet_address comes back for the rest.
async function handleWalletResolve(url, res) {
  const raw = (url.searchParams.get('q') || '').trim();
  if (!raw) return sendJson(res, 400, { error: 'q required' });

  // favorite_team/display_name/avatar_url come from a separate enrichment
  // pass (NHL Breakaway project's scripts/backfill-wallet-profiles.js, added
  // 2026-08-27) over the same wallet_usernames table — a wallet whose
  // username was resolved before that pass ran (or that hasn't reached the
  // front of the backfill queue yet, ~25k wallets at 2 req/300ms ≈ an hour)
  // will have these as null until then. favorite_team is a team abbreviation
  // ("DET") — matches teams.abbreviation exactly, joined here for the full
  // name/logo. This is what nhlbreakaway.com's own profile page shows as
  // "___ Fan" ("Fan Club").
  const PROFILE_COLUMNS = `wu.favorite_team, wu.display_name, wu.avatar_url,
         t.team_name AS favorite_team_name, t.logo_url AS favorite_team_logo_url`;
  const PROFILE_JOIN = `LEFT JOIN teams t ON t.abbreviation = wu.favorite_team`;

  if (WALLET_ADDRESS_RE.test(raw)) {
    // A syntactically valid address is always a valid lookup target, whether
    // or not it happens to have a cached username — same behavior as before
    // this feature existed. The username here is purely for display.
    const { rows } = await pool.query(
      `SELECT wu.username, ${PROFILE_COLUMNS}
       FROM wallet_usernames wu
       ${PROFILE_JOIN}
       WHERE LOWER(wu.wallet_address) = LOWER($1)`,
      [raw]
    );
    const r = rows[0] || {};
    return sendJson(res, 200, {
      wallet_address: normalizeWallet(raw),
      username: r.username || null,
      display_name: r.display_name || null,
      avatar_url: r.avatar_url || null,
      favorite_team: r.favorite_team || null,
      favorite_team_name: r.favorite_team_name || null,
      favorite_team_logo_url: r.favorite_team_logo_url || null,
    }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
  }

  // Not address-shaped — must resolve as a username. Case-insensitive exact
  // match (confirmed zero case-insensitive duplicate usernames in this table).
  const { rows } = await pool.query(
    `SELECT wu.wallet_address, wu.username, ${PROFILE_COLUMNS}
     FROM wallet_usernames wu
     ${PROFILE_JOIN}
     WHERE LOWER(wu.username) = LOWER($1)`,
    [raw]
  );
  if (!rows.length) return sendJson(res, 404, { error: 'not found' });
  const r = rows[0];
  sendJson(res, 200, {
    wallet_address: normalizeWallet(r.wallet_address),
    username: r.username,
    display_name: r.display_name || null,
    avatar_url: r.avatar_url || null,
    favorite_team: r.favorite_team || null,
    favorite_team_name: r.favorite_team_name || null,
    favorite_team_logo_url: r.favorite_team_logo_url || null,
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Type-ahead suggestions for the Wallet Look Up search box. A partial 0x
// string matches by address prefix; anything else matches by username
// (prefix matches ranked ahead of mid-string matches, same as any normal
// autocomplete). No ILIKE — LOWER()/LIKE only, per the handoff's dialect
// note (Turso migration ahead), same rule handleHoldersEditions follows.
async function handleWalletSuggest(url, res) {
  const raw = (url.searchParams.get('q') || '').trim();
  if (raw.length < 2) return sendJson(res, 200, { suggestions: [] });

  let rows;
  if (raw.startsWith('0x')) {
    ({ rows } = await pool.query(
      `SELECT wallet_address, username FROM wallet_usernames
       WHERE LOWER(wallet_address) LIKE LOWER($1) || '%'
       ORDER BY wallet_address ASC
       LIMIT 8`,
      [raw]
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT wallet_address, username,
         CASE WHEN LOWER(username) LIKE LOWER($1) || '%' THEN 0 ELSE 1 END AS rank
       FROM wallet_usernames
       WHERE LOWER(username) LIKE '%' || LOWER($1) || '%'
       ORDER BY rank ASC, username ASC
       LIMIT 8`,
      [raw]
    ));
  }
  sendJson(res, 200, {
    suggestions: rows.map(r => ({ wallet_address: normalizeWallet(r.wallet_address), username: r.username })),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

async function handleWalletSummary(url, res) {
  const wallet = normalizeWallet(url.searchParams.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });
  const [cardsRes, packsRes, badgesRes] = await Promise.all([
    // sets_represented counts distinct moments.set_uuid (== collections.set_uuid,
    // see collection_key note in SETS_SQL) directly off the owned cards' own
    // moments join — no separate collections lookup needed for a plain count.
    pool.query(
      `SELECT COUNT(*) AS cards_held, COUNT(DISTINCT c.moment_uuid) AS moments_held, COUNT(DISTINCT m.set_uuid) AS sets_represented
       FROM cards c
       JOIN moments m ON m.moment_uuid = c.moment_uuid
       WHERE LOWER(c.owner_wallet) = $1 AND c.burned = 0`,
      [wallet]
    ),
    pool.query(`SELECT COUNT(*) AS packs_held FROM packs WHERE LOWER(owner_wallet) = $1 AND burned = 0`, [wallet]),
    // Wallet-wide counts of the same 3 per-edition badges holders.html
    // computes client-side per moment (EDITION_BADGES) — #1 Edition, Perfect
    // Edition, Jersey Match Edition. Perfect Edition on an uncapped/growing
    // moment (total_editions IS NULL) falls back to that moment's own
    // CURRENT max edition (same rule as holders.html's HEADER.current_max_edition)
    // — the inner MAX(...) subquery only runs for that CASE branch, so it's
    // skipped entirely for the vast majority of (capped) rows.
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.edition_number = 1) AS first_edition_count,
         COUNT(*) FILTER (WHERE c.edition_number = CASE
           WHEN m.total_editions IS NOT NULL THEN m.total_editions
           ELSE (SELECT MAX(c3.edition_number) FROM cards c3 WHERE c3.moment_uuid = c.moment_uuid)
         END) AS perfect_edition_count,
         COUNT(*) FILTER (WHERE m.jersey_number IS NOT NULL AND c.edition_number = m.jersey_number) AS jersey_match_count
       FROM cards c
       JOIN moments m ON m.moment_uuid = c.moment_uuid
       WHERE LOWER(c.owner_wallet) = $1 AND c.burned = 0`,
      [wallet]
    ),
  ]);
  const c = cardsRes.rows[0];
  const b = badgesRes.rows[0];
  sendJson(res, 200, {
    wallet,
    cards_held: Number(c.cards_held),
    moments_held: Number(c.moments_held),
    sets_represented: Number(c.sets_represented),
    packs_held: Number(packsRes.rows[0].packs_held),
    badges: {
      first_edition: Number(b.first_edition_count),
      perfect_edition: Number(b.perfect_edition_count),
      jersey_match: Number(b.jersey_match_count),
    },
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

async function handleWalletSets(url, res) {
  const wallet = normalizeWallet(url.searchParams.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });
  // Scoped by set_uuid, not (series_label, set_name) — same rule as SETS_SQL
  // (see project_nhlbreakaway_sets_formula Gotcha #6): a set_name can back
  // several collections rows for themed sets, so grouping by the label alone
  // would silently sum sibling collections' owned counts together.
  // moments_total comes from minted_template_count, not template_count — a
  // highlight Sweet hasn't minted any editions of yet can never be owned by
  // anyone, so counting it in the denominator would cap this set below 100%
  // forever. minted_template_count excludes those (see lib/db.js's collections
  // schema comment) and is recomputed every build-collections.js run, so a
  // set starts counting a highlight the first time it's actually minted.
  const { rows } = await pool.query(
    `SELECT col.set_uuid, col.collection_key, col.series_label, col.set_name, col.rarity, col.minted_template_count AS moments_total,
       COUNT(DISTINCT c.moment_uuid) AS moments_owned,
       COUNT(*) AS cards_owned
     FROM cards c
     JOIN moments m ON m.moment_uuid = c.moment_uuid
     JOIN collections col ON col.set_uuid = m.set_uuid
     WHERE LOWER(c.owner_wallet) = $1 AND c.burned = 0
     GROUP BY col.set_uuid, col.collection_key, col.series_label, col.set_name, col.rarity, col.minted_template_count
     ORDER BY col.series_label, col.set_name`,
    [wallet]
  );
  const sets = rows.map(r => {
    const momentsTotal = r.moments_total === null ? null : Number(r.moments_total);
    const momentsOwned = Number(r.moments_owned);
    return {
      set_uuid: r.set_uuid,
      collection_key: r.collection_key,
      series_label: r.series_label,
      set_name: r.set_name,
      rarity: r.rarity,
      moments_total: momentsTotal,
      moments_owned: momentsOwned,
      cards_owned: Number(r.cards_owned),
      pct_complete: pct(momentsOwned, momentsTotal),
    };
  });
  sendJson(res, 200, { sets }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Edition Rankings — user-facing name; the underlying table/endpoints keep
// their original "mint_rankings"/"mint-rankings" names (this project has no
// concept of "mint" at all — every card attribute is an "edition", so the
// display label was renamed sitewide, but the DB table/route names weren't).
// Precomputed by a STANDALONE script in the sibling NHL Breakaway project
// (`npm run build-mint-rankings`), NOT part of this dev-server's own
// refresh/index logic. See the handoff note's "MINT RANKINGS" section for
// the full schema/formula — this file only reads the table, never computes
// rating/rank itself. One row per (collection_key, wallet_address,
// set_number) — a wallet owning N complete sets of a collection gets N
// independently-ranked rows (set_number 1 = its best/lowest-edition set), by
// explicit product decision, not a bug.
async function handleMintRankings(url, res) {
  const q = url.searchParams;
  const collectionKey = q.get('collection_key');
  if (!collectionKey) return sendJson(res, 400, { error: 'collection_key required' });

  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);

  const [{ rows: collRows }, { rows: maxRows }, { rows }] = await Promise.all([
    pool.query(
      `SELECT series_label, set_name, rarity, image_url, template_count FROM collections WHERE collection_key = $1`,
      [collectionKey]
    ),
    // MAX(computed_at) rather than trusting the first page's row — this
    // table is populated by a standalone, not-yet-scheduled script (see the
    // handoff note), so surfacing exactly when it last ran matters more here
    // than on the hourly-refreshed Sets/Highlights pages.
    pool.query(`SELECT MAX(computed_at) AS computed_at FROM mint_rankings WHERE collection_key = $1`, [collectionKey]),
    pool.query(
      `SELECT wallet_address, owner_username, set_number, total_complete_sets, set_size, sum_of_editions, avg_edition, total_assets, rating, rank,
         COUNT(*) OVER() AS total_count
       FROM mint_rankings
       WHERE collection_key = $1
       ORDER BY rank ASC
       LIMIT $2 OFFSET $3`,
      [collectionKey, limit + 1, offset]
    ),
  ]);
  if (!collRows.length) return sendJson(res, 404, { error: 'collection not found' });

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const total = pageRows.length ? Number(pageRows[0].total_count) : 0;
  sendJson(res, 200, {
    collection: collRows[0],
    computed_at: maxRows[0].computed_at,
    total,
    has_more: hasMore,
    rankings: pageRows.map(r => ({
      wallet_address: r.wallet_address,
      owner_username: r.owner_username,
      set_number: r.set_number,
      total_complete_sets: r.total_complete_sets,
      set_size: r.set_size,
      sum_of_editions: r.sum_of_editions,
      avg_edition: Number(r.avg_edition),
      total_assets: r.total_assets,
      rating: Number(r.rating),
      rank: r.rank,
    })),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Which collections actually have Edition Rankings data — 73 of 93 as of the
// first build (a collection needs at least one wallet holding a full set to
// produce any rows at all). Backs the Sets page's conditional "Edition
// Rankings" link and this page's own set-picker, so neither ever points at a
// collection with zero rows.
async function handleMintRankingsCollections(res) {
  const { rows } = await pool.query(`SELECT DISTINCT collection_key FROM mint_rankings`);
  // mint_rankings is a precompute-batch table, refreshed even less often
  // than the live cards data — very safe to cache.
  sendJson(res, 200, { collection_keys: rows.map(r => r.collection_key) }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// The landing state (no set picked yet) shows a "Top 5 best" teaser instead
// of a bare hint — the best rank-1 row of every collection, ordered by
// rating, so it surfaces the single most impressive complete set in the
// whole game first. Scoped to rank = 1 (each collection's own best) rather
// than a plain "ORDER BY rating DESC LIMIT 5" over the whole table, so one
// collection's several complete-set rows for the same whale (see the
// handoff's "a wallet CAN hold multiple top ranks" design) can't crowd out
// every other collection's own best entry.
async function handleMintRankingsTop(url, res) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 5, 1), 20);
  const { rows } = await pool.query(
    // set_size >= 10 excludes small/themed collections (several "Hometown
    // History: ..." sets are just 1-2 cards) where a perfect rating 100 is
    // trivial to hit with almost no real difficulty — verified live that an
    // unfiltered "ORDER BY rating DESC" was completely dominated by 1-card
    // ties, not genuinely impressive multi-card completions. 10 is an
    // explicit, user-chosen cutoff (an initial 50+ cutoff was tried first
    // but only ever had 3 qualifying collections in the whole game — too
    // strict to reliably fill 5 slots; 10+ has 44 qualifying collections).
    `SELECT mr.wallet_address, mr.owner_username, mr.rating, mr.avg_edition, mr.sum_of_editions, mr.set_size, mr.total_complete_sets,
       col.collection_key, col.series_label, col.set_name, col.rarity, col.image_url
     FROM mint_rankings mr
     JOIN collections col ON col.collection_key = mr.collection_key
     WHERE mr.rank = 1 AND mr.set_size >= 10
     ORDER BY mr.rating DESC
     LIMIT $1`,
    [limit]
  );
  sendJson(res, 200, {
    top: rows.map(r => ({
      wallet_address: r.wallet_address,
      owner_username: r.owner_username,
      rating: Number(r.rating),
      avg_edition: Number(r.avg_edition),
      sum_of_editions: r.sum_of_editions,
      set_size: r.set_size,
      total_complete_sets: r.total_complete_sets,
      collection_key: r.collection_key,
      series_label: r.series_label,
      set_name: r.set_name,
      rarity: r.rarity,
      image_url: r.image_url,
    })),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Expands one specific ranked row's `editions_used` JSON (moment_uuid/
// edition_number/total_editions per card in that exact complete set) with
// display metadata — player/team/rarity — joined fresh from `moments` rather
// than denormalized into mint_rankings itself (per the handoff note). Kept
// as its own on-demand endpoint (only called when a leaderboard row is
// expanded) rather than joined into handleMintRankings for every row, since
// a set can run to 100+ cards and most rows are never expanded.
async function handleMintRankingsExpand(url, res) {
  const q = url.searchParams;
  const collectionKey = q.get('collection_key');
  const wallet = normalizeWallet(q.get('wallet'));
  const setNumber = parseInt(q.get('set_number'), 10);
  if (!collectionKey || !wallet || !Number.isInteger(setNumber)) {
    return sendJson(res, 400, { error: 'collection_key, wallet, and set_number required' });
  }
  const { rows } = await pool.query(
    `SELECT editions_used FROM mint_rankings WHERE collection_key = $1 AND LOWER(wallet_address) = $2 AND set_number = $3`,
    [collectionKey, wallet, setNumber]
  );
  if (!rows.length) return sendJson(res, 404, { error: 'not found' });

  const editionsUsed = JSON.parse(rows[0].editions_used);
  const momentUuids = editionsUsed.map(e => e.moment_uuid);
  const { rows: momentRows } = await pool.query(
    `SELECT m.moment_uuid, m.player, m.team, m.rarity, t.logo_url AS team_logo_url
     FROM moments m
     LEFT JOIN teams t ON t.team_name = m.team
     WHERE m.moment_uuid = ANY($1::text[])`,
    [momentUuids]
  );
  const byUuid = new Map(momentRows.map(r => [r.moment_uuid, r]));
  const cards = editionsUsed
    .map(e => {
      const m = byUuid.get(e.moment_uuid) || {};
      return {
        moment_uuid: e.moment_uuid,
        edition_number: e.edition_number,
        total_editions: e.total_editions,
        player: m.player || null,
        team: m.team || null,
        team_logo_url: m.team_logo_url || null,
        rarity: m.rarity || null,
      };
    })
    .sort((a, b) => (a.player || '').localeCompare(b.player || ''));
  sendJson(res, 200, { cards }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// One wallet's own complete sets across EVERY collection — backs a section
// on the Wallet Look Up page (total_complete_sets/set_number are already
// computed for free, per the handoff's "suggested shape"). Small result set
// (a handful of rows per wallet even for a heavy collector), so no
// pagination needed, unlike the per-collection leaderboard above.
async function handleWalletMintRankings(url, res) {
  const wallet = normalizeWallet(url.searchParams.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });
  const [{ rows }, { rows: maxRows }] = await Promise.all([
    pool.query(
      `SELECT mr.collection_key, mr.set_number, mr.total_complete_sets, mr.set_size, mr.sum_of_editions, mr.avg_edition, mr.total_assets, mr.rating, mr.rank,
         col.series_label, col.set_name, col.rarity
       FROM mint_rankings mr
       JOIN collections col ON col.collection_key = mr.collection_key
       WHERE LOWER(mr.wallet_address) = $1
       ORDER BY col.series_label, col.set_name, mr.set_number ASC`,
      [wallet]
    ),
    // Same "when did this last run" caveat as the per-collection leaderboard
    // — the whole table is one standalone batch job, so a wallet's own
    // freshness matches the table's overall MAX(computed_at), not a per-row
    // value (every row from one run shares essentially the same timestamp).
    pool.query(`SELECT MAX(computed_at) AS computed_at FROM mint_rankings WHERE LOWER(wallet_address) = $1`, [wallet]),
  ]);
  sendJson(res, 200, {
    computed_at: maxRows[0].computed_at,
    sets: rows.map(r => ({
      collection_key: r.collection_key,
      series_label: r.series_label,
      set_name: r.set_name,
      rarity: r.rarity,
      set_number: r.set_number,
      total_complete_sets: r.total_complete_sets,
      set_size: r.set_size,
      sum_of_editions: r.sum_of_editions,
      avg_edition: Number(r.avg_edition),
      total_assets: r.total_assets,
      rating: Number(r.rating),
      rank: r.rank,
    })),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Backs Wallet Look Up's "Activity" tab. sweet_transaction_history has no
// wallet_address column at all (see NHL_BREAKAWAY_DATA_HANDOFF.txt's own
// SWEET TRANSACTION HISTORY section) — only whichever username/raw-address
// string Sweet's API returned — so a wallet must be resolved to its
// username FIRST via wallet_usernames, then matched against from_username/
// to_username. A wallet with no cached username has no way to be matched
// here at all; this returns a clean empty result (not an error) for that
// case, same "no username = no data for this feature" limitation the
// handoff note describes.
//
// Resolves each transaction to its exact card/pack via token_uri (the
// SPECIFIC edition, PK on both `cards` and `packs`) — NOT series_id, which
// is shared across every moment in a collapsed set (e.g. all 32 Ice Nation
// player templates share one series_id) and would return an arbitrary/wrong
// player for those. Verified against the live table: 754,331/754,573 rows
// (99.97%) exact-match cards.token_uri or packs.token_uri, never both — see
// NHL_BREAKAWAY_DATA_HANDOFF.txt's "token_uri gotcha" for the full story
// (an earlier version of that doc, and this code, wrongly joined series_id
// instead). The ~0.03% miss on both sides is a known small gap (a dead/edge
// token_uri not currently in `cards`), not a bug to chase — it just shows
// as blank item/player fields. `item_name`/`is_pack` in the response tell
// the frontend whether to link into a Highlights moment or a pack design.
// A raw 'purchase' row records BOTH sides of one sale at once (from_username
// = seller, to_username = buyer, amount = the sale price) — Sweet's API has
// no separate 'sale' transaction_type at the source (confirmed in
// NHL_BREAKAWAY_DATA_HANDOFF.txt's "Top spenders / Top sellers" note: a
// wallet's purchase is logically the other wallet's sale, same row).
// Relative to the wallet being viewed, the SAME row is a real purchase
// (money out) when this wallet is the buyer, and a sale (money in) when
// this wallet is the seller — always derive it this way, never trust the
// raw literal type value for display. Positional $1 assumes username is
// always the first param pushed in buildActivityWhere below.
const ACTIVITY_EFFECTIVE_TYPE_SQL = `CASE
       WHEN s.transaction_type = 'purchase' AND s.from_username = $1 THEN 'sale'
       WHEN s.transaction_type = 'purchase' AND s.to_username = $1 THEN 'purchase'
       ELSE s.transaction_type END`;
const WALLET_ACTIVITY_TYPES = new Set(['purchase', 'sale', 'trade', 'gift', 'pack_open', 'promo', 'transfer']);
const WALLET_ACTIVITY_SORT_COLUMNS = {
  date: 's.transaction_datetime',
  amount: 's.amount',
};

// Shared by handleWalletActivity and handleWalletActivitySummary — same
// filter set applies to both the row-level and aggregated views.
function buildActivityWhere(q, username) {
  const where = ['(s.from_username = $1 OR s.to_username = $1)'];
  const params = [username];
  const typeFilter = q.get('type');
  if (typeFilter === 'purchase') {
    where.push(`(s.transaction_type = 'purchase' AND s.to_username = $1)`);
  } else if (typeFilter === 'sale') {
    where.push(`(s.transaction_type = 'purchase' AND s.from_username = $1)`);
  } else if (WALLET_ACTIVITY_TYPES.has(typeFilter)) {
    params.push(typeFilter);
    where.push(`s.transaction_type = $${params.length}`);
  }
  const addEqFilter = (col, val) => {
    if (!val) return;
    params.push(val);
    where.push(`${col} = $${params.length}`);
  };
  addEqFilter('COALESCE(c.series_label, p.series_label)', q.get('series_label'));
  addEqFilter('COALESCE(c.set_name, p.pack_name)', q.get('set_name'));
  addEqFilter('COALESCE(c.rarity, p.rarity)', q.get('rarity'));
  const minAmount = parseFloat(q.get('min_amount'));
  const maxAmount = parseFloat(q.get('max_amount'));
  if (Number.isFinite(minAmount)) { params.push(minAmount); where.push(`s.amount >= $${params.length}`); }
  if (Number.isFinite(maxAmount)) { params.push(maxAmount); where.push(`s.amount <= $${params.length}`); }
  const walletSearch = (q.get('wallet_search') || '').trim();
  if (walletSearch) {
    params.push(`%${walletSearch.toLowerCase()}%`);
    where.push(`(LOWER(s.from_username) LIKE $${params.length} OR LOWER(s.to_username) LIKE $${params.length})`);
  }
  const playerSearch = (q.get('player') || '').trim();
  if (playerSearch) {
    // c.player only (not p.* — packs have no player), so this naturally
    // excludes pack rows, same as filtering by a player would imply.
    params.push(`%${playerSearch.toLowerCase()}%`);
    where.push(`LOWER(c.player) LIKE $${params.length}`);
  }
  return { where, params };
}

async function resolveWalletUsername(wallet) {
  const { rows } = await pool.query(
    `SELECT username FROM wallet_usernames WHERE LOWER(wallet_address) = $1`,
    [wallet]
  );
  return rows[0]?.username || null;
}

async function handleWalletActivity(url, res) {
  const q = url.searchParams;
  const wallet = normalizeWallet(q.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });

  const username = await resolveWalletUsername(wallet);
  if (!username) {
    // Not an error — this wallet simply has no username Sweet's own API
    // would ever report as a from/to value, so it can't match any row.
    return sendJson(res, 200, { activity: [], total: 0, has_more: false, no_username: true }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
  }

  const { where, params } = buildActivityWhere(q, username);

  const sortKey = WALLET_ACTIVITY_SORT_COLUMNS[q.get('sort')] ? q.get('sort') : 'date';
  const sortSql = WALLET_ACTIVITY_SORT_COLUMNS[sortKey];
  const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
  // amount is NULL for every type except 'purchase' — Postgres's default NULL
  // ordering flips with direction (NULLS FIRST for DESC), which would bury
  // every real purchase amount under a wall of NULLs on the default "amount
  // desc" sort. Same gotcha/fix as Highlights' top_holder column elsewhere
  // in this file. transaction_datetime is never NULL, so this is scoped to
  // amount only.
  const nullsClause = sortKey === 'amount' ? ' NULLS LAST' : '';
  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT ${ACTIVITY_EFFECTIVE_TYPE_SQL} AS transaction_type, s.transaction_datetime, s.edition, s.amount, s.currency,
       s.from_username, s.to_username, s.explorer_url,
       COALESCE(c.set_name, p.pack_name) AS item_name,
       COALESCE(c.series_label, p.series_label) AS series_label,
       COALESCE(c.rarity, p.rarity) AS rarity,
       c.player,
       (p.token_uri IS NOT NULL) AS is_pack,
       COUNT(*) OVER() AS total_count
     FROM sweet_transaction_history s
     LEFT JOIN cards c ON c.token_uri = s.token_uri
     LEFT JOIN packs p ON p.token_uri = s.token_uri
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortSql} ${dir}${nullsClause}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const activity = rows.map(r => ({
    transaction_type: r.transaction_type,
    transaction_datetime: r.transaction_datetime,
    edition: r.edition,
    amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency,
    from_username: r.from_username,
    to_username: r.to_username,
    explorer_url: r.explorer_url,
    item_name: r.item_name,
    series_label: r.series_label,
    rarity: r.rarity,
    player: r.player,
    is_pack: r.is_pack,
  }));
  sendJson(res, 200, { activity, total, has_more: offset + activity.length < total }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Summary view — one row per transaction_type, respecting the same filters
// as handleWalletActivity, GROUP BY at the database rather than aggregating
// a client-visible page of rows (which would silently under-count once
// there's more than one page). `total_amount` is a real SUM, NULL for any
// type that never carries an amount (everything but 'purchase').
async function handleWalletActivitySummary(url, res) {
  const q = url.searchParams;
  const wallet = normalizeWallet(q.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });

  const username = await resolveWalletUsername(wallet);
  if (!username) {
    return sendJson(res, 200, { summary: [], no_username: true }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
  }

  const { where, params } = buildActivityWhere(q, username);
  const { rows } = await pool.query(
    `SELECT ${ACTIVITY_EFFECTIVE_TYPE_SQL} AS transaction_type, COUNT(*) AS count, SUM(s.amount) AS total_amount
     FROM sweet_transaction_history s
     LEFT JOIN cards c ON c.token_uri = s.token_uri
     LEFT JOIN packs p ON p.token_uri = s.token_uri
     WHERE ${where.join(' AND ')}
     GROUP BY 1
     ORDER BY count DESC`,
    params
  );
  const summary = rows.map(r => ({
    transaction_type: r.transaction_type,
    count: Number(r.count),
    total_amount: r.total_amount === null ? null : Number(r.total_amount),
  }));
  sendJson(res, 200, { summary }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Filter dropdown options, scoped to THIS wallet's own activity rows (same
// "don't show a set/rarity the wallet has zero activity in" convention as
// populateSetsFilters()) — not the whole sitewide catalog.
async function handleWalletActivityFilters(url, res) {
  const wallet = normalizeWallet(url.searchParams.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });

  const username = await resolveWalletUsername(wallet);
  if (!username) return sendJson(res, 200, { series: [], sets: [], rarities: [] }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });

  const { rows } = await pool.query(
    `SELECT DISTINCT COALESCE(c.series_label, p.series_label) AS series_label,
       COALESCE(c.set_name, p.pack_name) AS set_name,
       COALESCE(c.rarity, p.rarity) AS rarity
     FROM sweet_transaction_history s
     LEFT JOIN cards c ON c.token_uri = s.token_uri
     LEFT JOIN packs p ON p.token_uri = s.token_uri
     WHERE (s.from_username = $1 OR s.to_username = $1)`,
    [username]
  );
  sendJson(res, 200, {
    series: [...new Set(rows.map(r => r.series_label).filter(Boolean))].sort(),
    sets: [...new Set(rows.map(r => r.set_name).filter(Boolean))].sort(),
    rarities: sortRarities([...new Set(rows.map(r => r.rarity).filter(Boolean))]),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Sitewide, cross-wallet leaderboard for sweet_transaction_history — "who
// spent/sold/traded/opened packs the most," one type at a time (each type
// is a genuinely different metric — count-only for most, count+$ for
// purchase/sale — so this is never an "all types combined" view, unlike
// the per-wallet Activity Summary which shows every type at once).
// groupBy tells the query which side of the row identifies "whose activity
// this is": 'to' (buyer/opener/recipient), 'from' (seller), or 'either'
// (both sides count — a trade/gift/transfer has no single "owner" of the
// event, matching NHL_BREAKAWAY_DATA_HANDOFF.txt's own "Most trades"
// example query, which UNIONs from_username and to_username). 'sale' has
// no raw transaction_type of its own — same 'purchase' row, other side.
const ACTIVITY_LEADERBOARD_TYPES = {
  purchase:  { rawType: 'purchase',  groupBy: 'to',     hasAmount: true },
  sale:      { rawType: 'purchase',  groupBy: 'from',   hasAmount: true },
  trade:     { rawType: 'trade',     groupBy: 'either', hasAmount: false },
  gift:      { rawType: 'gift',      groupBy: 'either', hasAmount: false },
  pack_open: { rawType: 'pack_open', groupBy: 'to',     hasAmount: false },
  promo:     { rawType: 'promo',     groupBy: 'to',     hasAmount: false },
  transfer:  { rawType: 'transfer',  groupBy: 'either', hasAmount: false },
};

// Same filter set as buildActivityWhere, minus the wallet-scoping clause —
// there's no single "viewed wallet" for a sitewide leaderboard.
function buildActivityLeaderboardWhere(q, rawType) {
  const where = ['s.transaction_type = $1'];
  const params = [rawType];
  const addEqFilter = (col, val) => {
    if (!val) return;
    params.push(val);
    where.push(`${col} = $${params.length}`);
  };
  addEqFilter('COALESCE(c.series_label, p.series_label)', q.get('series_label'));
  addEqFilter('COALESCE(c.set_name, p.pack_name)', q.get('set_name'));
  addEqFilter('COALESCE(c.rarity, p.rarity)', q.get('rarity'));
  return { where, params };
}

// Shared by handleActivityLeaderboard and handleActivityLeaderboardRank —
// projects the filtered sweet_transaction_history rows down to one
// (username, amount) row per "side" that counts for this type. 'either'
// (trade/gift/transfer) UNIONs both sides since neither has a single
// "owner" of the event — matches the handoff doc's own "Most trades"
// example query.
function buildActivityLeaderboardFromClause(config, whereSql) {
  const perSideSelect = `
    SELECT s.from_username, s.to_username, s.amount
    FROM sweet_transaction_history s
    LEFT JOIN cards c ON c.token_uri = s.token_uri
    LEFT JOIN packs p ON p.token_uri = s.token_uri
    WHERE ${whereSql}`;
  return config.groupBy === 'either'
    ? `(
        SELECT from_username AS username, amount FROM (${perSideSelect}) t1
        UNION ALL
        SELECT to_username AS username, amount FROM (${perSideSelect}) t2
      ) combined`
    : `(SELECT ${config.groupBy === 'from' ? 'from_username' : 'to_username'} AS username, amount FROM (${perSideSelect}) t) combined`;
}

// Excludes raw 0x-shaped values (no cached username — see the handoff
// doc's own "Top spenders"/"Most trades" example queries, same
// convention) AND the literal brand string "NHL" — confirmed via live
// query that it appears as from_username on ~118K raw 'purchase' rows
// (the platform's own primary-market sales, not a real collector
// reselling), which would otherwise top the Sale leaderboard outright.
// This table has no wallet_address to join system_wallets against
// (unlike every other system-wallet exclusion in this file) — "NHL" is a
// sentinel string Sweet's own API returns for platform-originated events,
// not a real queryable wallet identity, so a direct string check is the
// only option here. Matches the handoff doc's own explicit "NHL"
// exclusion note for promo rows, extended here since the same sentinel
// shows up on purchase rows too.
const ACTIVITY_LEADERBOARD_EXCLUSION = `username !~ '^0x[0-9a-fA-F]{40}$' AND UPPER(username) <> 'NHL'`;

async function handleActivityLeaderboard(url, res) {
  const q = url.searchParams;
  const config = ACTIVITY_LEADERBOARD_TYPES[q.get('type')];
  if (!config) return sendJson(res, 400, { error: 'type required' });

  const { where, params } = buildActivityLeaderboardWhere(q, config.rawType);
  const fromClause = buildActivityLeaderboardFromClause(config, where.join(' AND '));
  const sortKey = (q.get('sort') === 'amount' && config.hasAmount) ? 'total_amount' : 'count';
  const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  params.push(limit + 1, offset);

  const sql = `
    SELECT username, COUNT(*) AS count, SUM(amount) AS total_amount
    FROM ${fromClause}
    WHERE ${ACTIVITY_LEADERBOARD_EXCLUSION}
    GROUP BY username
    ORDER BY ${sortKey} ${dir} NULLS LAST, username ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > limit;
  const leaderboard = rows.slice(0, limit).map(r => ({
    username: r.username,
    count: Number(r.count),
    total_amount: r.total_amount === null ? null : Number(r.total_amount),
  }));
  sendJson(res, 200, { leaderboard, has_more: hasMore }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// "Find a collector" — this wallet's real rank within the CURRENT filtered
// leaderboard, without paging through however many wallets rank ahead of
// it. Reuses the exact same from-clause/exclusion as handleActivityLeaderboard,
// so a rank found here is always consistent with what the paginated list
// would eventually show. Identified by USERNAME, not wallet_address — this
// table has no wallet_address column at all, so a wallet with no cached
// username simply cannot appear here (the caller resolves address ->
// username via /api/wallet/resolve first and shows its own "no username"
// message before ever calling this endpoint).
async function handleActivityLeaderboardRank(url, res) {
  const q = url.searchParams;
  const config = ACTIVITY_LEADERBOARD_TYPES[q.get('type')];
  if (!config) return sendJson(res, 400, { error: 'type required' });
  const username = (q.get('username') || '').trim();
  if (!username) return sendJson(res, 400, { error: 'username required' });

  const { where, params } = buildActivityLeaderboardWhere(q, config.rawType);
  const fromClause = buildActivityLeaderboardFromClause(config, where.join(' AND '));
  const sortKey = (q.get('sort') === 'amount' && config.hasAmount) ? 'total_amount' : 'count';
  params.push(username);

  const sql = `
    WITH agg AS (
      SELECT username, COUNT(*) AS count, SUM(amount) AS total_amount
      FROM ${fromClause}
      WHERE ${ACTIVITY_LEADERBOARD_EXCLUSION}
      GROUP BY username
    )
    SELECT a.username, a.count, a.total_amount,
      (SELECT COUNT(*) FROM agg a2 WHERE a2.${sortKey} > a.${sortKey}) + 1 AS rank
    FROM agg a
    WHERE LOWER(a.username) = LOWER($${params.length})
  `;
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return sendJson(res, 200, { found: false }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
  const r = rows[0];
  sendJson(res, 200, {
    found: true,
    username: r.username,
    count: Number(r.count),
    total_amount: r.total_amount === null ? null : Number(r.total_amount),
    rank: Number(r.rank),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

const WALLET_CARDS_SORT_COLUMNS = {
  player: 'm.player',
  set: 'm.set_name',
  rarity: rarityRankSqlCase('m.rarity'),
  edition: 'c.edition_number',
  team: 'm.team',
};

// "By Count" view (group=count) — one row per highlight instead of one row
// per owned edition, for a wallet holding many duplicates of the same
// highlight (e.g. 13 rows collapsing into 1 row showing "13"). `count` sorts
// by how many are owned; `edition` doesn't apply here (there's no single
// edition per row anymore) so it's replaced with `count` as the new
// "interesting" default sort direction (desc = most-owned first).
const WALLET_CARDS_GROUPED_SORT_COLUMNS = {
  player: 'm.player',
  set: 'm.set_name',
  rarity: rarityRankSqlCase('m.rarity'),
  // COUNT(c.moment_uuid), not COUNT(*) — identical result in the owned-only
  // (INNER JOIN) path below, but the roster/"all"+"missing" ownership path
  // further down LEFT JOINs from moments, where a missing highlight's single
  // placeholder row has every c.* column NULL; COUNT(*) would wrongly count
  // that row as 1 instead of 0.
  count: 'COUNT(c.moment_uuid)',
  team: 'm.team',
};

// "All"/"Missing" ownership — only reachable from the frontend once a Set
// filter is chosen (see wallet.html's cardsOwnershipToggle, hidden until
// cardsState.set_name is set): shows every highlight in that set regardless
// of ownership ("all"), or only the ones this wallet does NOT hold a single
// edition of ("missing"). Sourced from the moments CATALOG via a LEFT JOIN
// to this wallet's cards, unlike the owned-only INNER JOIN the default
// 'owned' mode uses below — always rendered in the grouped/count shape,
// since edition-level detail (edition_number, badges) has no meaning for a
// highlight nobody owns yet.
async function handleWalletCardsRoster(q, wallet, ownership, res) {
  const where = [`m.${DEAD_MOMENTS_EXCLUSION}`];
  const params = [wallet];
  const addFilter = (col, val, ilike) => {
    if (!val) return;
    params.push(ilike ? `%${val.toLowerCase()}%` : val);
    where.push(ilike ? `LOWER(${col}) LIKE $${params.length}` : `${col} = $${params.length}`);
  };
  addFilter('m.player', q.get('player'), true);
  addFilter('m.set_name', q.get('set_name'));
  addFilter('m.rarity', q.get('rarity'));
  addFilter('m.series_label', q.get('series_label'));
  addFilter('m.team', q.get('team'));
  // edition_badges is deliberately NOT applied here — every badge type is
  // defined in terms of an owned edition number, which doesn't exist for a
  // highlight this wallet doesn't hold. The frontend hides that filter
  // whenever ownership isn't 'owned', so this is never reachable from the UI.

  const sortKey = WALLET_CARDS_GROUPED_SORT_COLUMNS[q.get('sort')] ? q.get('sort') : 'player';
  const sortSql = WALLET_CARDS_GROUPED_SORT_COLUMNS[sortKey];
  const dir = q.get('dir') === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  params.push(limit, offset);

  // total_count via COUNT(*) OVER() is evaluated on the HAVING-filtered
  // grouped rows (Postgres runs window functions after GROUP BY/HAVING,
  // before ORDER BY/LIMIT) — so it already reflects the "missing" filter,
  // same one-query-no-second-round-trip trick used throughout this file.
  const havingSql = ownership === 'missing' ? 'HAVING COUNT(c.moment_uuid) = 0' : '';

  const sql = `
    SELECT m.moment_uuid, m.player, m.set_name, m.series_label, m.rarity, m.team, t.logo_url AS team_logo_url,
      COUNT(c.moment_uuid) AS owned_count,
      (ARRAY_AGG(c.edition_number ORDER BY c.edition_number ASC) FILTER (WHERE c.edition_number IS NOT NULL))[1:3] AS lowest_editions,
      COUNT(*) OVER() AS total_count
    FROM moments m
    LEFT JOIN teams t ON t.team_name = m.team
    LEFT JOIN cards c ON c.moment_uuid = m.moment_uuid AND LOWER(c.owner_wallet) = $1 AND c.burned = 0
    WHERE ${where.join(' AND ')}
    GROUP BY m.moment_uuid, m.player, m.set_name, m.series_label, m.rarity, m.team, t.logo_url
    ${havingSql}
    ORDER BY ${sortSql} ${dir}, m.moment_uuid ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const cards = rows.map(r => ({
    moment_uuid: r.moment_uuid,
    player: r.player,
    set_name: r.set_name,
    series_label: r.series_label,
    rarity: r.rarity,
    team: r.team,
    team_logo_url: r.team_logo_url || null,
    owned_count: Number(r.owned_count),
    lowest_editions: r.lowest_editions,
  }));
  sendJson(res, 200, { cards, total, has_more: offset + cards.length < total }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

async function handleWalletCards(url, res) {
  const q = url.searchParams;
  const wallet = normalizeWallet(q.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });
  const ownership = ['all', 'missing'].includes(q.get('ownership')) ? q.get('ownership') : 'owned';
  if (ownership !== 'owned') return handleWalletCardsRoster(q, wallet, ownership, res);
  const grouped = q.get('group') === 'count';

  const where = ['LOWER(c.owner_wallet) = $1', 'c.burned = 0'];
  const params = [wallet];
  const addFilter = (col, val, ilike) => {
    if (!val) return;
    params.push(ilike ? `%${val.toLowerCase()}%` : val);
    where.push(ilike ? `LOWER(${col}) LIKE $${params.length}` : `${col} = $${params.length}`);
  };
  addFilter('m.player', q.get('player'), true);
  addFilter('m.set_name', q.get('set_name'));
  addFilter('m.rarity', q.get('rarity'));
  addFilter('m.series_label', q.get('series_label'));
  addFilter('m.team', q.get('team'));

  // Per-edition computed badges (#1 Edition / Perfect Edition / Jersey Match
  // Edition) — same client-side-computed concept as holders.html's/this
  // page's own WALLET_BADGES summary block, and the identical filter on
  // leaderboard.html (see buildHighlightsSubquery's own comment for why
  // Perfect Edition's COALESCE only pays for its MAX(...) subquery on
  // uncapped/growing moments). A card counts if it qualifies for ANY of the
  // selected types. Applied to the shared `where` before the grouped/
  // ungrouped branch below, so it narrows both view modes identically.
  const editionBadges = parseCsvParam(q.get('edition_badges')).filter(b => EDITION_BADGE_KEYS.has(b));
  if (editionBadges.length) {
    const badgeClauses = [];
    if (editionBadges.includes('first')) badgeClauses.push('c.edition_number = 1');
    if (editionBadges.includes('jersey')) badgeClauses.push('(m.jersey_number IS NOT NULL AND c.edition_number = m.jersey_number)');
    if (editionBadges.includes('perfect')) {
      badgeClauses.push(`c.edition_number = COALESCE(m.total_editions, (SELECT MAX(c2.edition_number) FROM cards c2 WHERE c2.moment_uuid = m.moment_uuid))`);
    }
    where.push(`(${badgeClauses.join(' OR ')})`);
  }

  const sortColumns = grouped ? WALLET_CARDS_GROUPED_SORT_COLUMNS : WALLET_CARDS_SORT_COLUMNS;
  const defaultSort = grouped ? 'count' : 'player';
  const sortKey = sortColumns[q.get('sort')] ? q.get('sort') : defaultSort;
  const sortSql = sortColumns[sortKey];
  const dir = q.get('dir') === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  params.push(limit, offset);

  if (grouped) {
    // One row per moment_uuid — COUNT(*) is how many editions of it this
    // wallet owns, lowest_editions is the 3 lowest edition numbers owned
    // (ARRAY_AGG ordered ascending, sliced to the first 3 — cheap, no
    // separate subquery needed). COUNT(*) OVER() here counts GROUPED rows
    // (evaluated after GROUP BY collapses them), giving the real total
    // number of distinct highlights alongside the page in one query, same
    // "no second round-trip" reasoning as the ungrouped query below.
    const sql = `
      SELECT c.moment_uuid, m.player, m.set_name, m.series_label, m.rarity, m.team, t.logo_url AS team_logo_url,
        COUNT(*) AS owned_count,
        (ARRAY_AGG(c.edition_number ORDER BY c.edition_number ASC))[1:3] AS lowest_editions,
        COUNT(*) OVER() AS total_count
      FROM cards c
      JOIN moments m ON m.moment_uuid = c.moment_uuid
      LEFT JOIN teams t ON t.team_name = m.team
      WHERE ${where.join(' AND ')}
      GROUP BY c.moment_uuid, m.player, m.set_name, m.series_label, m.rarity, m.team, t.logo_url
      ORDER BY ${sortSql} ${dir}, c.moment_uuid ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await pool.query(sql, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    const cards = rows.map(r => ({
      moment_uuid: r.moment_uuid,
      player: r.player,
      set_name: r.set_name,
      series_label: r.series_label,
      rarity: r.rarity,
      team: r.team,
      team_logo_url: r.team_logo_url || null,
      owned_count: Number(r.owned_count),
      lowest_editions: r.lowest_editions,
    }));
    return sendJson(res, 200, { cards, total, has_more: offset + cards.length < total }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
  }

  // COUNT(*) OVER() is evaluated over every row matching WHERE, before
  // LIMIT/OFFSET clip the result set — gives the real total alongside the
  // page in one query, cheaper than a second round-trip. Scoped to a single
  // wallet (never a full-table scan), so this is cheap regardless of size —
  // same reasoning as every other per-wallet query on this page.
  // jersey_number/total_editions/perfect_edition back the "Badges" column on
  // the frontend's "By Edition" view (computeEditionBadges() in wallet.html)
  // — same 3 client-computed badge types as holders.html's own EDITION_BADGES,
  // just evaluated per row here since this table spans many different
  // highlights at once, not one shared moment. perfect_edition is the target
  // edition number a card needs to BE a Perfect Edition (the cap, or on an
  // uncapped/growing moment, that moment's current live max) — computed here
  // rather than pushing the COALESCE logic into the frontend. The inner
  // MAX(...) subquery only runs for the uncapped-moment CASE branch (Postgres
  // short-circuits the untaken branch), so it's skipped for the vast
  // majority of (capped) rows — same lazy-CASE pattern used throughout this
  // file (see handleWalletSummary's own perfect_edition_count).
  const sql = `
    SELECT c.moment_uuid, c.edition_number, m.player, m.set_name, m.series_label, m.rarity, m.team, t.logo_url AS team_logo_url,
      m.jersey_number, m.total_editions,
      CASE WHEN m.total_editions IS NOT NULL THEN m.total_editions
           ELSE (SELECT MAX(c2.edition_number) FROM cards c2 WHERE c2.moment_uuid = c.moment_uuid)
      END AS perfect_edition,
      COUNT(*) OVER() AS total_count
    FROM cards c
    JOIN moments m ON m.moment_uuid = c.moment_uuid
    LEFT JOIN teams t ON t.team_name = m.team
    WHERE ${where.join(' AND ')}
    ORDER BY ${sortSql} ${dir}, c.edition_number ASC, c.moment_uuid ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const cards = rows.map(r => ({
    moment_uuid: r.moment_uuid,
    edition_number: r.edition_number,
    player: r.player,
    set_name: r.set_name,
    series_label: r.series_label,
    rarity: r.rarity,
    team: r.team,
    team_logo_url: r.team_logo_url || null,
    jersey_number: r.jersey_number === null ? null : Number(r.jersey_number),
    total_editions: r.total_editions === null ? null : Number(r.total_editions),
    perfect_edition: r.perfect_edition === null ? null : Number(r.perfect_edition),
  }));
  sendJson(res, 200, { cards, total, has_more: offset + cards.length < total }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

const WALLET_PACKS_SORT_COLUMNS = {
  pack: 'pm.pack_name',
  series: 'pm.series_label',
  rarity: rarityRankSqlCase('pm.rarity'),
  edition: 'p.edition_number',
};

// Sitewide (not wallet-scoped) distinct values, same pattern as
// handleHighlightsFilters — pack_moments is a small design-catalog table
// (one row per pack design, not per owned copy), so this is cheap regardless
// of which wallet is being viewed.
async function handleWalletPacksFilters(res) {
  const [seriesRes, raritiesRes] = await Promise.all([
    pool.query(`SELECT DISTINCT series_label FROM pack_moments WHERE series_label IS NOT NULL ORDER BY series_label`),
    pool.query(`SELECT DISTINCT rarity FROM pack_moments WHERE rarity IS NOT NULL`),
  ]);
  sendJson(res, 200, {
    series: seriesRes.rows.map(r => r.series_label),
    rarities: sortRarities(raritiesRes.rows.map(r => r.rarity)),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

async function handleWalletPacks(url, res) {
  const q = url.searchParams;
  const wallet = normalizeWallet(q.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });

  const where = ['LOWER(p.owner_wallet) = $1', 'p.burned = 0'];
  const params = [wallet];
  const addFilter = (col, val, ilike) => {
    if (!val) return;
    params.push(ilike ? `%${val.toLowerCase()}%` : val);
    where.push(ilike ? `LOWER(${col}) LIKE $${params.length}` : `${col} = $${params.length}`);
  };
  addFilter('pm.pack_name', q.get('pack_name'), true);
  addFilter('pm.series_label', q.get('series_label'));
  addFilter('pm.rarity', q.get('rarity'));

  const sortKey = WALLET_PACKS_SORT_COLUMNS[q.get('sort')] ? q.get('sort') : 'pack';
  const sortSql = WALLET_PACKS_SORT_COLUMNS[sortKey];
  const dir = q.get('dir') === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT p.pack_uuid, p.edition_number, pm.pack_name, pm.series_label, pm.rarity,
       COUNT(*) OVER() AS total_count
     FROM packs p
     JOIN pack_moments pm ON pm.pack_uuid = p.pack_uuid
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortSql} ${dir}, p.edition_number ASC, p.pack_uuid ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const packs = rows.map(r => ({
    pack_uuid: r.pack_uuid,
    edition_number: r.edition_number,
    pack_name: r.pack_name,
    series_label: r.series_label,
    rarity: r.rarity,
  }));
  sendJson(res, 200, { packs, total, has_more: offset + packs.length < total }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

const HIGHLIGHTS_SORT_COLUMNS = {
  player: 'player',
  set: 'set_name',
  rarity: rarityRankSqlCase('rarity'),
  editions: 'editions_display', // the computed column below, not raw total_editions
  holders: 'holders_count',
  in_packs: 'in_packs_count', // sorts by the raw count, not the %, same as every other count/pct pair on this site
  top_holder: 'th_count',
  team: 'team',
};

async function handleHighlights(url, res) {
  const q = url.searchParams;
  const where = [`m.${DEAD_MOMENTS_EXCLUSION}`];
  const params = [];
  const addFilter = (col, val, ilike) => {
    if (!val) return;
    params.push(ilike ? `%${val}%` : val);
    where.push(`${col} ${ilike ? 'ILIKE' : '='} $${params.length}`);
  };
  addFilter('player', q.get('player'), true);
  // The "Set" dropdown filters by name (see handleHighlightsFilters' dedup
  // comment) — not set_uuid, which is one-per-rarity for themed sets and so
  // can't represent "all rows sharing this set name" as a single value.
  addFilter('set_name', q.get('set_name'));
  addFilter('rarity', q.get('rarity'));
  addFilter('series_label', q.get('series_label'));
  addFilter('team', q.get('team'));
  // Deep-link from the Sets page ("?set=<collection_key>") — collection_key
  // is one opaque string, identical on both `collections` and `moments` for
  // the same (series, set, rarity). DEAD_MOMENTS_EXCLUSION above still
  // applies on top of this — it's an independent exclusion, not implied by
  // collection_key alone (the 2 dead Chicago Blackhawks duplicates share
  // their real twin's collection_key).
  addFilter('collection_key', q.get('set'));

  const sortKey = HIGHLIGHTS_SORT_COLUMNS[q.get('sort')] ? q.get('sort') : 'player';
  const sortSql = HIGHLIGHTS_SORT_COLUMNS[sortKey];
  const dir = q.get('dir') === 'desc' ? 'DESC' : 'ASC';
  // th_count is NULL whenever a highlight has no current holder at all (the
  // "—" rows) — Postgres's default NULL ordering flips with direction
  // (NULLS LAST for ASC, NULLS FIRST for DESC), which put those dash rows at
  // the TOP when sorting DESC. Forcing NULLS LAST unconditionally keeps them
  // pinned to the bottom regardless of sort direction. Every other sortable
  // column here is never NULL, so this is scoped to top_holder specifically
  // rather than applied blindly to every sort.
  const nullsClause = sortKey === 'top_holder' ? ' NULLS LAST' : '';

  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Snapshot the filter params before LIMIT/OFFSET are appended below, so the
  // total-count query (run in parallel, see near the bottom of this function)
  // can reuse the exact same WHERE clause without picking up those two extras.
  const filterParams = params.slice();
  // Fetch one extra row instead of relying on the total count to know whether
  // "Load more" should stay available — still cheaper than re-deriving it
  // from `total`/limit/offset arithmetic for no real benefit.
  params.push(limit + 1, offset);
  // total_editions IS NULL means this highlight has no fixed cap — it grows
  // by one every time a collector crafts a new copy (855 such moments,
  // confirmed all in the 6 "Signature X" sets). editions_display live-counts
  // actual cards rows for those instead of showing a bare "—"; the subquery
  // is cheap (indexed on moment_uuid, only ever evaluated for the page's
  // ≤200 rows, same cost class as everything else here). Sorting uses this
  // same computed value (see HIGHLIGHTS_SORT_COLUMNS), not raw total_editions,
  // so a Signature card crafted 400 times sorts near 400, not with the
  // true-zero/unknowns.
  // Holders/In Packs — same role-based split as SETS_SQL/handleHoldersHeader
  // (see the big SYSTEM_WALLET_OWNER_JOIN comment above), just scoped to one
  // moment_uuid per row via correlated subqueries instead of a GROUP BY.
  // Cheap: cards.moment_uuid is indexed (idx_cards_moment) and this only ever
  // runs for the page's ≤200 rows, same cost class as editions_display's own
  // per-row subquery above. In Packs % divides by the CAP (raw
  // total_editions), not editions_display's live substitute — an uncapped/
  // growing moment (total_editions IS NULL) shows a blank "—" for the %,
  // same convention as SETS_SQL leaving in_packs_pct null when the cap itself
  // is null.
  // These 4 columns used to be per-row correlated subqueries/a LATERAL join
  // — "cheap, only evaluated for the page's ≤200 rows" is true when sorting
  // by a plain indexed column (player/set/rarity/team), since Postgres can
  // find the top N rows via the index before ever touching them. But
  // sorting BY one of these computed columns forces Postgres to evaluate it
  // for EVERY row satisfying the filters before it can determine ORDER BY —
  // with ~1,960 moments, that's ~1,960 separate correlated-subquery/LATERAL
  // executions, each its own query plan against `cards` (1.14M rows).
  // Measured live: 14-33 SECONDS sorting by any of these, vs ~4s for a
  // plain-column sort. Fixed by precomputing each as a single GROUP BY pass
  // over `cards` instead (cardAgg/topHolderAgg below), joined once — one
  // sequential/index scan + hash aggregate instead of ~1,960 repeated plans.
  // Verified byte-for-byte identical output against the old per-row version
  // for several sort orders (including a filtered query) before replacing
  // it — this is a real behavior-preserving perf fix, not a rewrite of what
  // gets displayed.
  const cardAgg = `
    SELECT c.moment_uuid,
      COUNT(*) AS total_cards,
      COUNT(DISTINCT c.owner_wallet) FILTER (WHERE c.burned = 0 AND sw.wallet_address IS NULL) AS holders_count,
      COUNT(*) FILTER (WHERE c.burned = 0 AND sw.role = 'pack_escrow') AS in_packs_count
    FROM cards c
    LEFT JOIN system_wallets sw ON LOWER(sw.wallet_address) = LOWER(c.owner_wallet)
    GROUP BY c.moment_uuid`;
  // Top Holder — the single wallet holding the most (unburned, non-system)
  // editions of each highlight. DISTINCT ON picks the top row per moment
  // from a per-(moment, wallet) aggregate, same tie-break (held count desc,
  // then wallet address asc for determinism) as the old LATERAL join.
  const topHolderAgg = `
    SELECT DISTINCT ON (moment_uuid) moment_uuid, owner_wallet, owner_username, owner_name, held_count
    FROM (
      SELECT c.moment_uuid, c.owner_wallet, c.owner_username, c.owner_name, COUNT(*) AS held_count
      FROM cards c
      LEFT JOIN system_wallets sw ON LOWER(sw.wallet_address) = LOWER(c.owner_wallet)
      WHERE c.burned = 0 AND sw.wallet_address IS NULL
      GROUP BY c.moment_uuid, c.owner_wallet, c.owner_username, c.owner_name
    ) per_wallet
    ORDER BY moment_uuid, held_count DESC, owner_wallet ASC`;
  const sql = `
    WITH card_agg AS (${cardAgg}), top_holder_agg AS (${topHolderAgg})
    SELECT m.moment_uuid, m.player, m.set_name, m.set_uuid, m.series_label, m.rarity, m.team, m.total_editions,
      t.logo_url AS team_logo_url,
      CASE WHEN m.total_editions IS NULL
           THEN COALESCE(ca.total_cards, 0)
           ELSE m.total_editions
      END AS editions_display,
      (m.total_editions IS NULL) AS editions_is_growing,
      COALESCE(ca.holders_count, 0) AS holders_count,
      COALESCE(ca.in_packs_count, 0) AS in_packs_count,
      th.owner_wallet AS th_wallet, th.owner_username AS th_username, th.owner_name AS th_name, th.held_count AS th_count
    FROM moments m
    LEFT JOIN teams t ON t.team_name = m.team
    LEFT JOIN card_agg ca ON ca.moment_uuid = m.moment_uuid
    LEFT JOIN top_holder_agg th ON th.moment_uuid = m.moment_uuid
    ${whereSql}
    ORDER BY ${sortSql} ${dir}${nullsClause}, m.moment_uuid ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  // total is the real count of highlights matching the current filters (not
  // the ~1,965-row whole `moments` table) — the frontend shows this instead
  // of "however many rows happen to be loaded so far", which used to always
  // read "100" (the page size) regardless of how many actually matched.
  // `moments` alone is small (~1,965 rows, all filter columns indexed), so
  // this is cheap even run on every request.
  const [{ rows }, totalResult] = await Promise.all([
    pool.query(sql, params),
    pool.query(`SELECT COUNT(*) FROM moments m ${whereSql}`, filterParams),
  ]);
  const total = Number(totalResult.rows[0].count);
  const hasMore = rows.length > limit;
  const highlights = rows.slice(0, limit).map(r => {
    const inPacksCount = Number(r.in_packs_count);
    return {
      moment_uuid: r.moment_uuid,
      player: r.player,
      set_name: r.set_name,
      set_uuid: r.set_uuid,
      series_label: r.series_label,
      rarity: r.rarity,
      team: r.team,
      team_logo_url: r.team_logo_url || null,
      editions: r.editions_display === null ? null : Number(r.editions_display),
      editions_is_growing: r.editions_is_growing,
      holders: Number(r.holders_count),
      in_packs: inPacksCount,
      in_packs_pct: pct(inPacksCount, r.total_editions === null ? null : Number(r.total_editions)),
      // Display fallback chain matches holders.html's own holder rendering
      // exactly: owner_username -> owner_name -> shortened wallet. The link
      // (top_holder_username) is separate and only ever a REAL Sweet
      // username — a wallet address or owner_name isn't a valid
      // nhlbreakaway.com profile slug. Falls back to the FULL address (never
      // shortened) when there's no username/name — a truncated address is
      // useless for anyone trying to actually verify or search for it.
      top_holder: r.th_wallet
        ? (r.th_username || r.th_name || r.th_wallet)
        : null,
      top_holder_username: r.th_username || null,
      top_holder_count: r.th_wallet ? Number(r.th_count) : null,
    };
  });
  // Same reasoning as handleSets/handleLeaderboard: entirely derived from
  // moments/cards/teams (no live Sweet API call, unlike Holders), so it's
  // identical for every visitor with the same filters and only actually
  // changes when the data-refresh pipeline runs.
  sendJson(res, 200, { highlights, has_more: hasMore, total }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

function sortRarities(rarities) {
  return rarities.sort((a, b) => {
    const ai = RARITY_ORDER.indexOf(a);
    const bi = RARITY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

async function handleHighlightsFilters(res) {
  const [seriesRes, setsRes, raritiesRes, teamsRes] = await Promise.all([
    pool.query(`SELECT DISTINCT series_label FROM moments WHERE series_label IS NOT NULL AND ${DEAD_MOMENTS_EXCLUSION} ORDER BY series_label`),
    // Deduplicated by set_name only, NOT set_uuid — a themed set like
    // "Hometown History: Detroit Red Wings" has one set_uuid per rarity (6
    // distinct real rows), so grouping by set_uuid produced 6 duplicate
    // dropdown entries for the one name. Picking this option filters
    // handleHighlights by set_name (all 6 rows), same "one entry in the
    // list, ungrouped rows in the grid" behavior as the Sets page's
    // collection_key deep link.
    pool.query(`SELECT DISTINCT set_name FROM moments WHERE set_name IS NOT NULL AND ${DEAD_MOMENTS_EXCLUSION} ORDER BY set_name`),
    pool.query(`SELECT DISTINCT rarity FROM moments WHERE rarity IS NOT NULL AND ${DEAD_MOMENTS_EXCLUSION}`),
    pool.query(`SELECT DISTINCT team FROM moments WHERE team IS NOT NULL AND team != '' AND ${DEAD_MOMENTS_EXCLUSION} ORDER BY team`),
  ]);
  sendJson(res, 200, {
    series: seriesRes.rows.map(r => r.series_label),
    sets: setsRes.rows.map(r => r.set_name),
    rarities: sortRarities(raritiesRes.rows.map(r => r.rarity)),
    teams: teamsRes.rows.map(r => r.team),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// "Listed" is deliberately NOT stored in our DB — a listing can appear or
// get cancelled independent of our sync cadence (same reasoning as the
// price/sale-history decision in the handoff note), so it's fetched live
// straight from Sweet's own public API, no auth needed. This one live call
// backs BOTH the header's "Listed" count and each edition row's own
// "Listed — $X" indicator, so the two numbers can never disagree with each
// other the way they could if the header pulled from moment_stats_snapshot
// instead (that table can lag; this call is always current).
// Endpoint confirmed by the user directly (not derived/guessed) — the
// public NHL Breakaway handoff note only had the path, not the host.
const SWEET_LISTINGS_TTL_MS = 30_000; // avoid re-hitting Sweet on every Load More click within one viewing session
const _sweetListingsCache = new Map(); // moment_uuid -> { fetchedAt, count, lowestAsk, byEdition: Map<editionNumber, {price_usd, listing_id, status}> }

async function fetchSweetListings(momentUuid) {
  const cached = _sweetListingsCache.get(momentUuid);
  if (cached && Date.now() - cached.fetchedAt < SWEET_LISTINGS_TTL_MS) return cached;

  // sort=price.asc means hits[0] is already the cheapest, but lowestAsk is
  // computed as a real MIN over all hits rather than trusted blindly — cheap
  // insurance against relying on an undocumented API's sort guarantee.
  const url = `https://apigw.sweet.io/catalog/listing/moments?campaign_id=826&scroll=true&limit=100&collapse=false&offers=true&sweet_is_seller=false&offer_type=fixed-price&sort=price.asc&uuid=${encodeURIComponent(momentUuid)}`;
  const byEdition = new Map();
  let count = 0;
  let lowestAsk = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      const hits = Array.isArray(json.hits) ? json.hits : [];
      count = hits.length;
      for (const hit of hits) {
        const editionNumber = hit.attributes && Number(hit.attributes['edition-number']);
        const offer = hit.current_offers && hit.current_offers[0];
        if (!editionNumber || !offer) continue;
        const priceUsd = offer.price_usd != null ? Number(offer.price_usd) : null;
        byEdition.set(editionNumber, {
          price_usd: priceUsd,
          listing_id: offer.listing_id ?? null,
          status: offer.status ?? null,
        });
        if (priceUsd != null && (lowestAsk === null || priceUsd < lowestAsk)) lowestAsk = priceUsd;
      }
    } else {
      console.error(`Sweet listings fetch failed for ${momentUuid}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`Sweet listings fetch failed for ${momentUuid}:`, err.message);
  }
  const entry = { fetchedAt: Date.now(), count, lowestAsk, byEdition };
  _sweetListingsCache.set(momentUuid, entry);
  return entry;
}

// "Frozen" (2026-08-27) — same "don't store, fetch on demand" decision as
// fetchSweetListings above, replacing the old moment_stats_snapshot-backed
// version. That table was refreshed by a NHL Breakaway pipeline script
// (scripts/sync-moment-stats.js) that hit this exact endpoint for EVERY
// moment on every pipeline run (~1,965 calls, ~7min, the single slowest
// phase) just to keep one column fresh here — wasteful when the endpoint is
// public, unauthenticated, and fast enough (~250ms measured) to call live
// per page view instead, same as Listed. moment_stats_snapshot/
// sync-moment-stats.js still exist for their diagnostic cross-check value
// (comparing our wallet-role-derived counts against Sweet's own — see that
// script's header comment) but are no longer part of the routine refresh
// pipeline and nothing here reads that table anymore.
const SWEET_SERIES_STATS_TTL_MS = 30_000;
const _sweetSeriesStatsCache = new Map(); // moment_uuid -> { fetchedAt, frozen }

async function fetchSweetSeriesStats(seriesId, momentUuid) {
  const cached = _sweetSeriesStatsCache.get(momentUuid);
  if (cached && Date.now() - cached.fetchedAt < SWEET_SERIES_STATS_TTL_MS) return cached;

  let frozen = null;
  try {
    const seriesUri = `https://nft.nhlbreakaway.com/series/${seriesId}`;
    const url = `https://apigw.sweet.io/distribution/series/stats/${encodeURIComponent(seriesUri)}/${momentUuid}`;
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      frozen = json.frozen != null ? Number(json.frozen) : null;
    } else {
      console.error(`Sweet series stats fetch failed for ${momentUuid}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`Sweet series stats fetch failed for ${momentUuid}:`, err.message);
  }
  const entry = { fetchedAt: Date.now(), frozen };
  _sweetSeriesStatsCache.set(momentUuid, entry);
  return entry;
}

async function handleHoldersHeader(url, res) {
  const momentUuid = url.searchParams.get('moment_uuid');
  if (!momentUuid) return sendJson(res, 400, { error: 'moment_uuid required' });

  // Needs series_id before the live stats call below can fire, so this one
  // runs first rather than joining the Promise.all — negligible cost (local,
  // indexed, sub-millisecond) next to the ~250ms live Sweet call it gates.
  const { rows } = await pool.query(
    `SELECT m.moment_uuid, m.player, m.set_name, m.set_uuid, m.series_label, m.series_id, m.rarity, m.team, m.play,
            m.total_editions, m.jersey_number, m.sequence_number, t.logo_url AS team_logo_url
     FROM moments m
     LEFT JOIN teams t ON t.team_name = m.team
     WHERE m.moment_uuid = $1 AND m.${DEAD_MOMENTS_EXCLUSION}`,
    [momentUuid]
  );
  if (!rows.length) return sendJson(res, 404, { error: 'not found' });
  const r = rows[0];

  const [{ rows: badgeRows }, { rows: statusRows }, { rows: maxRows }, seriesStats, listings] = await Promise.all([
    // Highlight-level badges (0 to several) — separate from the 3 fixed
    // per-edition badges computed client-side (see EDITION_BADGES in
    // holders.html), which are deliberately NOT stored here since Sweet's API
    // returns those unreliably per-edition.
    pool.query(`SELECT badge_name, badge_image_url FROM moment_badges WHERE moment_uuid = $1`, [momentUuid]),
    // Status breakdown across ALL editions, not just the current page — same
    // 5-way role-based split as SETS_SQL above, just scoped to one moment_uuid
    // instead of grouped by set. Counts real cards rows, which can be fewer
    // than total_editions (the cap) for a not-fully-minted highlight.
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.burned = 0 AND sw.wallet_address IS NULL) AS held,
         COUNT(*) FILTER (WHERE c.burned = 0 AND sw.role = 'pack_escrow') AS in_packs,
         COUNT(*) FILTER (WHERE c.burned = 0 AND sw.role = 'crafting_processing' AND COALESCE(c.crafting_turn_in, 0) = 0) AS other,
         COUNT(*) FILTER (WHERE
           (c.burned = 1 AND bw.role = 'crafting_processing')
           OR (c.burned = 0 AND sw.role = 'crafting_processing' AND c.crafting_turn_in = 1)
         ) AS used_for_crafting,
         COUNT(*) FILTER (WHERE c.burned = 1 AND bw.role = 'pack_escrow') AS removed_from_circulation
       FROM cards c
       ${SYSTEM_WALLET_OWNER_JOIN}
       ${SYSTEM_WALLET_BURNER_JOIN}
       WHERE c.moment_uuid = $1`,
      [momentUuid]
    ),
    // Needed for the Perfect Edition badge on a growing (uncapped) moment —
    // total_editions IS NULL there, so the badge falls back to "whichever
    // edition is currently the highest-numbered", not a fixed cap. Computed
    // here (once, indexed on moment_uuid) rather than client-side from
    // whatever page of editions happens to be loaded — the editions list is
    // paginated 100 at a time, so the true max might not even be on the
    // first page yet for a heavily-crafted moment.
    pool.query(`SELECT MAX(edition_number) AS max_edition FROM cards WHERE moment_uuid = $1`, [momentUuid]),
    fetchSweetSeriesStats(r.series_id, momentUuid),
    fetchSweetListings(momentUuid),
  ]);
  const s = statusRows[0];
  const maxEdition = maxRows[0].max_edition;
  sendJson(res, 200, {
    moment_uuid: r.moment_uuid,
    player: r.player,
    set_name: r.set_name,
    set_uuid: r.set_uuid,
    series_label: r.series_label,
    series_id: r.series_id,
    rarity: r.rarity,
    team: r.team,
    team_logo_url: r.team_logo_url || null,
    play: r.play,
    // Direct video file (not the full card-info page) — moments.sequence_number
    // is a per-moment id of its own, distinct from cards.sequence_number
    // (each edition's individual on-chain token id).
    media_url: r.series_id && r.sequence_number
      ? `https://mediagateway.sweet.io/media/token/${r.series_id}/${r.sequence_number}/video.mp4`
      : null,
    total_editions: r.total_editions === null ? null : Number(r.total_editions),
    jersey_number: r.jersey_number === null ? null : Number(r.jersey_number),
    current_max_edition: maxEdition === null ? null : Number(maxEdition),
    badges: badgeRows.map(b => ({ badge_name: b.badge_name, badge_image_url: b.badge_image_url })),
    status_counts: {
      held: Number(s.held),
      in_packs: Number(s.in_packs),
      other: Number(s.other),
      used_for_crafting: Number(s.used_for_crafting),
      removed_from_circulation: Number(s.removed_from_circulation),
      // frozen: null means the live Sweet call failed this time (see
      // fetchSweetSeriesStats), not a confirmed zero.
      frozen: seriesStats.frozen,
      listed: listings.count,
      listed_lowest_ask: listings.lowestAsk,
    },
  });
}

// Same 5-way split as the per-row status computed below, expressed as SQL
// conditions so the Holders page can filter server-side (pagination is
// server-side too, so a client-side filter over just the loaded page would
// silently miss rows). Keyed by the same status strings the frontend/JSON
// response already use, and only ever looked up through this whitelist —
// the raw ?status= query value is never interpolated into SQL directly.
// "Other" vs "Used for Crafting" also depends on crafting_turn_in now (see
// the big comment above SETS_SQL for the full story) — a crafting_processing-
// held card already submitted/locked into crafting (crafting_turn_in = 1)
// counts as "Used for Crafting" even before its on-chain burn lands, not
// "Other". COALESCE(crafting_turn_in, 0) treats NULL as not-yet-submitted.
const HOLDERS_STATUS_FILTERS = {
  held: `c.burned = 0 AND sw.wallet_address IS NULL`,
  in_packs: `c.burned = 0 AND sw.role = 'pack_escrow'`,
  other: `c.burned = 0 AND sw.role = 'crafting_processing' AND COALESCE(c.crafting_turn_in, 0) = 0`,
  used_for_crafting: `((c.burned = 1 AND bw.role = 'crafting_processing') OR (c.burned = 0 AND sw.role = 'crafting_processing' AND c.crafting_turn_in = 1))`,
  removed_from_circulation: `c.burned = 1 AND bw.role = 'pack_escrow'`,
};

// Same status precedence as HOLDERS_STATUS_FILTERS above, just expressed as
// a numeric rank instead of a WHERE condition, so "sort by Status" groups
// rows in the same order they're categorized in (Held, In Packs, Other,
// Used for Crafting, Removed from Circulation, then the 'burned' fallback).
const HOLDERS_STATUS_RANK_SQL = `(CASE
  WHEN c.burned = 0 AND sw.wallet_address IS NULL THEN 0
  WHEN c.burned = 0 AND sw.role = 'pack_escrow' THEN 1
  WHEN c.burned = 0 AND sw.role = 'crafting_processing' AND COALESCE(c.crafting_turn_in, 0) = 0 THEN 2
  WHEN (c.burned = 1 AND bw.role = 'crafting_processing') OR (c.burned = 0 AND sw.role = 'crafting_processing' AND c.crafting_turn_in = 1) THEN 3
  WHEN c.burned = 1 AND bw.role = 'pack_escrow' THEN 4
  ELSE 5
END)`;

const HOLDERS_SORT_COLUMNS = {
  edition: 'c.edition_number',
  holder: `COALESCE(c.owner_username, c.owner_name, c.owner_wallet)`,
  status: HOLDERS_STATUS_RANK_SQL,
};

// Portable across Postgres and the eventual Turso/SQLite backend — no ILIKE
// (Postgres-only), just LOWER()/LIKE, per the handoff note's dialect warning.
//
// All filters below are combinable (AND'd together), per explicit user
// decision: status tile, "listed" toggle, "edition badges" toggle, holder
// text search, and edition min/max range can all be active at once. Because
// combining filters can no longer guarantee a tiny result set (the old
// "listed"/"edition badges" branches used to skip pagination entirely, since
// each was exclusive and capped at ~40/~3 rows), LIMIT/OFFSET pagination now
// always applies, even when those two are active alone.
async function handleHoldersEditions(url, res) {
  const q = url.searchParams;
  const momentUuid = q.get('moment_uuid');
  if (!momentUuid) return sendJson(res, 400, { error: 'moment_uuid required' });

  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  const sortSql = HOLDERS_SORT_COLUMNS[q.get('sort')] || HOLDERS_SORT_COLUMNS.edition;
  const dir = q.get('dir') === 'desc' ? 'DESC' : 'ASC';

  // Same live Sweet call (cached briefly, see fetchSweetListings) that backs
  // the header's "Listed" count and "Lowest ask" — reused here so a row's
  // own "Listed for $X.XX" pill can never disagree with those header numbers,
  // and so the "listed" toggle below can be expressed as an ordinary
  // edition_number membership condition alongside every other filter.
  const listings = await fetchSweetListings(momentUuid);

  const editionColumns = `c.edition_number, c.owner_username, c.owner_name, c.owner_wallet, c.owned_since,
              c.burned, c.burned_by_wallet, c.burned_at, c.sequence_number, c.crafting_turn_in,
              sw.role AS owner_role,
              bw.role AS burner_role,
              sc.contract_address`;
  const editionJoins = `${SYSTEM_WALLET_OWNER_JOIN}
       ${SYSTEM_WALLET_BURNER_JOIN}
       LEFT JOIN series_contracts sc ON sc.series_id = c.series_id AND sc.asset_type = 'card'`;

  const where = ['c.moment_uuid = $1'];
  const params = [momentUuid];

  const statusFilter = HOLDERS_STATUS_FILTERS[q.get('status')];
  if (statusFilter) where.push(statusFilter);

  if (q.get('listed') === '1') {
    // Not a per-row SQL fact the way the 5 role-based statuses are — it
    // comes entirely from the live Sweet response above, expressed here as
    // an edition_number membership condition so it combines with everything
    // else instead of being its own exclusive branch.
    const editionNumbers = [...listings.byEdition.keys()];
    if (editionNumbers.length === 0) {
      where.push('1 = 0');
    } else {
      params.push(editionNumbers);
      where.push(`c.edition_number = ANY($${params.length}::int[])`);
    }
  }

  const explicitEditions = q.get('editions');
  if (explicitEditions) {
    // Generic "restrict to exactly these edition numbers" filter — used by
    // the Edition Badges toggle (#1/Perfect/Jersey Match), which the CLIENT
    // already computes for free from data it has on hand (edition 1, plus
    // total_editions/current_max_edition/jersey_number from the header
    // response), no extra query needed on this end.
    const editionNumbers = explicitEditions.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (editionNumbers.length === 0) {
      where.push('1 = 0');
    } else {
      params.push(editionNumbers);
      where.push(`c.edition_number = ANY($${params.length}::int[])`);
    }
  }

  const holderSearch = q.get('holder');
  if (holderSearch) {
    params.push(`%${holderSearch.toLowerCase()}%`);
    const idx = params.length;
    where.push(`(LOWER(c.owner_username) LIKE $${idx} OR LOWER(c.owner_name) LIKE $${idx} OR LOWER(c.owner_wallet) LIKE $${idx})`);
  }

  const editionMin = parseInt(q.get('edition_min'), 10);
  if (Number.isInteger(editionMin)) {
    params.push(editionMin);
    where.push(`c.edition_number >= $${params.length}`);
  }
  const editionMax = parseInt(q.get('edition_max'), 10);
  if (Number.isInteger(editionMax)) {
    params.push(editionMax);
    where.push(`c.edition_number <= $${params.length}`);
  }

  params.push(limit + 1, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const result = await pool.query(
    `SELECT ${editionColumns}
     FROM cards c
     ${editionJoins}
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortSql} ${dir}, c.edition_number ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);

  const editions = rows.map(r => {
    // Role-based 5-way split — see SETS_SQL's comment above for the full
    // rationale. 'burned' (no role match on burned_by_wallet) is a defensive
    // fallback only: confirmed empirically that every burned row in this
    // dataset was burned by one of the two system wallets, so this branch
    // isn't expected to actually fire, but a genuine holder-initiated burn
    // shouldn't get silently miscategorized as one of the platform buckets
    // if the data ever changes.
    // "Other" vs "Used for Crafting": a crafting_processing-held unburned
    // card already submitted into crafting (crafting_turn_in === 1) counts
    // as "Used for Crafting" even before its burn lands — see SETS_SQL's
    // comment for the full story (fixed 2026-08-26, was overcounting "Other").
    let status;
    if (r.burned) {
      status = r.burner_role === 'crafting_processing' ? 'used_for_crafting'
        : r.burner_role === 'pack_escrow' ? 'removed_from_circulation'
        : 'burned';
    } else if (r.owner_role === 'crafting_processing' && r.crafting_turn_in === 1) {
      status = 'used_for_crafting';
    } else {
      status = r.owner_role === 'pack_escrow' ? 'in_packs'
        : r.owner_role === 'crafting_processing' ? 'other'
        : 'held';
    }
    // Falls back to the FULL wallet address (never shortened) when there's
    // no username/name — a truncated address can't be verified or searched.
    const holder = status === 'held'
      ? (r.owner_username || r.owner_name || r.owner_wallet)
      : null;
    const isBurnedFamily = status === 'burned' || status === 'used_for_crafting' || status === 'removed_from_circulation';
    return {
      edition_number: r.edition_number,
      status,
      holder,
      // Separate from `holder` (which falls back to owner_name/the full
      // wallet) because only a REAL Sweet username can be linked to
      // nhlbreakaway.com/user/:username — null here means the frontend
      // must render `holder` as plain text, not a link.
      holder_username: status === 'held' ? (r.owner_username || null) : null,
      owned_since: status === 'held' ? r.owned_since : null,
      burned_at: isBurnedFamily ? r.burned_at : null,
      burned_by: isBurnedFamily && r.burned_by_wallet ? r.burned_by_wallet : null,
      polygonscan_url: r.contract_address && r.sequence_number
        ? `https://polygonscan.com/token/${r.contract_address}?a=${r.sequence_number}`
        : null,
      // Ownership-wise this card is still whatever `status` says above (per
      // the handoff note: a listed card is still "Held", not its own status
      // bucket) — this is purely an additional indicator, only meaningful
      // when status === 'held'.
      listed_price_usd: listings.byEdition.get(r.edition_number)?.price_usd ?? null,
    };
  });
  sendJson(res, 200, { editions, has_more: hasMore });
}

// Top Holders — a leaderboard of who holds the most editions of this exact
// highlight, independent of the Editions tab's own filters (status tile,
// Listed, Edition Badges, Holder search, Edition range all apply to the
// per-edition list; this is a separate, always-"held-only" aggregate view).
// One GROUP BY over cards for this moment_uuid, same system-wallet exclusion
// as everywhere else (SYSTEM_WALLET_OWNER_JOIN). Paginated the same
// LIMIT+1 way as every other list endpoint in this file — a heavily-
// distributed moment (Ice Nation, etc.) can have thousands of distinct
// holders.
async function handleHoldersTopHolders(url, res) {
  const q = url.searchParams;
  const momentUuid = q.get('moment_uuid');
  if (!momentUuid) return sendJson(res, 400, { error: 'moment_uuid required' });

  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);

  const { rows } = await pool.query(
    `SELECT c.owner_wallet, c.owner_username, c.owner_name, COUNT(*) AS held_count
     FROM cards c
     ${SYSTEM_WALLET_OWNER_JOIN}
     WHERE c.moment_uuid = $1 AND c.burned = 0 AND sw.wallet_address IS NULL
     GROUP BY c.owner_wallet, c.owner_username, c.owner_name
     ORDER BY COUNT(*) DESC, c.owner_wallet ASC
     LIMIT $2 OFFSET $3`,
    [momentUuid, limit + 1, offset]
  );
  const hasMore = rows.length > limit;
  const holders = rows.slice(0, limit).map(r => ({
    owner_wallet: r.owner_wallet,
    // Same display fallback chain as the Editions tab's own holder cell
    // (owner_username -> owner_name -> FULL wallet address, never
    // shortened); holder_username stays separate since only a real Sweet
    // username links to a profile.
    holder: r.owner_username || r.owner_name || r.owner_wallet,
    holder_username: r.owner_username || null,
    held_count: Number(r.held_count),
  }));
  sendJson(res, 200, { holders, has_more: hasMore });
}

// Collector Leaderboard — a general-purpose "who owns the most cards matching
// these filters" ranking, not scoped to any one highlight/set the way
// Holders'/Wallet Look Up's own leaderboards are. Dupes intentionally count:
// this is a plain COUNT(*), not COUNT(DISTINCT moment_uuid) — a wallet owning
// 10 copies of the same highlight contributes 10, per explicit product
// decision (verified feasible live before building: ~200-600ms even on the
// heaviest filter combos, on this temporary local Postgres box).
async function handleLeaderboardFilters(res) {
  const [seriesRes, setsRes, raritiesRes, teamsRes, badgesRes] = await Promise.all([
    pool.query(`SELECT DISTINCT series_label FROM moments WHERE series_label IS NOT NULL AND ${DEAD_MOMENTS_EXCLUSION} ORDER BY series_label`),
    pool.query(`SELECT DISTINCT set_name FROM moments WHERE set_name IS NOT NULL AND ${DEAD_MOMENTS_EXCLUSION} ORDER BY set_name`),
    pool.query(`SELECT DISTINCT rarity FROM moments WHERE rarity IS NOT NULL AND ${DEAD_MOMENTS_EXCLUSION}`),
    pool.query(`SELECT DISTINCT team FROM moments WHERE team IS NOT NULL AND team != '' AND ${DEAD_MOMENTS_EXCLUSION} ORDER BY team`),
    pool.query(`SELECT DISTINCT badge_name FROM moment_badges ORDER BY badge_name`),
  ]);
  sendJson(res, 200, {
    series: seriesRes.rows.map(r => r.series_label),
    sets: setsRes.rows.map(r => r.set_name),
    rarities: sortRarities(raritiesRes.rows.map(r => r.rarity)),
    teams: teamsRes.rows.map(r => r.team),
    highlight_badges: badgesRes.rows.map(r => r.badge_name),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Query-param convention for multi-select filters (matches inventory.html's
// own frontend pattern): comma-joined values, parsed here into an array for
// `= ANY($n::text[])`.
function parseCsvParam(v) {
  return v ? v.split(',').filter(Boolean) : [];
}

const EDITION_BADGE_KEYS = new Set(['first', 'perfect', 'jersey']);
const LEADERBOARD_ASSET_TYPES = new Set(['all', 'highlights', 'packs']);

// Highlights (cards+moments) and Packs (packs+pack_moments) are UNIONed
// together as one flat row-set BEFORE the outer GROUP BY, so "All" is a
// single combined count rather than two separate leaderboards stitched
// together — added per explicit follow-up ("I forgot packs count as assets
// too"). Only the filters that actually apply to packs (Series, Rarity,
// Edition #) affect the packs half — Set/Team/Player/Highlight Badges/
// Edition Badges are highlight-only concepts (packs have none of that data),
// so they silently only narrow the highlights half. The frontend disables
// those controls in "Only Packs" mode so this isn't a silent surprise.
function buildHighlightsSubquery(q, params) {
  const where = ['c.burned = 0', 'sw.wallet_address IS NULL', `m.${DEAD_MOMENTS_EXCLUSION}`];
  const addArrayFilter = (col, values) => {
    if (!values.length) return;
    params.push(values);
    where.push(`${col} = ANY($${params.length}::text[])`);
  };
  addArrayFilter('m.series_label', parseCsvParam(q.get('series')));
  addArrayFilter('m.set_name', parseCsvParam(q.get('set_name')));
  addArrayFilter('m.rarity', parseCsvParam(q.get('rarity')));
  addArrayFilter('m.team', parseCsvParam(q.get('team')));
  // Pins to one or more SPECIFIC highlight designs (moment_uuid) — the
  // "Highlight" picker on the frontend, distinct from the Player text search
  // above (a player can have many separate highlight designs).
  addArrayFilter('m.moment_uuid', parseCsvParam(q.get('highlight')));

  const player = q.get('player');
  if (player) { params.push(`%${player.toLowerCase()}%`); where.push(`LOWER(m.player) LIKE $${params.length}`); }

  const editionMin = parseInt(q.get('edition_min'), 10);
  if (Number.isInteger(editionMin)) { params.push(editionMin); where.push(`c.edition_number >= $${params.length}`); }
  const editionMax = parseInt(q.get('edition_max'), 10);
  if (Number.isInteger(editionMax)) { params.push(editionMax); where.push(`c.edition_number <= $${params.length}`); }

  // Highlight-level badges (moment_badges — Series Debut, Curator Badge,
  // Signature Quest I-XI, etc.) — a card counts if its highlight carries ANY
  // of the selected badges (OR across selections, same as every other
  // multi-select filter here).
  const highlightBadges = parseCsvParam(q.get('highlight_badges'));
  if (highlightBadges.length) {
    params.push(highlightBadges);
    where.push(`EXISTS (SELECT 1 FROM moment_badges mb WHERE mb.moment_uuid = m.moment_uuid AND mb.badge_name = ANY($${params.length}::text[]))`);
  }

  // Per-edition computed badges (#1 Edition / Perfect Edition / Jersey Match
  // Edition — NOT stored, same client-side-computed concept as
  // holders.html's/wallet.html's EDITION_BADGES/WALLET_BADGES). A card
  // counts if it qualifies for ANY of the selected types. Perfect Edition's
  // COALESCE only evaluates its MAX(...) subquery for uncapped/growing
  // moments (total_editions IS NULL) — the same lazy-CASE-branch pattern
  // used in handleHighlights' own in_packs_pct — so capped moments (the vast
  // majority) never pay for it.
  const editionBadges = parseCsvParam(q.get('edition_badges')).filter(b => EDITION_BADGE_KEYS.has(b));
  if (editionBadges.length) {
    const clauses = [];
    if (editionBadges.includes('first')) clauses.push('c.edition_number = 1');
    if (editionBadges.includes('jersey')) clauses.push('(m.jersey_number IS NOT NULL AND c.edition_number = m.jersey_number)');
    if (editionBadges.includes('perfect')) {
      clauses.push(`c.edition_number = COALESCE(m.total_editions, (SELECT MAX(c2.edition_number) FROM cards c2 WHERE c2.moment_uuid = m.moment_uuid))`);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  return `
    SELECT c.owner_wallet, c.owner_username, c.owner_name
    FROM cards c
    JOIN moments m ON m.moment_uuid = c.moment_uuid
    LEFT JOIN system_wallets sw ON LOWER(sw.wallet_address) = LOWER(c.owner_wallet)
    WHERE ${where.join(' AND ')}
  `;
}

// True when any filter that ONLY applies to highlights (packs have none of
// this data) is active: Set, Team, Player, Highlight Badges, Edition Badges,
// or the Highlight picker. Series/Rarity/Edition # are excluded here since
// buildPacksSubquery DOES apply those to packs too. Used to exclude packs
// from an "All" total whenever one of these is set — otherwise "All" would
// silently add every UNFILTERED pack on top of a narrowed highlights count
// (e.g. "#1 Edition" + "All" originally included every pack regardless of
// edition, wildly inflating the total — caught via a live user report).
function hasHighlightOnlyFilter(q) {
  return parseCsvParam(q.get('highlight')).length > 0
    || parseCsvParam(q.get('set_name')).length > 0
    || parseCsvParam(q.get('team')).length > 0
    || parseCsvParam(q.get('highlight_badges')).length > 0
    || parseCsvParam(q.get('edition_badges')).some(b => EDITION_BADGE_KEYS.has(b))
    || !!(q.get('player') && q.get('player').trim());
}

function buildPacksSubquery(q, params) {
  const where = ['p.burned = 0', 'sw.wallet_address IS NULL'];
  const addArrayFilter = (col, values) => {
    if (!values.length) return;
    params.push(values);
    where.push(`${col} = ANY($${params.length}::text[])`);
  };
  addArrayFilter('pm.series_label', parseCsvParam(q.get('series')));
  addArrayFilter('pm.rarity', parseCsvParam(q.get('rarity')));

  const editionMin = parseInt(q.get('edition_min'), 10);
  if (Number.isInteger(editionMin)) { params.push(editionMin); where.push(`p.edition_number >= $${params.length}`); }
  const editionMax = parseInt(q.get('edition_max'), 10);
  if (Number.isInteger(editionMax)) { params.push(editionMax); where.push(`p.edition_number <= $${params.length}`); }

  return `
    SELECT p.owner_wallet, p.owner_username, p.owner_name
    FROM packs p
    JOIN pack_moments pm ON pm.pack_uuid = p.pack_uuid
    LEFT JOIN system_wallets sw ON LOWER(sw.wallet_address) = LOWER(p.owner_wallet)
    WHERE ${where.join(' AND ')}
  `;
}

async function handleLeaderboard(url, res) {
  const q = url.searchParams;
  const assetType = LEADERBOARD_ASSET_TYPES.has(q.get('asset_type')) ? q.get('asset_type') : 'all';
  const excludePacks = hasHighlightOnlyFilter(q);

  const params = [];
  const subqueries = [];
  if (assetType === 'all' || assetType === 'highlights') subqueries.push(buildHighlightsSubquery(q, params));
  if (!excludePacks && (assetType === 'all' || assetType === 'packs')) subqueries.push(buildPacksSubquery(q, params));

  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 100, 1), 200);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  params.push(limit + 1, offset);

  const sql = `
    SELECT
      combined.owner_wallet,
      MAX(wu.username) AS wu_username,
      MAX(combined.owner_username) AS card_username,
      MAX(combined.owner_name) AS card_name,
      COUNT(*) AS cards_owned
    FROM (
      ${subqueries.join('\n      UNION ALL\n      ')}
    ) combined
    LEFT JOIN wallet_usernames wu ON LOWER(wu.wallet_address) = LOWER(combined.owner_wallet)
    GROUP BY combined.owner_wallet
    ORDER BY cards_owned DESC, combined.owner_wallet ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > limit;
  const leaders = rows.slice(0, limit).map(r => ({
    owner_wallet: r.owner_wallet,
    // wallet_usernames is the authoritative/current source (see
    // handleWalletResolve) — cards.owner_username can lag it per the
    // handoff's own "username-resolve pass is paused" note. Falls back to
    // the FULL wallet address (never shortened) when nothing else exists.
    holder: r.wu_username || r.card_username || r.card_name || r.owner_wallet,
    holder_username: r.wu_username || r.card_username || null,
    cards_owned: Number(r.cards_owned),
  }));
  // Cached per exact query string (Vercel's CDN cache key includes it) — the
  // common no-filter default view gets the full benefit; a rare filter
  // combo just won't hit cache often, no downside either way. Same
  // "identical for everyone, only changes when the pipeline refreshes"
  // reasoning as handleSets.
  sendJson(res, 200, { leaders, has_more: hasMore }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// "Find a collector" — a specific wallet's rank within the CURRENT filtered
// leaderboard, without needing to page through however many collectors rank
// ahead of them. Reuses the exact same subqueries/params as handleLeaderboard
// (same filters, same asset_type), so a rank found here is always consistent
// with what the paginated list would eventually show. Rank is computed by
// counting how many OTHER wallets have a strictly greater count — cheap once
// the per-wallet aggregate itself exists, same cost class as the main
// leaderboard query.
async function handleLeaderboardRank(url, res) {
  const q = url.searchParams;
  const wallet = normalizeWallet(q.get('wallet'));
  if (!wallet) return sendJson(res, 400, { error: 'wallet required' });
  const assetType = LEADERBOARD_ASSET_TYPES.has(q.get('asset_type')) ? q.get('asset_type') : 'all';
  const excludePacks = hasHighlightOnlyFilter(q);

  const params = [];
  const subqueries = [];
  if (assetType === 'all' || assetType === 'highlights') subqueries.push(buildHighlightsSubquery(q, params));
  if (!excludePacks && (assetType === 'all' || assetType === 'packs')) subqueries.push(buildPacksSubquery(q, params));

  params.push(wallet);
  const sql = `
    WITH combined AS (
      ${subqueries.join('\n      UNION ALL\n      ')}
    ), agg AS (
      SELECT
        combined.owner_wallet,
        MAX(wu.username) AS wu_username,
        MAX(combined.owner_username) AS card_username,
        MAX(combined.owner_name) AS card_name,
        COUNT(*) AS cards_owned
      FROM combined
      LEFT JOIN wallet_usernames wu ON LOWER(wu.wallet_address) = LOWER(combined.owner_wallet)
      GROUP BY combined.owner_wallet
    )
    SELECT
      a.owner_wallet, a.wu_username, a.card_username, a.card_name, a.cards_owned,
      (SELECT COUNT(*) FROM agg a2 WHERE a2.cards_owned > a.cards_owned) + 1 AS rank
    FROM agg a
    WHERE LOWER(a.owner_wallet) = $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return sendJson(res, 200, { found: false }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
  const r = rows[0];
  // The rank computation here (COUNT of every OTHER wallet with more cards)
  // is another full aggregation over the combined highlights/packs union —
  // same cost profile as handleLeaderboard itself, worth caching for the
  // same reason.
  sendJson(res, 200, {
    found: true,
    owner_wallet: r.owner_wallet,
    holder: r.wu_username || r.card_username || r.card_name || r.owner_wallet,
    holder_username: r.wu_username || r.card_username || null,
    cards_owned: Number(r.cards_owned),
    rank: Number(r.rank),
  }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Type-ahead for the leaderboard's Player text filter — makes sure a picked
// name actually exists in the catalog rather than silently matching zero
// rows on a typo. Prefix matches ranked ahead of mid-string matches, same
// convention as handleWalletSuggest.
async function handleLeaderboardPlayers(url, res) {
  const raw = (url.searchParams.get('q') || '').trim();
  if (raw.length < 2) return sendJson(res, 200, { players: [] });
  const { rows } = await pool.query(
    `SELECT DISTINCT player,
       CASE WHEN LOWER(player) LIKE LOWER($1) || '%' THEN 0 ELSE 1 END AS rank
     FROM moments
     WHERE player IS NOT NULL AND LOWER(player) LIKE '%' || LOWER($1) || '%' AND ${DEAD_MOMENTS_EXCLUSION}
     ORDER BY rank ASC, player ASC
     LIMIT 8`,
    [raw]
  );
  sendJson(res, 200, { players: rows.map(r => r.player) }, { cacheSeconds: VERSIONED_CACHE_SECONDS, immutable: true });
}

// Backs the nav bar's "Last updated: ..." line AND every page's
// getDataVersion()/withVersion() cache-busting helper — this is the single
// source of truth both read to decide whether a new data version exists.
// Short real TTL (SITE_META_CACHE_SECONDS), not versioned/immutable like
// everything else — see that constant's own comment for why.
async function handleSiteMeta(res) {
  const { rows } = await pool.query(
    `SELECT value FROM site_meta WHERE key = 'data_last_updated'`
  );
  sendJson(res, 200, { data_last_updated: rows[0]?.value ?? null }, { cacheSeconds: SITE_META_CACHE_SECONDS });
}

// The refresh pipeline runs on an irregular schedule (hourly most of the
// day, but sometimes paused 5-6 hours overnight) — a flat TTL is the wrong
// tool here: short enough to be safe overnight wastes most of its potential
// speed during the day, long enough to be fast during the day risks serving
// stale data for hours if a refresh gets delayed. Instead, every cacheable
// endpoint is cached under a URL that includes `?v=<data_last_updated>`
// (appended by the frontend, see each page's getDataVersion()/withVersion()
// helpers) — a fundamentally different cache key per data version, so the
// cache can live essentially forever (VERSIONED_CACHE_SECONDS) with zero
// staleness risk: an old version's URL is simply never requested again once
// the frontend picks up a new version string, so there's nothing to expire.
// site_meta itself (the thing that tells everyone what the current version
// IS) is the one endpoint that still needs a real, short TTL — see its own
// handler for why.
const VERSIONED_CACHE_SECONDS = 60 * 60 * 24 * 365; // 1 year

// This is the ONE endpoint that still needs a real, short TTL — it's the
// thing every page checks to find out whether the version they should be
// appending to every other request has changed. This bounds "how long could
// it possibly take for a real data update to start being noticed" to about
// a minute, independent of how the versioned caching above behaves.
const SITE_META_CACHE_SECONDS = 60;

// cacheSeconds: for endpoints whose result is identical for every visitor
// (for a given set of params) and only changes when the data-refresh
// pipeline runs (never per-request, never per-user) — sets a CDN cache
// header so most requests are served instantly from the edge instead of
// re-running an expensive full-table aggregation every time. NEVER pass
// this for anything intentionally live (Sweet listings/prices — see
// fetchSweetListings's own "don't store, fetch on demand" reasoning, the
// opposite tradeoff made on purpose for a different reason).
// immutable: pair with VERSIONED_CACHE_SECONDS for endpoints whose caller
// appends `?v=` — tells the CDN/browser this exact URL's content will NEVER
// change, so it never needs to even ask. Omit for site_meta itself (short,
// ordinary TTL instead — see its handler).
function sendJson(res, status, body, { cacheSeconds, immutable } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    // Public read-only data — permissive CORS is harmless, and keeps local
    // dev simple (frontend and this dev server run on different local ports;
    // in production the Vercel function is same-origin so this header is
    // just unused, not unsafe).
    'Access-Control-Allow-Origin': '*',
  };
  if (cacheSeconds) {
    headers['Cache-Control'] = immutable
      // A versioned URL's content is fixed forever — no revalidation, ever.
      ? `public, max-age=${cacheSeconds}, immutable`
      // public: Vercel's CDN may cache it, not just the visitor's own
      // browser. stale-while-revalidate: a visitor hitting it right as it
      // expires still gets the (slightly stale) cached response instantly,
      // while Vercel refetches in the background for the next request —
      // never makes anyone wait for a full recompute.
      : `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

// Shared by both entry points at the bottom of this file: the standalone
// local dev server (plain `node`, for hand-testing against production data)
// and api/[...route].js, the real Vercel serverless function that serves
// this section in production. Keeping the routing/handlers in exactly one
// place means a fix here is a fix everywhere — never duplicate this dispatch
// or any handler function into the Vercel function file itself.
export async function routeRequest(url, res) {
  try {
    if (url.pathname === '/api/sets') {
      await handleSets(res);
    } else if (url.pathname === '/api/packs') {
      await handlePacks(res);
    } else if (url.pathname === '/api/wallet/resolve') {
      await handleWalletResolve(url, res);
    } else if (url.pathname === '/api/wallet/suggest') {
      await handleWalletSuggest(url, res);
    } else if (url.pathname === '/api/wallet/summary') {
      await handleWalletSummary(url, res);
    } else if (url.pathname === '/api/wallet/sets') {
      await handleWalletSets(url, res);
    } else if (url.pathname === '/api/wallet/cards') {
      await handleWalletCards(url, res);
    } else if (url.pathname === '/api/wallet/packs') {
      await handleWalletPacks(url, res);
    } else if (url.pathname === '/api/wallet/packs/filters') {
      await handleWalletPacksFilters(res);
    } else if (url.pathname === '/api/wallet/mint-rankings') {
      await handleWalletMintRankings(url, res);
    } else if (url.pathname === '/api/wallet/activity/filters') {
      await handleWalletActivityFilters(url, res);
    } else if (url.pathname === '/api/wallet/activity/summary') {
      await handleWalletActivitySummary(url, res);
    } else if (url.pathname === '/api/wallet/activity') {
      await handleWalletActivity(url, res);
    } else if (url.pathname === '/api/mint-rankings/collections') {
      await handleMintRankingsCollections(res);
    } else if (url.pathname === '/api/mint-rankings/top') {
      await handleMintRankingsTop(url, res);
    } else if (url.pathname === '/api/mint-rankings/expand') {
      await handleMintRankingsExpand(url, res);
    } else if (url.pathname === '/api/mint-rankings') {
      await handleMintRankings(url, res);
    } else if (url.pathname === '/api/highlights') {
      await handleHighlights(url, res);
    } else if (url.pathname === '/api/highlights/filters') {
      await handleHighlightsFilters(res);
    } else if (url.pathname === '/api/holders/header') {
      await handleHoldersHeader(url, res);
    } else if (url.pathname === '/api/holders/editions') {
      await handleHoldersEditions(url, res);
    } else if (url.pathname === '/api/holders/top-holders') {
      await handleHoldersTopHolders(url, res);
    } else if (url.pathname === '/api/leaderboard/filters') {
      await handleLeaderboardFilters(res);
    } else if (url.pathname === '/api/leaderboard/rank') {
      await handleLeaderboardRank(url, res);
    } else if (url.pathname === '/api/leaderboard/players') {
      await handleLeaderboardPlayers(url, res);
    } else if (url.pathname === '/api/leaderboard') {
      await handleLeaderboard(url, res);
    } else if (url.pathname === '/api/activity-leaderboard/rank') {
      await handleActivityLeaderboardRank(url, res);
    } else if (url.pathname === '/api/activity-leaderboard') {
      await handleActivityLeaderboard(url, res);
    } else if (url.pathname === '/api/site-meta') {
      await handleSiteMeta(res);
    } else if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
}

// Only start a standalone listener + run the index-ensuring migrations when
// this file is executed directly (`npm run dev:nhlbreakaway`) — NOT when
// api/[...route].js imports routeRequest() for the deployed Vercel function.
// A serverless function cold start has no business opening its own TCP
// listener, and the indexes only ever need creating once against the real
// database (already done, since this always talks to the same production
// Postgres regardless of who's running it — see NHL Breakaway project memory).
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    await routeRequest(url, res);
  });

  Promise.all([ensureHighlightsIndexes(), ensureWalletIndexes(), ensureLeaderboardIndexes()])
    .catch(err => console.error('Failed to ensure indexes:', err))
    .finally(() => {
      server.listen(PORT, () => {
        console.log(`nhlbreakaway dev API on http://localhost:${PORT}`);
      });
    });
}

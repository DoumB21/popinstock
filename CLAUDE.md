# PopInStock 3.0 — CLAUDE.md

## Critical rules

- **NEVER push to GitHub unless the user explicitly asks.** Always stage and commit only, then wait for "push" confirmation. Incomplete pages have been pushed accidentally in the past.
- Never run `git push` as part of a commit flow unless the user says "push" or "push it".

---

## Project overview

PopInStock is a **static HTML + vanilla JS** collector tool suite for WAX blockchain NFTs (Funko Digital, Topps MLB, Wombat Dungeon Master) plus Twitch stream analytics. There is no backend server — all data comes from the WAX blockchain API and Supabase (read-only anon access).

**Live site:** www.popinstock.com  
**Hosting:** Vercel (vercel.json enforces www redirect)  
**Repo:** GitHub (main branch: `master`)

---

## URL scheme

`vercel.json` sets `"cleanUrls": true` — every page is served without its `.html` extension (e.g. `funko/wallet.html` is browsed as `/funko/wallet`; a direct hit on the `.html` URL 308-redirects to the clean one). Files on disk keep their `.html` names — only link targets and browser-facing URLs drop it. Every internal `href`/`location`/nav-link reference site-wide must therefore be extensionless; when adding a new page or link, don't write `.html` into it.

`collection.html` and `template.html` additionally get path-style URLs via explicit `rewrites` in vercel.json: `/collection/:name` → `collection.html?collection_name=:name` and `/template/:id` → `template.html?template_id=:id`. The page JS just reads `collection_name`/`template_id` off `location.search` as usual — Vercel populates it from the path segment automatically, no extra parsing needed.

---

## Folder structure

```
/
├── index.html               # Homepage — links to all sections
├── trade-offers.html        # WAX trade offer reviewer (requires wallet)
├── og-banner.html           # OG meta image (1200×630, rendered HTML)
├── robots.txt / sitemap.xml / ads.txt
├── vercel.json
│
├── funko/                   # Funko Digital section (largest)
├── topps/                   # Topps MLB section
├── wombat/                  # Wombat Dungeon Master section
├── twitch/                  # Twitch stream analytics section
├── shared/                  # Global CSS, Supabase config, compiled WAX auth
├── src/                     # WAX auth source (ES module — build before editing)
├── images/                  # Logos and icons
├── patches/                 # patch-package patches (Anchor wallet plugin)
└── node_modules/            # gitignored
```

---

## Sections

### funko/ — Funko Digital

Hub: `funko/funko.html`  
Nav links (in `funko/nav.js`): Trade Analyzer · Mint Rankings · Wallet Look Up · Market Overview · Set Tracker

| Page | Purpose |
|------|---------|
| `trade-analyzer.html` | Compare up to 5 wallets for any drop; spot trade opportunities |
| `mint-rankings.html` | Browse all Funko drops with mint rankings and collector standings |
| `wallet.html` | Look up any WAX wallet; collection stats and set rankings |
| `market-overview.html` | Browse live marketplace prices; filter by rarity/drop |
| `set-tracker.html` | Track collection progress, find missing Royalty/Mastery cards |
| `set-tracker-full.html` | Extended set tracker with Supply column |
| `drop.html` | Per-drop analytics |
| `set-detail.html` | Per-set analytics |
| `sales-history.html` | Daily trading activity and volume trends; click chart dots to filter |
| `price-history.html` | eBay/physical pop pricing vs NFT data |
| `redemptions.html` | Final redemption numbers for all Funko Pop sets |
| `profile.html` | Collector profile: 4-tier achievement system (see below) |

**Local data files:** `drops_catalog.json`, `full_catalog.json`, `packs_catalog.json`, `redemptions_sets_catalog.json`, `sort_order.json`, `wax_endpoint.json`

### topps/ — Topps MLB

Hub: `topps/topps.html`  
Nav links: Trade Analyzer · Mint Rankings · Wallet Look Up

| Page | Purpose |
|------|---------|
| `trade-analyzer.html` | Compare wallets for any Topps subset |
| `mint-rankings.html` | Mint rankings for Topps subsets |
| `wallet.html` | Look up any WAX wallet for Topps cards |
| `subset.html` | Per-subset analytics |

**Local data files:** `drops_catalog.json`, `rarities_catalog.json`, `rarity-config.js`, `subsets_catalog.json`, `sort_order.json`, `wax_endpoint.json`

### wombat/ — Wombat Dungeon Master

Hub: `wombat/wombat.html`  
Nav links: Mining Power Search

| Page | Purpose |
|------|---------|
| `mining-power-search.html` | Search mining power data for Wombat NFTs |

### twitch/ — Twitch Analytics

Hub: `twitch/twitch.html`  
Nav links: Monthly Stats

| Page | Purpose |
|------|---------|
| `monthly-stats.html` | Monthly stream activity, game results, community stats |

**Local data files:** `data/archiveGameResults.json`, `data/archiveGuesses.json`, `data/archiveSecondChance.json`, `data/transfer-results.json`

---

## shared/ — Global assets

| File | Purpose |
|------|---------|
| `global.css` | Master stylesheet — design tokens, nav, cards, tables, rarity colors, footer |
| `supabase-config.js` | Sets globals: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `IPFS_GATEWAY` |
| `wax-auth.js` | **Compiled IIFE bundle** — exposes `window.WaxAuth`. Do not edit directly. |

---

## Navigation system

Every section has a `nav.js` file loaded by each page via `<script src="nav.js"></script>`. It:
- Dynamically builds the sticky header (logo, section badge, nav links, wallet widget, hamburger)
- Builds the back-to-top button and footer
- Manages WAX wallet state

**Page template pattern:**
```html
<script src="../shared/supabase-config.js"></script>  <!-- sets SUPABASE_URL etc. -->
<script src="nav.js"></script>
```

**Critical exception:** `funko/funko.html` does NOT load `supabase-config.js`. So `funko/nav.js` has the Supabase URL and anon key embedded directly as `_SB_URL` / `_SB_ANON` constants for its own DB calls (tier fetch).

**Flash prevention:** `_updateNavWaxBtn()` is called synchronously right after `buildNav()` in the DOMContentLoaded handler. This reads `localStorage.wax_account` immediately so returning users never see the "Connect Wallet" button flash on page load.

**Optional site banner:**
```js
const SITE_BANNER = { message: 'Your text here.', type: 'warning' }; // or null to hide
// type: 'warning' (amber) | 'info' (blue) | 'error' (red)
```

---

## WAX wallet authentication

**Source:** `src/wax-auth.js` (ES module, ~100 lines)  
**Output:** `shared/wax-auth.js` (IIFE bundle, ~800KB)  
**Build command:** `npm run build:auth`  
**Rebuild when:** `src/wax-auth.js` changes. Always commit the built `shared/wax-auth.js`.

**Supported wallets:** WAX Cloud Wallet · Anchor · Wombat

**WAX chain:**
- ID: `1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4`
- RPC: `https://wax.greymass.com`
- App name in modal: `'Pop In Stock'`

**WaxAuth API:**
- `WaxAuth.login()` — opens wallet modal, returns account name, fires `wax-auth-change` event
- `WaxAuth.logout()` — clears session, fires event
- `WaxAuth.restore()` — restores session from sessionKit cache (does NOT fire event)
- `WaxAuth.getAccount()` — returns current account or null
- `WaxAuth.transact(actions)` — signs and broadcasts on-chain actions

**localStorage keys:**
- `wax_account` — connected wallet name
- `wax_funko_tier` — cached tier level (1–4) for the Funko nav icon

**Custom event:** `wax-auth-change` — dispatched by `_dispatch()` on login/logout. Pages listen to this to react to wallet changes. `restore()` does NOT dispatch it — nav.js calls `_updateNavWaxBtn()` manually after restore.

**Anchor plugin patch:** `wallet-plugin-anchor` fires `window.location.href = 'esr://...'` before showing the QR modal, causing a native browser popup. Fixed by removing that line. Patch lives in `patches/@wharfkit+wallet-plugin-anchor+1.6.1.patch` and auto-applies on `npm install`.

**Wombat note:** Uses Scatter protocol (connects to `local.get-scatter.com`). Without the Wombat extension, `ERR_CONNECTION_REFUSED` appears in console — expected, not a bug.

**Tier fetch in nav:** `_fetchAndCacheTier(account)` in `funko/nav.js` fetches `funko_collector_tiers` from Supabase on login and on session restore. This ensures the tier emoji (🌱/📚/🏛️/👑) appears in the nav without requiring a visit to `profile.html`.

---

## Supabase

**URL:** `https://otzyszbbsuwoxupbpfju.supabase.co`  
**Access:** anon key, read-only for most tables  
**Config:** `shared/supabase-config.js` sets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `IPFS_GATEWAY`

**Schema header pattern:** Tables in non-public schemas require:
- GET requests: `Accept-Profile: funko`
- POST/PATCH requests: `Content-Profile: funko` (not Accept-Profile — this distinction caused a 404 bug)

**Standard query headers:**
```js
const SB_HEADERS = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Accept-Profile': 'funko',  // for funko schema tables
};
```

### Key tables

#### Funko schema (`Accept-Profile: funko`)
| Table | Contents |
|-------|---------|
| `funko_market_prices` | Live marketplace listings (template_id, wax_price_wax, wax_price_usd, dp_locked_count) |
| `funko_set_prices` | Set-level aggregates (collection_name, schema_name, drop_displayname) |
| `funko_wallet_profiles` | Pre-computed user profiles (wallet PK, profile JSONB, updated_at) — only wallets with 100+ cards |
| `funko_collector_tiers` | Tier high-watermark per wallet (wallet PK, max_tier, tier_1_at…tier_4_at, updated_at) |
| `funko_sales_history` | Daily trading activity |
| `templates` | Master card catalog (template_id, name, rarity, schema_name, img, video) |
| `collections` | Collection metadata |
| `schema_stats` | Per-set stats (total_assets, burned, unique_owners, rarity_breakdown) |
| `leaderboard_ratings` | Collector rankings (wallet, set_type, avg_mint, rank, rating) |
| `top_holders` | Top collectors per set |
| `pack_stats` | Pack burn/redemption data |
| `ebay_funko_pops` | Physical Funko Pop data (cross-referenced via pop_phase_links) |
| `template_sold_listings` | Historical NFT sale prices |
| `ebay_sold_listings` | Historical physical pop sale prices |

#### Topps schema
| Table | Contents |
|-------|---------|
| `top_holders` | Top collectors per subset |
| `subset_stats` | Per-subset aggregate stats |
| `leaderboard_ratings` | Mint rankings |
| `templates` | Card catalog |
| `traders_list` | Known traders |

#### Wombat schema
| Table/RPC | Contents |
|-----------|---------|
| `wombat_meta` | Metadata timestamp |
| `wombat_listings` | NFT listings with mining power |
| `rpc/get_wombat_collections` | RPC — fetches collection list |

---

## Collector Profile page (funko/profile.html)

4-tier achievement system for Funko collectors. Accessible via the wallet name link in the Funko nav.

**Tiers:**
| # | Icon | Name | Achievements |
|---|------|------|-------------|
| 1 | 🌱 | Apprentice | 6 |
| 2 | 📚 | Collector | 8 |
| 3 | 🏛️ | Curator | 8 |
| 4 | 👑 | Legend | 6 |

**Architecture:**
- `appState = { profile, updatedAt, maxTier, tierDates, loaded }` — single source of truth
- `fetchData(wallet)` — parallel fetch of `funko_wallet_profiles` + `funko_collector_tiers`
- `renderAll()` — drives all UI from appState
- `claimTier(n)` — POST upsert to `funko_collector_tiers`, updates appState, re-renders
- `onWalletChange()` — entry point on wallet connect/disconnect

**Tier state source:** Always from `funko_collector_tiers.max_tier` — never re-evaluate live thresholds. Once claimed, a tier is permanent.

**Tier card states:**
- `tier-card--locked` — more than 1 tier ahead of maxTier
- `tier-card--current` — exactly 1 ahead (shows achievements + "Level up!" button when all pass)
- `tier-card--completed` — at or below maxTier (shows "✨ Congratulations!\nLevel completed on {date}")

**Sync notice:** Banner at top of content — "🔄 Progress updates every 24–48 hours…" — with last sync date from `funko_wallet_profiles.updated_at`.

**Nav tier icon:** Written to `localStorage.wax_funko_tier` by both nav.js (on connect/restore) and profile.html (on fetch/claim). Cleared on logout.

---

## Explore (root explore.html)

Browses live NFT listings across any collection — buy instantly or build a cart to buy several at once. WAX account `hoardiostore` earns 1% commission on purchases. Deep-links via `?template_id=` (used site-wide as the "Buy" link target) resolve the collection automatically and scope listings to that one card; supports `maxMint`, `sort`/`order`, and a Listings/Sales History tab pair. Replaced the old root `marketplace.html`, which was removed once nothing linked to it.

## Trade Offers (root trade-offers.html)

Reviews incoming WAX trade offers. Requires wallet connection. Fetches pending trades from `atomicassets` smart contract via WAX RPC. Resolves template metadata from Supabase `templates` table.

---

## Design system (shared/global.css)

**Core palette:**
```css
--bg-main:        #0a0a0f
--bg-card:        #13131d
--text-primary:   #f0f0f5
--text-secondary: #8888aa
--accent:         #c07828   /* muted orange */
--accent-light:   #f0a840   /* bright orange */
--border:         rgba(255,255,255,0.08)
```

**Rarity colors (CSS custom properties):** `--rarity-common`, `--rarity-rare`, `--rarity-epic`, `--rarity-legendary`, `--rarity-grail`, `--rarity-mythic`, `--rarity-royalty`, `--rarity-1of1`, `--rarity-ultra`, `--rarity-series`, `--rarity-super-rare`, `--rarity-epic-exclusive`, `--rarity-event-exclusive`, `--rarity-legendary-exclusive`

**Layout:** Sticky nav (64px), max content width 1100px, 1.5rem side padding.

---

## Droppp shutdown

Droppp closes **2026-05-31**. Removal changes prepared locally — push to GitHub on that date. Do not remove Droppp references before then.

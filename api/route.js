// Catch-all for every NHL Breakaway API path (/api/sets, /api/wallet/resolve,
// /api/highlights, /api/site-meta, etc.) — this is the real production
// backend for that section, serving live traffic from the same Postgres
// database (hosted on Raff Technologies) the local dev server also uses.
//
// Reached via an explicit vercel.json rewrite ("/api/:path*" -> "/api/route"),
// NOT Vercel's bracket-based dynamic filename convention (api/[...route].js).
// That was tried first and looked right, but broke silently in production:
// single-segment paths (/api/sets) worked, while every multi-segment path
// (/api/wallet/suggest, /api/highlights/filters, /api/leaderboard/filters —
// most of this section's real endpoints) 404'd. The rewrite-based approach
// is the standard, well-documented way to put an entire API behind one
// function on Vercel — a rewrite keeps req.url as the ORIGINAL requested
// path (confirmed live), so routeRequest() below still does its own
// pathname-based dispatch exactly as it always has, unmodified.
//
// Vercel matches actual filesystem routes before falling back to
// vercel.json rewrites, so api/og-image/*.js and api/og-page/*.js (real
// files at those exact paths) keep taking priority over this rewrite —
// confirmed those were never affected by any of this.
//
// Deliberately thin: all real logic/SQL lives in
// nhlbreakaway/dev-server/index.js's routeRequest(), shared verbatim with
// the local dev server (`npm run dev:nhlbreakaway`) — never duplicate
// handler logic here. Fix a bug or add an endpoint there, not in this file.
import { routeRequest } from '../nhlbreakaway/dev-server/index.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routeRequest(url, res);
}

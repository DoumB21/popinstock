// Catch-all for every NHL Breakaway API path (/api/sets, /api/wallet/resolve,
// /api/highlights, /api/site-meta, etc.) — this is the real production
// backend for that section, serving live traffic from the same Postgres
// database (hosted on Raff Technologies) the local dev server also uses.
//
// Vercel matches more specific static files first (api/og-image/*.js,
// api/og-page/*.js), so this catch-all only ever receives requests nothing
// else claims — currently that's exactly the NHL Breakaway paths and
// nothing else in the repo.
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

// Bot-only interception for social-preview crawlers. Real visitors are completely
// unaffected — this only ever rewrites requests whose User-Agent matches a known
// crawler (see BOT_UA_RE), and only for the three routes that can be shared as a
// specific item: /collection/:name, /template/:id, /inventory/:wallet (the
// older /inventory?wallet=X query-string form still works too, for any
// bookmarks or links already out in the wild). Every other request
// (including non-bot hits on these same paths) falls through via next() to
// the existing vercel.json rewrites/static files, unchanged.
import { rewrite, next } from '@vercel/functions';
import { BOT_UA_RE } from './api/_lib/og-shared.js';

export const config = {
  matcher: ['/collection/:name', '/template/:id', '/inventory/:wallet', '/inventory'],
};

export default function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  if (!BOT_UA_RE.test(ua)) return next();

  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'collection' && segments[1]) {
    const target = new URL('/api/og-page/collection', url);
    target.searchParams.set('name', segments[1]);
    return rewrite(target);
  }

  if (segments[0] === 'template' && segments[1]) {
    const target = new URL('/api/og-page/template', url);
    target.searchParams.set('id', segments[1]);
    return rewrite(target);
  }

  if (segments[0] === 'inventory') {
    const wallet = segments[1] || url.searchParams.get('wallet');
    if (wallet) {
      const target = new URL('/api/og-page/inventory', url);
      target.searchParams.set('wallet', wallet);
      return rewrite(target);
    }
  }

  return next();
}

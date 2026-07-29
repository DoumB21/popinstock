import fs from 'fs';
import path from 'path';
import { fetchAA, patchHeadMeta, truncate, SITE_ORIGIN } from '../_lib/og-shared.js';

const STATIC_PATH = path.join(process.cwd(), 'inventory.html');

export default async function handler(req, res) {
  const wallet = String(req.query.wallet || '').toLowerCase();
  const staticHtml = fs.readFileSync(STATIC_PATH, 'utf8');

  try {
    if (!wallet) throw new Error('missing wallet');
    // /accounts/:wallet embeds full metadata (description, socials, images, ...) for
    // every distinct collection the wallet holds — for a wallet spread across hundreds
    // of collections that response can run into the tens of megabytes and take 8+
    // seconds, blowing well past a crawler's timeout budget (confirmed live: a 714-
    // collection wallet returned a 16MB payload in 8.7s). /assets/_count needs none of
    // that — just the number itself.
    const total = Number(await fetchAA(`/assets/_count?owner=${encodeURIComponent(wallet)}`));
    if (!total) throw new Error('empty or unknown wallet');
    const description = truncate(
      `${total.toLocaleString()} NFT${total === 1 ? '' : 's'} on WAX — browse the full inventory.`,
      200
    );

    const html = patchHeadMeta(staticHtml, {
      title: `${wallet}'s Inventory — Hoardio`,
      description,
      url: `${SITE_ORIGIN}/inventory/${encodeURIComponent(wallet)}`,
      image: `${SITE_ORIGIN}/api/og-image/inventory?wallet=${encodeURIComponent(wallet)}`,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.status(200).send(html);
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(staticHtml);
  }
}

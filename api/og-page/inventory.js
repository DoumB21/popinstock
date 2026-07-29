import fs from 'fs';
import path from 'path';
import { fetchAA, patchHeadMeta, truncate, SITE_ORIGIN } from '../_lib/og-shared.js';

const STATIC_PATH = path.join(process.cwd(), 'inventory.html');

export default async function handler(req, res) {
  const wallet = String(req.query.wallet || '').toLowerCase();
  const staticHtml = fs.readFileSync(STATIC_PATH, 'utf8');

  try {
    if (!wallet) throw new Error('missing wallet');
    const data = await fetchAA(`/accounts/${encodeURIComponent(wallet)}`);
    const total = Number(data?.assets || 0);
    if (!total) throw new Error('empty or unknown wallet');
    const collections = data.collections || [];
    const description = truncate(
      `${total.toLocaleString()} NFT${total === 1 ? '' : 's'} across ${collections.length} collection${collections.length === 1 ? '' : 's'} on WAX — browse the full inventory.`,
      200
    );

    const html = patchHeadMeta(staticHtml, {
      title: `${wallet}'s Inventory — Hoardio`,
      description,
      url: `${SITE_ORIGIN}/inventory?wallet=${encodeURIComponent(wallet)}`,
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

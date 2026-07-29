import fs from 'fs';
import path from 'path';
import { fetchAA, patchHeadMeta, plainTextFromDescription, truncate, SITE_ORIGIN } from '../_lib/og-shared.js';

const STATIC_PATH = path.join(process.cwd(), 'collection.html');

export default async function handler(req, res) {
  const name = String(req.query.name || '');
  const staticHtml = fs.readFileSync(STATIC_PATH, 'utf8');

  try {
    if (!name) throw new Error('missing name');
    const info = await fetchAA(`/collections/${encodeURIComponent(name)}`);
    const displayName = info.data?.name || info.collection_name || name;
    const rawDescription = plainTextFromDescription(info.data?.description);
    const description = truncate(rawDescription || `WAX NFT collection${info.author ? ' by ' + info.author : ''} — stats, schemas, and market activity.`, 200);

    const html = patchHeadMeta(staticHtml, {
      title: `${displayName} — Hoardio`,
      description,
      url: `${SITE_ORIGIN}/collection/${encodeURIComponent(name)}`,
      image: `${SITE_ORIGIN}/api/og-image/collection?name=${encodeURIComponent(name)}`,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.status(200).send(html);
  } catch {
    // Not found / API down / malformed data — fall back to the plain default page,
    // identical to what a human visitor would see today.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(staticHtml);
  }
}

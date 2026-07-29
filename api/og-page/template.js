import fs from 'fs';
import path from 'path';
import { fetchAA, patchHeadMeta, truncate, SITE_ORIGIN } from '../_lib/og-shared.js';

const STATIC_PATH = path.join(process.cwd(), 'template.html');

export default async function handler(req, res) {
  const id = String(req.query.id || '');
  const staticHtml = fs.readFileSync(STATIC_PATH, 'utf8');

  try {
    if (!id) throw new Error('missing id');
    const rows = await fetchAA(`/templates?template_id=${encodeURIComponent(id)}&limit=1`);
    const tpl = rows?.[0];
    if (!tpl) throw new Error('template not found');

    const name = tpl.immutable_data?.name || `Template #${id}`;
    const collectionName = tpl.collection?.name || tpl.collection?.collection_name || '';
    const rarity = tpl.immutable_data?.rarity;
    const description = truncate(
      `From ${collectionName}${rarity ? ' · ' + rarity : ''} — WAX NFT details, supply, and market activity.`,
      200
    );

    const html = patchHeadMeta(staticHtml, {
      title: `${name} — Hoardio`,
      description,
      url: `${SITE_ORIGIN}/template/${encodeURIComponent(id)}`,
      image: `${SITE_ORIGIN}/api/og-image/template?id=${encodeURIComponent(id)}`,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.status(200).send(html);
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(staticHtml);
  }
}

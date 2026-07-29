import fs from 'fs';
import path from 'path';
import { fetchAA, isRenderableImage, patchHeadMeta, truncate, SITE_ORIGIN } from '../_lib/og-shared.js';

const STATIC_PATH = path.join(process.cwd(), 'template.html');
const DEFAULT_IMAGE = `${SITE_ORIGIN}/images/og-banner.png`;

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

    // Most Funko templates are animated-only (.mp4 `video`, no static `img`) — no still
    // frame exists anywhere to show, so those (and the rarer unsupported-image-format
    // case) get the generic site banner instead of a custom card with a visible gap.
    const hasArt = await isRenderableImage(tpl.immutable_data?.img);
    const image = hasArt
      ? `${SITE_ORIGIN}/api/og-image/template?id=${encodeURIComponent(id)}`
      : DEFAULT_IMAGE;

    const html = patchHeadMeta(staticHtml, {
      title: `${name} — Hoardio`,
      description,
      url: `${SITE_ORIGIN}/template/${encodeURIComponent(id)}`,
      image,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.status(200).send(html);
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(staticHtml);
  }
}

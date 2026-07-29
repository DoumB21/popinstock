import { ImageResponse } from '@vercel/og';
import { fetchAA, fetchImageDataUri, fetchGoogleFontTtf, h, COLORS } from '../_lib/og-shared.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id') || '';

  let name = id ? `Template #${id}` : 'Template';
  let collectionName = '';
  let rarity = null;
  let cardImg = null;

  try {
    const rows = await fetchAA(`/templates?template_id=${encodeURIComponent(id)}&limit=1`);
    const tpl = rows?.[0];
    if (tpl) {
      name = tpl.immutable_data?.name || name;
      collectionName = tpl.collection?.name || tpl.collection?.collection_name || '';
      rarity = tpl.immutable_data?.rarity || null;
      if (tpl.immutable_data?.img) cardImg = await fetchImageDataUri(tpl.immutable_data.img);
    }
  } catch {
    // API down / not found — render the generic branded placeholder below.
  }

  const fontData = await fetchGoogleFontTtf('Inter', 700);

  const artNode = cardImg
    ? h('img', { src: cardImg, width: 340, height: 340, style: { width: 340, height: 340, objectFit: 'contain', borderRadius: 20, marginRight: 64, backgroundColor: COLORS.card, border: `1px solid ${COLORS.border}` } })
    : h('div', {
        style: {
          width: 340, height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 64,
          borderRadius: 20, backgroundColor: COLORS.card, border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary, fontSize: 100,
        },
      }, '?');

  const infoChildren = [
    h('div', { style: { display: 'flex', color: COLORS.accentLight, fontSize: 20, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 18 } }, collectionName || 'WAX Collection'),
    h('div', { style: { display: 'flex', color: COLORS.textPrimary, fontSize: 54, fontWeight: 700, lineHeight: 1.15, marginBottom: 24 } }, name),
    rarity
      ? h('div', {
          style: {
            display: 'flex', alignSelf: 'flex-start', fontSize: 18, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase',
            color: COLORS.accent, padding: '8px 22px', borderRadius: 999, border: '1px solid rgba(192,120,40,0.35)', backgroundColor: 'rgba(192,120,40,0.08)',
          },
        }, rarity)
      : null,
  ].filter(Boolean);

  return new ImageResponse(
    h('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: COLORS.bg,
        backgroundImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(192,120,40,0.10) 0%, transparent 70%)',
        fontFamily: fontData ? 'Inter' : 'sans-serif', padding: '0 90px',
      },
    }, [
      artNode,
      h('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: 620 } }, infoChildren),
    ]),
    { width: 1200, height: 630, fonts: fontData ? [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }] : undefined }
  );
}

import { ImageResponse } from '@vercel/og';
import { fetchAA, fetchImageDataUri, fetchGoogleFontTtf, bufferImageResponse, h, COLORS } from '../_lib/og-shared.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const wallet = (searchParams.get('wallet') || '').toLowerCase();

  // The AtomicAssets+logos lookup and the font fetch are independent — run them
  // concurrently instead of one after another to keep worst-case latency down for
  // crawlers with tight timeouts (see bufferImageResponse's comment for the other half
  // of this fix).
  const dataPromise = (async () => {
    let total = 0;
    let collectionCount = 0;
    let topLogos = [];
    try {
      const data = await fetchAA(`/accounts/${encodeURIComponent(wallet)}`);
      total = Number(data?.assets || 0);
      const collections = data.collections || [];
      collectionCount = collections.length;
      const top = [...collections].sort((a, b) => Number(b.assets || 0) - Number(a.assets || 0)).slice(0, 4);
      topLogos = (await Promise.all(top.map(entry => entry.collection?.img ? fetchImageDataUri(entry.collection.img) : null))).filter(Boolean);
    } catch {
      // API down / unknown wallet — render the generic branded placeholder below.
    }
    return { total, collectionCount, topLogos };
  })();

  const [{ total, collectionCount, topLogos }, fontData] = await Promise.all([
    dataPromise,
    fetchGoogleFontTtf('Inter', 700),
  ]);

  const children = [
    h('div', { style: { display: 'flex', color: COLORS.accentLight, fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 24 } }, 'Hoardio Wallet Inventory'),
    h('div', { style: { display: 'flex', color: COLORS.textPrimary, fontSize: 58, fontWeight: 700, marginBottom: 20 } }, wallet || 'Wallet'),
    h('div', { style: { display: 'flex', color: COLORS.textSecondary, fontSize: 28, marginBottom: 40 } },
      `${total.toLocaleString()} NFT${total === 1 ? '' : 's'}${collectionCount ? ` across ${collectionCount} collection${collectionCount === 1 ? '' : 's'}` : ''}`),
    topLogos.length
      ? h('div', { style: { display: 'flex', gap: 20 } }, topLogos.map(src =>
          h('img', { src, width: 100, height: 100, style: { width: 100, height: 100, borderRadius: 16, objectFit: 'cover', border: `2px solid ${COLORS.border}` } })
        ))
      : null,
  ].filter(Boolean);

  return bufferImageResponse(new ImageResponse(
    h('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        backgroundColor: COLORS.bg,
        backgroundImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(192,120,40,0.10) 0%, transparent 70%)',
        fontFamily: fontData ? 'Inter' : 'sans-serif',
      },
    }, children),
    { width: 1200, height: 630, fonts: fontData ? [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }] : undefined }
  ));
}

import { ImageResponse } from '@vercel/og';
import { fetchAA, fetchImageDataUri, fetchGoogleFontTtf, bufferImageResponse, truncate, plainTextFromDescription, h, COLORS } from '../_lib/og-shared.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get('name') || '';

  // The AtomicAssets+logo lookup and the font fetch are independent — run them
  // concurrently instead of one after another to keep worst-case latency down for
  // crawlers with tight timeouts (see bufferImageResponse's comment for the other half
  // of this fix).
  const dataPromise = (async () => {
    let displayName = name || 'Collection';
    let description = 'WAX Blockchain Collection';
    let logoDataUri = null;
    try {
      const info = await fetchAA(`/collections/${encodeURIComponent(name)}`);
      displayName = info.data?.name || info.collection_name || name;
      description = truncate(plainTextFromDescription(info.data?.description), 140) || 'WAX Blockchain Collection';
      if (info.img) logoDataUri = await fetchImageDataUri(info.img);
    } catch {
      // API down / not found — render the generic branded placeholder below.
    }
    return { displayName, description, logoDataUri };
  })();

  const [{ displayName, description, logoDataUri }, fontData] = await Promise.all([
    dataPromise,
    fetchGoogleFontTtf('Inter', 700),
  ]);

  const children = [
    h('div', { style: { display: 'flex', color: COLORS.accentLight, fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 28 } }, 'Hoardio'),
    logoDataUri
      ? h('img', { src: logoDataUri, width: 160, height: 160, style: { width: 160, height: 160, borderRadius: 24, objectFit: 'cover', marginBottom: 32, border: `2px solid ${COLORS.border}` } })
      : null,
    h('div', { style: { display: 'flex', color: COLORS.textPrimary, fontSize: 60, fontWeight: 700, marginBottom: 20, maxWidth: 1000, textAlign: 'center', lineHeight: 1.1 } }, displayName),
    h('div', { style: { display: 'flex', color: COLORS.textSecondary, fontSize: 26, maxWidth: 900, textAlign: 'center', lineHeight: 1.4 } }, description),
    h('div', {
      style: {
        display: 'flex', marginTop: 40, fontSize: 18, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase',
        color: COLORS.accent, padding: '10px 28px', borderRadius: 999, border: '1px solid rgba(192,120,40,0.35)',
        backgroundColor: 'rgba(192,120,40,0.08)',
      },
    }, 'WAX Blockchain Collection'),
  ].filter(Boolean);

  return bufferImageResponse(new ImageResponse(
    h('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg,
        backgroundImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(192,120,40,0.10) 0%, transparent 70%)',
        fontFamily: fontData ? 'Inter' : 'sans-serif',
      },
    }, h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 90px', textAlign: 'center' } }, children)),
    { width: 1200, height: 630, fonts: fontData ? [{ name: 'Inter', data: fontData, weight: 700, style: 'normal' }] : undefined }
  ));
}

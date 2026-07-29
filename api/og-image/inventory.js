import { ImageResponse } from '@vercel/og';
import { fetchAA, fetchGoogleFontTtf, bufferImageResponse, h, COLORS } from '../_lib/og-shared.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const wallet = (searchParams.get('wallet') || '').toLowerCase();

  // The wallet lookup and the font fetch are independent — run them concurrently
  // instead of one after another to keep worst-case latency down for crawlers with
  // tight timeouts (see bufferImageResponse's comment for the other half of this fix).
  // Deliberately just a total count, not a collection breakdown: /accounts/:wallet
  // embeds full metadata for every distinct collection a wallet holds, which for a
  // wallet spread across hundreds of collections runs into the tens of megabytes and
  // 8+ seconds (confirmed live: a 714-collection wallet returned 16MB in 8.7s) — no
  // per-wallet collection count/logos are worth showing at that cost, so this card is
  // stats-only.
  const dataPromise = (async () => {
    let total = 0;
    try {
      total = Number(await fetchAA(`/assets/_count?owner=${encodeURIComponent(wallet)}`));
    } catch {
      // API down / unknown wallet — render the generic branded placeholder below.
    }
    return { total };
  })();

  const [{ total }, fontData] = await Promise.all([
    dataPromise,
    fetchGoogleFontTtf('Inter', 700),
  ]);

  const children = [
    h('div', { style: { display: 'flex', color: COLORS.accentLight, fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 24 } }, 'Hoardio Wallet Inventory'),
    h('div', { style: { display: 'flex', color: COLORS.textPrimary, fontSize: 58, fontWeight: 700, marginBottom: 20 } }, wallet || 'Wallet'),
    h('div', { style: { display: 'flex', color: COLORS.textSecondary, fontSize: 28 } }, `${total.toLocaleString()} NFT${total === 1 ? '' : 's'} on WAX`),
  ];

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

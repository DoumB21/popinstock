// Node-only counterpart to fetching card art / logos for the OG image cards. Split out
// from og-shared.js because this uses `sharp` (a native binary) — that must never end up
// in middleware.js's Edge bundle, so keep this file imported only from api/og-image/*.
import { IPFS_GATEWAYS, fetchWithTimeout } from './og-shared.js';

// Loaded lazily (not a static top-level import) and only on the code path that actually
// needs to convert a format Satori can't embed directly — a native binary failing to load
// in some Vercel Node.js function environments must never crash the whole invocation
// (a static `import sharp from 'sharp'` at module-evaluation time did exactly that: every
// og-image/*.js function 500'd immediately on cold start, even collection/inventory
// requests whose art was already a plain JPEG that never touches sharp at all).
let sharpPromise;
function loadSharp() {
  if (!sharpPromise) sharpPromise = import('sharp').then(m => m.default).catch(err => {
    console.error('sharp failed to load:', err);
    return null;
  });
  return sharpPromise;
}

// Satori (the engine behind @vercel/og's ImageResponse) only decodes these raster formats
// natively when rasterizing an embedded <img>. Everything else (webp, avif, ...) — which
// turns out to be the dominant format for at least some WAX collections' card art — gets
// converted to PNG via sharp first, since Satori/resvg can't be taught new formats from
// outside.
const NATIVELY_SUPPORTED = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];

// Resolves an IPFS hash (or a full http(s) URL) to a base64 data URI, trying every
// gateway in turn, converting to PNG first if the source isn't a format Satori can embed
// directly. Returns null on total failure (network down, or truly corrupt/unusable file)
// — the image is always optional in the rendered card, never a reason to fail the whole
// response.
export async function fetchImageDataUriConverting(hashOrUrl, timeoutMs = 5000) {
  if (!hashOrUrl) return null;
  const urls = /^https?:\/\//i.test(hashOrUrl)
    ? [hashOrUrl]
    : IPFS_GATEWAYS.map(gw => gw + hashOrUrl);
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (!res.ok) continue;
      const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      if (NATIVELY_SUPPORTED.includes(contentType)) {
        return `data:${contentType};base64,${buf.toString('base64')}`;
      }
      const sharp = await loadSharp();
      if (!sharp) continue; // sharp unavailable — same file/format at every gateway, but
                             // move on rather than throw; caller treats null as "no image"
      const png = await sharp(buf).png().toBuffer();
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch (err) {
      console.error('fetchImageDataUriConverting failed for', url, err);
      // try next gateway
    }
  }
  return null;
}

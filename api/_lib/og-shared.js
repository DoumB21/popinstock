// Shared helpers for the bot-only dynamic OG functions (api/og-page/*, api/og-image/*)
// and middleware.js. Kept dependency-free and framework-agnostic so it works in both
// the Node.js runtime (og-page/*) and the Edge runtime (og-image/*).

export const SITE_ORIGIN = 'https://www.hoardio.com';

// Mirrors shared/global.css's design tokens (see CLAUDE.md) for the generated OG images.
export const COLORS = {
  bg: '#0a0a0f',
  card: '#13131d',
  textPrimary: '#f0f0f5',
  textSecondary: '#8888aa',
  accent: '#c07828',
  accentLight: '#f0a840',
  border: 'rgba(255,255,255,0.08)',
};

// Minimal hyperscript helper so api/og-image/* can build Satori's element tree
// (@vercel/og's ImageResponse) as plain objects instead of needing a JSX build step.
export function h(type, props, children) {
  return { type, props: { ...props, children } };
}

// Same crawler UAs that must see the dynamic preview instead of the generic default.
export const BOT_UA_RE = /facebookexternalhit|Facebot|Twitterbot|Discordbot|Slackbot-LinkExpanding|Slack-ImgProxy|TelegramBot|LinkedInBot|WhatsApp|Applebot|redditbot|Pinterest|SkypeUriPreview|vkShare/i;

// AtomicAssets: wax.api.atomicassets.io is called out as "the reliable reference" node
// in shared/wax-api.js; detroitledger is the first entry in that file's own pool. This
// is bot-only, low-volume traffic, so a 2-endpoint fallback is enough — no need to port
// the full client-side failover pool.
const AA_BASES = [
  'https://wax.api.atomicassets.io/atomicassets/v1',
  'https://atomic.wax.detroitledger.tech/atomicassets/v1',
];

// Same 3-gateway list used client-side (collection.html / template.html / inventory.html).
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://dweb.link/ipfs/',
];

// Edge runtime has no Node `Buffer` global, so base64-encode via the Web-standard
// btoa() instead (available in both the Edge runtime and modern Node) — keeps this
// module safe to import from middleware.js (Edge) as well as the Node og-page/* functions.
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Fetches an AtomicAssets API path (e.g. "/collections/foo") from the primary node,
// falling back to the secondary on any error/timeout. Returns the parsed `.data` field,
// or throws if both endpoints fail — callers should catch this and fall back to serving
// the plain static file untouched.
export async function fetchAA(path, timeoutMs = 4000) {
  let lastErr;
  for (const base of AA_BASES) {
    try {
      const res = await fetchWithTimeout(base + path, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error('API returned success:false');
      return json.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Satori (the engine behind @vercel/og's ImageResponse) only decodes these raster formats
// when rasterizing an embedded <img>. Anything else (webp, avif, svg, ...) renders as a
// silent blank/broken image instead of throwing — worse than just omitting it, since a
// bad embed can blank out the whole card, not just that one element.
const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];

// Cheap existence/format check (headers only, body discarded) — used by og-page/template.js
// to decide *which* og:image URL to advertise before ever generating a card. Most Funko
// templates have no static `img` at all (animated-only, .mp4 `video` field instead, which
// can't be rasterized without a much heavier video-frame-extraction pipeline) — for those,
// and for the rarer unsupported-format case, the generic site banner is used instead of a
// custom card with a visible gap where the art should be.
export async function isRenderableImage(hashOrUrl, timeoutMs = 3000) {
  if (!hashOrUrl) return false;
  const urls = /^https?:\/\//i.test(hashOrUrl)
    ? [hashOrUrl]
    : IPFS_GATEWAYS.map(gw => gw + hashOrUrl);
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      res.body?.cancel?.();
      if (!res.ok) continue;
      const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
      return SUPPORTED_IMAGE_TYPES.includes(contentType);
    } catch {
      // try next gateway
    }
  }
  return false;
}

// Resolves an IPFS hash (or a full http(s) URL) to a base64 data URI, trying every
// gateway in turn. Returns null on total failure, or if the source file is in a format
// Satori can't embed — the image is always optional in the rendered card, never a reason
// to fail the whole response.
export async function fetchImageDataUri(hashOrUrl, timeoutMs = 3000) {
  if (!hashOrUrl) return null;
  const urls = /^https?:\/\//i.test(hashOrUrl)
    ? [hashOrUrl]
    : IPFS_GATEWAYS.map(gw => gw + hashOrUrl);
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || 'image/png';
      if (!SUPPORTED_IMAGE_TYPES.includes(contentType.split(';')[0].trim())) {
        // Same file, same format, at every gateway — no point trying the others.
        return null;
      }
      const buf = await res.arrayBuffer();
      return `data:${contentType};base64,${arrayBufferToBase64(buf)}`;
    } catch {
      // try next gateway
    }
  }
  return null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/\n/g, ' ');
}

// Mirrors collection.html's renderDescription lightweight-markdown patterns
// ("**bold**", "[label](url)"), but strips to plain text instead of rendering HTML —
// og:description / twitter:description can't contain markup.
export function plainTextFromDescription(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

export function truncate(text, maxLen) {
  const t = String(text ?? '').trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1).trimEnd() + '…' : t;
}

// Fetches a Google Font as a .ttf ArrayBuffer for use with @vercel/og's ImageResponse
// (Satori only supports .ttf/.otf/.woff, not .woff2 — Google's CSS2 API only serves
// .woff2 to modern browser UAs, so requesting with an old UA string is the standard
// trick to get a .ttf `src` back instead).
export async function fetchGoogleFontTtf(family, weight, timeoutMs = 3000) {
  try {
    const cssRes = await fetchWithTimeout(
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`,
      timeoutMs
    );
    // Old UA with no woff2 support — the trick that makes Google serve a .ttf @font-face.
    const css = await (await fetch(cssRes.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; rv:2.0.1) Gecko/20100101 Firefox/4.0.1' },
    })).text();
    const match = css.match(/src: url\((.+?)\) format\('truetype'\)/);
    if (!match) return null;
    const fontRes = await fetchWithTimeout(match[1], timeoutMs);
    if (!fontRes.ok) return null;
    return await fontRes.arrayBuffer();
  } catch {
    return null;
  }
}

// Patches the <title>/<meta description>/og:*/twitter:*/canonical block of a static
// HTML page with per-item values. `html` is the raw file contents; the replacements are
// applied by tag rather than by exact string match so small unrelated edits to the
// surrounding markup don't break this.
export function patchHeadMeta(html, { title, description, url, image }) {
  let out = html;
  out = out.replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  out = out.replace(/<meta name="description" content=".*?"\s*\/?>/, `<meta name="description" content="${escapeAttr(description)}" />`);
  out = out.replace(/<link rel="canonical" href=".*?"\s*\/?>/, `<link rel="canonical" href="${escapeAttr(url)}" />`);
  out = out.replace(/<meta property="og:url" content=".*?"\s*\/?>/, `<meta property="og:url" content="${escapeAttr(url)}" />`);
  out = out.replace(/<meta property="og:title" content=".*?"\s*\/?>/, `<meta property="og:title" content="${escapeAttr(title)}" />`);
  out = out.replace(/<meta property="og:description" content=".*?"\s*\/?>/, `<meta property="og:description" content="${escapeAttr(description)}" />`);
  out = out.replace(/<meta property="og:image" content=".*?"\s*\/?>/, `<meta property="og:image" content="${escapeAttr(image)}" />`);
  out = out.replace(/<meta name="twitter:title" content=".*?"\s*\/?>/, `<meta name="twitter:title" content="${escapeAttr(title)}" />`);
  out = out.replace(/<meta name="twitter:description" content=".*?"\s*\/?>/, `<meta name="twitter:description" content="${escapeAttr(description)}" />`);
  out = out.replace(/<meta name="twitter:image" content=".*?"\s*\/?>/, `<meta name="twitter:image" content="${escapeAttr(image)}" />`);
  return out;
}

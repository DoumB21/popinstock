// Thin wrapper around @wharfkit/web-renderer's vendored QR-SVG encoder
// (used internally there for the Anchor-login QR modal, but not exposed as
// a standalone utility). Reused here rather than hand-ported — it's a real
// Reed-Solomon QR encoder (~1200 lines across its files), not something to
// retype by hand. Dependency-free, no canvas, no CDN — outputs a plain SVG
// string, matching the site's no-external-CDN convention.
import generate from '@wharfkit/web-renderer/src/lib/qrcode/index';

export function generate_qr(text, level, version) {
  return generate(text, level, version);
}

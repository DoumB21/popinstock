(function () {
  if (!location.hostname.includes('popinstock.com')) return;
  const newUrl = location.href.replace('popinstock.com', 'hoardio.com');
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a0f;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  el.innerHTML = `
    <img src="/images/Hoardio_logo.png" alt="Hoardio" style="height:64px;filter:invert(1);margin-bottom:2rem;">
    <h1 style="color:#f0f0f5;font-size:1.75rem;margin:0 0 1rem;">Pop In Stock has a new home.</h1>
    <p style="color:#8888aa;font-size:1.05rem;line-height:1.6;max-width:480px;margin:0 0 2rem;">
      We've moved to <strong style="color:#f0a840;">hoardio.com</strong><br>same tools, same data, better name.<br>Please update your bookmark.
    </p>
    <a href="${newUrl}" style="display:inline-block;background:#c07828;color:#fff;font-weight:700;font-size:1rem;padding:.75rem 2rem;border-radius:8px;text-decoration:none;letter-spacing:.02em;" onmouseover="this.style.background='#f0a840'" onmouseout="this.style.background='#c07828'">Go to Hoardio →</a>
  `;
  document.body.appendChild(el);
})();

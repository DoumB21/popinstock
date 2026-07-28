'use strict';
/* Injects promo content into every <div class="ad-slot"></div> on the page.
   CSS (.ad-slot-card) lives in shared/global.css, same as every other
   shared component on this site.

   This is the ONLY file to edit to change what's promoted (a partner
   project, the Twitch stream, etc.) — host pages just declare an empty
   .ad-slot container and load this script; they never need to change
   again when the promo changes. */
(function () {
  // Edit this to swap the current promo. Set to null for the plain
  // "contact me" placeholder below.
  const PROMO = null;
  // Shape for a real promo, once there is one:
  // const PROMO = { href: 'https://example.com', img: 'https://…', title: 'Project Name', desc: 'One line about it.' };

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function html() {
    if (!PROMO) {
      return `<div class="ad-slot-card">Contact me to promote your project here.</div>`;
    }
    return `<a class="ad-slot-card" href="${esc(PROMO.href)}" target="_blank" rel="noopener">
      ${PROMO.img ? `<img src="${esc(PROMO.img)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0;">` : ''}
      <div>
        <div style="font-weight:600;color:var(--text-primary);">${esc(PROMO.title)}</div>
        <div>${esc(PROMO.desc)}</div>
      </div>
    </a>`;
  }

  function render() {
    document.querySelectorAll('.ad-slot').forEach(el => { el.innerHTML = html(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();

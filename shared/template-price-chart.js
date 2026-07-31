'use strict';
/* Template-pooled price history: a 4-tile stats grid (Highest/Lowest Sale,
   Total Sales, 24h Sales) + a Chart.js dual-axis (price line + volume bars)
   chart with range (1M/3M/6M/1Y/ALL) and currency (WAX/USD) toggles.

   Extracted out of template.html — that page's own "Price History" section
   and asset.html's own (template-pooled, not per-instance — confirmed live
   against AtomicHub's own asset page) Price History section both call this
   with just a different templateId/collectionName and their own empty
   container div. Injects its own markup into that one container; CSS lives
   in shared/global.css under the .tpc- prefix (not page-local <style>,
   since this is now a real shared component — same convention as
   shared/ad-slot.js).

   Usage: TemplatePriceChart.mount({ containerId, templateId, collectionName })
*/
(function () {
  function fmtWax(raw, precision) {
    const n = Number(raw) / (10 ** (precision ?? 8));
    if (!isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' WAX';
  }
  function fmtCompactInt(raw) {
    const n = Number(raw);
    if (!isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'M';
    return n.toLocaleString();
  }
  // Chart y-axis tick label — scales precision to the value's own magnitude
  // (a cheap template whose whole price range sits under 1 WAX would
  // otherwise collapse every tick to "0.01" under a fixed 2-decimals rule).
  function fmtChartPrice(v) {
    if (v >= 10) return Math.round(v).toLocaleString();
    if (v >= 1) return v.toFixed(2);
    return parseFloat(v.toFixed(4)).toString();
  }

  // Same table + Accept-Profile:funko header pattern as every other page's
  // copy of this helper — the funko-schema table itself holds a generic
  // daily WAX/USD rate, not Funko-specific data, so it's fine to read from
  // any page. Requires SUPABASE_URL/SUPABASE_ANON_KEY globals (set by
  // shared/supabase-config.js, already loaded by every page this mounts on).
  async function fetchHistoricalWaxUsdRates(dates) {
    const unique = [...new Set(dates)].filter(Boolean);
    if (!unique.length) return {};
    try {
      const headers = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Accept-Profile': 'funko' };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/wax_usd_rates?rate_date=in.(${unique.join(',')})&select=rate_date,usd_per_wax`, { headers });
      const rows = await r.json();
      return Object.fromEntries((rows || []).map(row => [row.rate_date, row.usd_per_wax]));
    } catch { return {}; }
  }

  // Groups a timestamp into its day/week(Monday)/month bucket key — the
  // granularity is picked from the selected range's actual data span (see
  // render()), same adaptive idea funko/sales-history.html's day/week/month
  // toggle uses manually, just automatic here.
  function bucketKey(ms, unit) {
    const d = new Date(ms);
    if (unit === 'day') return d.toISOString().slice(0, 10);
    if (unit === 'week') {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - dow);
      return monday.toISOString().slice(0, 10);
    }
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  function bucketLabel(key, unit) {
    if (unit === 'month') {
      const [y, m] = key.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    }
    return new Date(key + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const RANGE_DAYS = { '1M': 30, '3M': 90, '6M': 182, '1Y': 365, 'ALL': Infinity };

  function mount(opts) {
    const { containerId, templateId, collectionName } = opts;
    const root = document.getElementById(containerId);
    if (!root) return;

    // Unique inner ids per mount — lets a page host more than one of these
    // (not needed today, but avoids a silent collision if it ever does).
    const uid = containerId;
    root.innerHTML = `
      <div class="stats-grid tpc-stats-grid" id="${uid}-stats"></div>
      <div class="tpc-chart-wrap" style="margin-top:1rem;">
        <div class="tpc-chart-controls">
          <div class="tpc-toggle-group" id="${uid}-range">
            <button class="tpc-toggle-btn" data-range="1M">1M</button>
            <button class="tpc-toggle-btn" data-range="3M">3M</button>
            <button class="tpc-toggle-btn" data-range="6M">6M</button>
            <button class="tpc-toggle-btn" data-range="1Y">1Y</button>
            <button class="tpc-toggle-btn active" data-range="ALL">ALL</button>
          </div>
          <div class="tpc-toggle-group" id="${uid}-currency">
            <button class="tpc-toggle-btn active" data-currency="WAX">WAX</button>
            <button class="tpc-toggle-btn" data-currency="USD">USD</button>
          </div>
        </div>
        <div class="tpc-chart-canvas-wrap" id="${uid}-canvas-wrap"><canvas id="${uid}-canvas"></canvas></div>
      </div>
    `;

    const state = { chart: null, dailyData: [], rateByDate: {}, range: 'ALL', currency: 'WAX' };

    (async () => {
      const mkt = WaxApi.marketBase();

      let priceStats;
      try { priceStats = (await WaxApi.apiFetch(`${mkt}/prices/templates?collection_name=${encodeURIComponent(collectionName)}&template_id=${templateId}&symbol=WAX`))?.[0] || null; }
      catch { priceStats = null; }

      // Prefer the actual highest/lowest-priced single-asset sale record
      // over priceStats.max/min for both the WAX figure and its USD tag —
      // guarantees the two agree with each other and with the historical
      // rate looked up for that sale's own date. Bundle sales (assets.length
      // > 1) are excluded so a multi-asset bundle price isn't misattributed
      // to one template (confirmed live: a 7/8-asset bundle showing 9,999
      // WAX vs. the true single-item high of 4,600 WAX for template 298612).
      let highestSale, lowestSale;
      try {
        const rows = await WaxApi.apiFetch(`${mkt}/sales?template_id=${templateId}&symbol=WAX&state=3&sort=price&order=desc&limit=20`);
        highestSale = (rows || []).find(s => s.assets?.length === 1) || null;
      } catch { highestSale = null; }
      try {
        const rows = await WaxApi.apiFetch(`${mkt}/sales?template_id=${templateId}&symbol=WAX&state=3&sort=price&order=asc&limit=20`);
        lowestSale = (rows || []).find(s => s.assets?.length === 1) || null;
      } catch { lowestSale = null; }
      const [highestSaleRate, lowestSaleRate] = await Promise.all([highestSale, lowestSale].map(async sale => {
        if (!sale) return null;
        const dateKey = new Date(Number(sale.updated_at_time)).toISOString().slice(0, 10);
        const rates = await fetchHistoricalWaxUsdRates([dateKey]);
        return rates[dateKey] ?? null;
      }));

      // Sales in the last rolling 24h — count=true asks the API for just
      // the total instead of paging through matching rows ourselves. Counts
      // bundle sales too (unlike Highest/Lowest Sale) since this is an
      // activity/velocity number, not a per-item price.
      let sales24h = null;
      try {
        const res = await WaxApi.apiFetch(`${mkt}/sales?template_id=${templateId}&symbol=WAX&state=3&after=${Date.now() - 86400000}&count=true`);
        sales24h = Number(res);
      } catch { sales24h = null; }

      const highestWax = highestSale ? fmtWax(highestSale.price.amount, highestSale.price.token_precision)
        : (priceStats ? fmtWax(priceStats.max) : '—');
      const highestUsd = highestSale && highestSaleRate
        ? `<div class="tpc-usd">≈ $${(Number(highestSale.price.amount) / (10 ** highestSale.price.token_precision) * highestSaleRate).toFixed(2)}</div>` : '';
      const lowestWax = lowestSale ? fmtWax(lowestSale.price.amount, lowestSale.price.token_precision)
        : (priceStats ? fmtWax(priceStats.min) : '—');
      const lowestUsd = lowestSale && lowestSaleRate
        ? `<div class="tpc-usd">≈ $${(Number(lowestSale.price.amount) / (10 ** lowestSale.price.token_precision) * lowestSaleRate).toFixed(2)}</div>` : '';
      document.getElementById(`${uid}-stats`).innerHTML = `
        <div class="stat-card"><div class="stat-value">${highestWax}</div>${highestUsd}<div class="stat-label">Highest Sale</div></div>
        <div class="stat-card"><div class="stat-value">${lowestWax}</div>${lowestUsd}<div class="stat-label">Lowest Sale</div></div>
        <div class="stat-card"><div class="stat-value">${priceStats ? fmtCompactInt(priceStats.sales) : '0'}</div><div class="stat-label">Total Sales</div></div>
        <div class="stat-card"><div class="stat-value">${sales24h != null ? fmtCompactInt(sales24h) : '—'}</div><div class="stat-label">24h Sales</div></div>
      `;

      await loadChart();
    })();

    async function loadChart() {
      const wrap = document.getElementById(`${uid}-canvas-wrap`);
      const mkt = WaxApi.marketBase();

      let rows;
      try { rows = await WaxApi.apiFetch(`${mkt}/prices/sales/days?template_id=${templateId}&collection_name=${encodeURIComponent(collectionName)}&symbol=WAX`); }
      catch { rows = null; }

      state.dailyData = (rows || [])
        .map(r => ({ time: Number(r.time), volumeWax: Number(r.volume) / 1e8, sales: Number(r.sales) }))
        .filter(d => isFinite(d.time) && isFinite(d.volumeWax) && d.sales > 0)
        .sort((a, b) => a.time - b.time);

      if (!state.dailyData.length) {
        root.querySelector('.tpc-chart-controls').style.display = 'none';
        wrap.innerHTML = '<div class="tpc-placeholder">No sales yet.</div>';
        return;
      }

      const dateKeys = state.dailyData.map(d => new Date(d.time).toISOString().slice(0, 10));
      state.rateByDate = await fetchHistoricalWaxUsdRates(dateKeys);

      root.querySelectorAll(`#${uid}-range .tpc-toggle-btn`).forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.classList.contains('active')) return;
          state.range = btn.dataset.range;
          root.querySelectorAll(`#${uid}-range .tpc-toggle-btn`).forEach(b => b.classList.toggle('active', b === btn));
          renderChart();
        });
      });
      root.querySelectorAll(`#${uid}-currency .tpc-toggle-btn`).forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.classList.contains('active')) return;
          state.currency = btn.dataset.currency;
          root.querySelectorAll(`#${uid}-currency .tpc-toggle-btn`).forEach(b => b.classList.toggle('active', b === btn));
          renderChart();
        });
      });

      renderChart();
    }

    function renderChart() {
      const wrap = document.getElementById(`${uid}-canvas-wrap`);
      const days = RANGE_DAYS[state.range];
      const cutoff = isFinite(days) ? Date.now() - days * 86400000 : 0;
      const points = state.dailyData.filter(d => d.time >= cutoff);

      if (!points.length) {
        wrap.innerHTML = '<div class="tpc-placeholder">No sales in this range.</div>';
        return;
      }
      if (!wrap.querySelector('canvas')) wrap.innerHTML = `<canvas id="${uid}-canvas"></canvas>`;

      const spanDays = (points[points.length - 1].time - points[0].time) / 86400000;
      const unit = spanDays <= 45 ? 'day' : spanDays <= 200 ? 'week' : 'month';

      // WAX->USD uses that day's own historical rate — days with no rate yet
      // (very recent, not backfilled) are dropped from the USD view rather
      // than shown with a wrong/zero value.
      const toVolumeDisplay = d => {
        if (state.currency !== 'USD') return d.volumeWax;
        const rate = state.rateByDate[new Date(d.time).toISOString().slice(0, 10)];
        return rate ? d.volumeWax * rate : null;
      };

      // Bucket price = bucket volume / bucket sale count — exact (not
      // approximate) since "volume" is already the true sum of that
      // bucket's sale prices.
      const buckets = new Map(); // key -> { volume, sales }
      points.forEach(d => {
        const volume = toVolumeDisplay(d);
        if (volume == null) return;
        const key = bucketKey(d.time, unit);
        let b = buckets.get(key);
        if (!b) { b = { volume: 0, sales: 0 }; buckets.set(key, b); }
        b.volume += volume;
        b.sales += d.sales;
      });

      const keys = [...buckets.keys()].sort();
      const labels = keys.map(k => bucketLabel(k, unit));
      const priceData = keys.map(k => { const b = buckets.get(k); return b.sales ? b.volume / b.sales : 0; });
      const volumeData = keys.map(k => buckets.get(k).volume);

      const fmtAmount = v => state.currency === 'USD' ? '$' + fmtChartPrice(v) : fmtChartPrice(v) + ' WAX';

      if (state.chart) { state.chart.destroy(); state.chart = null; }
      const ctx = document.getElementById(`${uid}-canvas`).getContext('2d');
      state.chart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              type: 'bar', label: 'Volume', data: volumeData,
              backgroundColor: 'rgba(59,130,246,0.35)', borderRadius: 3,
              yAxisID: 'y1', order: 2,
            },
            {
              type: 'line', label: 'Price', data: priceData,
              borderColor: '#f0a840', backgroundColor: 'rgba(240,168,64,0.12)',
              borderWidth: 2, fill: true, tension: 0.3,
              pointRadius: keys.length > 40 ? 0 : 3, pointHoverRadius: 6,
              pointBackgroundColor: '#f0a840',
              yAxisID: 'y', order: 1,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1a1a2a', borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1, titleColor: '#fff', padding: 10,
              callbacks: {
                label: ctx => (ctx.dataset.label === 'Price' ? 'Avg price: ' : 'Volume: ') + fmtAmount(ctx.parsed.y),
              },
            },
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: 'rgba(255,255,255,0.45)', font: { size: 11 }, maxTicksLimit: 12 },
            },
            y: {
              position: 'left',
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#f0a840', font: { size: 11 }, callback: fmtAmount },
            },
            y1: {
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: { color: '#3b82f6', font: { size: 11 }, callback: fmtAmount },
              beginAtZero: true,
            },
          },
        },
      });
    }
  }

  window.TemplatePriceChart = { mount };
})();

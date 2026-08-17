'use strict';
/* Collection-wide sales volume chart: a Chart.js dual-axis (avg price line +
   sales-count bars) chart with range (1M/3M/6M/1Y/ALL) and currency
   (WAX/USD) toggles — collection-scoped sibling of shared/template-price-chart.js
   (same .tpc- CSS classes, same AtomicMarket /prices/sales/days endpoint,
   just filtered by collection_name alone instead of one template_id). No
   stats-grid tiles here — collection.html's own statsGrid already shows
   All-Time Volume/Sales, so repeating Highest/Lowest/24h Sales figures
   scoped to a single template wouldn't make sense at the collection level.

   Usage: CollectionSalesChart.mount({ containerId, collectionName })
*/
(function () {
  function fmtChartPrice(v) {
    if (v >= 10) return Math.round(v).toLocaleString();
    if (v >= 1) return v.toFixed(2);
    return parseFloat(v.toFixed(4)).toString();
  }
  function fmtCompactInt(raw) {
    const n = Number(raw);
    if (!isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'M';
    return n.toLocaleString();
  }

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

  function bucketKey(ms, unit) {
    const d = new Date(ms);
    if (unit === 'day') return d.toISOString().slice(0, 10);
    if (unit === 'week') {
      const dow = (d.getUTCDay() + 6) % 7;
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - dow);
      return monday.toISOString().slice(0, 10);
    }
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  function bucketLabel(key, unit) {
    if (unit === 'month') {
      const [y, m] = key.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }
    return new Date(key + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  const RANGE_DAYS = { '1M': 30, '3M': 90, '6M': 182, '1Y': 365, 'ALL': Infinity };

  function mount(opts) {
    const { containerId, collectionName } = opts;
    const root = document.getElementById(containerId);
    if (!root) return;

    const uid = containerId;
    root.innerHTML = `
      <div class="tpc-chart-wrap">
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
      const wrap = document.getElementById(`${uid}-canvas-wrap`);
      const mkt = WaxApi.marketBase();

      let rows;
      try { rows = await WaxApi.apiFetch(`${mkt}/prices/sales/days?collection_name=${encodeURIComponent(collectionName)}&symbol=WAX`); }
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
    })();

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
      const unitLabel = unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month';

      const toVolumeDisplay = d => {
        if (state.currency !== 'USD') return d.volumeWax;
        const rate = state.rateByDate[new Date(d.time).toISOString().slice(0, 10)];
        return rate ? d.volumeWax * rate : null;
      };

      const buckets = new Map();
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
      const salesData = keys.map(k => buckets.get(k).sales);

      const fmtAmount = v => state.currency === 'USD' ? '$' + fmtChartPrice(v) : fmtChartPrice(v) + ' WAX';

      if (state.chart) { state.chart.destroy(); state.chart = null; }
      const ctx = document.getElementById(`${uid}-canvas`).getContext('2d');
      state.chart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              type: 'bar', label: 'Sales', data: salesData,
              backgroundColor: 'rgba(59,130,246,0.35)', borderRadius: 3,
              yAxisID: 'y1', order: 2,
            },
            {
              type: 'line', label: 'Avg Price', data: priceData,
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
                title: items => `${unitLabel}: ${items[0]?.label ?? ''}`,
                label: ctx => ctx.dataset.label === 'Avg Price'
                  ? 'Avg price: ' + fmtAmount(ctx.parsed.y)
                  : 'Sales: ' + ctx.parsed.y.toLocaleString(),
                afterBody: items => {
                  const idx = items[0]?.dataIndex;
                  return idx == null ? [] : ['Volume: ' + fmtAmount(volumeData[idx])];
                },
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
              ticks: { color: '#3b82f6', font: { size: 11 }, callback: v => Number.isInteger(v) ? fmtCompactInt(v) : '' },
              beginAtZero: true,
            },
          },
        },
      });
    }
  }

  window.CollectionSalesChart = { mount };
})();

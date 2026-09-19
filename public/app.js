/* =========================================================
   Expenso dashboard
   Data contract (unchanged): GET /api/dashboard/data
   rows: { Date, Amount, Category, Description|Merchant, "Need/Want" }
   ========================================================= */

const CAT_COLORS = [
    '#0F8B8D', '#9B4F96', '#7C8B2E', '#D1495B', '#5C6AC4',
    '#B08968', '#4EA5D9', '#3E9B5F', '#C9A227', '#7A8599'
];
const TYPE_LABEL = { need: 'Need', want: 'Want', other: 'Unspecified' };
const PAGE_SIZE = 10;

const currMonth = new Date().toISOString().slice(0, 7);

const state = {
    range: `month-${currMonth}`,
    from: '',
    to: '',
    type: 'all',      // all | need | want | other
    cats: new Set(),
    q: '',
    trend: 'daily',   // daily | weekly | cumulative
    sort: { key: 'date', dir: 'desc' },
    focus: null,      // { from, to, label, prep } set by clicking a chart bar
    page: 1
};

let all = [];
let bounds = { min: '', max: '' };
let catColor = {};
let token = null;
let trendChart = null;
let trendBuckets = [];
let skipAnim = false;

const $ = id => document.getElementById(id);

/* ---------- Formatting helpers ---------- */
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = n => INR.format(Math.round(n));
const compact = n => {
    if (n >= 100000) return '₹' + (n / 100000).toFixed(1).replace(/\.0$/, '') + 'L';
    if (n >= 1000) return '₹' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return '₹' + Math.round(n);
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Date helpers (all UTC, YYYY-MM-DD strings) ---------- */
const D = s => new Date(s + 'T00:00:00Z');
const S = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return S(d); };
const diffDays = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const weekStart = s => addDays(s, -((D(s).getUTCDay() + 6) % 7));
const fmtShort = s => D(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtLong = s => D(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    generateMonthButtons();
    bindEvents();

    const params = new URLSearchParams(window.location.search);
    const authStatus = $('authStatus');

    if (params.has('demo')) {
        authStatus.textContent = 'Sample data';
        authStatus.className = 'status demo';
        setData(normalize(demoData()));
        return;
    }

    const urlToken = params.get('token');
    if (urlToken) {
        localStorage.setItem('auth_token', urlToken);
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    token = localStorage.getItem('auth_token');

    if (!token) {
        signedOut('You are not signed in. Send <strong>/dashboard</strong> to the Telegram bot and open the link it replies with, or <a href="?demo=1">preview with sample data</a>.');
        setData([]);
        return;
    }

    authStatus.textContent = 'Signed in';
    authStatus.className = 'status ok';
    await loadData();
});

function signedOut(message) {
    const s = $('authStatus');
    s.textContent = 'Not signed in';
    s.className = 'status';
    showNotice(message);
}

function showNotice(html) { const n = $('notice'); n.innerHTML = html; n.hidden = false; }
function hideNotice() { $('notice').hidden = true; }

async function loadData() {
    try {
        let url = '/api/dashboard/data';

        const today = new Date().toISOString().slice(0, 10);
        let start = '', end = today;

        if (state.range === '7d') start = addDays(today, -6);
        else if (state.range === '30d') start = addDays(today, -29);
        else if (state.range.startsWith('month-')) {
            const ym = state.range.split('-').slice(1).join('-');
            start = `${ym}-01`;
            const [y, m] = ym.split('-');
            const eD = new Date(Date.UTC(y, m, 0));
            end = eD.toISOString().slice(0, 10);
        }
        else if (state.range === 'custom') {
            start = state.from || today;
            end = state.to || today;
        } else if (state.range === 'all') {
            start = '';
            end = '';
        }

        if (start && end) {
            url += `?start=${start}&end=${end}`;
        }

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401 || response.status === 403) {
            localStorage.removeItem('auth_token');
            token = null;
            signedOut('Your session has expired. Send <strong>/dashboard</strong> in Telegram to get a new link.');
            return;
        }

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        hideNotice();
        setData(normalize(data));
    } catch (err) {
        console.error('Failed fetching data:', err);
        showNotice('Could not load your sheet data. Check your connection and select <strong>Sync sheets</strong> to try again.');
    }
}

/* ---------- Data ---------- */
function normalize(raw) {
    return (Array.isArray(raw) ? raw : [])
        .map(r => {
            const nw = String(r['Need/Want'] || '').trim().toLowerCase();
            return {
                date: String(r.Date || '').substring(0, 10),
                desc: r.Description || r.Merchant || 'Untitled',
                cat: r.Category || 'Uncategorised',
                type: nw === 'need' || nw === 'want' ? nw : 'other',
                amount: Number(String(r.Amount ?? '').replace(/[₹,\s]/g, ''))
            };
        })
        .filter(r => r.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

function setData(rows) {
    all = rows;
    if (rows.length) {
        const ds = rows.map(r => r.date).sort();
        bounds = { min: ds[0], max: ds[ds.length - 1] };
    } else {
        const today = S(new Date());
        bounds = { min: today, max: today };
    }

    // Stable colour per category (ranked by all-time spend)
    const totals = {};
    rows.forEach(r => { totals[r.cat] = (totals[r.cat] || 0) + r.amount; });
    catColor = {};
    Object.keys(totals).sort((a, b) => totals[b] - totals[a])
        .forEach((c, i) => { catColor[c] = CAT_COLORS[i % CAT_COLORS.length]; });

    state.cats = new Set([...state.cats].filter(c => totals[c]));
    state.page = 1;
    render();
}

function resolveRange() {
    const { min, max } = bounds;
    switch (state.range) {
        case '7d': return [addDays(max, -6), max];
        case '30d': return [addDays(max, -29), max];
        case 'custom': return [state.from || min, state.to || max];
        default: 
            if (state.range.startsWith('month-')) {
                const ym = state.range.split('-').slice(1).join('-');
                const start = `${ym}-01`;
                let end;
                if (ym === currMonth) {
                    end = new Date().toISOString().slice(0, 10);
                } else {
                    const [y, m] = ym.split('-');
                    const eD = new Date(Date.UTC(y, m, 0));
                    end = eD.toISOString().slice(0, 10);
                }
                return [start, end];
            }
            return [min, max];
    }
}

/* Faceted selection: each panel ignores its own filter so you can see the alternatives */
function select({ skipType = false, skipCat = false, range = null } = {}) {
    const [f, t] = range || resolveRange();
    const q = state.q.trim().toLowerCase();
    return all.filter(r =>
        r.date >= f && r.date <= t &&
        (skipType || state.type === 'all' || r.type === state.type) &&
        (skipCat || !state.cats.size || state.cats.has(r.cat)) &&
        (!q || r.desc.toLowerCase().includes(q) || r.cat.toLowerCase().includes(q))
    );
}

const sum = rows => rows.reduce((a, r) => a + r.amount, 0);

/* ---------- Render ---------- */
function render() {
    const [f, t] = resolveRange();
    // Drop a bar selection that no longer falls inside the date range
    if (state.focus && (state.focus.to < f || state.focus.from > t)) state.focus = null;
    const rows = select();
    renderFilters(f, t);
    renderCatMenu();
    renderHero(rows, f, t);
    renderCats();
    renderTrend(rows, f, t);
    renderTable(tableRows(rows));
}

/* The table follows every filter plus the selected chart bar; the charts ignore the bar */
function tableRows(rows = select()) {
    const fc = state.focus;
    return fc ? rows.filter(r => r.date >= fc.from && r.date <= fc.to) : rows;
}

/* ---------- Gear menu: one checkbox per category ---------- */
function renderCatMenu() {
    const list = $('catMenuList');
    const activeEl = document.activeElement;
    const keep = activeEl && list.contains(activeEl) ? activeEl.dataset.cat : null;

    const spend = {};
    select({ skipCat: true }).forEach(r => { spend[r.cat] = (spend[r.cat] || 0) + r.amount; });
    const names = Object.keys(catColor);
    const allOn = state.cats.size === 0;

    list.innerHTML = names.length ? names.map(n => `
        <li><label class="menu-item">
            <input type="checkbox" data-cat="${esc(n)}" ${allOn || state.cats.has(n) ? 'checked' : ''}>
            <span class="dot" style="background:${catColor[n]}"></span>
            <span class="name">${esc(n)}</span>
            <span class="amt">${spend[n] ? money(spend[n]) : '-'}</span>
        </label></li>`).join('') : '<li class="cat-empty">No categories yet.</li>';

    if (keep) {
        const el = [...list.querySelectorAll('input')].find(i => i.dataset.cat === keep);
        if (el) el.focus();
    }

    const badge = $('gearBadge');
    badge.hidden = allOn;
    badge.textContent = state.cats.size;
    $('catAll').hidden = allOn;
}

function setMenu(open) {
    $('catMenuPanel').hidden = !open;
    $('catMenuBtn').setAttribute('aria-expanded', String(open));
}

/* ---------- Chart click: list that bucket's transactions ---------- */
function pickBucket(i) {
    const start = trendBuckets[i];
    if (!start) return;
    const [f, t] = resolveRange();
    const weekly = state.trend === 'weekly';
    const from = weekly && start < f ? f : start;
    const end = weekly ? addDays(start, 6) : start;
    const to = end > t ? t : end;

    const same = state.focus && state.focus.from === from && state.focus.to === to;
    state.focus = same ? null : {
        from, to,
        label: weekly ? `${fmtShort(from)} to ${fmtShort(to)}` : fmtLong(from),
        prep: weekly ? 'during' : 'on'
    };
    state.page = 1;
    skipAnim = true;
    render();
    skipAnim = false;

    if (state.focus) {
        const panel = $('transactions');
        if (panel.getBoundingClientRect().top > window.innerHeight - 220) {
            const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            panel.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
        }
    }
}

function renderFilters(f, t) {
    document.querySelectorAll('#rangeSeg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.range === state.range)));
    document.querySelectorAll('#typeSeg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.type === state.type)));
    document.querySelectorAll('#trendSeg button').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.mode === state.trend)));

    const custom = state.range === 'custom';
    $('customRange').hidden = !custom;
    if (custom) {
        $('fromDate').value = f;
        $('toDate').value = t;
    }

    $('rangeLabel').textContent = `${fmtLong(f)} to ${fmtLong(t)}`;

    // Active filter chips
    const chips = [];
    if (state.type !== 'all') {
        chips.push(`<span class="chip">${esc(TYPE_LABEL[state.type])} only<button type="button" data-clear-type aria-label="Remove ${esc(TYPE_LABEL[state.type])} filter">&times;</button></span>`);
    }
    if (state.cats.size > 3) {
        chips.push(`<span class="chip">${state.cats.size} of ${Object.keys(catColor).length} categories<button type="button" data-clear-cats aria-label="Include all categories">&times;</button></span>`);
    } else {
        state.cats.forEach(c => {
            chips.push(`<span class="chip"><span class="dot" style="background:${catColor[c] || '#999'}"></span>${esc(c)}<button type="button" data-clear-cat="${esc(c)}" aria-label="Remove ${esc(c)} filter">&times;</button></span>`);
        });
    }
    if (state.q.trim()) {
        chips.push(`<span class="chip">Search: ${esc(state.q.trim())}<button type="button" data-clear-q aria-label="Clear search">&times;</button></span>`);
    }
    $('activeChips').innerHTML = chips.join('');
    $('chipsRow').hidden = chips.length === 0;
}

function renderHero(rows, f, t) {
    const total = sum(rows);
    const days = diffDays(f, t) + 1;
    const largest = rows.reduce((m, r) => (r.amount > m.amount ? r : m), { amount: 0, desc: '-' });

    $('totalSpend').textContent = money(total);
    $('totalTxns').textContent = rows.length.toLocaleString('en-IN');
    $('avgDaily').textContent = money(total / Math.max(days, 1));
    $('highestExpense').textContent = money(largest.amount);
    $('highestExpenseName').textContent = largest.amount ? largest.desc : 'No transactions';

    // Change vs previous period of equal length
    const delta = $('delta');
    delta.hidden = true;
    if (state.range !== 'all') {
        const prev = [addDays(f, -days), addDays(f, -1)];
        if (prev[0] >= bounds.min) {
            const prevTotal = sum(select({ range: prev }));
            if (prevTotal > 0) {
                const pct = ((total - prevTotal) / prevTotal) * 100;
                const down = pct <= 0;
                delta.className = 'delta ' + (down ? 'good' : 'bad');
                delta.textContent = `${Math.abs(pct).toFixed(0)}% ${down ? 'lower' : 'higher'} than the previous ${days} days`;
                delta.hidden = false;
            }
        }
    }

    renderSplit();
}

function renderSplit() {
    const rows = select({ skipType: true });
    const totals = { need: 0, want: 0, other: 0 };
    rows.forEach(r => { totals[r.type] += r.amount; });
    const total = totals.need + totals.want + totals.other;
    const keys = ['need', 'want', 'other'].filter(k => totals[k] > 0);
    const filtered = state.type !== 'all';

    const split = $('split');
    split.classList.toggle('filtered', filtered);

    if (!total) {
        split.innerHTML = '<div class="seg-empty">No spending to split</div>';
        $('splitLegend').innerHTML = '';
        return;
    }

    const colour = k => `var(--${k})`;
    split.innerHTML = keys.map(k => {
        const pct = (totals[k] / total) * 100;
        return `<button type="button" data-type="${k}" style="flex:${totals[k]} 1 0;background:${colour(k)}"
            aria-pressed="${state.type === k}" aria-label="${TYPE_LABEL[k]}: ${money(totals[k])}, ${pct.toFixed(0)}%">${pct >= 9 ? pct.toFixed(0) + '%' : ''}</button>`;
    }).join('');

    $('splitLegend').innerHTML = keys.map(k => {
        const pct = (totals[k] / total) * 100;
        return `<button type="button" class="legend-item" data-type="${k}" aria-pressed="${state.type === k}">
            <span class="dot" style="background:${colour(k)}"></span>
            <span class="name">${TYPE_LABEL[k]}</span>
            <span class="amt">${money(totals[k])}</span>
            <span class="pct">${pct.toFixed(0)}%</span></button>`;
    }).join('');
}

function renderCats() {
    const rows = select({ skipCat: true });
    const groups = {};
    rows.forEach(r => {
        const g = groups[r.cat] || (groups[r.cat] = { total: 0, need: 0, want: 0, other: 0 });
        g.total += r.amount;
        g[r.type] += r.amount;
    });
    // Keep selected categories visible even if they have no spend under other filters
    state.cats.forEach(c => { if (!groups[c]) groups[c] = { total: 0, need: 0, want: 0, other: 0 }; });

    const list = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
    const grand = list.reduce((a, [, g]) => a + g.total, 0);
    const max = list.length ? list[0][1].total : 0;
    const ul = $('catList');

    ul.classList.toggle('has-selection', state.cats.size > 0);

    if (!list.length) {
        ul.innerHTML = '<li class="cat-empty">No categories in this range.</li>';
        return;
    }

    ul.innerHTML = list.map(([name, g]) => {
        const c = catColor[name] || '#999';
        const width = max ? (g.total / max) * 100 : 0;
        const part = k => (g.total ? (g[k] / g.total) * 100 : 0);
        const pct = grand ? (g.total / grand) * 100 : 0;
        return `<li><button type="button" class="cat-row" data-cat="${esc(name)}" aria-pressed="${state.cats.has(name)}">
            <span class="cat-top">
                <span class="dot" style="background:${c}"></span>
                <span class="cat-name">${esc(name)}</span>
                <span class="cat-amt">${money(g.total)}</span>
                <span class="cat-pct">${pct.toFixed(0)}%</span>
            </span>
            <span class="cat-track"><span class="cat-fill" style="width:${width}%;">
                <i style="width:${part('need')}%;background:${c}"></i><i class="want" style="width:${part('want')}%;background:${c}"></i><i class="other" style="width:${part('other')}%;background:${c}"></i>
            </span></span>
        </button></li>`;
    }).join('');
}

/* ---------- Trend chart ---------- */
function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return {
        need: v('--need'), want: v('--want'), other: v('--other'),
        ink: v('--ink'), surface: v('--surface'), line: v('--line'), muted: v('--muted')
    };
}

function buildTrend(rows, f, t) {
    const weekly = state.trend === 'weekly';
    const key = weekly ? weekStart : d => d;
    const step = weekly ? 7 : 1;
    const labels = [];
    const idx = {};
    for (let cur = weekly ? weekStart(f) : f; cur <= t; cur = addDays(cur, step)) {
        idx[cur] = labels.length;
        labels.push(cur);
    }
    const sets = { need: labels.map(() => 0), want: labels.map(() => 0), other: labels.map(() => 0) };
    rows.forEach(r => {
        const i = idx[key(r.date)];
        if (i !== undefined) sets[r.type][i] += r.amount;
    });
    return { labels, sets };
}

function renderTrend(rows, f, t) {
    const c = themeColors();
    const mode = state.trend;
    const { labels, sets } = buildTrend(rows, f, t);
    const totals = labels.map((_, i) => sets.need[i] + sets.want[i] + sets.other[i]);

    // Remember buckets for click handling and find the selected one so we can highlight it
    trendBuckets = labels;
    const focusIdx = state.focus
        ? labels.indexOf(mode === 'weekly' ? weekStart(state.focus.from) : state.focus.from)
        : -1;
    const shade = col => ctx => (focusIdx < 0 || ctx.dataIndex === focusIdx ? col : col + '4D');

    $('trendEmpty').hidden = rows.length > 0;
    const unit = mode === 'weekly' ? 'week' : 'day';
    $('trendSub').textContent = mode === 'cumulative'
        ? 'Running total. Select a point to list that day\'s transactions.'
        : `Needs and wants by ${unit}. Select a bar to list its transactions.`;

    Chart.defaults.color = c.muted;
    Chart.defaults.font.family = "'Instrument Sans', system-ui, sans-serif";

    if (trendChart) trendChart.destroy();
    const ctx = $('trendChart').getContext('2d');

    let datasets, type;
    if (mode === 'cumulative') {
        type = 'line';
        let run = 0;
        const gradient = ctx.createLinearGradient(0, 0, 0, 320);
        gradient.addColorStop(0, c.need + '44');
        gradient.addColorStop(1, c.need + '00');
        datasets = [{
            label: 'Cumulative spend',
            data: totals.map(v => (run += v)),
            borderColor: c.need, backgroundColor: gradient, fill: true,
            tension: 0.2, borderWidth: 2.5, pointHoverRadius: 5,
            pointBackgroundColor: c.need, pointRadius: ctx => (ctx.dataIndex === focusIdx ? 6 : 0)
        }];
    } else {
        type = 'bar';
        datasets = [['need', 'Need'], ['want', 'Want'], ['other', 'Unspecified']]
            .filter(([k]) => k !== 'other' || sets.other.some(v => v > 0))
            .map(([k, label]) => ({
                label, data: sets[k], backgroundColor: shade(c[k]),
                borderRadius: 3, borderSkipped: false, maxBarThickness: 28, stack: 's'
            }));
    }

    trendChart = new Chart(ctx, {
        type,
        data: { labels: labels.map(fmtShort), datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            ...(skipAnim ? { animation: false } : {}),
            interaction: { mode: 'index', intersect: false },
            onClick: (evt, _els, chart) => {
                const pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
                if (!pts.length) return;
                const i = pts[0].index;
                // Defer: pickBucket re-renders and destroys this chart
                setTimeout(() => pickBucket(i), 0);
            },
            plugins: {
                legend: {
                    display: mode !== 'cumulative',
                    align: 'end',
                    labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 16 }
                },
                tooltip: {
                    backgroundColor: c.ink, titleColor: c.surface, bodyColor: c.surface, footerColor: c.surface,
                    padding: 10, cornerRadius: 8, boxPadding: 4,
                    callbacks: {
                        title: items => (mode === 'weekly' ? 'Week of ' : '') + items[0].label,
                        label: item => ` ${item.dataset.label}: ${money(item.parsed.y)}`,
                        footer: items => (mode !== 'cumulative' && items.length > 1
                            ? 'Total ' + money(items.reduce((a, i) => a + i.parsed.y, 0)) : '')
                    }
                }
            },
            scales: {
                x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
                y: { stacked: true, beginAtZero: true, border: { display: false }, grid: { color: c.line }, ticks: { maxTicksLimit: 5, callback: v => compact(v) } }
            }
        }
    });
}

/* ---------- Table ---------- */
const comparators = {
    date: (a, b) => a.date.localeCompare(b.date),
    desc: (a, b) => a.desc.localeCompare(b.desc),
    cat: (a, b) => a.cat.localeCompare(b.cat),
    type: (a, b) => a.type.localeCompare(b.type),
    amount: (a, b) => a.amount - b.amount
};

function sortedRows(rows) {
    const { key, dir } = state.sort;
    const m = dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => comparators[key](a, b) * m);
}

function renderTable(rows) {
    const sorted = sortedRows(rows);
    const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const slice = sorted.slice(start, start + PAGE_SIZE);

    document.querySelectorAll('#txnTable th').forEach(th => {
        const btn = th.querySelector('button');
        th.setAttribute('aria-sort', btn.dataset.sort === state.sort.key
            ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });

    document.querySelector('#txnTable tbody').innerHTML = slice.map(r => `
        <tr>
            <td class="date">${fmtLong(r.date)}</td>
            <td class="desc" title="${esc(r.desc)}">${esc(r.desc)}</td>
            <td class="cat"><span><span class="dot" style="background:${catColor[r.cat] || '#999'}"></span>${esc(r.cat)}</span></td>
            <td><span class="badge ${r.type}">${TYPE_LABEL[r.type]}</span></td>
            <td class="num amount">${money(r.amount)}</td>
        </tr>`).join('');

    const empty = sorted.length === 0;
    $('txnEmpty').hidden = !empty;
    $('txnTable').closest('.table-container').hidden = empty;
    $('pager').hidden = empty;
    const fc = state.focus;
    const where = fc ? ` ${fc.prep} ${fc.label}` : '';
    $('txnSub').textContent = empty
        ? (fc ? `No transactions${where}` : 'Nothing to show')
        : `${sorted.length.toLocaleString('en-IN')} transaction${sorted.length === 1 ? '' : 's'}${where}, totalling ${money(sum(sorted))}`;
    $('focusChip').hidden = !fc;
    if (fc) {
        $('focusChip').innerHTML = `<span class="chip">${esc(fc.label)}<button type="button" data-clear-focus aria-label="Show all dates">&times;</button></span>`;
    }
    $('emptyMsg').textContent = fc ? `No transactions${where} with the current filters.` : 'No transactions match these filters.';
    $('emptyClear').textContent = fc ? 'Show all dates' : 'Clear filters';
    $('pagerInfo').textContent = empty ? '' : `Showing ${start + 1} to ${start + slice.length} of ${sorted.length.toLocaleString('en-IN')}`;
    $('prevPage').disabled = state.page <= 1;
    $('nextPage').disabled = state.page >= pages;
}

/* ---------- Export ---------- */
function exportCsv() {
    const rows = sortedRows(tableRows());
    const cell = v => {
        let s = String(v);
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    };
    const csv = [
        'Date,Description,Category,Need/Want,Amount',
        ...rows.map(r => [r.date, cell(r.desc), cell(r.cat), TYPE_LABEL[r.type], r.amount].join(','))
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `expenses-${resolveRange().join('_to_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

/* ---------- Events ---------- */
function resetFilters() {
    state.type = 'all';
    state.cats.clear();
    state.q = '';
    $('search').value = '';
    state.page = 1;
    render();
}

function bindEvents() {
    $('rangeSeg').addEventListener('click', async e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.range === 'custom' && state.range !== 'custom') {
            [state.from, state.to] = resolveRange();
        }

        const changed = state.range !== b.dataset.range;
        state.range = b.dataset.range;
        state.page = 1;

        if (changed) {
            const btn = $('syncBtn');
            if (btn) btn.textContent = 'Loading...';
            await loadData();
            if (btn) btn.textContent = 'Sync sheets';
        } else {
            render();
        }
    });

    const onDate = async () => {
        state.from = $('fromDate').value || bounds.min;
        state.to = $('toDate').value || bounds.max;
        if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
        state.page = 1;

        const btn = $('syncBtn');
        if (btn) btn.textContent = 'Loading...';
        await loadData();
        if (btn) btn.textContent = 'Sync sheets';
    };
    $('fromDate').addEventListener('change', onDate);
    $('toDate').addEventListener('change', onDate);

    $('typeSeg').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        state.type = b.dataset.type;
        state.page = 1;
        render();
    });

    // Needs/wants bar and legend both toggle the type filter
    const toggleType = e => {
        const b = e.target.closest('button[data-type]');
        if (!b) return;
        state.type = state.type === b.dataset.type ? 'all' : b.dataset.type;
        state.page = 1;
        render();
    };
    $('split').addEventListener('click', toggleType);
    $('splitLegend').addEventListener('click', toggleType);

    $('catList').addEventListener('click', e => {
        const b = e.target.closest('button[data-cat]');
        if (!b) return;
        const c = b.dataset.cat;
        state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
        state.page = 1;
        render();
    });

    $('activeChips').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if ('clearType' in b.dataset) state.type = 'all';
        if ('clearCat' in b.dataset) state.cats.delete(b.dataset.clearCat);
        if ('clearCats' in b.dataset) state.cats.clear();
        if ('clearQ' in b.dataset) { state.q = ''; $('search').value = ''; }
        state.page = 1;
        render();
    });

    $('clearBtn').addEventListener('click', resetFilters);
    $('emptyClear').addEventListener('click', () => {
        if (state.focus) { state.focus = null; render(); } else resetFilters();
    });
    $('focusChip').addEventListener('click', e => {
        if (!e.target.closest('button')) return;
        state.focus = null;
        state.page = 1;
        render();
    });

    let timer;
    $('search').addEventListener('input', e => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.q = e.target.value; state.page = 1; render(); }, 150);
    });

    $('trendSeg').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        state.trend = b.dataset.mode;
        state.focus = null; // bucket size changed, so the old selection no longer maps to a bar
        render();
    });

    document.querySelector('#txnTable thead').addEventListener('click', e => {
        const b = e.target.closest('button[data-sort]');
        if (!b) return;
        const key = b.dataset.sort;
        state.sort = state.sort.key === key
            ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: key === 'date' || key === 'amount' ? 'desc' : 'asc' };
        render();
    });

    $('prevPage').addEventListener('click', () => { state.page--; render(); });
    $('nextPage').addEventListener('click', () => { state.page++; render(); });
    $('exportBtn').addEventListener('click', exportCsv);

    // Gear menu
    $('catMenuBtn').addEventListener('click', () => setMenu($('catMenuPanel').hidden));
    $('catAll').addEventListener('click', () => { state.cats.clear(); state.page = 1; render(); });
    $('catMenuList').addEventListener('change', e => {
        const input = e.target.closest('input[data-cat]');
        if (!input) return;
        const name = input.dataset.cat;
        const names = Object.keys(catColor);
        if (input.checked) {
            state.cats.add(name);
        } else {
            if (state.cats.size === 0) names.forEach(n => state.cats.add(n)); // leaving "all": start from everything
            state.cats.delete(name);
            if (state.cats.size === 0) state.cats.add(name);                  // always keep one selected
        }
        if (state.cats.size >= names.length) state.cats.clear();              // everything ticked equals no filter
        state.page = 1;
        render();
    });
    document.addEventListener('click', e => {
        if (!$('catMenuPanel').hidden && !$('catMenu').contains(e.target)) setMenu(false);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('catMenuPanel').hidden) { setMenu(false); $('catMenuBtn').focus(); }
    });

    $('themeBtn').addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('theme', next); } catch (_) { /* ignore */ }
        render();
    });

    $('syncBtn').addEventListener('click', async () => {
        const btn = $('syncBtn');
        if (!token) {
            showNotice('Sign in first: send <strong>/dashboard</strong> to the Telegram bot and open the link it replies with.');
            return;
        }
        btn.disabled = true;
        btn.textContent = 'Syncing...';
        await loadData();
        btn.disabled = false;
        btn.textContent = 'Sync sheets';
    });
}

function initTheme() {
    let t = null;
    try { t = localStorage.getItem('theme'); } catch (_) { /* ignore */ }
    if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
}

/* ---------- Sample data (open the page with ?demo=1) ---------- */
function demoData() {
    let seed = 42;
    const rnd = () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = a => a[Math.floor(rnd() * a.length)];
    const between = (a, b) => Math.round((a + rnd() * (b - a)) / 10) * 10;

    const catalog = [
        { cat: 'Food & dining', type: null, w: 5, r: [150, 950], items: ['Swiggy order', 'Zomato order', 'Third Wave Coffee', 'Truffles', 'Lunch with team'] },
        { cat: 'Groceries', type: 'Need', w: 3, r: [300, 2200], items: ['BigBasket', 'Blinkit', 'Nature\'s Basket', 'Local vegetable market'] },
        { cat: 'Transport', type: 'Need', w: 4, r: [60, 480], items: ['Uber ride', 'Namma Yatri auto', 'Metro top-up', 'Petrol'] },
        { cat: 'Shopping', type: 'Want', w: 2, r: [700, 5500], items: ['Amazon', 'Myntra', 'Decathlon', 'Croma'] },
        { cat: 'Entertainment', type: 'Want', w: 2, r: [199, 1200], items: ['PVR tickets', 'Spotify', 'Netflix', 'Steam'] },
        { cat: 'Health', type: 'Need', w: 1, r: [250, 2400], items: ['Apollo Pharmacy', 'Cult.fit', 'Dental checkup'] },
        { cat: 'Bills & utilities', type: 'Need', w: 1, r: [400, 2600], items: ['Airtel broadband', 'BESCOM electricity', 'Jio recharge'] },
        { cat: 'Travel', type: 'Want', w: 1, r: [1500, 9000], items: ['IndiGo flight', 'Hotel booking', 'RedBus'] }
    ];
    const bag = catalog.flatMap(c => Array(c.w).fill(c));

    const rows = [];
    for (let d = '2026-08-01'; d <= '2026-09-19'; d = addDays(d, 1)) {
        if (d.endsWith('-01')) {
            rows.push({ Date: d, Description: 'House rent', Category: 'Rent', 'Need/Want': 'Need', Amount: 28000 });
        }
        const n = Math.floor(rnd() * 4);
        for (let i = 0; i < n; i++) {
            const c = pick(bag);
            rows.push({
                Date: d,
                Description: pick(c.items),
                Category: c.cat,
                'Need/Want': c.type || (rnd() > 0.35 ? 'Want' : 'Need'),
                Amount: between(c.r[0], c.r[1])
            });
        }
    }
    return rows;
}

function generateMonthButtons() {
    const seg = $('rangeSeg');
    
    const oldBtn = seg.querySelector('[data-range="month"]');
    if (oldBtn) oldBtn.remove();
    const allBtn = seg.querySelector('[data-range="all"]');
    if (allBtn) allBtn.remove();
    
    const customBtn = seg.querySelector('[data-range="custom"]');

    const start = new Date(Date.UTC(2026, 6, 1)); // 6 = July
    const today = new Date();
    let cur = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));

    while (cur >= start) {
        const y = cur.getUTCFullYear();
        const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
        const val = `month-${y}-${m}`;
        const label = cur.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
        
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.range = val;
        btn.textContent = label;
        
        seg.insertBefore(btn, customBtn);
        
        cur.setUTCMonth(cur.getUTCMonth() - 1);
    }
}
import {analyze, cellStats, dist, makeGrid, parseCsv, timeline} from './model.js';
import {findUnusual} from './unusual.js';
import {showDevices} from './devices.js';

const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const css = v => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(v).trim();
const SERIES = ['--series-1', '--series-2', '--series-3'];
const TRAVELER_M = 400; // heard over a stretch this long -> it is moving with you
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const fmtT = ms => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});

const map = L.map('map', {preferCanvas: true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap'}).addTo(map);
const layer = L.layerGroup().addTo(map);
const focus = L.layerGroup().addTo(map);
let unusual = [], ufilter = 'all';

let raw = [];   // [{name, rows, color, on}]
let hunts = []; // analyzed, same order

const files = (await (await fetch('/hunts')).json()).slice(0, 3).reverse();
raw = await Promise.all(files.map(async (f, i) => ({
  name: f.name, size: f.size, on: true, color: SERIES[i % 3],
  rows: parseCsv(await (await fetch('/hunts/' + f.name)).text()),
})));

function label(name) {
  const m = name.match(/hunt_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : name;
}

function recompute() {
  const merge = $('merge').checked;
  hunts = raw.map(r => {
    const h = analyze(r.rows, {merge});
    for (const d of h.devices) d.traveler = d.spread > TRAVELER_M;
    let len = 0;
    for (let i = 1; i < h.fixes.length; i++) len += dist(h.fixes[i - 1], h.fixes[i]);
    return Object.assign(h, {name: r.name, color: r.color, on: r.on, len});
  });
  unusual = findUnusual(hunts);
  renderHunts();
  renderUnusual();
  render();
}

function renderHunts() {
  const minN = +$('minN').value;
  $('hunts').innerHTML = hunts.map((h, i) => {
    const dur = ((h.sightings.at(-1)?.t ?? 0) - (h.fixes[0]?.t ?? h.sightings[0]?.t ?? 0)) / 60000;
    const kept = h.devices.filter(d => d.n >= minN).length;
    return `<label class="hunt"><input type="checkbox" data-i="${i}" ${h.on ? 'checked' : ''}>
      <span class="sw" style="background:var(${h.color})"></span>
      <span>${label(h.name)}<small>${dur.toFixed(1)} min · ${(h.len / 1000).toFixed(2)} km · ${h.sightings.length} sightings<br>
      ${h.rawMacs} raw MACs → ${h.devices.length} after folding → ${kept} heard ≥${minN}×</small></span></label>`;
  }).join('');
  $('hunts').querySelectorAll('input').forEach(cb => cb.onchange = () => { raw[+cb.dataset.i].on = hunts[+cb.dataset.i].on = cb.checked; render(); });
}

function render() {
  const on = hunts.filter(h => h.on);
  const minN = +$('minN').value, cellM = +$('cell').value, mode = $('layer').value, hideTrav = $('trav').checked;
  $('minNv').textContent = minN; $('cellv').textContent = cellM + ' m';
  layer.clearLayers();
  const allFix = on.flatMap(h => h.fixes);
  if (!allFix.length) return;

  if (mode === 'rate') {
    const grid = makeGrid(allFix[0], cellM);
    const cells = cellStats(on, grid, {minN, excludeTravelers: hideTrav}).filter(c => c.macs.size && c.dwell > 0);
    const rates = cells.map(c => c.rate).sort((a, b) => a - b);
    const q = rates.length ? RAMP.map((_, i) => rates[Math.floor(i / RAMP.length * rates.length)]) : [];
    const step = r => { let s = 0; for (let i = 0; i < q.length; i++) if (r >= q[i]) s = i; return s; };
    for (const c of cells) {
      const thin = c.dwell < 4;
      L.rectangle(grid.bounds(c.k), {
        stroke: true, weight: 1, color: '#ffffff', opacity: 0.6,
        fillColor: RAMP[step(c.rate)], fillOpacity: thin ? 0.35 : 0.8,
      }).bindTooltip(`<b>${c.rate.toFixed(1)} devices/min</b><br>${c.macs.size} devices · ${c.dwell.toFixed(0)} s spent here${thin ? '<br><i>passed through quickly: low confidence</i>' : ''}`, {sticky: true})
        .on('click', () => showCell(c)).addTo(layer);
    }
    $('legend').innerHTML = q.length ? `<div class="legend"><span>${q[0].toFixed(1)}</span>
      <div class="ramp" style="background:linear-gradient(90deg,${RAMP.join(',')})"></div><span>${rates.at(-1).toFixed(0)}/min</span></div>
      <p class="sub" style="margin-top:6px">Unique devices heard in each cell ÷ minutes the phone spent in it, so stopping at a light doesn't inflate an area. Faded = passed in under 4 s.</p>` : '';
  } else if (mode === 'spots') {
    $('legend').innerHTML = `<p class="sub">Each dot is one device, placed at the average phone position while it was heard; size = sightings. With only 2 power levels and no RSSI, this is ±the radio range (tens of metres), and a single drive-by can't tell which side of the street it's on.</p>`;
  } else $('legend').innerHTML = '';

  for (const h of on) {
    L.polyline(h.fixes.map(f => [f.lat, f.lon]), {color: css(h.color), weight: 3, opacity: mode === 'rate' ? 0.9 : 1}).addTo(layer);
    if (mode === 'spots') {
      for (const d of h.devices) {
        if (d.n < minN || !d.centroid || (hideTrav && d.traveler)) continue;
        L.circleMarker([d.centroid.lat, d.centroid.lon], {
          radius: Math.max(4, Math.min(16, Math.sqrt(d.n) * 1.6)), weight: 2, color: '#ffffff',
          fillColor: d.police ? css('--critical') : css(h.color), fillOpacity: 0.75,
        }).bindTooltip(devLine(d)).on('click', () => showDevice(d, h)).addTo(layer);
      }
    }
  }
  if (!render.fitted) { map.fitBounds(L.latLngBounds(allFix.map(f => [f.lat, f.lon])).pad(0.05)); render.fitted = true; }

  renderFindings(on);
  renderDevTable(on, minN);
  drawCharts(on);
}

function devLine(d) {
  return `<b>${esc(d.name || d.vendor || 'unnamed')}</b>${d.name && d.vendor ? ' · ' + esc(d.vendor) : ''}<br><code>${d.mac}</code> · ${d.n} sightings${d.shards ? ` (+${d.shards} shard MACs)` : ''}${d.police ? `<br><b style="color:var(--critical)">⚠ ${esc(d.police)}</b>` : ''}`;
}

function showCell(c) {
  $('detailH').textContent = `Cell: ${c.macs.size} devices, ${c.dwell.toFixed(0)} s`;
  const ds = [...c.macs.values()].sort((a, b) => b.n - a.n);
  $('detail').innerHTML = `<table>${ds.slice(0, 40).map(d => `<tr><td>${esc(d.name || d.vendor || '—')}<br><code>${d.mac}</code></td><td class="n">${d.n}</td></tr>`).join('')}</table>${ds.length > 40 ? `<p class="sub">…and ${ds.length - 40} more</p>` : ''}`;
}

function showDevice(d, h) {
  $('detailH').textContent = 'Device';
  $('detail').innerHTML = `<p>${devLine(d)}</p><p class="sub">Heard ${fmtT(d.first)}–${fmtT(d.last)} on hunt ${label(h.name)}, over ~${d.spread.toFixed(0)} m of track.</p>
    <p class="sub">First AD: <code style="word-break:break-all">${esc(d.sightings[0].ad)}</code></p>`;
}

function renderFindings(on) {
  const raw = on.reduce((s, h) => s + h.rawMacs, 0), merged = on.reduce((s, h) => s + h.merged, 0);
  const allS = on.flatMap(h => h.sightings);
  const crcS = allS.filter(s => s.crc === 'S').length;
  const police = on.flatMap(h => h.devices.filter(d => d.police));
  const trav = on.flatMap(h => h.devices.filter(d => d.traveler && d.n >= 5));
  const multi = new Map();
  for (const h of on) for (const d of h.devices) if (d.n >= 3) multi.set(d.mac, (multi.get(d.mac) ?? 0) + 1);
  const shared = [...multi.values()].filter(v => v > 1).length;
  $('findings').innerHTML = [
    `<div class="finding"><b>${police.length ? police.length + ' police matches' : 'No police matches'}</b> in the selected hunts.</div>`,
    `<div class="finding"><b>${(crcS / allS.length * 100).toFixed(2)}% of sightings are CRC:S</b> (structure only, CRC never captured). Bit errors survive, so one device shows up under many MACs and names (net → jet/nat/nEt).</div>`,
    `<div class="finding"><b>${merged} of ${raw} MACs (${(merged / raw * 100).toFixed(0)}%)</b> are within 2 bits of a much louder MAC heard at the same moment, which makes them shards. ${$('merge').checked ? 'Folded in.' : 'Folding is off.'}</div>`,
    `<div class="finding"><b>${trav.length ? trav.length + ' device(s) rode along' : 'Nothing rode along with you'}</b> (heard over more than ${TRAVELER_M} m of track)${trav.length ? ': ' + trav.slice(0, 4).map(d => esc(d.name || d.vendor || d.mac)).join(', ') : ''}.</div>`,
    `<div class="finding"><b>${shared}</b> devices (≥3 sightings) appear in more than one selected hunt. These are fixed devices on streets you drove twice, or near home.</div>`,
  ].join('');
}

function renderDevTable(on, minN) {
  const ds = on.flatMap(h => h.devices.filter(d => d.n >= minN).map(d => ({d, h}))).sort((a, b) => b.d.n - a.d.n).slice(0, 25);
  $('devtable').innerHTML = ds.map(({d, h}) => `<tr style="cursor:pointer" data-mac="${d.mac}" data-h="${h.name}">
    <td><span class="sw" style="display:inline-block;width:8px;height:3px;border-radius:2px;background:var(${h.color});vertical-align:middle"></span>
    ${esc(d.name || d.vendor || '—')}${d.name && d.vendor ? `<br><code>${esc(d.vendor)}</code>` : ''}</td>
    <td class="n">${d.n}${d.shards ? `<br><code>+${d.shards}</code>` : ''}</td></tr>`).join('');
  $('devtable').querySelectorAll('tr').forEach(tr => tr.onclick = () => {
    const h = hunts.find(x => x.name === tr.dataset.h), d = h.devices.find(x => x.mac === tr.dataset.mac);
    showDevice(d, h);
    if (d.centroid) map.setView([d.centroid.lat, d.centroid.lon], Math.max(map.getZoom(), 17));
  });
}

// ---- charts: hand-drawn SVG lines, shared x = seconds since hunt start ----
function drawCharts(on) {
  const series = on.map(h => ({h, pts: timeline(h, 10)}));
  lineChart($('c1'), series.map(s => ({h: s.h, pts: s.pts.map(p => ({x: p.s, y: p.devices}))})), v => v.toFixed(0));
  lineChart($('c2'), series.map(s => ({h: s.h, pts: s.pts.filter(p => p.kmh != null).map(p => ({x: p.s, y: p.kmh}))})), v => v.toFixed(0) + ' km/h');
}

function lineChart(el, series, fmt) {
  const svg = el.querySelector('svg'), tip = el.querySelector('.tip');
  el.querySelector('.lg').innerHTML = series.map(s => `<span><i style="background:var(${s.h.color})"></i>${label(s.h.name)}</span>`).join('');
  const W = svg.clientWidth || 600, H = 150, m = {l: 34, r: 10, t: 8, b: 20};
  const xs = series.flatMap(s => s.pts.map(p => p.x)), ys = series.flatMap(s => s.pts.map(p => p.y));
  const xMax = Math.max(60, ...xs), yMax = niceMax(Math.max(1, ...ys));
  const X = x => m.l + x / xMax * (W - m.l - m.r), Y = y => H - m.b - y / yMax * (H - m.t - m.b);
  const grid = css('--grid'), muted = css('--text-muted');
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = yMax * i / 4; g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${grid}"/><text x="${m.l - 6}" y="${Y(v) + 3}" text-anchor="end" font-size="10" fill="${muted}">${v.toFixed(0)}</text>`; }
  for (let t = 0; t <= xMax; t += 60) g += `<text x="${X(t)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="${muted}">${t / 60}m</text>`;
  for (const s of series) {
    if (!s.pts.length) continue;
    g += `<path d="${s.pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join('')}" fill="none" stroke="${css(s.h.color)}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  g += `<line class="xh" y1="${m.t}" y2="${H - m.b}" stroke="${muted}" stroke-dasharray="2 3" visibility="hidden"/>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;
  const xh = svg.querySelector('.xh');
  svg.onmousemove = e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width;
    const x = Math.max(0, Math.min(xMax, (px - m.l) / (W - m.l - m.r) * xMax));
    xh.setAttribute('x1', X(x)); xh.setAttribute('x2', X(x)); xh.setAttribute('visibility', 'visible');
    const rows = series.map(s => { let best = null; for (const p of s.pts) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; return best && Math.abs(best.x - x) <= 15 ? `<div><i style="display:inline-block;width:8px;height:2px;background:var(${s.h.color});vertical-align:middle;margin-right:4px"></i>${label(s.h.name)}: <b>${fmt(best.y)}</b></div>` : ''; }).join('');
    tip.innerHTML = `<div style="color:var(--text-secondary)">${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')} in</div>${rows}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX - el.getBoundingClientRect().left + 12, el.clientWidth - 160) + 'px';
    tip.style.top = '30px';
  };
  svg.onmouseleave = () => { tip.style.display = 'none'; xh.setAttribute('visibility', 'hidden'); };
}
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p; return 10 * p; }

['layer', 'minN', 'cell', 'trav'].forEach(id => $(id).oninput = () => { renderHunts(); render(); });
$('merge').onchange = recompute;
window.onresize = () => drawCharts(hunts.filter(h => h.on));

// ---- second tab: unusual devices ----
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('pane-map').hidden = name !== 'map';
  $('pane-unusual').hidden = name !== 'unusual';
  $('pane-devices').hidden = name !== 'devices';
  document.querySelector('.viz-root').classList.toggle('wide', name === 'devices');
  if (name === 'devices') showDevices();
  if (name === 'map') { map.invalidateSize(); drawCharts(hunts.filter(h => h.on)); }
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

const FILTERS = [
  ['all', 'All'], ['tracker', 'Trackers'], ['camera', 'Meta / camera'], ['fleet', 'Fleet & modems'],
  ['police', 'Police'], ['mobile', 'Moved between hunts'], ['follow', 'Followed you'], ['range', 'Long range'], ['rare', 'Rare kind'],
];
const HOT = new Set(['police', 'tracker', 'camera', 'follow', 'fleet']);

function renderUnusual() {
  $('ucount').textContent = `(${unusual.length})`;
  const count = tag => unusual.filter(u => u.reasons.some(r => r.tag === tag && r.pts > 0)).length;
  $('ufilters').innerHTML = FILTERS.filter(([t]) => t === 'all' || count(t))
    .map(([t, l]) => `<button data-f="${t}" aria-pressed="${t === ufilter}">${l} ${t === 'all' ? unusual.length : count(t)}</button>`).join('');
  $('ufilters').querySelectorAll('button').forEach(b => b.onclick = () => { ufilter = b.dataset.f; renderUnusual(); });

  const rows = ufilter === 'all' ? unusual : unusual.filter(u => u.reasons.some(r => r.tag === ufilter && r.pts > 0));
  const max = Math.max(1, ...unusual.map(u => u.score));
  $('utable').innerHTML = `<thead><tr><th>Score</th><th>Device</th><th>What it advertises</th><th>Why it stands out</th><th>Hunts</th><th style="text-align:right">Sightings</th><th style="text-align:right">Heard</th></tr></thead>
  <tbody>${rows.map((u, i) => {
    const first = Math.min(...u.group.map(g => g.d.first)), last = Math.max(...u.group.map(g => g.d.last));
    return `<tr data-i="${unusual.indexOf(u)}">
      <td><div class="score"><i style="width:${(u.score / max * 48).toFixed(0)}px"></i>${u.score}</div></td>
      <td><b>${esc(u.d.name || u.d.vendor || 'unnamed')}</b>${u.d.name && u.d.vendor ? `<br><span class="sub">${esc(u.d.vendor)}</span>` : ''}<br><code>${u.d.mac}</code>${u.d.shards ? ` <code>+${u.d.shards} shards</code>` : ''}</td>
      <td style="color:var(--text-secondary)">${esc(u.kind)}</td>
      <td>${u.reasons.map(r => `<p class="why"><span class="tag${HOT.has(r.tag) ? ' hot' : ''}">${r.tag}</span>${esc(r.why)}</p>`).join('')}</td>
      <td style="white-space:nowrap">${u.group.map(g => `<div><span style="display:inline-block;width:10px;height:3px;border-radius:2px;background:var(${g.h.color});vertical-align:middle;margin-right:5px"></span>${label(g.h.name)}</div>`).join('')}</td>
      <td class="num">${u.n}</td>
      <td class="num">${fmtT(first)}<br><span class="sub">${u.group.length > 1 ? u.group.map(g => Math.max(1, Math.round((g.d.last - g.d.first) / 1000)) + " s").join(" + ") : Math.max(1, Math.round((last - first) / 1000)) + " s span"}</span></td>
    </tr>`;
  }).join('')}</tbody>`;
  $('utable').querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => focusDevice(unusual[+tr.dataset.i]));
}

function focusDevice(u) {
  showTab('map');
  focus.clearLayers();
  const pts = [];
  for (const g of u.group) {
    for (const s of g.d.sightings) {
      if (s.lat == null) continue;
      pts.push([s.lat, s.lon]);
      L.circleMarker([s.lat, s.lon], {radius: 6, weight: 2, color: css('--critical'), fillColor: css(g.h.color), fillOpacity: 0.9})
        .bindTooltip(`${fmtT(s.t)} · ${label(g.h.name)}${s.shardOf ? `<br>as shard <code>${s.shardOf}</code>` : ''}`).addTo(focus);
    }
  }
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.6), {maxZoom: 18});
  showDevice(u.d, u.h);
  $('detail').insertAdjacentHTML('beforeend', `<p class="sub">${u.reasons.map(r => `<span class="tag${HOT.has(r.tag) ? ' hot' : ''}">${r.tag}</span>${esc(r.why)}`).join('<br>')}</p>
    <p><button id="clearFocus" style="font:inherit">Clear highlight</button></p>`);
  $('clearFocus').onclick = () => focus.clearLayers();
}

// ---- start ----
const [hashLayer, hashTab] = location.hash.slice(1).split("/");
if (hashLayer) $("layer").value = hashLayer;
recompute();
if (hashTab) showTab(hashTab);

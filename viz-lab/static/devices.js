// Devices tab: every sighting drawn at the phone's position when it was
// heard, one color per device, on MapLibre + OpenFreeMap (same stack as
// ../super-atlas). A device's dots bunch up along the stretch of road where
// it was in range; that bunch is the "where is it" answer. Select devices
// to isolate them and draw their estimated spot and uncertainty circle.

import {analyze, parseCsv} from './model.js';
import {findUnusual} from './unusual.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const css = v => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(v).trim();
const fmtT = ms => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
const label = name => { const m = name.match(/hunt_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/); return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : name; };

// ---- per-device color: stable hash of the MAC -> OKLCH hue, red band left out (reserved for police) ----
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function oklchHex(L, C, hDeg) {
  const h = hDeg * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return '#' + rgb.map(v => { v = Math.max(0, Math.min(1, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, '0'); }).join('');
}
function deviceColor(mac) {
  const x = hash(mac);
  const hue = 45 + (x % 300);                 // skip 345..45: the police red band
  const L = (dark() ? 0.70 : 0.60) + ((x >>> 9) % 3 - 1) * 0.06; // three lightness steps add separation
  return oklchHex(L, 0.15, hue);
}

// ---- state ----
const cache = new Map(); // file name -> analyzed hunt
let files = [], picked = new Set(), devices = [], hunts = [];
let filter = 'all', minN = 3, query = '', showOthers = true, fan = true;
const selected = new Set();
let map, ready = false, hoverPopup, clickPopup;

async function loadHunt(name) {
  if (!cache.has(name)) {
    const rows = parseCsv(await (await fetch('/hunts/' + name)).text());
    const h = analyze(rows, {merge: true});
    for (const d of h.devices) d.traveler = d.spread > 400;
    cache.set(name, Object.assign(h, {name}));
  }
  return cache.get(name);
}

/** Combine the picked hunts' devices by MAC. */
async function rebuild() {
  hunts = await Promise.all([...picked].sort().map(loadHunt));
  const byMac = new Map();
  for (const h of hunts) for (const d of h.devices) {
    let x = byMac.get(d.mac);
    if (!x) byMac.set(d.mac, x = {mac: d.mac, name: '', vendor: '', police: '', n: 0, sightings: [], hunts: new Set(), color: deviceColor(d.mac), tags: []});
    x.name ||= d.name; x.vendor ||= d.vendor; x.police ||= d.police;
    x.n += d.n; x.hunts.add(h.name);
    for (const s of d.sightings) if (s.lat != null) x.sightings.push({...s, hunt: h.name});
  }
  for (const u of findUnusual(hunts)) { const x = byMac.get(u.d.mac); if (x) { x.score = u.score; x.tags = u.reasons.filter(r => r.pts > 0).map(r => r.tag); } }
  devices = [...byMac.values()].filter(d => d.sightings.length).sort((a, b) => b.n - a.n);
  for (const d of devices) d.est = estimate(d.sightings);
  for (const m of [...selected]) if (!byMac.has(m)) selected.delete(m);
  renderList();
  renderMap(true);
}

/** Estimated spot: mean of phone positions while heard; radius: RMS distance from it (min 15 m). */
function estimate(ss) {
  let lat = 0, lon = 0;
  for (const s of ss) { lat += s.lat; lon += s.lon; }
  lat /= ss.length; lon /= ss.length;
  const k = Math.cos(lat * Math.PI / 180) * 111320;
  let sq = 0;
  for (const s of ss) sq += ((s.lat - lat) * 111320) ** 2 + ((s.lon - lon) * k) ** 2;
  return {lat, lon, r: Math.max(15, Math.sqrt(sq / ss.length))};
}

function visible() {
  const q = query.toLowerCase();
  return devices.filter(d => {
    if (d.n < minN) return false;
    if (filter === 'police' && !d.police) return false;
    if (filter === 'notpolice' && d.police) return false;
    if (filter === 'unusual' && !d.score) return false;
    if (q && !`${d.name} ${d.vendor} ${d.mac}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ---- left panel ----
async function renderFiles() {
  files = await (await fetch('/hunts')).json();
  if (!picked.size) files.slice(0, 3).forEach(f => picked.add(f.name));
  $('dv-files').innerHTML = files.map(f => `<label class="dv-file"><input type="checkbox" value="${esc(f.name)}" ${picked.has(f.name) ? 'checked' : ''}>
    <span>${label(f.name)}<small>${(f.size / 1024).toFixed(0)} KB</small></span></label>`).join('');
  $('dv-files').querySelectorAll('input').forEach(cb => cb.onchange = () => { cb.checked ? picked.add(cb.value) : picked.delete(cb.value); rebuild(); });
}

function renderList() {
  const vis = visible();
  const counts = {all: devices.filter(d => d.n >= minN).length, police: devices.filter(d => d.n >= minN && d.police).length,
    notpolice: devices.filter(d => d.n >= minN && !d.police).length, unusual: devices.filter(d => d.n >= minN && d.score).length};
  document.querySelectorAll('#dv-filter button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.f === filter));
    b.querySelector('span').textContent = counts[b.dataset.f];
  });
  $('dv-sel').innerHTML = selected.size
    ? `${selected.size} selected · <button id="dv-clear" class="linkish">clear</button> · <label style="display:inline-flex;margin:0"><input type="checkbox" id="dv-others" ${showOthers ? 'checked' : ''}> show others faintly</label>`
    : `${vis.length} devices · ${vis.reduce((s, d) => s + d.sightings.length, 0)} sightings. Click a device to isolate it; shift-click adds more.`;
  $('dv-clear')?.addEventListener('click', () => { selected.clear(); renderList(); renderMap(); });
  $('dv-others')?.addEventListener('change', e => { showOthers = e.target.checked; renderMap(); });
  const rows = vis.slice(0, 400);
  $('dv-list').innerHTML = rows.map(d => `<li data-mac="${d.mac}" class="${selected.has(d.mac) ? 'sel' : ''}">
    <i style="background:${d.police ? css('--critical') : d.color}"></i>
    <span class="nm">${esc(d.name || d.vendor || 'unnamed')}${d.police ? ` <b class="pol">${esc(d.police)}</b>` : ''}${d.tags.length ? ` <em>${d.tags.slice(0, 2).join(', ')}</em>` : ''}<br><code>${d.mac}</code>${d.name && d.vendor ? ` <code>${esc(d.vendor)}</code>` : ''}</span>
    <span class="ct">${d.n}${d.hunts.size > 1 ? `<br><small>${d.hunts.size} hunts</small>` : ''}</span></li>`).join('') +
    (vis.length > rows.length ? `<li class="more">…${vis.length - rows.length} more: raise min sightings or search</li>` : '');
  $('dv-list').querySelectorAll('li[data-mac]').forEach(li => li.onclick = e => select(li.dataset.mac, e.shiftKey));
}

function select(mac, add) {
  if (add) selected.has(mac) ? selected.delete(mac) : selected.add(mac);
  else if (selected.size === 1 && selected.has(mac)) selected.clear();
  else { selected.clear(); selected.add(mac); }
  renderList();
  renderMap();
}

// ---- map ----
function circle(lat, lon, r, steps = 48) {
  const k = Math.cos(lat * Math.PI / 180) * 111320, ring = [];
  for (let i = 0; i <= steps; i++) { const a = i / steps * 2 * Math.PI; ring.push([lon + r * Math.cos(a) / k, lat + r * Math.sin(a) / 111320]); }
  return [ring];
}

// Fan-out: each device gets a fixed direction and 4-12 m distance, so devices heard at the same
// GPS fix sit side by side instead of hiding under each other. Positions are only good to tens
// of metres anyway (they are where the phone was, not where the device is).
function fanOffset(mac, lat) {
  if (!fan) return [0, 0];
  const x = hash(mac + '/fan'), a = (x % 3600) / 3600 * 2 * Math.PI, r = 4 + ((x >>> 12) % 9);
  return [r * Math.cos(a) / (Math.cos(lat * Math.PI / 180) * 111320), r * Math.sin(a) / 111320];
}

function renderMap(fit = false) {
  if (!ready) return;
  const vis = visible(), sel = selected.size > 0, police = css('--critical');
  const on = [], off = [];
  for (const d of vis) {
    const target = !sel || selected.has(d.mac) ? on : off;
    const [dx, dy] = fanOffset(d.mac, d.est.lat);
    for (const s of d.sightings) target.push({type: 'Feature', geometry: {type: 'Point', coordinates: [s.lon + dx, s.lat + dy]},
      properties: {mac: d.mac, color: d.police ? police : d.color, police: d.police ? 1 : 0, t: s.t, hunt: s.hunt}});
  }
  // police on top
  on.sort((a, b) => a.properties.police - b.properties.police);
  map.getSource('pts').setData({type: 'FeatureCollection', features: on});
  map.getSource('dim').setData({type: 'FeatureCollection', features: sel && showOthers ? off : []});
  const est = devices.filter(d => selected.has(d.mac)).map(d => ({type: 'Feature',
    geometry: {type: 'Polygon', coordinates: circle(d.est.lat, d.est.lon, d.est.r)},
    properties: {color: d.police ? police : d.color, label: `${d.name || d.vendor || d.mac}\n±${d.est.r.toFixed(0)} m`}}));
  map.getSource('est').setData({type: 'FeatureCollection', features: est});
  map.getSource('estpt').setData({type: 'FeatureCollection', features: devices.filter(d => selected.has(d.mac)).map(d => ({type: 'Feature',
    geometry: {type: 'Point', coordinates: [d.est.lon, d.est.lat]}, properties: {color: d.police ? police : d.color, label: `${d.name || d.vendor || d.mac}\n±${d.est.r.toFixed(0)} m`}}))});
  map.getSource('tracks').setData({type: 'FeatureCollection', features: hunts.map(h => ({type: 'Feature',
    geometry: {type: 'LineString', coordinates: h.fixes.map(f => [f.lon, f.lat])}, properties: {}}))});
  if (fit) {
    const b = new maplibregl.LngLatBounds();
    hunts.forEach(h => h.fixes.forEach(f => b.extend([f.lon, f.lat])));
    if (!b.isEmpty()) map.fitBounds(b, {padding: 40, duration: 0});
  }
}

function initMap() {
  map = new maplibregl.Map({
    container: 'dv-map',
    style: `https://tiles.openfreemap.org/styles/${dark() ? 'dark' : 'positron'}`,
    center: [-73.82, 42.72], zoom: 14, attributionControl: {compact: true},
    canvasContextAttributes: {preserveDrawingBuffer: location.search.includes('shot')},
  });
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
  map.addControl(new maplibregl.ScaleControl({unit: 'metric'}), 'bottom-left');
  if (location.search.includes('shot')) window.__dvmap = map; // test hook
  map.on('error', e => console.error('map error', e.error?.message ?? e));
  map.once('idle', () => console.log('map idle', map.queryRenderedFeatures({layers: ['pts']}).length, 'dots rendered'));
  map.on('load', () => {
    const empty = {type: 'FeatureCollection', features: []};
    for (const id of ['tracks', 'dim', 'pts', 'est', 'estpt']) map.addSource(id, {type: 'geojson', data: empty});
    const surface = dark() ? '#1a1a19' : '#ffffff';
    map.addLayer({id: 'tracks', type: 'line', source: 'tracks', paint: {'line-color': dark() ? '#8f8e86' : '#52514e', 'line-width': 2, 'line-opacity': 0.55}, layout: {'line-cap': 'round', 'line-join': 'round'}});
    map.addLayer({id: 'dim', type: 'circle', source: 'dim', paint: {'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 17, 4], 'circle-color': dark() ? '#5a5955' : '#b8b7b1', 'circle-opacity': 0.45}});
    map.addLayer({id: 'est-fill', type: 'fill', source: 'est', paint: {'fill-color': ['get', 'color'], 'fill-opacity': 0.12}});
    map.addLayer({id: 'est-line', type: 'line', source: 'est', paint: {'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2, 2]}});
    map.addLayer({id: 'pts', type: 'circle', source: 'pts', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, ['case', ['==', ['get', 'police'], 1], 4, 2.5], 17, ['case', ['==', ['get', 'police'], 1], 9, 6]],
      'circle-color': ['get', 'color'], 'circle-opacity': 0.8,
      'circle-stroke-color': surface, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 0, 16, 1],
    }});
    map.addLayer({id: 'estpt', type: 'circle', source: 'estpt', paint: {'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': surface, 'circle-stroke-width': 2.5}});
    map.addLayer({id: 'estlbl', type: 'symbol', source: 'estpt', layout: {'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top'},
      paint: {'text-color': dark() ? '#f0efec' : '#0b0b0b', 'text-halo-color': surface, 'text-halo-width': 1.6}});

    hoverPopup = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 8, className: 'dv-pop'});
    // Hit testing: a 12 px radius around the pointer, much larger than the dots,
    // nearest dot first. Used by both hover and click.
    const HIT = 12;
    const hits = (pt, layers) => map.queryRenderedFeatures([[pt.x - HIT, pt.y - HIT], [pt.x + HIT, pt.y + HIT]], {layers})
      .map(f => { const q = map.project(f.geometry.coordinates); return {f, d2: (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2}; })
      .filter(h => h.d2 <= HIT * HIT).sort((a, b) => a.d2 - b.d2).map(h => h.f);
    map.on('mousemove', e => {
      const f = hits(e.point, ['pts'])[0];
      if (!f) { map.getCanvas().style.cursor = ''; hoverPopup.remove(); return; }
      map.getCanvas().style.cursor = 'pointer';
      const p = f.properties, d = devices.find(x => x.mac === p.mac);
      hoverPopup.setLngLat(f.geometry.coordinates).setHTML(`<b>${esc(d.name || d.vendor || 'unnamed')}</b>${d.police ? `<br><b style="color:${css('--critical')}">${esc(d.police)}</b>` : ''}<br><code>${d.mac}</code><br>${fmtT(p.t)} · ${label(p.hunt)}`).addTo(map);
    });
    map.on('mouseout', () => { map.getCanvas().style.cursor = ''; hoverPopup.remove(); });
    // Click: everything heard at that spot (dots overlap: same phone position).
    // Click on empty map: deselect.
    map.on('click', e => {
      const fs = hits(e.point, ['pts', 'dim']);
      if (!fs.length) {
        clickPopup?.remove();
        if (selected.size) { selected.clear(); renderList(); renderMap(); }
        return;
      }
      const macs = [...new Set(fs.map(f => f.properties.mac))];
      if (macs.length === 1) { select(macs[0], e.originalEvent.shiftKey); return; }
      const ds = macs.map(m => devices.find(d => d.mac === m)).sort((a, b) => b.n - a.n);
      clickPopup?.remove();
      clickPopup = new maplibregl.Popup({offset: 8, maxWidth: '300px', className: 'dv-pop'}).setLngLat(e.lngLat)
        .setHTML(`<b>${ds.length} devices heard here</b><ul class="dv-pick">${ds.slice(0, 30).map(d => `<li data-mac="${d.mac}"><i style="background:${d.police ? css('--critical') : d.color}"></i>${esc(d.name || d.vendor || d.mac)} <small>${d.n}</small></li>`).join('')}</ul>`)
        .addTo(map);
      clickPopup.getElement().querySelectorAll('li').forEach(li => li.onclick = ev => { select(li.dataset.mac, ev.shiftKey); clickPopup.remove(); });
    });
    ready = true;
    renderMap(true);
  });
}

let started = false;
export async function showDevices() {
  if (started) { map?.resize(); return; }
  started = true;
  document.querySelectorAll('#dv-filter button').forEach(b => b.onclick = () => { filter = b.dataset.f; renderList(); renderMap(); });
  $('dv-min').oninput = e => { minN = +e.target.value; $('dv-minv').textContent = minN; renderList(); renderMap(); };
  $('dv-fan').onchange = e => { fan = e.target.checked; renderMap(); };
  $('dv-q').oninput = e => { query = e.target.value; renderList(); renderMap(); };
  initMap();
  await renderFiles();
  await rebuild();
}

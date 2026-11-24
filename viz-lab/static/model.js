// Hunt CSV -> analysis. Pure functions, used by the page and by Node checks.

export function parseCsv(text) {
  const rows = [];
  let c = '', q = false, r = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { r.push(c); c = ''; }
    else if (ch === '\n') { r.push(c); rows.push(r); r = []; c = ''; }
    else if (ch !== '\r') c += ch;
  }
  if (c || r.length) { r.push(c); rows.push(r); }
  const [h, ...rest] = rows;
  return rest.filter(x => x.length >= h.length - 1).map(x => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ''])));
}

const RAD = Math.PI / 180;
export function dist(a, b) {
  const x = (b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const y = (b.lat - a.lat) * RAD;
  return 6371000 * Math.hypot(x, y);
}

const macBits = m => BigInt('0x' + m.replace(/:/g, ''));
function popcount(n) { let c = 0; while (n) { n &= n - 1n; c++; } return c; }

/**
 * One hunt -> { fixes, sightings, devices }.
 * Every sighting is CRC:S (structure only), so single-bit errors in the
 * address create "shard" MACs. A rare MAC within `maxBits` bits of a MAC
 * heard at least `ratio`x as often, within `windowMs` of it, is folded in.
 */
export function analyze(rows, {merge = true, maxBits = 2, ratio = 4, windowMs = 15000} = {}) {
  const fixes = [], sightings = [];
  for (const x of rows) {
    const t = +x.unix_ms;
    if (x.kind === 'fix') fixes.push({t, lat: +x.lat, lon: +x.lon, acc: +x.acc_m, spd: x.speed_mps === '' ? null : +x.speed_mps});
    else if (x.kind === 'sighting') sightings.push({
      t, mac: x.mac, ch: x.ch, pwr: +x.pwr, crc: x.crc, police: x.police, confidence: x.confidence, reasons: x.reasons,
      vendor: x.vendor, name: x.name, lat: x.lat === '' ? null : +x.lat, lon: x.lon === '' ? null : +x.lon,
      spd: x.speed_mps === '' ? null : +x.speed_mps, ad: x.ad,
    });
  }
  const byMac = new Map();
  for (const s of sightings) { if (!byMac.has(s.mac)) byMac.set(s.mac, []); byMac.get(s.mac).push(s); }
  const rawMacs = byMac.size;

  const alias = new Map(); // shard mac -> parent mac
  if (merge) {
    const list = [...byMac.entries()].map(([mac, a]) => ({mac, a, n: a.length, b: macBits(mac)})).sort((p, q) => q.n - p.n);
    for (let i = 1; i < list.length; i++) {
      const s = list[i];
      for (let j = 0; j < i; j++) {
        const p = list[j];
        if (p.n < s.n * ratio) break; // sorted desc: the rest are lighter still
        if (alias.has(p.mac)) continue;
        if (popcount(p.b ^ s.b) > maxBits) continue;
        const near = s.a.some(x => p.a.some(y => Math.abs(x.t - y.t) <= windowMs));
        if (near) { alias.set(s.mac, p.mac); break; }
      }
    }
    for (const [shard, parent] of alias) {
      for (const x of byMac.get(shard)) { x.shardOf = shard; x.mac = parent; byMac.get(parent).push(x); }
      byMac.delete(shard);
    }
  }

  const devices = [...byMac.entries()].map(([mac, a]) => {
    a.sort((p, q) => p.t - q.t);
    const located = a.filter(x => x.lat != null);
    let lat = 0, lon = 0;
    for (const x of located) { lat += x.lat; lon += x.lon; }
    const c = located.length ? {lat: lat / located.length, lon: lon / located.length} : null;
    let spread = 0;
    for (const x of located) spread = Math.max(spread, dist(c, x) * 2);
    // most common name/vendor: shard copies carry bit-flipped names too
    const mode = k => { const m = {}; for (const x of a) if (x[k]) m[x[k]] = (m[x[k]] || 0) + 1; return Object.entries(m).sort((p, q) => q[1] - p[1])[0]?.[0] ?? ''; };
    return {
      mac, n: a.length, first: a[0].t, last: a.at(-1).t, centroid: c, spread,
      vendor: mode('vendor'), name: mode('name'), police: a.find(x => x.police)?.police ?? '',
      shards: new Set(a.filter(x => x.shardOf).map(x => x.shardOf)).size, sightings: a,
    };
  }).sort((p, q) => q.n - p.n);

  return {fixes, sightings, devices, rawMacs, merged: alias.size};
}

/** Square grid in metres around an origin. */
export function makeGrid(origin, cellM) {
  const mPerLat = 111320, mPerLon = 111320 * Math.cos(origin.lat * RAD);
  return {
    key(p) { return `${Math.floor((p.lat - origin.lat) * mPerLat / cellM)},${Math.floor((p.lon - origin.lon) * mPerLon / cellM)}`; },
    bounds(k) {
      const [i, j] = k.split(',').map(Number);
      return [[origin.lat + i * cellM / mPerLat, origin.lon + j * cellM / mPerLon],
              [origin.lat + (i + 1) * cellM / mPerLat, origin.lon + (j + 1) * cellM / mPerLon]];
    },
  };
}

/**
 * Per cell: seconds the phone spent there (from fixes), the distinct devices
 * heard while it was there, and devices per minute of dwell.
 */
export function cellStats(hunts, grid, {minN = 2, excludeTravelers = true} = {}) {
  const cells = new Map();
  const cell = k => { if (!cells.has(k)) cells.set(k, {k, dwell: 0, macs: new Map(), police: 0}); return cells.get(k); };
  for (const h of hunts) {
    const f = h.fixes;
    for (let i = 0; i < f.length; i++) {
      const dt = Math.min(((f[i + 1]?.t ?? f[i].t + 1000) - f[i].t) / 1000, 10);
      cell(grid.key(f[i])).dwell += dt;
    }
    for (const d of h.devices) {
      if (d.n < minN) continue;
      if (excludeTravelers && d.traveler) continue;
      for (const s of d.sightings) {
        if (s.lat == null) continue;
        const c = cell(grid.key(s));
        c.macs.set(d.mac, d);
        if (d.police) c.police++;
      }
    }
  }
  for (const c of cells.values()) c.rate = c.macs.size / Math.max(c.dwell / 60, 0.25);
  return [...cells.values()];
}

/** Devices heard per time bin (after merging) and speed per bin, for the timeline. */
export function timeline(h, binS = 10) {
  const t0 = Math.min(h.fixes[0]?.t ?? Infinity, h.sightings[0]?.t ?? Infinity);
  const bins = [];
  const b = t => Math.floor((t - t0) / 1000 / binS);
  for (const d of h.devices) for (const s of d.sightings) { const i = b(s.t); (bins[i] ??= {macs: new Set(), spd: []}).macs.add(d.mac); }
  for (const f of h.fixes) if (f.spd != null) { const i = b(f.t); (bins[i] ??= {macs: new Set(), spd: []}).spd.push(f.spd); }
  return Array.from(bins, (x, i) => ({
    s: i * binS, devices: x?.macs.size ?? 0,
    kmh: x?.spd.length ? x.spd.reduce((p, q) => p + q, 0) / x.spd.length * 3.6 : null,
  }));
}

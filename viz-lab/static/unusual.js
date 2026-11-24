// "Unusual devices": scores each device (after shard folding) on why it
// stands out from the everyday background of phones, TVs, appliances and
// smart bulbs. Every point comes with a plain-words reason.

import {dist} from './model.js';

/** Decode the AD structures a sighting carries (captures are often truncated). */
export function decodeAd(hex) {
  const b = (hex.match(/../g) ?? []).map(h => parseInt(h, 16));
  const out = {random: !!(b[0] & 0x40), mfr: [], svc: []};
  const end = 2 + (b[1] ?? 0);
  for (let i = 8; i < end && i + 1 < b.length;) {
    const l = b[i];
    if (!l || i + 1 + l > end) break;
    const t = b[i + 1], p = b.slice(i + 2, i + 1 + l);
    if (t === 0xff && p.length >= 2) out.mfr.push({id: p[0] | (p[1] << 8), d: p.slice(2)});
    if ((t === 0x16 || t === 0x02 || t === 0x03) && p.length >= 2)
      out.svc.push(((p[1] << 8) | p[0]).toString(16).toUpperCase().padStart(4, '0'));
    i += 1 + l;
  }
  return out;
}

const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

// Only identifiers we are sure of. Anything else shows as raw hex.
const COMPANY = {
  0x004C: 'Apple', 0x0006: 'Microsoft', 0x0075: 'Samsung', 0x05A7: 'Sonos', 0x058E: 'Meta (Oculus)',
  0x01AB: 'Meta', 0x0553: 'Nintendo', 0x00C4: 'LG', 0x0057: 'Harman', 0x012D: 'Sony',
};
const SERVICE = {
  FEAA: 'Eddystone beacon', FE2C: 'Google Fast Pair', FE07: 'Sonos', FD5A: 'Samsung SmartTag',
  FEED: 'Tile tracker', FEEC: 'Tile tracker', FEB8: 'Meta', FD5F: 'Meta', 1800: 'GAP', 1802: 'Immediate Alert',
};
const APPLE = {0x02: 'iBeacon', 0x05: 'AirDrop', 0x07: 'AirPods pairing', 0x09: 'AirPlay', 0x0C: 'Handoff',
  0x0F: 'Nearby Action', 0x10: 'Nearby Info', 0x12: 'Find My'};
const META_IDS = new Set([0x058E, 0x01AB]), META_SVC = new Set(['FEB8', 'FD5F']);
const TRACKER_SVC = {FD5A: 'Samsung SmartTag', FEED: 'Tile', FEEC: 'Tile'};
// Cellular-modem / fleet / public-safety hardware makers (vendor string from the OUI).
const FLEET = /sierra wireless|cradlepoint|digi international|semtech|getac|panasonic|zebra|garmin|motorola|l3harris|kenwood|axon|flock|watchguard|teltonika|calamp|geotab|inseego/i;
const EVERYDAY = /govee|^net$|dryer|washer|tv\]|envoy/i;

/** Most common payload "kind" of a device: company IDs (+ Apple subtype), services, address type. */
function profile(d) {
  const kinds = new Map();
  let findMySeparated = false;
  for (const s of d.sightings) {
    const a = decodeAd(s.ad ?? '');
    for (const m of a.mfr) if (m.id === 0x004C && m.d[0] === 0x12 && m.d[1] === 0x19) findMySeparated = true;
    const k = [
      a.mfr.map(m => hex4(m.id) + (m.id === 0x004C && m.d.length ? ':' + m.d[0].toString(16) : '')).join('+'),
      [...new Set(a.svc)].join('+'), a.random ? 'R' : 'P',
    ].join('|');
    const e = kinds.get(k) ?? {n: 0, a};
    e.n++;
    kinds.set(k, e);
  }
  const [sig, top] = [...kinds.entries()].sort((p, q) => q[1].n - p[1].n)[0];
  return {sig, ad: top.a, findMySeparated};
}

function describeKind(ad) {
  const parts = ad.mfr.map(m => (COMPANY[m.id] ?? `company 0x${hex4(m.id)}`) +
    (m.id === 0x004C && m.d.length ? ` ${APPLE[m.d[0]] ?? 'type 0x' + m.d[0].toString(16)}` : ''));
  for (const u of new Set(ad.svc)) parts.push(SERVICE[u] ? `${SERVICE[u]} (${u})` : `service ${u}`);
  parts.push(ad.random ? 'random address' : 'public address');
  return parts.join(' · ');
}

/**
 * hunts: analyzed hunts (all loaded, so rarity is judged on everything heard).
 * Returns [{d, h, score, reasons[], kind, sightingsAll, huntsSeen}] sorted by score.
 */
export function findUnusual(hunts, {minN = 2, rareMinN = 5} = {}) {
  const items = [];
  for (const h of hunts) for (const d of h.devices) if (d.n >= minN) items.push({d, h, p: profile(d)});

  const sigCount = new Map();
  for (const it of items) sigCount.set(it.p.sig, (sigCount.get(it.p.sig) ?? 0) + 1);
  const byMac = new Map();
  for (const it of items) { if (!byMac.has(it.d.mac)) byMac.set(it.d.mac, []); byMac.get(it.d.mac).push(it); }

  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.d.mac)) continue;
    seen.add(it.d.mac);
    const group = byMac.get(it.d.mac); // same MAC across hunts
    const main = group.reduce((p, q) => (q.d.n > p.d.n ? q : p));
    const {d, p} = main;
    const reasons = [];
    const add = (pts, tag, why) => reasons.push({pts, tag, why});

    if (d.police) add(100, 'police', `Police signature: ${d.police}`);

    const ids = new Set(p.ad.mfr.map(m => m.id)), svcs = new Set(p.ad.svc);
    if (p.findMySeparated) add(40, 'tracker', 'Apple Find My beacon in "away from owner" mode: an AirTag or Find My accessory without its owner nearby');
    else if (p.ad.mfr.some(m => m.id === 0x004C && m.d[0] === 0x12)) add(20, 'tracker', 'Apple Find My beacon (AirTag, AirPods case or other Find My accessory)');
    for (const u of svcs) if (TRACKER_SVC[u]) add(40, 'tracker', `${TRACKER_SVC[u]} tracker`);
    if ([...ids].some(x => META_IDS.has(x)) || [...svcs].some(x => META_SVC.has(x)))
      add(35, 'camera', 'Meta device: a Quest headset or Ray-Ban/Oakley Meta camera glasses');
    if (FLEET.test(d.vendor)) add(30, 'fleet', `${d.vendor} hardware (cellular modems, fleet and public-safety gear)`);

    const spread = Math.max(...group.map(g => g.d.spread));
    if (spread > 400) add(40, 'follow', `Heard along ${spread.toFixed(0)} m of your route: it was moving with you`);
    else if (spread > 250) add(10, 'range', `Heard over ${spread.toFixed(0)} m of road: an unusually strong or long-range transmitter`);

    if (group.length > 1) {
      const cs = group.map(g => g.d.centroid).filter(Boolean);
      let far = 0;
      for (const a of cs) for (const b of cs) far = Math.max(far, dist(a, b));
      if (far > 300) add(30, 'mobile', `Seen in ${group.length} hunts at places ${far.toFixed(0)} m apart`);
      else add(0, 'fixed', `Seen again in ${group.length} hunts at the same spot (a fixed device)`);
    }

    const k = sigCount.get(p.sig);
    const bare = !p.ad.mfr.length && !p.ad.svc.length;
    const known = p.ad.mfr.every(m => COMPANY[m.id] || d.vendor);
    if (!bare && known && d.n >= rareMinN && k <= 2 && !EVERYDAY.test(d.name))
      add(15, 'rare', k === 1 ? 'The only device of its kind across these hunts' : 'One of only 2 devices of its kind across these hunts');

    const score = reasons.reduce((s, r) => s + r.pts, 0);
    if (score >= 15) out.push({
      d, h: main.h, group, score, reasons: reasons.sort((a, b) => b.pts - a.pts), kind: describeKind(p.ad),
      n: group.reduce((s, g) => s + g.d.n, 0),
    });
  }
  return out.sort((a, b) => b.score - a.score || b.n - a.n);
}

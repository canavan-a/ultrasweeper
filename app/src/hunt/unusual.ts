// "Unusual" devices for the Map screen's filter: scores each device on why
// it stands out from the everyday background (phones, TVs, appliances,
// smart bulbs), with a plain-words reason per point. Same rules as the
// desktop viewer (viz-lab/static/unusual.js), judged over the picked hunts.
//
// A vendor matched on the address prefix alone is weak evidence: the
// "Sierra Wireless" unit from the 11/24 hunt was most likely an Energizer
// smart garage opener whose maker used that prefix. So the fleet/modem tag
// only scores when the vendor came from the payload's company ID.

import {distanceM} from '../geo';
import {classify} from '../lookup/adparse';
import type {Hunt, HuntDevice} from './analysis';

export type UnusualTag = 'police' | 'tracker' | 'camera' | 'fleet' | 'follow' | 'mobile' | 'range' | 'rare';

export interface Reason {
  tag: UnusualTag;
  pts: number;
  why: string;
}

export interface Unusual {
  mac: string;
  score: number;
  reasons: Reason[];
}

const TRACKER_SVC: Record<string, string> = {FD5A: 'Samsung SmartTag', FEED: 'Tile', FEEC: 'Tile'};
const META_IDS = new Set([0x058e, 0x01ab]);
const META_SVC = new Set(['FEB8', 'FD5F']);
const FLEET =
  /sierra wireless|cradlepoint|digi international|semtech|getac|panasonic|zebra|garmin|motorola|l3harris|kenwood|teltonika|calamp|geotab|inseego/i;
const EVERYDAY = /govee|^net$|dryer|washer|tv\]|envoy/i;

interface Profile {
  sig: string;
  companyIds: number[];
  services: string[];
  findMy: 'separated' | 'near' | null;
  random: boolean;
}

/** Most common payload kind of a device: company IDs (+ Apple subtype), services, address type. */
function profile(d: HuntDevice): Profile {
  const kinds = new Map<string, {n: number; p: Profile}>();
  let findMy: Profile['findMy'] = null;
  for (const s of d.sightings) {
    if (!s.ad) continue;
    const c = classify(s.mac, s.ad);
    for (const m of c.manufacturerData) {
      if (m.company === 0x004c && m.data.startsWith('12')) {
        // Find My: "12 19 …" is the separated-from-owner beacon, "12 02 …" near-owner
        if (m.data.slice(2, 4) === '19') findMy = 'separated';
        else findMy ??= 'near';
      }
    }
    const ids = c.manufacturerData.map(m => m.company.toString(16).padStart(4, '0') + (m.company === 0x004c ? ':' + m.data.slice(0, 2) : ''));
    const sig = [ids.join('+'), c.serviceUuids.join('+'), c.randomAddress ? 'R' : 'P'].join('|');
    const e = kinds.get(sig);
    if (e) e.n++;
    else kinds.set(sig, {n: 1, p: {sig, companyIds: c.companyIds, services: c.serviceUuids, findMy: null, random: c.randomAddress}});
  }
  const top = [...kinds.values()].sort((a, b) => b.n - a.n)[0]?.p;
  return {...(top ?? {sig: '||', companyIds: [], services: [], random: true}), findMy};
}

export function findUnusual(hunts: Hunt[], {minN = 2, rareMinN = 5} = {}): Map<string, Unusual> {
  const items: {d: HuntDevice; p: Profile}[] = [];
  for (const h of hunts) for (const d of h.devices) if (d.n >= minN) items.push({d, p: profile(d)});

  const sigCount = new Map<string, number>();
  for (const it of items) sigCount.set(it.p.sig, (sigCount.get(it.p.sig) ?? 0) + 1);
  const byMac = new Map<string, {d: HuntDevice; p: Profile}[]>();
  for (const it of items) {
    const g = byMac.get(it.d.mac);
    if (g) g.push(it);
    else byMac.set(it.d.mac, [it]);
  }

  const out = new Map<string, Unusual>();
  for (const [mac, group] of byMac) {
    const {d, p} = group.reduce((a, b) => (b.d.n > a.d.n ? b : a));
    const reasons: Reason[] = [];
    const add = (pts: number, tag: UnusualTag, why: string) => reasons.push({pts, tag, why});

    if (d.police) add(100, 'police', `Police signature: ${d.police}`);
    if (p.findMy === 'separated') add(40, 'tracker', 'Apple Find My beacon away from its owner (AirTag or similar)');
    else if (p.findMy === 'near') add(20, 'tracker', 'Apple Find My accessory');
    for (const u of p.services) if (TRACKER_SVC[u]) add(40, 'tracker', `${TRACKER_SVC[u]} tracker`);
    if (p.companyIds.some(x => META_IDS.has(x)) || p.services.some(x => META_SVC.has(x))) {
      add(35, 'camera', 'Meta device: Quest headset or Ray-Ban/Oakley Meta camera glasses');
    }
    // Vendor from a public-address prefix only (no company ID in the payload) proves little.
    if (FLEET.test(d.vendor)) {
      if (p.companyIds.length) add(30, 'fleet', `${d.vendor} (cellular modems, fleet and public-safety gear)`);
      else add(5, 'fleet', `${d.vendor} address prefix (weak: makers reuse prefixes)`);
    }

    const spread = Math.max(...group.map(g => g.d.spread));
    if (spread > 400) add(40, 'follow', `Heard along ${spread.toFixed(0)} m of your route: moving with you`);
    else if (spread > 250) add(10, 'range', `Heard over ${spread.toFixed(0)} m of road: strong transmitter`);

    if (group.length > 1) {
      const cs = group.map(g => g.d.centroid).filter((c): c is {lat: number; lon: number} => c != null);
      let far = 0;
      for (const a of cs) for (const b of cs) far = Math.max(far, distanceM(a, b));
      if (far > 300) add(30, 'mobile', `Seen in ${group.length} hunts at places ${far.toFixed(0)} m apart`);
    }

    const bare = !p.companyIds.length && !p.services.length;
    if (!bare && d.n >= rareMinN && (sigCount.get(p.sig) ?? 0) <= 2 && !EVERYDAY.test(d.name)) {
      add(15, 'rare', 'One of at most 2 devices of its kind in these hunts');
    }

    const score = reasons.reduce((s, r) => s + r.pts, 0);
    if (score >= 15) out.set(mac, {mac, score, reasons: reasons.sort((a, b) => b.pts - a.pts)});
  }
  return out;
}

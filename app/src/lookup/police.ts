// Police-equipment classifier (PLAN.md §5.3): decides whether a classified
// sighting looks like police or police-contracted surveillance gear, how
// sure we are, and why.
//
// Two tiers, shown honestly in the UI:
//   likely   — a vendor-specific signature: Axon's body-cam tag, SIG IDs or
//              IEEE OUI; Flock's battery/Raven signatures; explicit names.
//   possible — weaker evidence: a vendor whose OUI/IDs also cover non-police
//              products (a Motorola Solutions OUI can be a fire department
//              radio), capture-only IDs nobody has confirmed, or a name shape
//              that other devices can share.
//
// Sources: the open passive detectors All Cameras Are Beacons (ACAB,
// docs/axon.md + docs/signatures.md, field-validated 2026), AXEOFF,
// OUI-SPY, Eye Spy and flock-you. Rules those projects removed as false
// positives (bare 10-digit names, "Pigvision", "DfuTarg", the generic
// Nordic DFU service) are deliberately left out. None of this is confirmed
// by our own capture yet — extend from field captures, not folklore.
//
// OUI rules match exact 3-byte prefixes, not vendor-name substrings:
// "WatchGuard Technologies" (firewalls) and "Axon Networks" (unrelated) share
// names with police vendors. OUIs only mean something on public addresses
// (classify() reads the PDU's TxAdd bit), so a unit that rotates random
// addresses is caught only by its payload.

import type {Classification} from './adparse';

export type PoliceConfidence = 'likely' | 'possible';

export interface PoliceMatch {
  /** short headline, e.g. "Axon body camera" or "Flock Safety" */
  label: string;
  confidence: PoliceConfidence;
  /** each rule that fired, in plain words */
  reasons: string[];
}

// --- Axon ---------------------------------------------------------------

// Company ID 0x034D (TASER International). ACAB found real Axon payloads are
// 0x02 followed by a 9-character serial (e.g. "X870054FW"); a 0x034D advert
// without that shape is weak evidence.
const AXON_COMPANY_ID = 0x034d;

/** 0x02 then up to 9 uppercase letters/digits (fewer if the capture cut it off) */
function axonSerialShaped(dataHex: string): boolean {
  const bytes = (dataHex.toUpperCase().match(/../g) ?? []).map(h => parseInt(h, 16));
  if (bytes[0] !== 0x02 || bytes.length < 2) return false;
  return bytes.slice(1, 10).every(b => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a));
}
// Axon/TASER-registered 16-bit service UUIDs. FE6B is field-captured as
// service data with a serial payload; FE6C and FC81 are registry-only.
const AXON_SERVICE_UUIDS: Record<string, PoliceConfidence> = {FE6B: 'likely', FE6C: 'likely', FC81: 'likely'};
// ASCII tags carried *inside* a 128-bit service UUID. On air the UUID is
// little-endian, so the text appears reversed ("...ECIVEDCWB..."); both
// orders are checked, in the decoded UUIDs and in the raw capture.
const AXON_UUID_TAGS: {tag: string; label: string; confidence: PoliceConfidence; why: string}[] = [
  {tag: 'BWCDEVICE', label: 'Axon body camera', confidence: 'likely', why: 'Axon body-worn camera tag "BWCDEVICE"'},
  // Seen on Axon-OUI devices (ACAB, 2026-10); product unknown.
  {tag: 'METROPOLISDEVICE', label: 'Axon device', confidence: 'possible', why: 'Axon "METROPOLISDEVICE" tag (product unknown)'},
];
const AXON_OUIS: Record<string, string> = {
  '0025DF': 'Axon Enterprise OUI 00:25:DF',
  // IEEE lists the holder as "Private"; attributed to Axon by ACAB captures.
  D81F65: 'Axon OUI D8:1F:65 (field-attributed)',
};

// --- Motorola Solutions & other public-safety vendors ------------------

// Exact prefixes from src/lookup/oui-data.json. ACAB's fixed-site data had
// Motorola OUI hits that were never body cams, hence 'possible'.
const VENDOR_OUIS: Record<string, string> = {
  // Motorola Solutions: radios, body/in-car video (incl. WatchGuard Video)
  '00047D': 'Motorola Solutions',
  '001F92': 'Motorola Solutions',
  '4CCC34': 'Motorola Solutions',
  '001885': 'Motorola Solutions',
  '10746F': 'Motorola Solutions',
  B8E28C: 'Motorola Solutions',
  '9C862B': 'Motorola Solutions',
  '001D96': 'WatchGuard Video',
  // Body-worn / in-car video
  // i-PRO: Panasonic's former body-cam / in-car video line (also sells CCTV).
  D42DC5: 'i-PRO',
  '0023BD': 'Digital Ally',
  '48468D': 'Zepcam',
  '0016ED': 'Utility Inc. (BodyWorn)',
  '0009BC': 'Utility Inc. (BodyWorn)',
  // Land-mobile radio
  '0017F3': 'Harris (L3Harris)',
  '0006EC': 'Harris (L3Harris)',
  '0000C3': 'Harris (L3Harris)',
  '000DCA': 'Tait (land-mobile radio)',
  // In-vehicle routers: standard in patrol cars, but also sold to businesses.
  '003044': 'Cradlepoint (vehicle router)',
  '00E01C': 'Cradlepoint (vehicle router)',
  // Fixed surveillance infrastructure
  B41E52: 'Flock Safety',
  D411D6: 'ShotSpotter',
};
// Motorola Solutions IDs from ACAB's capture builds (never shipped there).
const MOTOROLA_COMPANY_IDS = [0x04ec];
// Not FE04: the SIG lists it under Motorola Solutions today, but it came
// with Openpath (door-access readers) and would flag office badge readers.
const MOTOROLA_SERVICE_UUIDS = ['FD8E'];

// --- Other public-safety vendors (Bluetooth SIG registry) ----------------

// Yardarm Technologies: firearm/holster sensors ("Holster Aware" in
// Motorola's body-cam system) that tell cameras to start recording.
const YARDARM_COMPANY_ID = 0x025f;
// Tait International: land-mobile radios (police, fire, utilities).
const TAIT_COMPANY_ID = 0x088f;

// --- Flock Safety ---------------------------------------------------------

// XUNTONG, the Bluetooth module in Flock gear. Shared silicon, so it only
// strengthens a Flock name match; on its own it is 'possible'.
const FLOCK_COMPANY_ID = 0x09c8;
// Flock battery pack GATT service (firmware-derived, flock-you).
const FLOCK_BATTERY_UUID128 = 'E8CCBB38-9532-46A8-9FE5-1814DF172E6F';
// Flock Raven (gunshot detection) services: GPS, power, network, upload,
// error. Field-captured by ACAB.
const FLOCK_RAVEN_UUIDS = ['3100', '3200', '3300', '3400', '3500'];
// Raven firmware 1.1.x: Health Thermometer + Location and Navigation (GainSec
// dataset via flock-you). Standard services, so only the pair counts, and
// only as 'possible'.
const FLOCK_RAVEN_OLD_UUIDS = ['1809', '1819'];

// --- Names ---------------------------------------------------------------

interface NameRule {
  re: RegExp;
  label: string;
  confidence: PoliceConfidence;
  why: string;
  /** upgrades a 'possible' name to 'likely' when this company ID is present */
  boostedBy?: number;
}
const NAME_RULES: NameRule[] = [
  {re: /\baxon\b/i, label: 'Axon', confidence: 'likely', why: 'name mentions Axon'},
  {re: /\btaser\b/i, label: 'Axon', confidence: 'likely', why: 'name mentions TASER'},
  {re: /\bbody\s*[234]\b/i, label: 'Axon', confidence: 'possible', why: 'name looks like an Axon Body 2/3/4'},
  {re: /^FS Ext Battery/, label: 'Flock Safety', confidence: 'likely', why: 'Flock battery name "FS Ext Battery"'},
  {re: /^Penguin-\d{10}$/, label: 'Flock Safety', confidence: 'likely', why: 'Flock Penguin battery name'},
  {
    re: /^FS-[0-9A-F]{4,}$/i,
    label: 'Flock Safety',
    confidence: 'possible',
    why: 'Flock "FS-" device name',
    boostedBy: FLOCK_COMPANY_ID,
  },
  {re: /BodyWorn Remote/i, label: 'Utility BodyWorn', confidence: 'likely', why: 'Utility "BodyWorn Remote" name'},
  {
    re: /^(BWC4000|IPS-BTS|BC-0[234]|TB-0[23]|HS-01)/,
    label: 'Getac / i-PRO body camera',
    confidence: 'possible',
    why: 'Getac/i-PRO body-cam name',
  },
];

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function asciiHex(s: string): string {
  return Array.from(s, c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
}

/** byte-aligned occurrence of `needle` (hex) in `hay` (hex) */
function hexContains(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (i % 2 === 0) return true;
  }
  return false;
}

function reverseBytes(hex: string): string {
  return (hex.match(/../g) ?? []).reverse().join('');
}

/** does the decoded UUID or the raw capture carry this ASCII tag, either byte order? */
function carriesTag(tag: string, cls: Classification, adHex: string): boolean {
  const fwd = asciiHex(tag);
  const rev = reverseBytes(fwd);
  const uuids = cls.serviceUuids128.map(u => u.replace(/-/g, ''));
  if (uuids.some(u => hexContains(u, fwd) || hexContains(u, rev))) return true;
  // The raw search also catches a tag whose UUID was cut off mid-way.
  const raw = adHex.toUpperCase();
  return hexContains(raw, fwd) || hexContains(raw, rev);
}

/**
 * `adHex` is the raw capture the classification came from; it lets rules see
 * bytes classify() doesn't keep.
 */
export function policeMatch(mac: string, cls: Classification, adHex = ''): PoliceMatch | null {
  const reasons: string[] = [];
  let label: string | undefined;
  let confidence: PoliceConfidence = 'possible';
  const hit = (l: string, c: PoliceConfidence, why: string) => {
    reasons.push(why);
    // The first likely hit names the device; otherwise the first hit does.
    if (!label || (c === 'likely' && confidence !== 'likely')) {
      label = l;
    }
    if (c === 'likely') {
      confidence = 'likely';
    }
  };

  // Axon
  for (const t of AXON_UUID_TAGS) {
    if (carriesTag(t.tag, cls, adHex)) hit(t.label, t.confidence, t.why);
  }
  for (const m of cls.manufacturerData) {
    if (m.company === AXON_COMPANY_ID) {
      if (axonSerialShaped(m.data)) {
        hit('Axon', 'likely', 'Axon company ID 0x034D with serial payload');
      } else {
        hit('Axon', 'possible', 'Axon company ID 0x034D (payload not serial-shaped)');
      }
    }
  }
  for (const uuid of cls.serviceUuids) {
    const c = AXON_SERVICE_UUIDS[uuid];
    if (c) hit('Axon', c, `Axon service UUID ${uuid}`);
  }

  // Motorola Solutions
  for (const id of cls.companyIds) {
    if (MOTOROLA_COMPANY_IDS.includes(id)) hit('Motorola Solutions', 'possible', `Motorola company ID 0x${hex4(id)}`);
  }
  for (const uuid of cls.serviceUuids) {
    if (MOTOROLA_SERVICE_UUIDS.includes(uuid)) hit('Motorola Solutions', 'possible', `Motorola service UUID ${uuid}`);
  }

  // Yardarm, Tait
  if (cls.companyIds.includes(YARDARM_COMPANY_ID)) {
    hit('Yardarm holster/firearm sensor', 'likely', 'Yardarm Technologies company ID 0x025F');
  }
  if (cls.companyIds.includes(TAIT_COMPANY_ID)) {
    hit('Tait radio', 'possible', 'Tait International company ID 0x088F');
  }

  // Flock Safety
  if (cls.serviceUuids128.includes(FLOCK_BATTERY_UUID128)) {
    hit('Flock Safety', 'likely', 'Flock battery service UUID');
  }
  const ravenUuids = cls.serviceUuids.filter(u => FLOCK_RAVEN_UUIDS.includes(u));
  if (ravenUuids.length > 0) {
    hit('Flock Raven (gunshot sensor)', 'likely', `Flock Raven service UUID ${ravenUuids.join(', ')}`);
  }
  if (FLOCK_RAVEN_OLD_UUIDS.every(u => cls.serviceUuids.includes(u))) {
    hit('Flock Raven (gunshot sensor)', 'possible', 'old Flock Raven services 1809 + 1819 together');
  }
  const hasFlockModule = cls.companyIds.includes(FLOCK_COMPANY_ID);

  // Address block (public addresses only)
  if (!cls.randomAddress) {
    const prefix = mac.split(':').slice(0, 3).join('').toUpperCase();
    if (AXON_OUIS[prefix]) {
      hit('Axon', 'likely', AXON_OUIS[prefix]);
    } else if (VENDOR_OUIS[prefix]) {
      hit(VENDOR_OUIS[prefix], 'possible', `${VENDOR_OUIS[prefix]} OUI ${prefix}`);
    }
  }

  // Names
  let flockNamed = false;
  if (cls.name) {
    for (const rule of NAME_RULES) {
      if (rule.re.test(cls.name)) {
        const boosted = rule.boostedBy !== undefined && cls.companyIds.includes(rule.boostedBy);
        hit(rule.label, boosted ? 'likely' : rule.confidence, `${rule.why} ("${cls.name}")`);
        flockNamed = rule.label === 'Flock Safety';
        break;
      }
    }
  }
  if (hasFlockModule) {
    // Backs a Flock name match; alone it's just a common Bluetooth module.
    hit('Flock Safety', 'possible', `XUNTONG (Flock module) company ID 0x${hex4(FLOCK_COMPANY_ID)}${flockNamed ? '' : ' alone'}`);
  }

  return label ? {label, confidence, reasons} : null;
}

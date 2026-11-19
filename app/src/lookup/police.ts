// Police-equipment classifier (PLAN.md §5.3): decides whether a classified
// sighting looks like police gear, how sure we are, and why.
//
// Two tiers, shown honestly in the UI:
//   likely   — an Axon-specific signature: Axon's SIG company IDs, Axon's
//              IEEE OUI on a public address, or an explicit name.
//   possible — the address block belongs to a vendor whose main business is
//              police/public-safety equipment, but that vendor also sells
//              things that aren't police gear (a Motorola Solutions OUI can
//              be a fire department radio), or a weak name pattern.
//
// OUI rules match exact 3-byte prefixes from the bundled IEEE registry, not
// vendor-name substrings: "WatchGuard Technologies" (firewalls) and "Axon
// Networks" (unrelated ISP gear) both share a name with police vendors.
// OUIs only mean anything on public/identity addresses; random addresses
// are skipped, so a unit that rotates its address is caught only by its
// payload (company ID, service UUID, name).
//
// Extend from field captures, not folklore — same rule as companies.ts.

import type {Classification} from './adparse';

export type PoliceConfidence = 'likely' | 'possible';

export interface PoliceMatch {
  /** short headline, e.g. "Axon" or "Motorola Solutions" */
  label: string;
  confidence: PoliceConfidence;
  /** each rule that fired, in plain words */
  reasons: string[];
}

// SIG company IDs associated with Axon. Both are still unverified against a
// real patrol capture (see companies.ts / PLAN.md §1). 0xFC81 sits in the
// 16-bit member-UUID range, so it is checked as a service UUID too.
const AXON_COMPANY_IDS = [0x034d, 0xfc81];
const AXON_SERVICE_UUIDS = ['FC81'];

const AXON_OUIS = ['0025DF']; // Axon Enterprise, Inc. (formerly TASER International)

// Public-safety vendors whose IEEE blocks are worth flagging. Prefixes are
// from src/lookup/oui-data.json; the note says what they make.
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
  '0023BD': 'Digital Ally',
  '48468D': 'Zepcam',
  '0016ED': 'Utility Inc. (BodyWorn)',
  '0009BC': 'Utility Inc. (BodyWorn)',
  // Land-mobile radio
  '0017F3': 'Harris (L3Harris)',
  '0006EC': 'Harris (L3Harris)',
  '0000C3': 'Harris (L3Harris)',
  // Fixed surveillance infrastructure
  B41E52: 'Flock Safety',
  D411D6: 'ShotSpotter',
};

const NAME_RULES: {
  re: RegExp;
  label: string;
  confidence: PoliceConfidence;
  why: string;
}[] = [
  {
    re: /\baxon\b/i,
    label: 'Axon',
    confidence: 'likely',
    why: 'name mentions Axon',
  },
  {
    re: /\btaser\b/i,
    label: 'Axon',
    confidence: 'likely',
    why: 'name mentions TASER',
  },
  {
    re: /\bbody\s*[23]\b/i,
    label: 'Axon',
    confidence: 'possible',
    why: 'name looks like an Axon Body 2/3',
  },
];

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

export function policeMatch(
  mac: string,
  cls: Classification,
): PoliceMatch | null {
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

  for (const id of cls.companyIds) {
    if (AXON_COMPANY_IDS.includes(id)) {
      hit('Axon', 'likely', `Axon company ID 0x${hex2(id)}`);
    }
  }
  for (const uuid of cls.serviceUuids) {
    if (AXON_SERVICE_UUIDS.includes(uuid)) {
      hit('Axon', 'likely', `Axon service UUID ${uuid}`);
    }
  }

  if (!cls.randomAddress) {
    const prefix = mac.split(':').slice(0, 3).join('').toUpperCase();
    if (AXON_OUIS.includes(prefix)) {
      hit('Axon', 'likely', `Axon Enterprise OUI ${prefix}`);
    } else if (VENDOR_OUIS[prefix]) {
      hit(
        VENDOR_OUIS[prefix],
        'possible',
        `${VENDOR_OUIS[prefix]} OUI ${prefix}`,
      );
    }
  }

  if (cls.name) {
    for (const rule of NAME_RULES) {
      if (rule.re.test(cls.name)) {
        hit(rule.label, rule.confidence, `${rule.why} ("${cls.name}")`);
        break;
      }
    }
  }

  return label ? {label, confidence, reasons} : null;
}

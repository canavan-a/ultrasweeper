// BLE advertising-structure parsing and vendor classification — the app's
// whole "what is this thing?" answer, built from the AD hex the firmware
// forwards verbatim (the firmware itself never interprets payloads).
//
// The input `ad` is the de-whitened PDU prefix as received:
//   [0]=PDU header  [1]=length  [2..7]=AdvA (LSB-first)  [8..]=AD structures
// AD structures are the standard BLE chain: length byte, type byte, payload.
// A truncated capture (very common: real advertisers run past the nRF's
// 32-byte FIFO) simply ends mid-chain — that's `truncated`, not an error.

import {COMPANIES} from './companies';
import {lookupOui} from './oui';
import {sigCompany, sigService} from './sig';
import {KNOWN_128} from './uuids128';

// Apple Continuity message types (first byte after Apple's company ID).
// Apple publishes no spec; names follow the public reverse-engineering
// (furiousMAC "continuity" dissector).
const APPLE_TYPES: Record<number, string> = {
  0x03: 'AirPrint',
  0x05: 'AirDrop',
  0x06: 'HomeKit accessory',
  0x07: 'AirPods/Beats pairing beacon',
  0x08: 'Hey Siri',
  0x09: 'AirPlay target',
  0x0a: 'AirPlay source',
  0x0b: 'Magic Switch',
  0x0c: 'Handoff',
  0x0d: 'Instant Hotspot (target)',
  0x0e: 'Instant Hotspot (source)',
  0x0f: 'Nearby Action',
  0x10: 'Nearby Info',
  0x12: 'Find My',
};

// Microsoft Connected Devices Platform beacon ([MS-CDP] "Bluetooth:
// Advertising Beacon"): scenario byte 0x01, then the low 5 bits of the
// next byte are the device type.
const MS_CDP_DEVICE: Record<number, string> = {
  1: 'Xbox One',
  6: 'iPhone',
  7: 'iPad',
  8: 'Android device',
  9: 'Windows desktop',
  11: 'Windows phone',
  12: 'Linux device',
  13: 'Windows IoT device',
  14: 'Surface Hub',
  15: 'Windows laptop',
  16: 'Windows tablet',
};

const EDDYSTONE_FRAMES: Record<number, string> = {0x00: 'UID', 0x10: 'URL', 0x20: 'TLM', 0x30: 'EID'};

export interface AdStructure {
  type: number;
  /** payload hex, may be shorter than declared when the capture cut off */
  data: string;
}

export interface PduInfo {
  pduType: number;
  pduLen: number;
  /** AdvA in air order (LSB-first) — reverse for printing */
  adva: number[];
  structures: AdStructure[];
  truncated: boolean;
}

function hexBytes(hex: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    out.push(hex.slice(i, i + 2));
  }
  return out;
}

export function parsePdu(adHex: string): PduInfo | null {
  const b = hexBytes(adHex);
  if (b.length < 9) {
    return null;
  }
  const pduType = parseInt(b[0], 16) & 0x0f;
  const pduLen = parseInt(b[1], 16);
  const adva = b.slice(2, 8).map(x => parseInt(x, 16));
  const structures: AdStructure[] = [];
  let truncated = false;
  // The declared PDU end, capped by what actually arrived.
  const declared = 8 + pduLen - 6;
  let i = 8;
  while (i < b.length) {
    const l = parseInt(b[i], 16);
    if (l === 0) {
      break; // zero padding terminates the chain
    }
    if (i + 1 + l > declared) {
      break; // structure overruns the declared length: treat as end
    }
    const type = parseInt(b[i + 1], 16);
    const payload = b.slice(i + 2, i + 1 + l);
    if (payload.length < l - 1) {
      truncated = true;
    }
    structures.push({type, data: payload.join('')});
    i = i + 1 + l;
  }
  return {pduType, pduLen, adva, structures, truncated};
}

export interface Classification {
  /** human labels, most specific first: "Apple iPhone/Mac (continuity)", ... */
  labels: string[];
  /** vendor name if any company ID/OUI resolved */
  vendor?: string;
  /** advertised Complete/Shortened Local Name, if any */
  name?: string;
  /** SIG company IDs from Manufacturer Specific Data, in the order seen */
  companyIds: number[];
  /** Manufacturer Specific Data: company ID + payload hex after the ID */
  manufacturerData: {company: number; data: string}[];
  /** 16-bit service UUIDs seen (hex, e.g. "F7FD") */
  serviceUuids: string[];
  /**
   * 128-bit service UUIDs seen (listed or as service data), canonical
   * big-endian form "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" uppercase.
   * Only complete UUIDs: one cut off by the capture is dropped.
   */
  serviceUuids128: string[];
  /**
   * Eddystone-UID frame identifiers, uppercase hex 10 bytes of namespace
   * followed by 6 bytes of instance (20 hex chars). Complete frames only.
   */
  eddystoneUids: string[];
  /** true when AdvA is a random address (most phones rotate these) */
  randomAddress: boolean;
}

function ascii(hex: string): string {
  return hexBytes(hex)
    .map(h => String.fromCharCode(parseInt(h, 16)))
    .filter(c => c >= ' ' && c <= '~')
    .join('')
    .trim();
}

/**
 * Classify one sighting from its AD payload alone. Confidence comes from
 * explicit fields first (local names, manufacturer data company IDs),
 * then SIG-assigned service UUIDs, then address-block OUI.
 */
export function classify(mac: string, adHex: string): Classification {
  const out: Classification = {
    labels: [],
    companyIds: [],
    manufacturerData: [],
    serviceUuids: [],
    serviceUuids128: [],
    eddystoneUids: [],
    randomAddress: false,
  };
  const add128 = (leHex: string) => {
    if (leHex.length < 32) return;
    const be = (hexBytes(leHex.slice(0, 32)).reverse().join('')).toUpperCase();
    const uuid = `${be.slice(0, 8)}-${be.slice(8, 12)}-${be.slice(12, 16)}-${be.slice(16, 20)}-${be.slice(20)}`;
    if (!out.serviceUuids128.includes(uuid)) out.serviceUuids128.push(uuid);
  };
  const macBytes = mac.split(':').map(p => parseInt(p, 16));
  // BLE public/identity addresses have the top two bits of the
  // most-significant byte clear; everything else (resolvable private
  // 0b01, static 0b11, and the 0b10 oddities real trackers emit) is
  // randomized or synthetic, and its first three bytes prove nothing.
  out.randomAddress = (macBytes[0] & 0xc0) !== 0x00;

  // Decoded, device-specific descriptions go first (the scan screen titles a
  // device with labels[0]); registry names of its services go last.
  const specific: string[] = [];
  const pdu = parsePdu(adHex);
  if (pdu) {
    // The advertising PDU header says it outright: TxAdd (bit 6) set means
    // AdvA is a random address. Better than the top-bits guess above, which
    // misreads public addresses whose first byte has high bits set (Axon's
    // D8:1F:65 block, for one).
    out.randomAddress = (parseInt(adHex.slice(0, 2), 16) & 0x40) !== 0;
    for (const s of pdu.structures) {
    switch (s.type) {
      case 0x08: // Shortened Local Name
      case 0x09: {
        // Complete Local Name
        const name = ascii(s.data);
        if (name) {
          out.name = out.name && out.name.length >= name.length ? out.name : name;
        }
        break;
      }
      case 0x16: {
        // Service Data - 16-bit UUID (LE on air)
        if (s.data.length >= 4) {
          const uuid = s.data.slice(2, 4) + s.data.slice(0, 2);
          if (!out.serviceUuids.includes(uuid)) {
            out.serviceUuids.push(uuid);
          }
          if (uuid === 'FE2C') {
            out.labels.push('Google Fast Pair device');
            // discoverable mode carries just the 3-byte model ID
            const model = s.data.slice(4);
            if (model.length === 6 && !pdu.truncated) specific.push(`Google Fast Pair accessory, model 0x${model.toUpperCase()}`);
          }
          if (uuid.toUpperCase() === 'FEAA' && s.data.length >= 6) {
            const frame = parseInt(s.data.slice(4, 6), 16);
            const frameName = EDDYSTONE_FRAMES[frame];
            if (frameName) specific.push(`Eddystone-${frameName} beacon`);
            if (frame === 0x00 && s.data.length >= 28) {
              // tx-power byte at [6..8); namespace [8..18), instance
              // [18..28). Flags match on this 20-hex id (FLAGS.md).
              const uid = s.data.slice(8, 28).toUpperCase();
              if (!out.eddystoneUids.includes(uid)) {
                out.eddystoneUids.push(uid);
              }
            }
          }
        }
        break;
      }
      case 0xFF: {
        // Manufacturer Specific Data: first two bytes = SIG company ID, LE
        if (s.data.length < 4) {
          break;
        }
        const company = parseInt(s.data.slice(2, 4) + s.data.slice(0, 2), 16);
        if (!out.companyIds.includes(company)) {
          out.companyIds.push(company);
        }
        out.manufacturerData.push({company, data: s.data.slice(4)});
        const vendor = COMPANIES[company] ?? sigCompany(company);
        if (vendor) {
          out.vendor = out.vendor ?? vendor;
        }
        if (company === 0x004c) {
          const sub = parseInt(s.data.slice(4, 6), 16);
          if (APPLE_TYPES[sub]) specific.push(`Apple ${APPLE_TYPES[sub]}`);
          if (sub === 0x02 && s.data.slice(6, 8) === '15') {
            out.labels.push('Apple iBeacon-format advertisement');
          } else if ([0x07, 0x08, 0x09, 0x10, 0x11, 0x12, 0x19].includes(sub)) {
            // proximity pairing / Handoff / Hotspot / Watch subdomains:
            // only Apple hardware emits these.
            out.labels.push('Apple device (continuity advertisement)');
          } else {
            out.labels.push('Apple advertisement');
          }
        } else if (company === 0x0006) {
          out.labels.push('Microsoft presence (MSVP) advertisement');
          if (s.data.slice(4, 6) === '01' && s.data.length >= 8) {
            const type = MS_CDP_DEVICE[parseInt(s.data.slice(6, 8), 16) & 0x1f];
            if (type) specific.push(`${type} (Microsoft CDP beacon)`);
          }
        }
        break;
      }
      case 0x06: // 128-bit Service UUIDs (Incomplete)
      case 0x07: {
        // 128-bit Service UUIDs (Complete), little-endian on air
        for (let i = 0; i + 32 <= s.data.length; i += 32) add128(s.data.slice(i, i + 32));
        break;
      }
      case 0x21: // Service Data - 128-bit UUID (the UUID leads the payload)
        add128(s.data);
        break;
      case 0x02: // Type for 16-bit Service UUIDs (Incomplete)
      case 0x03: {
        // Type for 16-bit Service UUIDs (Complete)
        for (let i = 0; i + 4 <= s.data.length; i += 4) {
          const uuid = s.data.slice(i + 2, i + 4) + s.data.slice(i, i + 2);
          if (!out.serviceUuids.includes(uuid)) {
            out.serviceUuids.push(uuid);
          }
        }
        break;
      }
      default:
        break;
    }
    }
  }

  for (const u of out.serviceUuids128) {
    const known = KNOWN_128[u];
    if (known) specific.push(known);
  }
  const serviceNames = out.serviceUuids
    .map(u => [u, sigService(u)] as const)
    .filter(([, n]) => n)
    .map(([u, n]) => `${n} service ${u.toUpperCase()}`);
  out.labels = [...specific, ...out.labels, ...serviceNames];
  if (!out.vendor) {
    // No company ID: a SIG member UUID (0xFC00 and up, assigned to one
    // company) names the vendor. Standard services (0x18xx) name nobody.
    const owned = out.serviceUuids.find(u => parseInt(u, 16) >= 0xfc00 && sigService(u));
    if (owned) out.vendor = sigService(owned);
  }

  if (!out.randomAddress) {
    const oui = lookupOui(macBytes.slice(0, 3));
    if (oui) {
      out.vendor = out.vendor ?? oui;
      out.labels.push(`OUI-registered: ${oui}`);
    }
  }
  return out;
}

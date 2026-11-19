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
  /** 16-bit service UUIDs seen (hex, e.g. "F7FD") */
  serviceUuids: string[];
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
  const out: Classification = {labels: [], companyIds: [], serviceUuids: [], randomAddress: false};
  const macBytes = mac.split(':').map(p => parseInt(p, 16));
  // BLE public/identity addresses have the top two bits of the
  // most-significant byte clear; everything else (resolvable private
  // 0b01, static 0b11, and the 0b10 oddities real trackers emit) is
  // randomized or synthetic, and its first three bytes prove nothing.
  out.randomAddress = (macBytes[0] & 0xc0) !== 0x00;

  const pdu = parsePdu(adHex);
  if (pdu) {
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
        const vendor = COMPANIES[company];
        if (vendor) {
          out.vendor = out.vendor ?? vendor;
        }
        if (company === 0x004c) {
          const sub = parseInt(s.data.slice(4, 6), 16);
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
        }
        break;
      }
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

  if (!out.randomAddress) {
    const oui = lookupOui(macBytes.slice(0, 3));
    if (oui) {
      out.vendor = out.vendor ?? oui;
      out.labels.push(`OUI-registered: ${oui}`);
    }
  }
  return out;
}

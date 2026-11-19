// Curated subset of the Bluetooth SIG Company ID registry: the vendors we
// actually expect a police-relevant scanner to hear, plus a few big
// platforms. Company IDs come from Manufacturer Specific Data (AD type
// 0xFF) and identify who authored the payload, not necessarily who built
// the hardware — e.g. a Samsung phone running Microsoft's presence
// protocol advertises under Microsoft. The classifier says as much.
//
// These values are stable SIG assignments; keep additions verified against
// the published registry (or real captures), not folklore.

export const COMPANIES: Record<number, string> = {
  0x0000: 'Ericsson Technology Licensing',
  0x0001: 'Nokia Mobile Phones',
  0x0002: 'Intel Corp.',
  0x0004: 'Toshiba Corp.',
  0x0006: 'Microsoft',
  0x000D: 'Texas Instruments Inc.',
  0x000F: 'Broadcom Corporation',
  0x0017: 'Qualcomm Technologies, Inc.',
  0x004C: 'Apple',
  0x0075: 'Samsung Electronics America',
  0x00E0: 'Google',
  // Axon (registered as TASER International). 0xFC81, once listed here as a
  // second Axon company ID, is an Axon 16-bit service UUID instead; see
  // lookup/police.ts for the service UUIDs and the body-cam tag.
  0x034D: 'Axon (TASER International)',
  // Motorola Solutions; seen in All Cameras Are Beacons capture builds.
  0x04EC: 'Motorola Solutions',
  // XUNTONG: the Bluetooth module in Flock Safety gear (also sold to others).
  0x09C8: 'XUNTONG (Flock module)',
};

export function companyName(id: number): string | undefined {
  return COMPANIES[id];
}

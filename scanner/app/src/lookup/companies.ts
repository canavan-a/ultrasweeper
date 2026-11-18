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
  // Axon: two company IDs are associated with Axon devices; both still
  // need confirming from a real patrol capture (PLAN.md open question).
  0x034D: 'Axon (unverified)',
  0xFC81: 'Axon Mobile (unverified)',
};

export function companyName(id: number): string | undefined {
  return COMPANIES[id];
}

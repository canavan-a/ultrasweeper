// Vendor-specific 128-bit service UUIDs we have identified. There is no
// central registry for these, so each entry needs a source: a public
// document or a capture we confirmed. Grow it as hunts turn up new ones.
// Keys are canonical uppercase "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX".

export const KNOWN_128: Record<string, string> = {
  // Xirgo Technologies XT6300 telematics, Bluetooth ELD user services
  // (product manual, "User Services (HOS, Engine, and Timer)"). Seen 2026-11-24.
  '1B19B844-038F-11E5-8418-1697F925EC7B': 'Xirgo vehicle telematics / ELD (engine service)',
  '1B19BB5A-038F-11E5-8418-1697F925EC7B': 'Xirgo vehicle telematics / ELD (timer service)',
  'A59611BA-78B7-4FD2-96FB-9B0F66D2311E': 'Xirgo vehicle telematics / ELD (hours-of-service)',
  // Nordic UART Service: Nordic's serial-over-BLE profile, used by countless
  // hobby and OEM devices; identifies the radio firmware, not the product.
  '6E400001-B5A3-F393-E0A9-E50E24DCCA9E': 'Nordic UART serial service (generic)',
};

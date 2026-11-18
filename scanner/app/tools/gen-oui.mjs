#!/usr/bin/env node
// tools/gen-oui.mjs — regenerate src/lookup/oui-data.json from the IEEE's
// published OUI registry (https://standards-oui.ieee.org/oui/oui.txt).
//
// The registry lists each 24-bit block twice (an "(OUI)" line and a
// "(hex)" line) followed by address lines; we keep just the (hex) form:
// {"AABBCC": "Vendor Name", ...}. Run with network access, commit the
// output; the app never downloads anything itself.
//
//   npm run gen-oui
import {writeFileSync} from 'node:fs';

const REGISTRY_URL = 'https://standards-oui.ieee.org/oui/oui.txt';

const res = await fetch(REGISTRY_URL);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const text = await res.text();

const ENTRY = /^([0-9A-F]{2})-([0-9A-F]{2})-([0-9A-F]{2})\s+\(hex\)\s+(.+?)\s*$/;
const data = {};
for (const line of text.split('\n')) {
  const m = line.match(ENTRY);
  if (m) {
    data[m[1] + m[2] + m[3]] = m[4];
  }
}

const keys = Object.keys(data);
if (keys.length < 20000) {
  console.error(`only ${keys.length} entries parsed — the registry format may have changed, refusing to write`);
  process.exit(1);
}

writeFileSync(
  new URL('../src/lookup/oui-data.json', import.meta.url),
  JSON.stringify(data),
);
console.log(`wrote ${keys.length} OUI entries`);

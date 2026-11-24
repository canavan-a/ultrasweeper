#!/usr/bin/env node
// tools/gen-sig.mjs — regenerate src/lookup/sig-data.json from the Bluetooth
// SIG's published assigned numbers (https://bitbucket.org/bluetooth-SIG/public):
//
//   companies  Company Identifiers (Manufacturer Specific Data, AD 0xFF)
//   services   16-bit UUIDs: SIG member UUIDs (0xFCxx–0xFExx, assigned to
//              companies, e.g. 0xFEAA Google) plus the standard GATT services
//
// Output: {"companies": {"76": "Apple, Inc.", ...}, "services": {"FEAA": "Google LLC", ...}}
// (company keys are decimal IDs). Run with network access and commit the
// output; the app never downloads anything itself.
//
//   npm run gen-sig
import {writeFileSync} from 'node:fs';

const BASE = 'https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers';

async function get(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) {
    console.error(`fetch ${path} failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  return res.text();
}

/** The files are flat YAML lists of `- <key>: 0xNNNN` + `name: ...`; no YAML library needed. */
function pairs(text, key) {
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const k = line.match(new RegExp(`^-\\s*${key}:\\s*0x([0-9A-Fa-f]+)\\s*$`));
    if (k) {
      cur = parseInt(k[1], 16);
      continue;
    }
    const n = line.match(/^name:\s*(.+)$/);
    if (n && cur != null) {
      let name = n[1].trim();
      if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replace(/''/g, "'");
      else if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\"/g, '"');
      out.push([cur, name]);
      cur = null;
    }
  }
  return out;
}

const companies = {};
for (const [id, name] of pairs(await get('company_identifiers/company_identifiers.yaml'), 'value')) companies[id] = name;

const services = {};
const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
for (const [id, name] of pairs(await get('uuids/service_uuids.yaml'), 'uuid')) services[hex4(id)] = name;
for (const [id, name] of pairs(await get('uuids/member_uuids.yaml'), 'uuid')) services[hex4(id)] = name;

const nc = Object.keys(companies).length;
const ns = Object.keys(services).length;
if (nc < 3000 || ns < 500) {
  console.error(`only ${nc} companies / ${ns} services parsed — the registry format may have changed, refusing to write`);
  process.exit(1);
}
writeFileSync(new URL('../src/lookup/sig-data.json', import.meta.url), JSON.stringify({companies, services}));
console.log(`wrote ${nc} company IDs and ${ns} 16-bit service UUIDs`);

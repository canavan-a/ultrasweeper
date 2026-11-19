#!/usr/bin/env node
// Synthesizes the police-alert chime: three short bell-like pings
// ("ping ping ping"), written as a 16-bit mono WAV to
// android/app/src/main/res/raw/police_ping.wav, which the alert
// notification channels play (see src/alerts.ts).
//
// Each ping is a sine at PITCH plus a quieter inharmonic partial (what makes
// it read as a bell rather than a beep), with a 4 ms attack and an
// exponential decay. The vibration pattern in src/alerts.ts follows the same
// three-beat rhythm.
//
//   node tools/gen-alert-sound.mjs

import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'android/app/src/main/res/raw/police_ping.wav');

const RATE = 22050;
const PITCH = 1568; // G6
const PARTIALS = [
  [1, 1],
  [2.76, 0.35],
  [5.4, 0.12],
];
const PING_EVERY = 0.2; // seconds between ping onsets
const PINGS = 3;
const DECAY = 0.11; // seconds, e-folding time
const TAIL = 0.6; // how long the last ping rings
const ATTACK = 0.004;
const GAIN = 0.55;

const total = Math.ceil((PING_EVERY * (PINGS - 1) + TAIL) * RATE);
const mix = new Float64Array(total);
for (let p = 0; p < PINGS; p++) {
  const start = Math.round(p * PING_EVERY * RATE);
  for (let i = 0; start + i < total; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / ATTACK) * Math.exp(-t / DECAY);
    if (env < 1e-4 && t > ATTACK) break;
    let s = 0;
    for (const [mult, amp] of PARTIALS) s += amp * Math.sin(2 * Math.PI * PITCH * mult * t);
    mix[start + i] += env * s;
  }
}
const peak = mix.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

const data = Buffer.alloc(total * 2);
for (let i = 0; i < total; i++) {
  data.writeInt16LE(Math.round((mix[i] / peak) * GAIN * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

writeFileSync(OUT, Buffer.concat([header, data]));
console.log(`wrote ${OUT} (${(total / RATE).toFixed(2)} s)`);

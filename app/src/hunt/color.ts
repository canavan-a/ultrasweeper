// Per-device colors and dot fan-out for the Map screen.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function oklchHex(L: number, C: number, hueDeg: number): string {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return (
    '#' +
    rgb
      .map(v => {
        v = Math.max(0, Math.min(1, v));
        v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(v * 255)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}

/**
 * A stable color per device, from its MAC, so filtering never repaints it.
 * The red band (345°–45°) is left out: red means police on this map.
 */
export function deviceColor(mac: string, dark: boolean): string {
  const x = hash(mac);
  const hue = 45 + (x % 300);
  const L = (dark ? 0.7 : 0.6) + (((x >>> 9) % 3) - 1) * 0.06;
  return oklchHex(L, 0.15, hue);
}

/**
 * Devices heard at the same GPS fix share one position. Each device gets a
 * fixed direction and 4–12 m offset so they sit side by side instead of
 * hiding under each other. Positions are only good to tens of metres anyway
 * (they are where the phone was, not where the device is).
 * Returns [dLon, dLat] in degrees.
 */
export function fanOffset(mac: string, lat: number): [number, number] {
  const x = hash(mac + '/fan');
  const a = ((x % 3600) / 3600) * 2 * Math.PI;
  const r = 4 + ((x >>> 12) % 9);
  return [(r * Math.cos(a)) / (Math.cos((lat * Math.PI) / 180) * 111320), (r * Math.sin(a)) / 111320];
}

/** A circle polygon ring around a point, radius in metres. */
export function circleRing(lat: number, lon: number, r: number, steps = 48): [number, number][] {
  const k = Math.cos((lat * Math.PI) / 180) * 111320;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + (r * Math.cos(a)) / k, lat + (r * Math.sin(a)) / 111320]);
  }
  return ring;
}

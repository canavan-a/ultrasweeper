// Small geodesy helpers for hunts: how far, and which way, a sighting's
// recorded position is from where the phone is now. Spherical earth is
// plenty at hunt scale (metres to a few km).

export interface Fix {
  lat: number;
  lon: number;
  /** fix time, wall-clock ms (from the location provider) */
  t: number;
  /** horizontal accuracy radius, metres */
  acc?: number;
  alt?: number;
  /** m/s */
  speed?: number;
  /** degrees clockwise from north, direction of travel */
  heading?: number;
  provider?: string;
}

const R = 6371008.8; // mean earth radius, m
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** great-circle distance in metres */
export function distanceM(a: Pick<Fix, 'lat' | 'lon'>, b: Pick<Fix, 'lat' | 'lon'>): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** initial bearing from a to b, degrees clockwise from north, [0, 360) */
export function bearingDeg(a: Pick<Fix, 'lat' | 'lon'>, b: Pick<Fix, 'lat' | 'lon'>): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compass(bearing: number): string {
  return COMPASS[Math.round(bearing / 45) % 8];
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/**
 * "120 m NE of you" — where `at` is from `here`. Under the combined fix
 * accuracy the direction is noise, so it just says "here".
 */
export function describeRelative(here: Fix, at: Fix): string {
  const d = distanceM(here, at);
  const slop = (here.acc ?? 0) + (at.acc ?? 0);
  if (d <= Math.max(slop, 10)) return 'right here';
  return `${formatDistance(d)} ${compass(bearingDeg(here, at))} of you`;
}

export function formatFix(f: Fix): string {
  const acc = f.acc != null ? ` ±${Math.round(f.acc)} m` : '';
  return `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}${acc}`;
}

import {bearingDeg, compass, describeRelative, distanceM, formatDistance} from '../src/geo';

const ALBANY = {lat: 42.6526, lon: -73.7562, t: 0};

describe('geo', () => {
  it('measures short distances', () => {
    // 0.001 deg of latitude ~ 111 m
    const north = {lat: ALBANY.lat + 0.001, lon: ALBANY.lon, t: 0};
    expect(distanceM(ALBANY, north)).toBeCloseTo(111.2, 0);
    expect(bearingDeg(ALBANY, north)).toBeCloseTo(0, 3);
  });

  it('names compass directions', () => {
    expect(compass(0)).toBe('N');
    expect(compass(44)).toBe('NE');
    expect(compass(180)).toBe('S');
    expect(compass(350)).toBe('N');
    const east = {lat: ALBANY.lat, lon: ALBANY.lon + 0.002, t: 0};
    expect(compass(bearingDeg(ALBANY, east))).toBe('E');
  });

  it('describes a sighting relative to the phone', () => {
    const ne = {lat: ALBANY.lat + 0.001, lon: ALBANY.lon + 0.0013, t: 0, acc: 5};
    expect(describeRelative({...ALBANY, acc: 5}, ne)).toBe('154 m NE of you');
    // inside the fixes' combined accuracy the direction is noise
    const near = {lat: ALBANY.lat + 0.0001, lon: ALBANY.lon, t: 0, acc: 10};
    expect(describeRelative({...ALBANY, acc: 10}, near)).toBe('right here');
  });

  it('formats distances', () => {
    expect(formatDistance(42.4)).toBe('42 m');
    expect(formatDistance(1530)).toBe('1.5 km');
    expect(formatDistance(23_400)).toBe('23 km');
  });
});

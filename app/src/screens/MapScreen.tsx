// Hunt map: pick one or more hunt logs and see every sighting at the
// phone's position when it was heard, one color per device (red = police).
// A device's dots bunch along the stretch of road where it was in range;
// tap a device (list or map) to isolate it and draw its estimated spot.
// Tap empty map to clear. The camera moves when the picked hunts change and
// when a device is picked from the list; never on a map tap. Held flag
// records (src/flags.ts) mark matching devices with a red ring; the list
// shows a flagged tag and, once picked, the flag's note.
//
// Basemap: OpenFreeMap (positron / dark), as in ../super-atlas. Analysis:
// src/hunt/ (shard folding, unusual-device scoring).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {
  Camera,
  CameraRef,
  CircleLayer,
  FillLayer,
  LineLayer,
  MapView,
  OnPressEvent,
  ShapeSource,
  SymbolLayer,
} from '@maplibre/maplibre-react-native';

import {analyzeHunt, combineHunts, Hunt, huntLabel, MapDevice, parseCsv} from '../hunt/analysis';
import {circleRing, deviceColor, fanOffset} from '../hunt/color';
import {MatchOptions, matchedNotes, matchDevice, useFlagsSnapshot} from '../flags';
import type {Classification} from '../lookup/adparse';
import {findUnusual, Unusual} from '../hunt/unusual';
import {Icon} from '../components/Icon';
import {formatBytes, huntLogAvailable, listLogs, LogFile, readLog} from '../huntlog';
import {settingsStore} from '../settings';
import {Theme, useTheme} from '../theme';

type Filter = 'all' | 'police' | 'notpolice' | 'unusual' | 'flagged';
const FILTERS: {key: Filter; label: string}[] = [
  {key: 'all', label: 'All'},
  {key: 'police', label: 'Police'},
  {key: 'notpolice', label: 'Not police'},
  {key: 'unusual', label: 'Unusual'},
  {key: 'flagged', label: 'Flagged'},
];
/** finger-sized touch area around the dots, px */
const HITBOX = {width: 32, height: 32};
const POLICE_RED = '#e5484d';
const FLAG_RED = '#e5484d';

// an empty classification for a device with no AD capture: only name/oui/
// mac matchers can land on it, filled from the CSV's own columns below
const EMPTY_CLS: Classification = {
  labels: [],
  serviceUuids: [],
  serviceUuids128: [],
  companyIds: [],
  manufacturerData: [],
  eddystoneUids: [],
  randomAddress: false,
};

const isDark = (t: Theme) => !(t.name === 'light' || t.name === 'sepia');
const deviceLabel = (d: MapDevice) => d.name || d.kind || d.vendor || 'unnamed';

export function MapScreen(): React.JSX.Element {
  const theme = useTheme();
  const dark = isDark(theme);
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const camera = useRef<CameraRef>(null);
  const cache = useRef(new Map<string, {size: number; hunt: Hunt}>());
  const lastFeaturePress = useRef(0);

  const [files, setFiles] = useState<LogFile[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hunts, setHunts] = useState<Hunt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [minN, setMinN] = useState(3);
  const [query, setQuery] = useState('');
  const [fan, setFan] = useState(true);
  const [showOthers, setShowOthers] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickList, setPickList] = useState<string[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // --- files ---
  useEffect(() => {
    listLogs()
      .then(fs => {
        setFiles(fs);
        // nothing is picked by default: open the menu so hunts can be chosen
        if (fs.length) setMenuOpen(true);
      })
      .catch(e => setError(String(e?.message ?? e)));
  }, []);

  // --- load + analyze the picked hunts (cached by name and size, so a hunt still being recorded reloads) ---
  useEffect(() => {
    let cancelled = false;
    const names = [...picked].sort();
    setLoading(true);
    Promise.all(
      names.map(async name => {
        const size = files?.find(f => f.name === name)?.size ?? -1;
        const hit = cache.current.get(name);
        if (hit && hit.size === size) return hit.hunt;
        const hunt = analyzeHunt(name, parseCsv(await readLog(name)));
        cache.current.set(name, {size, hunt});
        return hunt;
      }),
    )
      .then(hs => {
        if (cancelled) return;
        setHunts(hs);
        setError(null);
      })
      .catch(e => !cancelled && setError(String(e?.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [picked, files]);

  const devices = useMemo(() => combineHunts(hunts), [hunts]);
  const unusual = useMemo(() => findUnusual(hunts), [hunts]);
  // held flag records (local + pulled from the flags server): matched
  // against each map device's classification (merged across the picked
  // hunts, with the CSV's own name/vendor as fallback), so a flagged
  // device gets the red ring and its notes can be shown in the list.
  // MAC glitch tolerance follows Settings → mergeGlitches, as on the scan
  // screen: the map's shard folding also demands a loudness ratio and a
  // time window, so with merging off two distinct near-MACs stay distinct
  // and a flag must not hop between them.
  const flags = useFlagsSnapshot();
  const [mergeGlitches, setMergeGlitches] = useState(settingsStore.get().mergeGlitches);
  useEffect(() => {
    let on = true;
    settingsStore.load().then(s => on && setMergeGlitches(s.mergeGlitches));
    const off = settingsStore.subscribe(s => setMergeGlitches(s.mergeGlitches));
    return () => {
      on = false;
      off();
    };
  }, []);
  const flagged = useMemo(() => {
    const out = new Map<string, string[]>(); // mac -> full notes; [] = flagged, no note
    if (flags.server.length + flags.local.length === 0) {
      return out;
    }
    const opts: MatchOptions = {glitchTolerant: mergeGlitches};
    for (const d of devices) {
      // the CSV's own name/vendor always ride along: a re-classified
      // payload without a local name must not lose the name column's one,
      // and with no AD capture at all the stub is all there is
      const cls = d.cls ?? EMPTY_CLS;
      const match: Classification = {
        ...cls,
        name: cls.name ?? (d.name || undefined),
        vendor: cls.vendor ?? (d.vendor || undefined),
      };
      const matched = matchDevice(flags, match, d.mac, opts).filter(m => m.record.flag);
      if (matched.length) {
        out.set(d.mac, matchedNotes(matched));
      }
    }
    return out;
  }, [devices, flags, mergeGlitches]);
  const colors = useMemo(() => new Map(devices.map(d => [d.mac, d.police ? POLICE_RED : deviceColor(d.mac, dark)])), [devices, dark]);
  const byMac = useMemo(() => new Map(devices.map(d => [d.mac, d])), [devices]);

  // drop selections that left with a hunt
  useEffect(() => {
    setSelected(s => {
      const keep = [...s].filter(m => byMac.has(m));
      return keep.length === s.size ? s : new Set(keep);
    });
  }, [byMac]);

  // fit the camera when the picked hunts change (only then)
  useEffect(() => {
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const h of hunts) {
      for (const f of h.fixes) {
        minLat = Math.min(minLat, f.lat);
        maxLat = Math.max(maxLat, f.lat);
        minLon = Math.min(minLon, f.lon);
        maxLon = Math.max(maxLon, f.lon);
      }
    }
    if (minLat <= maxLat) camera.current?.fitBounds([maxLon, maxLat], [minLon, minLat], 40, 0);
  }, [hunts]);

  const counts = useMemo(() => {
    const base = devices.filter(d => d.n >= minN);
    return {
      all: base.length,
      police: base.filter(d => d.police).length,
      notpolice: base.filter(d => !d.police).length,
      unusual: base.filter(d => unusual.has(d.mac)).length,
      flagged: base.filter(d => flagged.has(d.mac)).length,
    };
  }, [devices, minN, unusual, flagged]);

  // the Flagged chip only exists while a flagged device is shown, so a
  // stuck 'flagged' selection (all flags cleared meanwhile) is dropped
  useEffect(() => {
    if (filter === 'flagged' && counts.flagged === 0) {
      setFilter('all');
    }
  }, [filter, counts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter(d => {
      if (d.n < minN) return false;
      if (filter === 'police' && !d.police) return false;
      if (filter === 'notpolice' && d.police) return false;
      if (filter === 'unusual' && !unusual.has(d.mac)) return false;
      if (filter === 'flagged' && !flagged.has(d.mac)) return false;
      if (q && !`${d.name} ${d.kind} ${d.vendor} ${d.mac}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [devices, minN, filter, query, unusual, flagged]);

  // --- map data ---
  const shapes = useMemo(() => {
    const sel = selected.size > 0;
    const on: GeoJSON.Feature[] = [];
    const off: GeoJSON.Feature[] = [];
    for (const d of visible) {
      const target = !sel || selected.has(d.mac) ? on : off;
      const [dx, dy] = fan ? fanOffset(d.mac, d.est.lat) : [0, 0];
      for (const p of d.points) {
        target.push({
          type: 'Feature',
          geometry: {type: 'Point', coordinates: [p.lon + dx, p.lat + dy]},
          properties: {mac: d.mac, color: colors.get(d.mac), police: d.police ? 1 : 0, flagged: flagged.has(d.mac) ? 1 : 0},
        });
      }
    }
    on.sort((a, b) => (a.properties!.police as number) - (b.properties!.police as number)); // police on top
    const chosen = devices.filter(d => selected.has(d.mac));
    return {
      on: {type: 'FeatureCollection', features: on} as GeoJSON.FeatureCollection,
      off: {type: 'FeatureCollection', features: sel && showOthers ? off : []} as GeoJSON.FeatureCollection,
      tracks: {
        type: 'FeatureCollection',
        features: hunts
          .filter(h => h.fixes.length > 1)
          .map(h => ({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: h.fixes.map(f => [f.lon, f.lat])}})),
      } as GeoJSON.FeatureCollection,
      est: {
        type: 'FeatureCollection',
        features: chosen.map(d => ({
          type: 'Feature',
          properties: {color: colors.get(d.mac), flagged: flagged.has(d.mac) ? 1 : 0},
          geometry: {type: 'Polygon', coordinates: [circleRing(d.est.lat, d.est.lon, d.est.r)]},
        })),
      } as GeoJSON.FeatureCollection,
      estPt: {
        type: 'FeatureCollection',
        features: chosen.map(d => ({
          type: 'Feature',
          properties: {color: colors.get(d.mac), flagged: flagged.has(d.mac) ? 1 : 0, label: `${deviceLabel(d)}\n±${d.est.r.toFixed(0)} m`},
          geometry: {type: 'Point', coordinates: [d.est.lon, d.est.lat]},
        })),
      } as GeoJSON.FeatureCollection,
    };
  }, [visible, selected, showOthers, fan, colors, devices, hunts, flagged]);

  // --- selection ---
  const select = useCallback((mac: string, add = false) => {
    setPickList(null);
    setSelected(s => nextSelection(s, mac, add));
  }, []);

  // From the list (not the map): select, then fit the camera to what's selected.
  const selectFromList = (mac: string, add = false) => {
    const next = nextSelection(selected, mac, add);
    setPickList(null);
    setSelected(next);
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const m of next) {
      for (const p of byMac.get(m)?.points ?? []) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
      }
    }
    if (minLat > maxLat) return; // deselected: leave the camera alone
    // pad a single-spot device out to ~60 m so the camera doesn't dive in
    const pad = 0.0003;
    camera.current?.fitBounds([maxLon + pad, maxLat + pad], [minLon - pad, minLat - pad], 60, 500);
  };

  const onDotsPress = useCallback(
    (e: OnPressEvent) => {
      lastFeaturePress.current = Date.now();
      // nearest first: the touch area is larger than the dots
      const {latitude, longitude} = e.coordinates;
      const dist = (f: GeoJSON.Feature) => {
        const [x, y] = (f.geometry as GeoJSON.Point).coordinates;
        return (x - longitude) ** 2 + (y - latitude) ** 2;
      };
      const macs = [...new Set([...e.features].sort((a, b) => dist(a) - dist(b)).map(f => f.properties?.mac as string))].filter(Boolean);
      if (macs.length === 1) select(macs[0]);
      else if (macs.length > 1) setPickList(macs);
    },
    [select],
  );

  const onMapPress = useCallback(() => {
    // a dot press may also reach the map on some versions: ignore those
    setTimeout(() => {
      if (Date.now() - lastFeaturePress.current < 400) return;
      setPickList(null);
      setSelected(s => (s.size ? new Set() : s));
    }, 50);
  }, []);

  const togglePick = (name: string) =>
    setPicked(p => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  if (!huntLogAvailable()) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>The map needs the Android app</Text>
        <Text style={styles.muted}>Hunt logs are written and read by the native module.</Text>
      </View>
    );
  }

  const surface = theme.bg;
  const sightingsShown = visible.reduce((s, d) => s + d.points.length, 0);

  return (
    <View style={styles.root}>
      <Pressable style={styles.topBar} onPress={() => setMenuOpen(true)} accessibilityLabel="Hunts and filters">
        <Icon name="filter" size={18} color={theme.text} />
        <Text style={styles.topBarTxt} numberOfLines={1}>
          {picked.size === 0
            ? 'No hunts picked: tap to choose'
            : `${picked.size} hunt${picked.size > 1 ? 's' : ''} · ${FILTERS.find(f => f.key === filter)!.label} · ≥${minN} seen${fan ? ' · fan' : ''}`}
        </Text>
        <Text style={styles.link}>Filters</Text>
      </Pressable>

      <View style={styles.mapWrap}>
        <MapView
          style={styles.map}
          mapStyle={`https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`}
          logoEnabled={false}
          compassEnabled={false}
          attributionPosition={{bottom: 6, right: 6}}
          onPress={onMapPress}>
          <Camera ref={camera} />
          <ShapeSource id="tracks" shape={shapes.tracks}>
            <LineLayer
              id="tracks-line"
              style={{lineColor: dark ? '#8b949e' : '#57606a', lineWidth: 2, lineOpacity: 0.55, lineCap: 'round', lineJoin: 'round'}}
            />
          </ShapeSource>
          <ShapeSource id="dim" shape={shapes.off} hitbox={HITBOX} onPress={onDotsPress}>
            <CircleLayer
              id="dim-dots"
              style={{
                circleRadius: ['interpolate', ['linear'], ['zoom'], 12, 1.5, 17, 4],
                circleColor: dark ? '#5a5955' : '#b8b7b1',
                circleOpacity: 0.45,
              }}
            />
            <CircleLayer
              id="dim-flag-ring"
              filter={['==', ['get', 'flagged'], 1]}
              style={{
                circleRadius: ['interpolate', ['linear'], ['zoom'], 12, 5, 17, 7.5],
                circleColor: 'rgba(0,0,0,0)',
                circleStrokeColor: FLAG_RED,
                circleStrokeOpacity: 0.7,
                circleStrokeWidth: 1.5,
              }}
            />
          </ShapeSource>
          <ShapeSource id="est" shape={shapes.est}>
            <FillLayer id="est-fill" style={{fillColor: ['get', 'color'], fillOpacity: 0.12}} />
            <LineLayer
              id="est-line"
              style={{
                lineColor: ['case', ['==', ['get', 'flagged'], 1], FLAG_RED, ['get', 'color']],
                lineWidth: ['case', ['==', ['get', 'flagged'], 1], 3, 2],
                lineDasharray: [2, 2],
              }}
            />
          </ShapeSource>
          <ShapeSource id="dots" shape={shapes.on} hitbox={HITBOX} onPress={onDotsPress}>
            <CircleLayer
              id="dots-flag-ring"
              filter={['==', ['get', 'flagged'], 1]}
              style={{
                // target marker: a red ring with clear air around the dot,
                // so it stays visible even on red-filled (police) dots.
                // Drawn under the dots: the sort that keeps police dots on
                // top still decides where they overlap a ring. Radius sits
                // a few px outside dots-circle at every zoom.
                circleRadius: [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  12,
                  ['case', ['==', ['get', 'police'], 1], 7.5, 6],
                  17,
                  ['case', ['==', ['get', 'police'], 1], 12.5, 9.5],
                ],
                circleColor: 'rgba(0,0,0,0)',
                circleStrokeColor: FLAG_RED,
                circleStrokeWidth: ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 2.5],
              }}
            />
            <CircleLayer
              id="dots-circle"
              style={{
                circleRadius: [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  12,
                  ['case', ['==', ['get', 'police'], 1], 4, 2.5],
                  17,
                  ['case', ['==', ['get', 'police'], 1], 9, 6],
                ],
                circleColor: ['get', 'color'],
                circleOpacity: 0.85,
                circleStrokeColor: surface,
                circleStrokeWidth: ['interpolate', ['linear'], ['zoom'], 13, 0, 16, 1],
              }}
            />
          </ShapeSource>
          <ShapeSource id="est-pt" shape={shapes.estPt}>
            <CircleLayer id="est-dot" style={{circleRadius: 7, circleColor: ['get', 'color'], circleStrokeColor: surface, circleStrokeWidth: 2.5}} />
            <CircleLayer
              id="est-pt-flag-ring"
              filter={['==', ['get', 'flagged'], 1]}
              style={{circleRadius: 11, circleColor: 'rgba(0,0,0,0)', circleStrokeColor: FLAG_RED, circleStrokeWidth: 2.5}}
            />
            <SymbolLayer
              id="est-label"
              style={{
                textField: ['get', 'label'],
                textFont: ['Noto Sans Bold'],
                textSize: 12,
                textOffset: [0, 1.4],
                textAnchor: 'top',
                textColor: theme.text,
                textHaloColor: surface,
                textHaloWidth: 1.6,
              }}
            />
          </ShapeSource>
        </MapView>

        {loading && (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.text} />
          </View>
        )}

        {pickList && (
          <View style={styles.pick}>
            <View style={styles.pickHead}>
              <Text style={styles.pickTitle}>{pickList.length} devices here</Text>
              <Pressable onPress={() => setPickList(null)} hitSlop={10}>
                <Text style={styles.link}>Close</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.pickScroll}>
              {pickList.map(m => {
                const d = byMac.get(m);
                if (!d) return null;
                return (
                  <Pressable key={m} style={styles.pickRow} onPress={() => select(m)} onLongPress={() => select(m, true)}>
                    <View style={[styles.swatch, {backgroundColor: colors.get(m)}]} />
                    <Text style={styles.pickName} numberOfLines={1}>
                      {/* marker first: a trailing tag would be cut off with the name */}
                      {flagged.has(m) ? <Text style={styles.flagTag}>⚑ </Text> : null}
                      {deviceLabel(d)}
                    </Text>
                    <Text style={styles.muted}>{d.n}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)} />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sheetH}>Hunt sessions</Text>
            <View style={styles.wrap}>
              {files == null ? (
                <Text style={styles.muted}>Loading logs…</Text>
              ) : files.length === 0 ? (
                <Text style={styles.muted}>No hunt logs yet. Connect the scanner to record one.</Text>
              ) : (
                files.map(f => (
                  <Chip
                    key={f.name}
                    styles={styles}
                    active={picked.has(f.name)}
                    label={`${huntLabel(f.name)}${f.open ? ' ●' : ''}`}
                    sub={formatBytes(f.size)}
                    onPress={() => togglePick(f.name)}
                  />
                ))
              )}
            </View>
            {files && files.length > 1 ? (
              <View style={styles.inlineLinks}>
                <Pressable onPress={() => setPicked(new Set(files.map(f => f.name)))} hitSlop={8}>
                  <Text style={styles.link}>Select all</Text>
                </Pressable>
                <Pressable onPress={() => setPicked(new Set())} hitSlop={8}>
                  <Text style={styles.link}>Select none</Text>
                </Pressable>
              </View>
            ) : null}

            <Text style={styles.sheetH}>Show</Text>
            <View style={styles.wrap}>
              {FILTERS.filter(f => f.key !== 'flagged' || counts.flagged > 0).map(f => (
                <Chip key={f.key} styles={styles} active={filter === f.key} label={`${f.label} ${counts[f.key]}`} onPress={() => setFilter(f.key)} />
              ))}
            </View>

            <Text style={styles.sheetH}>Minimum sightings per device</Text>
            <View style={styles.wrap}>
              <View style={styles.stepper}>
                <Pressable style={styles.stepBtn} onPress={() => setMinN(n => Math.max(1, n - 1))} hitSlop={6} accessibilityLabel="Fewer minimum sightings">
                  <Text style={styles.stepTxt}>−</Text>
                </Pressable>
                <Text style={styles.stepLabel}>≥{minN} seen</Text>
                <Pressable style={styles.stepBtn} onPress={() => setMinN(n => Math.min(50, n + 1))} hitSlop={6} accessibilityLabel="More minimum sightings">
                  <Text style={styles.stepTxt}>+</Text>
                </Pressable>
              </View>
            </View>

            <Text style={styles.sheetH}>Dots</Text>
            <View style={styles.wrap}>
              <Chip styles={styles} active={fan} label="Fan out devices at the same spot" onPress={() => setFan(v => !v)} />
            </View>
          </ScrollView>
          <Pressable style={styles.done} onPress={() => setMenuOpen(false)}>
            <Text style={styles.doneTxt}>Done</Text>
          </Pressable>
        </View>
      </Modal>

      <View style={styles.panel}>

        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search name, vendor or MAC"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={styles.statusRow}>
          {selected.size ? (
            <>
              <Text style={styles.muted}>{selected.size} selected · </Text>
              <Pressable onPress={() => setSelected(new Set())} hitSlop={8}>
                <Text style={styles.link}>Clear</Text>
              </Pressable>
              <Text style={styles.muted}> · </Text>
              <Pressable onPress={() => setShowOthers(v => !v)} hitSlop={8}>
                <Text style={styles.link}>{showOthers ? 'Hide others' : 'Show others'}</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.muted}>
              {error
                ? error
                : picked.size === 0
                ? 'No hunts picked. Open Filters above to choose some.'
                : `${visible.length} devices · ${sightingsShown} sightings. Tap to isolate, long-press to add.`}
            </Text>
          )}
        </View>

        <FlatList
          data={visible}
          keyExtractor={d => d.mac}
          initialNumToRender={20}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          renderItem={({item}) => (
            <DeviceRow
              d={item}
              color={colors.get(item.mac)!}
              unusual={unusual.get(item.mac)}
              flagNotes={flagged.get(item.mac)}
              selected={selected.has(item.mac)}
              styles={styles}
              onPress={() => selectFromList(item.mac)}
              onLongPress={() => selectFromList(item.mac, true)}
            />
          )}
        />
      </View>
    </View>
  );
}

/** tap: select only this one (tap again to clear); add: toggle it in the selection */
function nextSelection(s: Set<string>, mac: string, add: boolean): Set<string> {
  if (add) {
    const n = new Set(s);
    if (n.has(mac)) n.delete(mac);
    else n.add(mac);
    return n;
  }
  return s.size === 1 && s.has(mac) ? new Set() : new Set([mac]);
}

type Styles = ReturnType<typeof makeStyles>;

function Chip({styles, active, label, sub, onPress}: {styles: Styles; active: boolean; label: string; sub?: string; onPress: () => void}) {
  return (
    <Pressable style={[styles.chip, active && styles.chipOn]} onPress={onPress} accessibilityState={{selected: active}}>
      <Text style={[styles.chipTxt, active && styles.chipTxtOn]}>{label}</Text>
      {sub ? <Text style={[styles.chipSub, active && styles.chipTxtOn]}>{sub}</Text> : null}
    </Pressable>
  );
}

const DeviceRow = React.memo(function DeviceRow({
  d,
  color,
  unusual,
  flagNotes,
  selected,
  styles,
  onPress,
  onLongPress,
}: {
  d: MapDevice;
  color: string;
  unusual?: Unusual;
  /** full notes of the flag records matching this device; [] = flagged, no note */
  flagNotes?: string[];
  selected: boolean;
  styles: Styles;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const flagged = flagNotes !== undefined;
  return (
    <Pressable style={[styles.row, selected && styles.rowSel]} onPress={onPress} onLongPress={onLongPress}>
      <View style={[styles.swatch, {backgroundColor: color}]} />
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>
          {deviceLabel(d)}
          {d.police ? <Text style={styles.police}>  {d.police}</Text> : null}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {flagged ? <Text style={styles.flagTag}>flagged · </Text> : null}
          {d.mac}
          {d.name && d.kind ? ` · ${d.kind}` : ''}
          {(d.name || d.kind) && d.vendor ? ` · ${d.vendor}` : ''}
          {unusual ? ` · ${unusual.reasons.map(r => r.tag).join(', ')}` : ''}
        </Text>
        {selected && (
          <>
            <Text style={styles.rowSub}>Estimated spot ±{d.est.r.toFixed(0)} m · {d.hunts.map(huntLabel).join(', ')}</Text>
            {flagNotes?.map((n, i) => (
              <Text key={`${i}:${n}`} style={styles.flagNote}>⚑ {n}</Text>
            ))}
            {unusual?.reasons.map(r => (
              <Text key={r.tag + r.why} style={styles.rowSub}>
                • {r.why}
              </Text>
            ))}
          </>
        )}
      </View>
      <View style={styles.rowCount}>
        <Text style={styles.rowN}>{d.n}</Text>
        {d.hunts.length > 1 ? <Text style={styles.rowSub}>{d.hunts.length} hunts</Text> : null}
      </View>
    </Pressable>
  );
});

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: {flex: 1, backgroundColor: t.bg},
    mapWrap: {flex: 11},
    map: {flex: 1},
    loading: {position: 'absolute', top: 10, left: 10, padding: 8, borderRadius: 8, backgroundColor: t.surface},
    panel: {flex: 9, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.bg},
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
    },
    topBarTxt: {flex: 1, fontSize: 13, color: t.text},
    backdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)'},
    sheet: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      maxHeight: '85%',
      backgroundColor: t.bg,
      borderBottomLeftRadius: 14,
      borderBottomRightRadius: 14,
      borderBottomWidth: 1,
      borderColor: t.border,
    },
    sheetBody: {padding: 16, paddingBottom: 8},
    sheetH: {fontSize: 12, fontWeight: '700', color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 8},
    wrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    inlineLinks: {flexDirection: 'row', gap: 18, marginTop: 10},
    done: {margin: 12, marginTop: 4, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: t.text},
    doneTxt: {fontSize: 15, fontWeight: '700', color: t.bg},
    chip: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
    },
    chipOn: {backgroundColor: t.text, borderColor: t.text},
    chipTxt: {fontSize: 13, color: t.text, fontWeight: '600'},
    chipSub: {fontSize: 11, color: t.textMuted},
    chipTxtOn: {color: t.bg},
    stepper: {flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 999, backgroundColor: t.surface},
    stepBtn: {paddingHorizontal: 12, paddingVertical: 4},
    stepTxt: {fontSize: 16, color: t.text, fontWeight: '700'},
    stepLabel: {fontSize: 13, color: t.text, fontVariant: ['tabular-nums']},
    search: {
      flexShrink: 0,
      marginHorizontal: 10,
      marginTop: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      color: t.text,
      backgroundColor: t.surface,
      fontSize: 13,
    },
    statusRow: {flexShrink: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6},
    muted: {fontSize: 12, color: t.textMuted},
    link: {fontSize: 12, color: t.primary, fontWeight: '600'},
    row: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    rowSel: {backgroundColor: t.surface, borderLeftWidth: 3, borderLeftColor: t.text, paddingLeft: 9},
    swatch: {width: 12, height: 12, borderRadius: 6, marginTop: 3},
    rowMain: {flex: 1, minWidth: 0},
    rowName: {fontSize: 14, color: t.text, fontWeight: '600'},
    rowSub: {fontSize: 11, color: t.textMuted, marginTop: 1},
    police: {color: POLICE_RED, fontSize: 12, fontWeight: '700'},
    flagTag: {color: FLAG_RED, fontSize: 11, fontWeight: '700'},
    flagNote: {fontSize: 12, color: t.text, marginTop: 3},
    rowCount: {alignItems: 'flex-end'},
    rowN: {fontSize: 13, color: t.text, fontVariant: ['tabular-nums']},
    pick: {
      position: 'absolute',
      left: 10,
      right: 10,
      bottom: 10,
      maxHeight: 240,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.bg,
      paddingVertical: 6,
    },
    pickHead: {flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 4},
    pickTitle: {fontSize: 13, fontWeight: '700', color: t.text},
    pickScroll: {flexGrow: 0},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8},
    pickName: {flex: 1, fontSize: 13, color: t.text},
    empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 6},
    emptyTitle: {fontSize: 15, fontWeight: '700', color: t.text},
  });
}

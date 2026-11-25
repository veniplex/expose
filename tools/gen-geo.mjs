// Build-time generator for the globe's close-zoom geography (world-atlas 50m + d3-geo).
// Writes three compact binary/JSON assets to src/globe/gen/ that the app lazy-loads by URL:
//   borders.bin   — country borders + coastlines as quantised Int16 polylines
//   land-mask.bin — 4096×2048 equirectangular land mask, run-length encoded (Uint16 runs per row)
//   countries.json — country label anchors [name, lat, lon, areaRank]
// Run `node tools/gen-geo.mjs --force` to regenerate.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { feature, mesh } from 'topojson-client';
import { geoArea, geoCentroid, geoContains } from 'd3-geo';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src/globe/gen');
const outs = ['borders.bin', 'land-mask.bin', 'countries.json'].map((f) => join(outDir, f));
const self = fileURLToPath(import.meta.url);
if (
  !process.argv.includes('--force') &&
  outs.every((f) => existsSync(f) && statSync(f).mtimeMs >= statSync(self).mtimeMs)
) {
  console.log('[gen-geo] geo assets are up to date (use --force to regenerate)');
  process.exit(0);
}

const require = createRequire(import.meta.url);
let topo;
try {
  topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
} catch {
  if (outs.every((f) => existsSync(f))) {
    console.log('[gen-geo] world-atlas not installed, keeping committed geo assets');
    process.exit(0);
  }
  throw new Error('world-atlas is required to generate geo assets');
}
mkdirSync(outDir, { recursive: true });

/* ---------- borders + coastline polylines ---------- */
// File layout: u32 magic 'EXGB', u32 borderLineCount, u32 coastLineCount, u32 totalPoints,
// then a byte stream of zigzag varints: per line its point count, then per point (lon, lat)
// quantised to lon * 32767/180, lat * 32767/90 — the first point absolute, the rest as deltas
// to the previous point. ~2 bytes per point and still compresses well.
const Q_LON = 32767 / 180;
const Q_LAT = 32767 / 90;
const MIN_STEP = 0.01; // drop points closer than this (degrees) to the previous one
function lines(ml) {
  const out = [];
  for (const line of ml.coordinates) {
    const pts = [];
    let pl = null;
    for (const [lon, lat] of line) {
      if (pl && Math.abs(lon - pl[0]) > 180) {
        // antimeridian jump: end this polyline and start a new one
        if (pts.length >= 2) out.push(pts.splice(0));
        else pts.length = 0;
        pl = null;
      }
      if (pl && Math.abs(lon - pl[0]) < MIN_STEP && Math.abs(lat - pl[1]) < MIN_STEP) continue;
      pts.push([lon, lat]);
      pl = [lon, lat];
    }
    const last = line[line.length - 1];
    if (pts.length && (pts[pts.length - 1][0] !== last[0] || pts[pts.length - 1][1] !== last[1])) pts.push(last);
    // split very long lines so the u16 count never overflows
    for (let i = 0; i < pts.length - 1; i += 60000) out.push(pts.slice(i, i + 60001));
  }
  return out.filter((l) => l.length >= 2);
}
const borders = lines(mesh(topo, topo.objects.countries, (a, b) => a !== b));
const coast = lines(mesh(topo, topo.objects.countries, (a, b) => a === b));
const all = [...borders, ...coast];
const total = all.reduce((s, l) => s + l.length, 0);
const bytes = [];
const varint = (v) => {
  let z = v < 0 ? -2 * v - 1 : 2 * v; // zigzag
  while (z >= 0x80) {
    bytes.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  bytes.push(z);
};
for (const l of all) {
  varint(l.length);
  let px = 0;
  let py = 0;
  l.forEach(([lon, lat], i) => {
    const qx = Math.round(lon * Q_LON);
    const qy = Math.round(lat * Q_LAT);
    varint(i ? qx - px : qx);
    varint(i ? qy - py : qy);
    px = qx;
    py = qy;
  });
}
const buf = Buffer.alloc(16 + bytes.length);
buf.write('EXGB', 0, 'ascii');
buf.writeUInt32LE(borders.length, 4);
buf.writeUInt32LE(coast.length, 8);
buf.writeUInt32LE(total, 12);
Buffer.from(bytes).copy(buf, 16);
writeFileSync(outs[0], buf);
console.log(`[gen-geo] borders.bin: ${borders.length} border + ${coast.length} coast lines, ${total} points, ${buf.length} bytes`);

/* ---------- land mask (scanline rasterised, even-odd) ---------- */
// Layout: u32 magic 'EXLM', u16 width, u16 height, then per row: u16 runCount, then runCount × (u16 start, u16 length)
const W = 4096;
const H = 2048;
const countries = feature(topo, topo.objects.countries);
// Each polygon (with its holes) is rasterised on its own with even-odd scanlines and OR-ed into
// the mask, so a ring that crosses the antimeridian (unwrapped to continuous longitudes, closed
// over the pole when it circles the globe) can't break the parity of its neighbours.
const mask = new Uint8Array(W * H);
const polygons = [];
for (const f of countries.features) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'Polygon') polygons.push(g.coordinates);
  else if (g.type === 'MultiPolygon') polygons.push(...g.coordinates);
}
function unwrap(ring) {
  const out = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, ring[i][1]]);
  }
  const d = out[out.length - 1][0] - out[0][0];
  if (Math.abs(d) > 180) {
    // circles the globe (Antarctica): close it over the nearer pole
    const pole = out.reduce((s, p) => s + p[1], 0) / out.length < 0 ? -90 : 90;
    out.push([out[out.length - 1][0], pole], [out[0][0], pole], out[0]);
  }
  return out;
}
for (const poly of polygons) {
  const edges = [];
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const raw of poly) {
    const r = unwrap(raw);
    for (let i = 0; i < r.length - 1; i++) {
      const xa = ((r[i][0] + 180) / 360) * W;
      const ya = ((90 - r[i][1]) / 180) * H;
      const xb = ((r[i + 1][0] + 180) / 360) * W;
      const yb = ((90 - r[i + 1][1]) / 180) * H;
      if (ya === yb) continue;
      edges.push(ya < yb ? [ya, yb, xa, (xb - xa) / (yb - ya)] : [yb, ya, xb, (xa - xb) / (ya - yb)]);
      y0 = Math.min(y0, ya, yb);
      y1 = Math.max(y1, ya, yb);
    }
  }
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    const yc = y + 0.5;
    const xs = [];
    for (const e of edges) if (e[0] <= yc && e[1] > yc) xs.push(e[2] + (yc - e[0]) * e[3]);
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const s = Math.round(xs[k]);
      const e = Math.round(xs[k + 1]);
      for (let x = s; x < e; x++) mask[y * W + (((x % W) + W) % W)] = 1;
    }
  }
}
const rows = [];
let maskBytes = 0;
for (let y = 0; y < H; y++) {
  const runs = [];
  let x = 0;
  while (x < W) {
    if (!mask[y * W + x]) {
      x++;
      continue;
    }
    const s = x;
    while (x < W && mask[y * W + x]) x++;
    runs.push([s, x - s]);
  }
  rows.push(runs);
  maskBytes += 2 + runs.length * 4;
}
const mb = Buffer.alloc(8 + maskBytes);
mb.write('EXLM', 0, 'ascii');
mb.writeUInt16LE(W, 4);
mb.writeUInt16LE(H, 6);
let o = 8;
for (const runs of rows) {
  mb.writeUInt16LE(runs.length, o);
  o += 2;
  for (const [s, l] of runs) {
    mb.writeUInt16LE(s, o);
    mb.writeUInt16LE(l, o + 2);
    o += 4;
  }
}
writeFileSync(outs[1], mb);
console.log(`[gen-geo] land-mask.bin: ${W}x${H}, ${mb.length} bytes`);

/* ---------- country label anchors ---------- */
const labels = [];
for (const f of countries.features) {
  if (!f.geometry || !f.properties?.name) continue;
  // anchor on the largest polygon so e.g. France sits in Europe, not in French Guiana
  let best = f.geometry;
  if (f.geometry.type === 'MultiPolygon') {
    let ba = -1;
    for (const p of f.geometry.coordinates) {
      const poly = { type: 'Polygon', coordinates: p };
      const a = geoArea(poly);
      if (a > ba) ((ba = a), (best = poly));
    }
  }
  let [lon, lat] = geoCentroid(best);
  if (!geoContains(best, [lon, lat])) {
    // concave shape: fall back to the polygon vertex mean nudged toward the centroid
    const ring = best.coordinates[0];
    const mid = ring[Math.floor(ring.length / 2)];
    lon = (lon + mid[0]) / 2;
    lat = (lat + mid[1]) / 2;
  }
  labels.push({ name: f.properties.name, lat: +lat.toFixed(2), lon: +lon.toFixed(2), area: geoArea(f) });
}
labels.sort((a, b) => b.area - a.area);
writeFileSync(outs[2], JSON.stringify(labels.map((l) => [l.name, l.lat, l.lon])));
console.log(`[gen-geo] countries.json: ${labels.length} labels`);

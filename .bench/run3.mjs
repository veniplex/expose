import { spreadPositions } from './geo3.js';
import { readFileSync } from 'node:fs';
const g = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const n = g.entities.length;
const lat = Float64Array.from(g.entities, e => e.lat), lon = Float64Array.from(g.entities, e => e.lon);
const w = Float64Array.from(g.entities, e => e.influence ?? 0.1);
const active = new Uint8Array(n).fill(1);
const out = { lat: new Float64Array(n), lon: new Float64Array(n) };
for (const [pxPerDeg, zf] of [[7.3, 0], [15, 0.15], [40, 0.35], [120, 0.6], [400, 0.85], [770, 1]]) {
  const overlap = 0.42 + 0.58 * Math.min(1, zf / 0.55);
  const t = Math.max(0, Math.min(1, (zf - 0.25) / 0.7)); const gap = 0.5 + 16 * t * t * (3 - 2 * t);
  const rad = Float64Array.from(w, (x) => ((21 * Math.sqrt(Math.max(0.0958, x))) * (0.92 + 0.3 * zf) * 0.36 * overlap + gap / 2) / pxPerDeg);
  const t0 = performance.now();
  for (let r = 0; r < 5; r++) spreadPositions(lat, lon, w, rad, active, out);
  console.log(globalThis.T1/5, globalThis.T2/5);globalThis.T1=globalThis.T2=0;console.log(pxPerDeg, ((performance.now() - t0) / 5).toFixed(2), 'ms');
}

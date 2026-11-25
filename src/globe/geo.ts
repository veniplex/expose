import { Vector3 } from 'three';

export const DEG = Math.PI / 180;

/** Unit-sphere position for lat/lon (degrees). +Z faces lon 0 / lat 0, +Y is north. */
export function toVec3(lat: number, lon: number, r = 1, out = new Vector3()): Vector3 {
  const la = lat * DEG;
  const lo = lon * DEG;
  return out.set(Math.cos(la) * Math.sin(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.cos(lo) * r);
}

/** Wrap an angle (radians) into [-PI, PI). */
export function wrapPi(a: number): number {
  return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

/**
 * Sample an elevated great-circle arc between unit vectors a and b into `out`
 * (xyz triplets, `segments + 1` points). Returns the arc's central angle.
 */
export function sampleArc(
  a: Vector3,
  b: Vector3,
  segments: number,
  liftFor: (angle: number) => number,
  out: Float32Array,
  offset = 0,
  base = 1.004,
): number {
  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  const omega = Math.acos(dot);
  const s = Math.sin(omega);
  const lift = liftFor(omega);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let k1: number;
    let k2: number;
    if (s < 1e-5) {
      k1 = 1 - t;
      k2 = t;
    } else {
      k1 = Math.sin((1 - t) * omega) / s;
      k2 = Math.sin(t * omega) / s;
    }
    let x = a.x * k1 + b.x * k2;
    let y = a.y * k1 + b.y * k2;
    let z = a.z * k1 + b.z * k2;
    const len = Math.hypot(x, y, z) || 1;
    const r = (base + lift * Math.sin(Math.PI * t)) / len;
    x *= r;
    y *= r;
    z *= r;
    const o = offset + i * 3;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
  }
  return omega;
}

export const segmentsFor = (omega: number, max = 64): number =>
  Math.max(10, Math.min(max, Math.ceil(omega * 28)));

/**
 * Deterministically spread nodes that share (almost) the same location so each stays clickable.
 * `spacing` is the minimum distance in degrees between two markers. Nodes start on a sunflower
 * spiral around their true point (most connected in the middle), then a short relaxation pushes
 * apart anything still closer than `spacing` while pulling gently back toward the true position.
 */
export function spreadPositions(
  lat: Float64Array,
  lon: Float64Array,
  weight: Float64Array,
  spacing: number,
): { lat: Float64Array; lon: Float64Array } {
  const n = lat.length;
  const outLat = Float64Array.from(lat);
  const outLon = Float64Array.from(lon);
  if (n === 0 || spacing <= 0) return { lat: outLat, lon: outLon };

  // 1. bucket exact/near duplicates and lay them out on a sunflower spiral
  const bucket = new Map<string, number[]>();
  const q = Math.max(spacing * 0.5, 0.01);
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(lat[i] / q)}:${Math.round(lon[i] / q)}`;
    const arr = bucket.get(key);
    if (arr) arr.push(i);
    else bucket.set(key, [i]);
  }
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const c = spacing / 1.75;
  for (const ids of bucket.values()) {
    if (ids.length < 2) continue;
    ids.sort((x, y) => weight[y] - weight[x] || x - y);
    let cl = 0;
    let co = 0;
    for (const i of ids) {
      cl += lat[i];
      co += lon[i];
    }
    cl /= ids.length;
    co /= ids.length;
    const cosl = Math.max(0.2, Math.cos(cl * DEG));
    ids.forEach((i, k) => {
      const r = c * Math.sqrt(k);
      const a = k * GOLDEN;
      outLat[i] = cl + r * Math.sin(a);
      outLon[i] = co + (r * Math.cos(a)) / cosl;
    });
  }

  // 2. relaxation (O(n²) but n is a few hundred and this runs only when the zoom changes)
  const s2 = spacing * spacing;
  for (let it = 0; it < 24; it++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dLat = outLat[j] - outLat[i];
        if (dLat > spacing || dLat < -spacing) continue;
        const cosl = Math.max(0.2, Math.cos(((outLat[i] + outLat[j]) / 2) * DEG));
        let dLon = outLon[j] - outLon[i];
        if (dLon > 180) dLon -= 360;
        else if (dLon < -180) dLon += 360;
        const dx = dLon * cosl;
        const d2 = dx * dx + dLat * dLat;
        if (d2 >= s2) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const push = ((spacing - d) / d) * 0.5;
        // heavier (more connected) nodes move less
        const wi = weight[j] + 1;
        const wj = weight[i] + 1;
        const fi = wi / (wi + wj);
        const fj = 1 - fi;
        const px = d2 < 1e-12 ? spacing * 0.5 : dx * push;
        const py = d2 < 1e-12 ? 0 : dLat * push;
        outLat[i] -= py * fi;
        outLon[i] -= (px * fi) / cosl;
        outLat[j] += py * fj;
        outLon[j] += (px * fj) / cosl;
      }
    }
    for (let i = 0; i < n; i++) {
      outLat[i] += (lat[i] - outLat[i]) * 0.03;
      outLon[i] += (lon[i] - outLon[i]) * 0.03;
    }
  }
  for (let i = 0; i < n; i++) outLat[i] = Math.max(-85, Math.min(85, outLat[i]));
  return { lat: outLat, lon: outLon };
}

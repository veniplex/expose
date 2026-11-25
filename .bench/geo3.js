import { Vector3 } from 'three';
export const DEG = Math.PI / 180;
/** Unit-sphere position for lat/lon (degrees). +Z faces lon 0 / lat 0, +Y is north. */
export function toVec3(lat, lon, r = 1, out = new Vector3()) {
    const la = lat * DEG;
    const lo = lon * DEG;
    return out.set(Math.cos(la) * Math.sin(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.cos(lo) * r);
}
/** Wrap an angle (radians) into [-PI, PI). */
export function wrapPi(a) {
    return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}
/**
 * Sample an elevated great-circle arc between unit vectors a and b into `out`
 * (xyz triplets, `segments + 1` points). Returns the arc's central angle.
 */
export function sampleArc(a, b, segments, liftFor, out, offset = 0, base = 1.004) {
    const dot = Math.min(1, Math.max(-1, a.dot(b)));
    const omega = Math.acos(dot);
    const s = Math.sin(omega);
    const lift = liftFor(omega);
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        let k1;
        let k2;
        if (s < 1e-5) {
            k1 = 1 - t;
            k2 = t;
        }
        else {
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
export const segmentsFor = (omega, max = 64) => Math.max(10, Math.min(max, Math.ceil(omega * 28)));
/**
 * Deterministically spread nodes that share (almost) the same location so each stays visible and
 * tappable. `rad[i]` is node i's half-spacing in degrees (two nodes want ≥ rad[i] + rad[j] between
 * them); `active[i] = 0` excludes a node (hidden kinds keep their true position and take no room).
 *
 * 1. Exact / near duplicates (same city pin) start on a sunflower spiral around their common
 *    point, most influential in the middle.
 * 2. A few relaxation passes over a uniform hash grid push apart anything still too close while
 *    pulling gently back toward the true position. O(n · neighbours) per pass, so it stays cheap
 *    at a few thousand nodes and can run whenever the zoom changes the spacing.
 */
export function spreadPositions(lat, lon, weight, rad, active, out, iterations = 6) {
    const n = lat.length;
    globalThis.T0=performance.now();
    const outLat = out.lat;
    const outLon = out.lon;
    outLat.set(lat);
    outLon.set(lon);
    if (n === 0)
        return;
    let maxRad = 0;
    for (let i = 0; i < n; i++)
        if (active[i] && rad[i] > maxRad)
            maxRad = rad[i];
    if (maxRad <= 0)
        return;
    // 1. sunflower for co-located pins (bucket at a fixed ~1 km resolution: identical city pins)
    const bucket = new Map();
    for (let i = 0; i < n; i++) {
        if (!active[i])
            continue;
        const key = Math.round((lat[i] + 90) * 100) * 40000 + Math.round((lon[i] + 180) * 100);
        const arr = bucket.get(key);
        if (arr)
            arr.push(i);
        else
            bucket.set(key, [i]);
    }
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    for (const ids of bucket.values()) {
        if (ids.length < 2)
            continue;
        ids.sort((x, y) => weight[y] - weight[x] || x - y);
        let r0 = 0;
        for (const i of ids)
            r0 += rad[i];
        // sunflower cell spacing ≈ average diameter
        const c = (2 * r0) / ids.length / 1.75;
        const cl = lat[ids[0]];
        const co = lon[ids[0]];
        const cosl = Math.max(0.2, Math.cos(cl * DEG));
        ids.forEach((i, k) => {
            const r = c * Math.sqrt(k);
            const a = k * GOLDEN;
            outLat[i] = cl + r * Math.sin(a);
            outLon[i] = co + (r * Math.cos(a)) / cosl;
        });
    }
    globalThis.T1=(globalThis.T1||0)+performance.now()-globalThis.T0;globalThis.T0=performance.now();
    // 2. relaxation over a sorted cell index (cell ≈ a typical pair distance; big nodes search
    //    a wider neighbourhood). No allocations per pass: keys are packed into one Float64Array.
    const act = [];
    for (let i = 0; i < n; i++)
        if (active[i])
            act.push(i);
    const m = act.length;
    const radsSorted = Float64Array.from(act, (i) => rad[i]).sort();
    const cell = Math.max(1e-9, 2 * radsSorted[Math.floor(m * 0.9)]);
    const COLS = Math.ceil(400 / cell) + 2;
    const packed = new Float64Array(m);
    const keys = new Float64Array(m);
    const idx = new Int32Array(m);
    const N = 8192;
    const lowerBound = (k) => {
        let lo = 0;
        let hi = m;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (keys[mid] < k)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
    };
    for (let it = 0; it < iterations; it++) {
        for (let k = 0; k < m; k++) {
            const i = act[k];
            const key = Math.floor((outLat[i] + 100) / cell) * COLS + Math.floor((outLon[i] + 200) / cell);
            packed[k] = key * N + k;
        }
        packed.sort();
        for (let k = 0; k < m; k++) {
            const key = Math.floor(packed[k] / N);
            keys[k] = key;
            idx[k] = act[packed[k] - key * N];
        }
        let moved = 0;
        for (let k = 0; k < m; k++) {
            const i = act[k];
            const cx = Math.floor((outLon[i] + 200) / cell);
            const cy = Math.floor((outLat[i] + 100) / cell);
            const cosl = Math.max(0.2, Math.cos(outLat[i] * DEG));
            // each pair is resolved by its larger node, whose reach (2 × its radius) covers the pair
            const reach = Math.max(1, Math.ceil((2 * rad[i]) / cell));
            // longitude cells shrink toward the poles: widen the search horizontally
            const spanX = Math.min(COLS, Math.ceil(reach / cosl));
            for (let gy = cy - reach; gy <= cy + reach; gy++) {
                const end = gy * COLS + cx + spanX;
                for (let p = lowerBound(gy * COLS + cx - spanX); p < m && keys[p] <= end; p++) {
                    const j = idx[p];
                    if (j === i || rad[j] > rad[i] || (rad[j] === rad[i] && j < i))
                        continue;
                    const min = rad[i] + rad[j];
                    const dLat = outLat[j] - outLat[i];
                    if (dLat > min || dLat < -min)
                        continue;
                    const dx = (outLon[j] - outLon[i]) * cosl;
                    if (dx > min || dx < -min)
                        continue;
                    const d2 = dx * dx + dLat * dLat;
                    if (d2 >= min * min)
                        continue;
                    const d = Math.sqrt(d2);
                    const push = d < 1e-9 ? min * 0.5 : ((min - d) / d) * 0.5;
                    const px = d < 1e-9 ? push * (((i * 7 + j) % 2) * 2 - 1) : dx * push;
                    const py = d < 1e-9 ? 0 : dLat * push;
                    // heavier (more influential) nodes move less
                    const wi = weight[j] + 0.25;
                    const wj = weight[i] + 0.25;
                    const fi = wi / (wi + wj);
                    const fj = 1 - fi;
                    outLat[i] -= py * fi;
                    outLon[i] -= (px * fi) / cosl;
                    outLat[j] += py * fj;
                    outLon[j] += (px * fj) / cosl;
                    moved++;
                }
            }
        }
        for (let k = 0; k < m; k++) {
            const i = act[k];
            outLat[i] += (lat[i] - outLat[i]) * 0.03;
            outLon[i] += (lon[i] - outLon[i]) * 0.03;
        }
        if (!moved)
            break;
    }
    globalThis.T2=(globalThis.T2||0)+performance.now()-globalThis.T0;
    for (let i = 0; i < n; i++)
        outLat[i] = Math.max(-85, Math.min(85, outLat[i]));
}

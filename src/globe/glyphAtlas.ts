import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RedFormat, UnsignedByteType } from 'three';
import { KINDS } from '../kinds';

/** Atlas geometry shared with the marker shader. */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
export const ATLAS_CELL = 64;
/** fraction of a cell the 24-unit glyph box occupies (the rest is room for the outline / SDF falloff) */
export const ATLAS_GLYPH = 44 / 64;
/** SDF range in cell pixels: texel 0.5 = edge, 0 / 1 = this many px outside / inside */
export const ATLAS_RANGE = 8;

const INF = 1e20;

/** 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared distance from every pixel to the nearest pixel where `seed` is true. */
function edt2d(seed: Uint8Array, w: number, h: number): Float64Array {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = seed[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  return grid;
}

/**
 * Rasterise every kind glyph (same SVG path as the UI icon) into a signed distance field atlas.
 * Single-channel texture; the marker shader derives a crisp fill + dark outline at any size.
 */
export function createGlyphAtlas(): DataTexture {
  const W = ATLAS_COLS * ATLAS_CELL;
  const H = ATLAS_ROWS * ATLAS_CELL;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  const scale = (ATLAS_CELL * ATLAS_GLYPH) / 24;
  for (const k of KINDS) {
    const cx = (k.atlas % ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2;
    const cy = Math.floor(k.atlas / ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2;
    ctx.setTransform(scale, 0, 0, scale, cx, cy);
    ctx.fill(new Path2D(k.path), 'evenodd');
  }
  const px = ctx.getImageData(0, 0, W, H).data;
  const inside = new Uint8Array(W * H);
  const outside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const on = px[i * 4 + 3] >= 128;
    inside[i] = on ? 1 : 0;
    outside[i] = on ? 0 : 1;
  }
  const dOut = edt2d(inside, W, H); // distance to the glyph (for outside pixels)
  const dIn = edt2d(outside, W, H); // distance to the background (for inside pixels)
  const data = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const sd = inside[i] ? Math.sqrt(dIn[i]) - 0.5 : -(Math.sqrt(dOut[i]) - 0.5);
    data[i] = Math.max(0, Math.min(255, Math.round((0.5 + sd / (2 * ATLAS_RANGE)) * 255)));
  }
  const tex = new DataTexture(data, W, H, RedFormat, UnsignedByteType);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// Close-zoom geography, generated at build time by tools/gen-geo.mjs and fetched lazily as
// separate (hashed, gzip/brotli-served) assets so they never weigh on the main bundle.
import bordersUrl from './gen/borders.bin?url';
import maskUrl from './gen/land-mask.bin?url';
import countriesUrl from './gen/countries.json?url';

export interface BorderData {
  /** segment endpoints as unit-sphere xyz (LineSegments layout) */
  positions: Float32Array;
  /** 1 for coastline segments, 0 for country borders (per vertex) */
  coast: Float32Array;
}

export interface LandMask {
  width: number;
  height: number;
  /** 0 / 255 per texel, row 0 = 90°N, column 0 = 180°W */
  data: Uint8Array;
}

/** [name, lat, lon], sorted by country area (largest first) */
export type CountryLabel = [string, number, number];

const fetchBuf = async (url: string): Promise<ArrayBuffer> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
};

export async function loadBorders(radius: number): Promise<BorderData> {
  const buf = await fetchBuf(bordersUrl);
  const dv = new DataView(buf);
  const nBorder = dv.getUint32(4, true);
  const nCoast = dv.getUint32(8, true);
  const total = dv.getUint32(12, true);
  const nLines = nBorder + nCoast;
  const bytes = new Uint8Array(buf, 16);
  let o = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[o++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v % 2 ? -(v + 1) / 2 : v / 2; // un-zigzag
  };
  const segs = total - nLines;
  const positions = new Float32Array(segs * 6);
  const coast = new Float32Array(segs * 2);
  const KX = (180 / 32767) * (Math.PI / 180);
  const KY = (90 / 32767) * (Math.PI / 180);
  let s = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  let qx = 0;
  let qy = 0;
  for (let li = 0; li < nLines; li++) {
    const isCoast = li >= nBorder ? 1 : 0;
    const count = varint();
    for (let k = 0; k < count; k++) {
      if (k === 0) {
        qx = varint();
        qy = varint();
      } else {
        qx += varint();
        qy += varint();
      }
      const lo = qx * KX;
      const la = qy * KY;
      const cl = Math.cos(la);
      const x = cl * Math.sin(lo) * radius;
      const y = Math.sin(la) * radius;
      const z = cl * Math.cos(lo) * radius;
      if (k > 0) {
        const b = s * 6;
        positions[b] = px;
        positions[b + 1] = py;
        positions[b + 2] = pz;
        positions[b + 3] = x;
        positions[b + 4] = y;
        positions[b + 5] = z;
        coast[s * 2] = coast[s * 2 + 1] = isCoast;
        s++;
      }
      px = x;
      py = y;
      pz = z;
    }
  }
  return { positions, coast };
}

export async function loadLandMask(): Promise<LandMask> {
  const buf = await fetchBuf(maskUrl);
  const dv = new DataView(buf);
  const width = dv.getUint16(4, true);
  const height = dv.getUint16(6, true);
  const data = new Uint8Array(width * height);
  let o = 8;
  for (let y = 0; y < height; y++) {
    const runs = dv.getUint16(o, true);
    o += 2;
    for (let r = 0; r < runs; r++, o += 4) {
      const s = dv.getUint16(o, true);
      const l = dv.getUint16(o + 2, true);
      data.fill(255, y * width + s, y * width + s + l);
    }
  }
  return { width, height, data };
}

export async function loadCountries(): Promise<CountryLabel[]> {
  const res = await fetch(countriesUrl);
  if (!res.ok) throw new Error(`countries: ${res.status}`);
  return (await res.json()) as CountryLabel[];
}

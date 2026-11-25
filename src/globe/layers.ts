import {
  AdditiveBlending,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
  BufferAttribute,
  BufferGeometry,
  Color,
  EllipseCurve,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  Line,
  LineSegments,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import type { Theme } from '../theme';
import { LAND_DOTS_B64, LAND_DOT_COUNT } from './land-dots.gen';
import { toVec3 } from './geo';
import type { BorderData, LandMask } from './geoAssets';

/** Shared GLSL: how much a surface point faces the camera (1 = centre, 0 = limb). */
const FACING = /* glsl */ `
  float facingOf(vec3 local) {
    vec4 world = modelMatrix * vec4(local, 1.0);
    vec3 n = normalize(world.xyz);
    vec3 v = normalize(cameraPosition - world.xyz);
    return dot(n, v);
  }
`;

/**
 * Black sphere with a faint top-left sheen; writes depth so everything behind it is hidden.
 * It also draws the close-zoom land dot matrix procedurally: a lat/lon dot grid whose spacing
 * follows the zoom (two levels cross-faded), kept where the land mask texture says "land".
 * The mask is lazy-loaded (see geoAssets.ts); until then `uGrid` stays 0.
 */
export function createSphere(theme: Theme): Mesh {
  const empty = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat, UnsignedByteType);
  empty.needsUpdate = true;
  const mat = new ShaderMaterial({
    uniforms: {
      uA: { value: theme.discA },
      uB: { value: theme.discB },
      uDotColor: { value: theme.dot },
      uMask: { value: empty },
      uGrid: { value: 0 },
      uS0: { value: 1.05 },
      uS1: { value: 0.525 },
      uMix: { value: 0 },
      uDot: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main() {
        vN = normalize(normalMatrix * normal);
        vP = position;
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uA; uniform vec3 uB; uniform vec3 uDotColor; uniform sampler2D uMask;
      uniform float uGrid; uniform float uS0; uniform float uS1; uniform float uMix; uniform float uDot;
      varying vec3 vN; varying vec3 vP; varying vec3 vW;
      const float R2D = 57.29577951;

      float layer(float lat, float lon, float coslat, float s, float pxPerDeg) {
        float row = floor((lat + 90.0) / s);
        float rowLat = (row + 0.5) * s - 90.0;
        float n = max(1.0, floor(360.0 * max(cos(rowLat / R2D), 0.0) / s));
        float step = 360.0 / n;
        float phase = mod(row, 2.0) * 0.5 * step;
        float col = floor((lon + 180.0 - phase) / step);
        float cLon = (col + 0.5) * step + phase - 180.0;
        vec2 d = vec2((lon - cLon) * coslat, lat - rowLat) * pxPerDeg;
        float c = 1.0 - smoothstep(uDot - 0.7, uDot + 0.7, length(d));
        if (c <= 0.0) return 0.0;
        float land = texture2D(uMask, vec2((cLon + 180.0) / 360.0, (90.0 - rowLat) / 180.0)).r;
        return c * smoothstep(0.35, 0.65, land);
      }

      void main() {
        float l = max(dot(normalize(vN), normalize(vec3(-0.45, 0.5, 0.75))), 0.0);
        vec3 col = mix(uB, uA, pow(l, 1.6));
        if (uGrid > 0.001) {
          vec3 p = normalize(vP);
          float lat = asin(clamp(p.y, -1.0, 1.0)) * R2D;
          float lon = atan(p.x, p.z) * R2D;
          float coslat = cos(lat / R2D);
          // screen px per degree at this fragment (seam-free: from the 3D position)
          float degPerPx = max(length(dFdx(vP)), length(dFdy(vP))) * R2D;
          float pxPerDeg = 1.0 / max(degPerPx, 1e-7);
          float m = smoothstep(0.25, 0.75, uMix);
          float a = layer(lat, lon, coslat, uS0, pxPerDeg) * (1.0 - m) + layer(lat, lon, coslat, uS1, pxPerDeg) * m;
          vec3 n = normalize(vW);
          float f = dot(n, normalize(cameraPosition - vW));
          float fa = f <= 0.02 ? 0.0 : (0.2 + 0.68 * pow(f, 1.2)) * smoothstep(0.02, 0.22, f);
          col = mix(col, uDotColor, a * fa * uGrid);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const m = new Mesh(new SphereGeometry(1, 192, 128), mat);
  m.renderOrder = 0;
  return m;
}

/** Hand the decoded land mask to the sphere shader. */
export function setLandMask(sphere: Mesh, mask: LandMask): void {
  const tex = new DataTexture(mask.data, mask.width, mask.height, RedFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  (sphere.material as ShaderMaterial).uniforms.uMask.value = tex;
}

/** Country borders + coastlines as thin lines just above the surface (one draw call). */
export function createBorders(theme: Theme, data: BorderData): LineSegments {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(data.positions, 3));
  geo.setAttribute('aCoast', new BufferAttribute(data.coast, 1));
  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: theme.dot }, uBorderA: { value: 0 }, uCoastA: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aCoast; uniform float uBorderA; uniform float uCoastA; varying float vA;
      ${FACING}
      void main() {
        float f = facingOf(position);
        vA = smoothstep(0.0, 0.3, f) * mix(uBorderA, uCoastA, aCoast);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main() {
        if (vA < 0.004) discard;
        gl_FragColor = vec4(uColor, vA);
      }`,
  });
  const ls = new LineSegments(geo, mat);
  ls.renderOrder = 2;
  ls.frustumCulled = false;
  return ls;
}

/** The land dot matrix, decoded from the build-time generated Int16 table. */
export function createLand(theme: Theme, dpr: number): Points {
  const bin = atob(LAND_DOTS_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const raw = new Int16Array(bytes.buffer);
  const pos = new Float32Array(LAND_DOT_COUNT * 3);
  const v = toVec3(0, 0);
  for (let i = 0; i < LAND_DOT_COUNT; i++) {
    toVec3(raw[i * 2] / 100, raw[i * 2 + 1] / 100, 1.001, v);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: theme.dot },
      uSize: { value: 1.6 * dpr },
      uDim: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize; uniform float uDim; varying float vA;
      ${FACING}
      void main() {
        float f = facingOf(position);
        vA = f <= 0.02 ? 0.0 : (0.2 + 0.68 * pow(f, 1.2)) * smoothstep(0.02, 0.22, f);
        gl_PointSize = uDim < 0.004 ? 0.0 : uSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uDim; varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = 1.0 - smoothstep(0.32, 0.5, d);
        if (a * vA < 0.01) discard;
        gl_FragColor = vec4(uColor, a * vA * uDim);
      }`,
  });
  const pts = new Points(geo, mat);
  pts.renderOrder = 1;
  return pts;
}

/** 30° graticule drawn just above the surface. */
export function createGraticule(theme: Theme): LineSegments {
  const verts: number[] = [];
  const a = toVec3(0, 0);
  const b = toVec3(0, 0);
  const push = () => verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const R = 1.0004;
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -88; lat < 88; lat += 4) {
      toVec3(lat, lon, R, a);
      toVec3(Math.min(lat + 4, 88), lon, R, b);
      push();
    }
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 3) {
      toVec3(lat, lon, R, a);
      toVec3(lat, lon + 3, R, b);
      push();
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  const mat = new LineBasicMaterial({
    color: theme.atm,
    transparent: true,
    opacity: 0.075,
    depthWrite: false,
  });
  const ls = new LineSegments(geo, mat);
  ls.renderOrder = 1;
  return ls;
}

/**
 * Rim line + atmosphere: a camera-facing disc placed in the plane of the sphere's silhouette
 * (camera sits on +Z looking at the origin), so q = 1 is exactly the visible limb.
 */
export function createHalo(theme: Theme): Mesh {
  const mat = new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uColor: { value: theme.atm },
      uAlpha: { value: theme.atmAlpha },
      uRs: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha; uniform float uRs; varying vec2 vP;
      void main() {
        float q = length(vP) / uRs;
        float fw = fwidth(q);
        float rim = (1.0 - smoothstep(0.0, fw * 1.3, abs(q - 1.0))) * 0.5;
        float outer = q > 1.0 ? uAlpha * exp(-(q - 1.0) * 7.0) : 0.0;
        float inner = q <= 1.0 ? uAlpha * 0.55 * smoothstep(0.82, 1.0, q) : 0.0;
        float a = rim + outer + inner;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const m = new Mesh(new PlaneGeometry(3.4, 3.4), mat);
  m.renderOrder = 10;
  return m;
}

/** A faint dashed orbit ring around the globe — the one decorative element from the mockup. */
export function createOrbit(theme: Theme): Group {
  const curve = new EllipseCurve(0, 0, 1.2, 1.2, 0, Math.PI * 2, false, 0);
  const pts = curve.getPoints(240);
  const geo = new BufferGeometry().setFromPoints(pts);
  const mat = new LineDashedMaterial({
    color: theme.atm,
    dashSize: 0.012,
    gapSize: 0.04,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const line = new Line(geo, mat);
  line.computeLineDistances();
  const g = new Group();
  g.add(line);
  g.rotation.set(1.28, 0.0, -0.36);
  line.renderOrder = 2;
  return g;
}

/** Soft round sprite points used for pulses travelling along arcs. */
export function createPulseMaterial(dpr: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexColors: true,
    uniforms: { uSize: { value: 9 * dpr } },
    vertexShader: /* glsl */ `
      uniform float uSize; varying vec3 vC;
      void main() { vC = color; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float core = 1.0 - smoothstep(0.0, 0.35, d);
        float glow = exp(-d * d * 5.0) * 0.6;
        float a = core + glow;
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(vC, vec3(1.0), core * 0.8) * a, a);
      }`,
  });
}

export const white = new Color(1, 1, 1);

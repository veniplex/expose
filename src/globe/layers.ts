import {
  AdditiveBlending,
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

/** Shared GLSL: how much a surface point faces the camera (1 = centre, 0 = limb). */
const FACING = /* glsl */ `
  float facingOf(vec3 local) {
    vec4 world = modelMatrix * vec4(local, 1.0);
    vec3 n = normalize(world.xyz);
    vec3 v = normalize(cameraPosition - world.xyz);
    return dot(n, v);
  }
`;

/** Black sphere with a faint top-left sheen; writes depth so everything behind it is hidden. */
export function createSphere(theme: Theme): Mesh {
  const mat = new ShaderMaterial({
    uniforms: { uA: { value: theme.discA }, uB: { value: theme.discB } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      void main() {
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uA; uniform vec3 uB; varying vec3 vN;
      void main() {
        float l = max(dot(normalize(vN), normalize(vec3(-0.45, 0.5, 0.75))), 0.0);
        gl_FragColor = vec4(mix(uB, uA, pow(l, 1.6)), 1.0);
      }`,
  });
  const m = new Mesh(new SphereGeometry(1, 96, 64), mat);
  m.renderOrder = 0;
  return m;
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
    toVec3(raw[i * 2] / 100, raw[i * 2 + 1] / 100, 1.0015, v);
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
      uniform float uSize; varying float vA;
      ${FACING}
      void main() {
        float f = facingOf(position);
        vA = f <= 0.02 ? 0.0 : (0.2 + 0.68 * pow(f, 1.2)) * smoothstep(0.02, 0.22, f);
        gl_PointSize = uSize;
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
  const R = 1.001;
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

import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  Object3D,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { GraphIndex } from '../data';
import type { Theme } from '../theme';
import { KIND_SHAPE } from '../config';
import { spreadPositions, toVec3 } from './geo';

export const NODE_R = 1.006;

/** Per-node visual state, written into the `aState` attribute. */
export const enum NodeState {
  Normal = 0,
  Dim = 1,
  Neighbour = 2,
  Selected = 3,
}

/** Entity markers: one point sprite per entity, shape by kind, size by degree. */
export class Nodes {
  readonly points: Points;
  /** displayed unit-sphere positions (after co-location spreading) */
  readonly pos: Vector3[];
  readonly size: Float32Array; // CSS px
  private geo = new BufferGeometry();
  private mat: ShaderMaterial;
  private posAttr: BufferAttribute;
  private stateAttr: BufferAttribute;
  private colorAttr: BufferAttribute;
  private baseLat: Float64Array;
  private baseLon: Float64Array;
  private weight: Float64Array;
  private targetLat: Float64Array;
  private targetLon: Float64Array;
  private curLat: Float64Array;
  private curLon: Float64Array;
  private spacing = -1;
  private settling = false;
  readonly ids: string[];
  readonly indexOf = new Map<string, number>();

  constructor(
    index: GraphIndex,
    private theme: Theme,
    dpr: number,
  ) {
    const n = index.entities.length;
    this.ids = index.entities.map((e) => e.id);
    this.ids.forEach((id, i) => this.indexOf.set(id, i));
    this.baseLat = Float64Array.from(index.entities, (e) => (Number.isFinite(e.lat) ? e.lat : 0));
    this.baseLon = Float64Array.from(index.entities, (e) => (Number.isFinite(e.lon) ? e.lon : 0));
    this.weight = Float64Array.from(index.entities, (e) => index.degree.get(e.id) ?? 0);
    this.targetLat = Float64Array.from(this.baseLat);
    this.targetLon = Float64Array.from(this.baseLon);
    this.curLat = Float64Array.from(this.baseLat);
    this.curLon = Float64Array.from(this.baseLon);
    this.pos = index.entities.map((_, i) => toVec3(this.baseLat[i], this.baseLon[i]));

    this.size = new Float32Array(n);
    const shape = new Float32Array(n);
    index.entities.forEach((e, i) => {
      const d = index.degree.get(e.id) ?? 0;
      this.size[i] = 5 + 9 * Math.sqrt(d / index.maxDegree);
      shape[i] = KIND_SHAPE[e.kind] ?? 2;
    });

    this.posAttr = new BufferAttribute(new Float32Array(n * 3), 3);
    this.stateAttr = new BufferAttribute(new Float32Array(n), 1);
    this.colorAttr = new BufferAttribute(new Float32Array(n * 3), 3);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.geo.setAttribute('aShape', new BufferAttribute(shape, 1));
    this.geo.setAttribute('aState', this.stateAttr);
    this.geo.setAttribute('color', this.colorAttr);
    this.writePositions();
    this.setStates(new Map(), null);

    this.mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { uDpr: { value: dpr }, uScale: { value: 1 }, uHover: { value: -1 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aShape; attribute float aState;
        uniform float uDpr; uniform float uScale; uniform float uHover;
        varying float vShape; varying float vState; varying float vA; varying vec3 vC; varying float vPx;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float f = dot(normalize(world.xyz), normalize(cameraPosition - world.xyz));
          vA = smoothstep(0.0, 0.18, f);
          vShape = aShape; vState = aState; vC = color;
          float s = aSize * uScale;
          if (aState > 2.5) s += 3.0;
          if (abs(float(gl_VertexID) - uHover) < 0.5) s += 3.0;
          vPx = s * uDpr;
          gl_PointSize = vPx;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        varying float vShape; varying float vState; varying float vA; varying vec3 vC; varying float vPx;
        void main() {
          vec2 p = (gl_PointCoord - 0.5) * 2.0; // -1..1
          float px = 2.0 / vPx;                  // one device pixel in p units
          float d;                               // signed distance-ish, <0 inside
          if (vShape < 0.5) d = length(p) - 1.0 + px;                       // circle
          else if (vShape < 1.5) d = max(abs(p.x), abs(p.y)) - 0.82 + px;  // square
          else d = (abs(p.x) + abs(p.y)) * 0.8 - 0.86 + px;                 // diamond
          float fill = 1.0 - smoothstep(-px, px, d);
          if (fill < 0.01) discard;
          // organisations get a darker core so the shape reads as an outlined block
          float edge = 1.0 - smoothstep(-px * 2.6, -px * 1.2, d);
          float core = vShape < 0.5 ? 1.0 : mix(1.0, 0.38, edge);
          float alpha = vState > 0.5 && vState < 1.5 ? 0.28 : 1.0;
          gl_FragColor = vec4(vC * core, fill * vA * alpha);
        }`,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.renderOrder = 4;
  }

  /** Spread co-located nodes so markers stay `spacingPx` apart at globe radius `radiusPx`. */
  layout(radiusPx: number, spacingPx = 13, immediate = false): void {
    const spacing = (spacingPx / radiusPx) * (180 / Math.PI);
    if (this.spacing > 0 && Math.abs(spacing / this.spacing - 1) < 0.06 && !immediate) return;
    this.spacing = spacing;
    const r = spreadPositions(this.baseLat, this.baseLon, this.weight, spacing);
    this.targetLat = r.lat;
    this.targetLon = r.lon;
    if (immediate) {
      this.curLat.set(r.lat);
      this.curLon.set(r.lon);
      this.writePositions();
      this.settling = false;
    } else this.settling = true;
  }

  /** Ease displayed positions toward their layout targets. Returns true while moving. */
  tick(): boolean {
    if (!this.settling) return false;
    let maxD = 0;
    for (let i = 0; i < this.curLat.length; i++) {
      const dl = this.targetLat[i] - this.curLat[i];
      const dn = this.targetLon[i] - this.curLon[i];
      this.curLat[i] += dl * 0.25;
      this.curLon[i] += dn * 0.25;
      maxD = Math.max(maxD, Math.abs(dl), Math.abs(dn));
    }
    if (maxD < 0.002) {
      this.curLat.set(this.targetLat);
      this.curLon.set(this.targetLon);
      this.settling = false;
    }
    this.writePositions();
    return true;
  }

  displayedLatLon(i: number): [number, number] {
    return [this.curLat[i], this.curLon[i]];
  }

  private writePositions(): void {
    const arr = this.posAttr.array as Float32Array;
    for (let i = 0; i < this.pos.length; i++) {
      toVec3(this.curLat[i], this.curLon[i], 1, this.pos[i]);
      arr[i * 3] = this.pos[i].x * NODE_R;
      arr[i * 3 + 1] = this.pos[i].y * NODE_R;
      arr[i * 3 + 2] = this.pos[i].z * NODE_R;
    }
    this.posAttr.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  /** Apply per-node state + colour. `states` maps entity id -> state/colour override. */
  setStates(states: Map<string, { state: NodeState; color?: Color }>, selected: string | null): void {
    const st = this.stateAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;
    const anySelected = selected !== null;
    for (let i = 0; i < this.ids.length; i++) {
      const s = states.get(this.ids[i]);
      const state = s ? s.state : anySelected ? NodeState.Dim : NodeState.Normal;
      st[i] = state;
      const c =
        s?.color ??
        (state === NodeState.Selected ? this.theme.signal : state === NodeState.Dim ? this.theme.muted : this.theme.ink);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    this.stateAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  setHover(i: number): void {
    this.mat.uniforms.uHover.value = i;
  }

  setScale(s: number): void {
    this.mat.uniforms.uScale.value = s;
  }

  /** World position of node i (after the globe group's rotation). */
  world(i: number, parent: Object3D, out = new Vector3()): Vector3 {
    return out.copy(this.pos[i]).multiplyScalar(NODE_R).applyMatrix4(parent.matrixWorld);
  }

  /**
   * Project every node to CSS pixels. `out[i*3+2]` is the facing factor (<=0: behind the globe).
   */
  project(parent: Object3D, camera: Camera, w: number, h: number, out: Float32Array): void {
    const v = new Vector3();
    const camPos = camera.position;
    for (let i = 0; i < this.pos.length; i++) {
      this.world(i, parent, v);
      const nx = v.x, ny = v.y, nz = v.z;
      const len = Math.hypot(nx, ny, nz);
      const vx = camPos.x - nx, vy = camPos.y - ny, vz = camPos.z - nz;
      const facing = (nx * vx + ny * vy + nz * vz) / (len * Math.hypot(vx, vy, vz));
      v.project(camera);
      out[i * 3] = (v.x * 0.5 + 0.5) * w;
      out[i * 3 + 1] = (-v.y * 0.5 + 0.5) * h;
      out[i * 3 + 2] = facing;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

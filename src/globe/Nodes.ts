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
import { kindMeta } from '../kinds';
import { spreadPositions, toVec3 } from './geo';
import { ATLAS_CELL, ATLAS_COLS, ATLAS_GLYPH, ATLAS_RANGE, ATLAS_ROWS, createGlyphAtlas } from './glyphAtlas';

/** markers float just above the land dots / borders (kept low so they don't parallax at close zoom) */
export const NODE_R = 1.0012;

/** Per-node visual state, written into the `aState` attribute. */
export const enum NodeState {
  Normal = 0,
  Dim = 1,
  Neighbour = 2,
  Selected = 3,
  Hidden = 4,
}

/**
 * Glyph box size in CSS px from influence (0..1): 5 → 18 px, a 3.6× diameter range. The diameter
 * grows a little faster than linearly so the few most influential entities stand out from the many
 * mid-ranked ones (the pipeline's scores are spread roughly uniformly over 0..1).
 */
const BOX_MIN = 5;
const BOX_MAX = 18;
export const boxSize = (influence: number): number =>
  BOX_MIN + (BOX_MAX - BOX_MIN) * Math.pow(Math.max(0, Math.min(1, influence)), 1.3);

/**
 * Entity markers: one point sprite per entity in a single draw call. The sprite samples the
 * kind's glyph from a signed-distance-field atlas (same SVG paths as the UI icons); its size comes
 * from the entity's influence.
 */
export class Nodes {
  readonly points: Points;
  /** displayed unit-sphere positions (after co-location spreading) */
  readonly pos: Vector3[];
  /** glyph box size per node, CSS px (before the zoom scale) */
  readonly size: Float32Array;
  readonly influence: Float64Array;
  readonly ids: string[];
  readonly indexOf = new Map<string, number>();
  /** 1 = kind shown; hidden nodes are not drawn, picked, labelled or spread */
  readonly active: Uint8Array;
  private geo = new BufferGeometry();
  private mat: ShaderMaterial;
  private posAttr: BufferAttribute;
  private stateAttr: BufferAttribute;
  private colorAttr: BufferAttribute;
  private baseLat: Float64Array;
  private baseLon: Float64Array;
  private target: { lat: Float64Array; lon: Float64Array };
  private curLat: Float64Array;
  private curLon: Float64Array;
  private rad: Float64Array;
  private activeVersion = 0;
  private layoutVersion = -1;
  private layoutPxPerDeg = -1;
  private layoutZf = -1;
  private layoutPair = -1;
  private fullZf = -1;
  private settling = false;
  private scale = 1;

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
    this.influence = Float64Array.from(index.entities, (e) => index.influence.get(e.id) ?? 0);
    this.target = { lat: Float64Array.from(this.baseLat), lon: Float64Array.from(this.baseLon) };
    this.curLat = Float64Array.from(this.baseLat);
    this.curLon = Float64Array.from(this.baseLon);
    this.rad = new Float64Array(n);
    this.active = new Uint8Array(n).fill(1);
    this.pos = index.entities.map((_, i) => toVec3(this.baseLat[i], this.baseLon[i]));

    this.size = new Float32Array(n);
    const cell = new Float32Array(n);
    index.entities.forEach((e, i) => {
      this.size[i] = boxSize(this.influence[i]);
      cell[i] = kindMeta(e.kind).atlas;
    });

    this.posAttr = new BufferAttribute(new Float32Array(n * 3), 3);
    this.stateAttr = new BufferAttribute(new Float32Array(n), 1);
    this.colorAttr = new BufferAttribute(new Float32Array(n * 3), 3);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.geo.setAttribute('aCell', new BufferAttribute(cell, 1));
    this.geo.setAttribute('aState', this.stateAttr);
    this.geo.setAttribute('color', this.colorAttr);
    this.writePositions();
    this.setStates(new Map(), null);

    const f = (x: number) => x.toFixed(4);
    this.mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: {
        uDpr: { value: dpr },
        uScale: { value: 1 },
        uHover: { value: -1 },
        uAtlas: { value: createGlyphAtlas() },
      },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aCell; attribute float aState;
        uniform float uDpr; uniform float uScale; uniform float uHover;
        varying float vCell; varying float vState; varying float vA; varying vec3 vC; varying float vPx;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float f = dot(normalize(world.xyz), normalize(cameraPosition - world.xyz));
          vA = smoothstep(0.0, 0.18, f);
          vCell = aCell; vState = aState; vC = color;
          float s = aSize * uScale;
          if (aState > 2.5 && aState < 3.5) s += 4.0;
          if (abs(float(gl_VertexID) - uHover) < 0.5) s += 4.0;
          vPx = s / ${f(ATLAS_GLYPH)} * uDpr;
          if (aState > 3.5) { vPx = 0.0; vA = 0.0; }
          gl_PointSize = vPx;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas; uniform float uDpr;
        varying float vCell; varying float vState; varying float vA; varying vec3 vC; varying float vPx;
        void main() {
          if (vA < 0.004) discard;
          vec2 cell = vec2(mod(vCell, ${f(ATLAS_COLS)}), floor(vCell / ${f(ATLAS_COLS)}));
          vec2 uv = (cell + gl_PointCoord) / vec2(${f(ATLAS_COLS)}, ${f(ATLAS_ROWS)});
          // signed distance in device px (+ inside the glyph)
          float sd = (texture2D(uAtlas, uv).r - 0.5) * ${f(2 * ATLAS_RANGE)} * vPx / ${f(ATLAS_CELL)};
          float fill = clamp(sd + 0.5, 0.0, 1.0);
          // a dark keyline separates overlapping markers
          float ring = clamp(sd + 0.5 + 1.25 * uDpr, 0.0, 1.0);
          float a = max(fill, ring * 0.85);
          if (a < 0.01) discard;
          float alpha = vState > 0.5 && vState < 1.5 ? 0.3 : 1.0;
          gl_FragColor = vec4(vC * (fill / max(a, 0.001)), a * vA * alpha);
        }`,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.renderOrder = 4;
    this.points.frustumCulled = false;
  }

  /** On-screen pick / label radius of node i in CSS px. */
  radiusPx(i: number): number {
    return this.size[i] * this.scale * 0.36;
  }

  /**
   * Spread co-located nodes for the current zoom. `pxPerDeg` = screen px per degree at the globe
   * centre, `zf` = 0 (overview) … 1 (closest zoom). Far out, markers may overlap (clusters read
   * as one blob); as you zoom in the spacing grows until every marker is separately tappable.
   */
  layout(pxPerDeg: number, zf: number, immediate = false): void {
    const same =
      this.layoutVersion === this.activeVersion &&
      this.layoutPxPerDeg > 0 &&
      Math.abs(pxPerDeg / this.layoutPxPerDeg - 1) < 0.1 &&
      Math.abs(zf - this.layoutZf) < 0.06;
    if (same && !immediate) return;
    const activeChanged = this.layoutVersion !== this.activeVersion;
    this.layoutVersion = this.activeVersion;
    this.layoutPxPerDeg = pxPerDeg;
    this.layoutZf = zf;
    const overlap = 0.42 + 0.58 * Math.min(1, zf / 0.55);
    // extra breathing room between markers grows with zoom: ~26px centre spacing when closest
    const t = Math.max(0, Math.min(1, (zf - 0.25) / 0.7));
    const gap = 0.5 + 16 * t * t * (3 - 2 * t);
    for (let i = 0; i < this.rad.length; i++) {
      // visible glyph radius ≈ 0.36 × box
      this.rad[i] = (this.size[i] * this.scale * 0.36 * overlap + gap / 2) / pxPerDeg;
    }
    // median pair distance in degrees: the whole pattern scales with it
    const pair = 2 * Float64Array.from(this.rad).sort()[this.rad.length >> 1];
    const warm = !immediate && !activeChanged && this.layoutPair > 0 && Math.abs(zf - this.fullZf) < 0.3;
    if (warm) {
      // scale the previous layout's offsets from the true pins, then let a couple of passes fix it
      const k = pair / this.layoutPair;
      const { lat, lon } = this.target;
      for (let i = 0; i < lat.length; i++) {
        lat[i] = this.baseLat[i] + (lat[i] - this.baseLat[i]) * k;
        lon[i] = this.baseLon[i] + (lon[i] - this.baseLon[i]) * k;
      }
      spreadPositions(this.baseLat, this.baseLon, this.influence, this.rad, this.active, this.target, 2, true);
    } else {
      this.fullZf = zf;
      spreadPositions(this.baseLat, this.baseLon, this.influence, this.rad, this.active, this.target);
    }
    this.layoutPair = pair;
    if (immediate) {
      this.curLat.set(this.target.lat);
      this.curLon.set(this.target.lon);
      this.writePositions();
      this.settling = false;
    } else this.settling = true;
  }

  /** Ease displayed positions toward their layout targets. Returns true while moving. */
  tick(): boolean {
    if (!this.settling) return false;
    let maxD = 0;
    const tl = this.target.lat;
    const tn = this.target.lon;
    for (let i = 0; i < this.curLat.length; i++) {
      const dl = tl[i] - this.curLat[i];
      const dn = tn[i] - this.curLon[i];
      this.curLat[i] += dl * 0.25;
      this.curLon[i] += dn * 0.25;
      const m = Math.abs(dl) + Math.abs(dn);
      if (m > maxD) maxD = m;
    }
    // settle threshold relative to the current scale (≈ 0.3 px)
    if (maxD * this.layoutPxPerDeg < 0.3) {
      this.curLat.set(tl);
      this.curLon.set(tn);
      this.settling = false;
    }
    this.writePositions();
    return true;
  }

  displayedLatLon(i: number): [number, number] {
    return [this.curLat[i], this.curLon[i]];
  }

  trueLatLon(i: number): [number, number] {
    return [this.baseLat[i], this.baseLon[i]];
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
  }

  /** Which nodes are shown (by kind filter). Returns true when the set changed. */
  setActive(isActive: (i: number) => boolean): boolean {
    let changed = false;
    for (let i = 0; i < this.active.length; i++) {
      const v = isActive(i) ? 1 : 0;
      if (v !== this.active[i]) {
        this.active[i] = v;
        changed = true;
      }
    }
    if (changed) this.activeVersion++;
    return changed;
  }

  /** Apply per-node state + colour. `states` maps entity id -> state/colour override. */
  setStates(states: Map<string, { state: NodeState; color?: Color }>, selected: string | null): void {
    const st = this.stateAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;
    const anySelected = selected !== null;
    for (let i = 0; i < this.ids.length; i++) {
      const s = states.get(this.ids[i]);
      let state = s ? s.state : anySelected ? NodeState.Dim : NodeState.Normal;
      if (!this.active?.[i] && state !== NodeState.Selected) state = NodeState.Hidden;
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

  isHidden(i: number): boolean {
    return (this.stateAttr.array as Float32Array)[i] === NodeState.Hidden;
  }

  setHover(i: number): void {
    this.mat.uniforms.uHover.value = i;
  }

  setScale(s: number): void {
    this.scale = s;
    this.mat.uniforms.uScale.value = s;
  }

  /** World position of node i (after the globe group's rotation). */
  world(i: number, parent: Object3D, out = new Vector3()): Vector3 {
    return out.copy(this.pos[i]).multiplyScalar(NODE_R).applyMatrix4(parent.matrixWorld);
  }

  /**
   * Project every node to CSS pixels. `out[i*3+2]` is the facing factor (<=0: behind the globe,
   * -1 for hidden nodes).
   */
  project(parent: Object3D, camera: Camera, w: number, h: number, out: Float32Array): void {
    const v = new Vector3();
    const camPos = camera.position;
    const st = this.stateAttr.array as Float32Array;
    for (let i = 0; i < this.pos.length; i++) {
      if (st[i] === NodeState.Hidden) {
        out[i * 3 + 2] = -1;
        continue;
      }
      this.world(i, parent, v);
      const nx = v.x, ny = v.y, nz = v.z;
      const len = Math.hypot(nx, ny, nz);
      const vx = camPos.x - nx, vy = camPos.y - ny, vz = camPos.z - nz;
      const facing = (nx * vx + ny * vy + nz * vz) / (len * Math.hypot(vx, vy, vz));
      if (facing <= 0) {
        out[i * 3 + 2] = facing;
        continue;
      }
      v.project(camera);
      out[i * 3] = (v.x * 0.5 + 0.5) * w;
      out[i * 3 + 1] = (-v.y * 0.5 + 0.5) * h;
      // in front of the camera's near plane only
      out[i * 3 + 2] = v.z < 1 ? facing : -1;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

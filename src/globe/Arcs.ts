import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Points,
  ShaderMaterial,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Edge, GraphIndex } from '../data';
import type { Theme } from '../theme';
import type { Nodes } from './Nodes';
import { sampleArc, segmentsFor } from './geo';
import { createPulseMaterial } from './layers';

/** Arc height above the surface for central angle w; `k` shrinks the minimum lift at close zoom. */
const focusLift = (w: number, k: number) => Math.min(0.42, 0.025 * k + w * 0.17);

interface ArcSample {
  edge: Edge;
  pts: Float32Array;
  n: number; // number of points
  color: Color;
  phase: number;
}

/** Link rendering: faint ambient web, focused arcs of one entity, highlighted arc, travelling pulses. */
export class Arcs {
  readonly group = new Group();
  private ambient: LineSegments;
  private ambientMat: ShaderMaterial;
  private ambientGeo = new InstancedBufferGeometry();
  private ambientA: InstancedBufferAttribute | null = null;
  private ambientB: InstancedBufferAttribute | null = null;
  private ambientC: InstancedBufferAttribute | null = null;
  private colorsDirty = true;
  private focus: LineSegments2;
  private focusMat: LineMaterial;
  private hi: LineSegments2;
  private hiMat: LineMaterial;
  private pulses: Points;
  private pulseGeo = new BufferGeometry();
  private samples: ArcSample[] = [];
  private hiSample: ArcSample | null = null;
  private ambientEdges: Edge[] = [];
  private focusEdges: Edge[] = [];
  private hiKey: string | null = null;
  private focusDim = false;
  private liftK = 1;

  constructor(
    private index: GraphIndex,
    private nodes: Nodes,
    private theme: Theme,
    dpr: number,
  ) {
    // Ambient web: one instanced draw call. Each instance is one edge (endpoints + colour); the
    // vertex shader bends a fixed 24-segment template into the lifted great-circle arc, so moving
    // markers only rewrites the endpoint attributes.
    this.ambientMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uAlpha: { value: 1 }, uLiftK: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aT; attribute vec3 aA; attribute vec3 aB; attribute vec4 aColor;
        uniform float uLiftK; varying vec3 vC; varying float vA;
        const float PI = 3.14159265;
        void main() {
          vec3 a = normalize(aA); vec3 b = normalize(aB);
          float om = 2.0 * asin(clamp(length(b - a) * 0.5, 0.0, 1.0));
          float s = sin(om);
          vec3 p = s < 1e-4 ? mix(a, b, aT) : (sin((1.0 - aT) * om) * a + sin(aT * om) * b) / s;
          float lift = min(0.11, 0.008 * uLiftK + om * 0.05);
          float bump = sin(PI * aT);
          p = normalize(p) * (1.0018 + lift * bump);
          vC = aColor.rgb;
          // fade the very ends a bit so the web doesn't clump on top of markers
          vA = aColor.a * (0.45 + 0.55 * bump);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAlpha; varying vec3 vC; varying float vA;
        void main() { gl_FragColor = vec4(vC * vA * uAlpha, 1.0); }`,
    });
    const SEG = 24;
    const tmpl = new Float32Array(SEG * 2);
    for (let k = 0; k < SEG; k++) {
      tmpl[k * 2] = k / SEG;
      tmpl[k * 2 + 1] = (k + 1) / SEG;
    }
    this.ambientGeo.setAttribute('aT', new BufferAttribute(tmpl, 1));
    // three needs a position attribute to size the draw call; aT drives everything
    this.ambientGeo.setAttribute('position', new BufferAttribute(new Float32Array(SEG * 2 * 3), 3));
    this.ambient = new LineSegments(this.ambientGeo, this.ambientMat);
    this.ambient.renderOrder = 3;
    this.ambient.frustumCulled = false;

    const lineMat = (width: number, opacity: number) =>
      new LineMaterial({
        linewidth: width,
        vertexColors: true,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: AdditiveBlending,
      });
    this.focusMat = lineMat(1.4, 0.95);
    this.focus = new LineSegments2(new LineSegmentsGeometry(), this.focusMat);
    this.focus.renderOrder = 5;
    this.focus.frustumCulled = false;
    this.hiMat = lineMat(2.6, 1);
    this.hi = new LineSegments2(new LineSegmentsGeometry(), this.hiMat);
    this.hi.renderOrder = 6;
    this.hi.frustumCulled = false;

    this.pulseGeo.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
    this.pulseGeo.setAttribute('color', new BufferAttribute(new Float32Array(3), 3));
    this.pulses = new Points(this.pulseGeo, createPulseMaterial(dpr));
    this.pulses.renderOrder = 7;
    this.pulses.frustumCulled = false;

    this.group.add(this.ambient, this.focus, this.hi, this.pulses);
  }

  setResolution(w: number, h: number): void {
    this.focusMat.resolution.set(w, h);
    this.hiMat.resolution.set(w, h);
  }

  /** Edges shown as the faint ambient web (nothing selected). */
  setAmbient(edges: Edge[]): void {
    this.ambientEdges = edges;
    this.colorsDirty = true;
    this.rebuildAmbient();
  }

  setAmbientAlpha(a: number): void {
    this.ambientMat.uniforms.uAlpha.value = a;
    this.ambient.visible = a > 0.001 && this.ambientGeo.instanceCount > 0;
  }

  /** Links of the focused entity (selected or previewed) and the highlighted one. */
  setFocus(edges: Edge[], highlight: string | null, dimOthers: boolean, opacity = 0.95): void {
    this.focusEdges = edges;
    this.hiKey = highlight;
    this.focusDim = dimOthers;
    this.focusMat.opacity = opacity;
    this.rebuildFocus();
  }

  /** Scale of the minimum arc lift (1 at the overview, → 0 when zoomed in). Returns true if changed. */
  setLiftScale(k: number): boolean {
    this.ambientMat.uniforms.uLiftK.value = k;
    if (Math.abs(k / this.liftK - 1) < 0.15) return false;
    this.liftK = k;
    return true;
  }

  /** Re-sample everything (node positions moved). */
  refresh(): void {
    this.rebuildAmbient();
    this.rebuildFocus();
  }

  private endpoints(l: Edge) {
    const a = this.nodes.indexOf.get(l.a);
    const b = this.nodes.indexOf.get(l.b);
    if (a === undefined || b === undefined) return null;
    return [this.nodes.pos[a], this.nodes.pos[b]] as const;
  }

  /** (Re)write the ambient instance attributes: endpoints follow the displayed marker positions. */
  private rebuildAmbient(): void {
    const edges = this.ambientEdges;
    const n = edges.length;
    if (!this.ambientA || this.ambientA.count < n) {
      const cap = Math.max(64, n);
      this.ambientA = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.ambientB = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.ambientC = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      this.ambientGeo.setAttribute('aA', this.ambientA);
      this.ambientGeo.setAttribute('aB', this.ambientB);
      this.ambientGeo.setAttribute('aColor', this.ambientC);
    }
    const A = this.ambientA.array as Float32Array;
    const B = this.ambientB!.array as Float32Array;
    const C = this.ambientC!.array as Float32Array;
    let k = 0;
    for (const l of edges) {
      const ep = this.endpoints(l);
      if (!ep) continue;
      A[k * 3] = ep[0].x;
      A[k * 3 + 1] = ep[0].y;
      A[k * 3 + 2] = ep[0].z;
      B[k * 3] = ep[1].x;
      B[k * 3 + 1] = ep[1].y;
      B[k * 3 + 2] = ep[1].z;
      if (this.colorsDirty) {
        const c = this.theme.category[l.category];
        // more influential endpoints = a more visible strand
        const ia = this.index.influence.get(l.a) ?? 0;
        const ib = this.index.influence.get(l.b) ?? 0;
        C[k * 4] = c.r;
        C[k * 4 + 1] = c.g;
        C[k * 4 + 2] = c.b;
        C[k * 4 + 3] = 0.035 + 0.22 * Math.sqrt(Math.min(ia, ib));
      }
      k++;
    }
    this.colorsDirty = false;
    this.ambientA.needsUpdate = true;
    this.ambientB!.needsUpdate = true;
    this.ambientC!.needsUpdate = true;
    this.ambientGeo.instanceCount = k;
    this.ambient.visible = k > 0 && this.ambientMat.uniforms.uAlpha.value > 0.001;
  }

  private sample(l: Edge, i: number): ArcSample | null {
    const ep = this.endpoints(l);
    if (!ep) return null;
    const w = Math.acos(Math.min(1, Math.max(-1, ep[0].dot(ep[1]))));
    const seg = segmentsFor(w);
    const pts = new Float32Array((seg + 1) * 3);
    sampleArc(ep[0], ep[1], seg, (w) => focusLift(w, this.liftK), pts, 0, 1.0024);
    return { edge: l, pts, n: seg + 1, color: this.theme.category[l.category], phase: (i * 0.618) % 1 };
  }

  private toSegments(samples: ArcSample[], dim: (s: ArcSample) => number) {
    let total = 0;
    for (const s of samples) total += (s.n - 1) * 6;
    const pos = new Float32Array(total);
    const col = new Float32Array(total);
    let o = 0;
    for (const s of samples) {
      const k = dim(s);
      for (let i = 0; i < s.n - 1; i++) {
        pos.set(s.pts.subarray(i * 3, i * 3 + 6), o);
        for (let j = 0; j < 2; j++) {
          col[o + j * 3] = s.color.r * k;
          col[o + j * 3 + 1] = s.color.g * k;
          col[o + j * 3 + 2] = s.color.b * k;
        }
        o += 6;
      }
    }
    return { pos, col };
  }

  private rebuildFocus(): void {
    this.samples = [];
    this.focusEdges.forEach((l, i) => {
      const s = this.sample(l, i);
      if (s) this.samples.push(s);
    });
    const hi = this.hiKey;
    const dimK = hi && this.focusDim ? 0.32 : 1;
    const f = this.toSegments(
      this.samples.filter((s) => s.edge.key !== hi),
      () => dimK,
    );
    const g = new LineSegmentsGeometry();
    if (f.pos.length) {
      g.setPositions(f.pos);
      g.setColors(f.col);
    }
    this.focus.geometry.dispose();
    this.focus.geometry = g;
    this.focus.visible = f.pos.length > 0;

    this.hiSample = hi ? (this.samples.find((s) => s.edge.key === hi) ?? null) : null;
    const hg = new LineSegmentsGeometry();
    if (this.hiSample) {
      const h = this.toSegments([this.hiSample], () => 1);
      hg.setPositions(h.pos);
      hg.setColors(h.col);
    }
    this.hi.geometry.dispose();
    this.hi.geometry = hg;
    this.hi.visible = !!this.hiSample;

    const count = this.samples.length;
    this.pulseGeo.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    const pc = new Float32Array(Math.max(1, count) * 3);
    this.samples.forEach((s, i) => {
      const k = hi && this.focusDim && s.edge.key !== hi ? 0.35 : 1;
      pc[i * 3] = s.color.r * k;
      pc[i * 3 + 1] = s.color.g * k;
      pc[i * 3 + 2] = s.color.b * k;
    });
    this.pulseGeo.setAttribute('color', new BufferAttribute(pc, 3));
    this.pulseGeo.setDrawRange(0, count);
    this.pulses.visible = count > 0;
  }

  /** Move pulses along their arcs. `time` in seconds; `animate` false freezes them out of view. */
  tick(time: number, animate: boolean): void {
    if (!this.samples.length) return;
    this.pulses.visible = animate;
    if (!animate) return;
    const pos = this.pulseGeo.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    this.samples.forEach((s, i) => {
      const t = (time / 2.4 + s.phase) % 1;
      const f = t * (s.n - 1);
      const k = Math.floor(f);
      const r = f - k;
      const a = k * 3;
      const b = Math.min(s.n - 1, k + 1) * 3;
      arr[i * 3] = s.pts[a] + (s.pts[b] - s.pts[a]) * r;
      arr[i * 3 + 1] = s.pts[a + 1] + (s.pts[b + 1] - s.pts[a + 1]) * r;
      arr[i * 3 + 2] = s.pts[a + 2] + (s.pts[b + 2] - s.pts[a + 2]) * r;
    });
    pos.needsUpdate = true;
  }

  get hasFocus(): boolean {
    return this.samples.length > 0;
  }
}

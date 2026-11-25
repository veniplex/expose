import {
  Color,
  Group,
  Line,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { GraphIndex } from '../data';
import type { State, Store } from '../store';
import type { Theme } from '../theme';
import { edgesFrom, other, parseRowKey, type Edge } from '../data';
import { entityVisible, visibleLinks } from '../filters';
import { isCompact, reducedMotion } from '../dom';
import { Nodes, NodeState } from './Nodes';
import { Arcs } from './Arcs';
import { Labels, type Box, type LabelTier } from './Labels';
import { Controls } from './Controls';
import { createBorders, createGraticule, createHalo, createLand, createOrbit, createSphere, setLandMask } from './layers';
import { loadBorders, loadCountries, loadLandMask } from './geoAssets';
import { DEG, toVec3, wrapPi } from './geo';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const FOV = 32;
const TAN = Math.tan((FOV / 2) * DEG);
const ZOOM_MIN = 0.75;
/** closest camera altitude above the surface, in globe radii (≈ 220 km: one metro area fills the view) */
const ALT_MIN = 0.034;
const AUTO_SPEED = 0.045; // rad/s
const AUTO_RESUME_MS = 25000;
const AMBIENT_MAX = 600;
const PICK_CELL = 40;

export interface GlobeEvents {
  /** pointer hovering a node (mouse only) */
  hover(id: string | null, x: number, y: number): void;
  pick(id: string): void;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The WebGL globe: scene, camera rig, render loop and selection visuals. */
export class Globe {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
  private world = new Group();
  private sphere: Mesh;
  private halo: Mesh;
  private orbit: Group;
  private land: Points;
  private borders: LineSegments | null = null;
  private maskReady = false;
  private geoRequested = false;
  private nodes: Nodes;
  private arcs: Arcs;
  private labels: Labels;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private insetsTarget: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private rotX = 0.42;
  private rotY = 1.7;
  private velX = 0;
  private velY = 0;
  /** surface magnification relative to the fitted overview (1) */
  private mag = 1;
  private magTarget = 1;
  private magMax = 60;
  /** pending rotation that keeps the zoom anchor under the pointer */
  private nudgeX = 0;
  private nudgeY = 0;
  private fly: { fx: number; fy: number; tx: number; ty: number; t0: number; dur: number; dip: number } | null = null;
  private flyDip = 1;
  private autoRotate = true;
  private lastInteract = 0;
  private dragging = false;
  private raf = 0;
  private running = false;
  private dirty = true;
  private last = 0;
  private time = 0;
  private screen: Float32Array;
  private hoverIdx = -1;
  private state: State;
  private reduced = reducedMotion();
  private baseRadius = 300;
  /** screen px per radian at the globe centre (surface) */
  private pxPerRad = 300;
  /** 0 = overview … 1 = closest zoom */
  private zf = 0;
  private rank: Int32Array;
  private frameNo = 0;
  private pickGrid: Map<number, number[]> | null = null;
  private pickFrame = -1;
  private raycaster = new Raycaster();
  private invWorld = new Matrix4();
  private perf = { frames: 0, total: 0, max: 0 };
  private occluders: Box[] = [];
  private cx = 0;
  private cy = 0;
  private layoutPending = false;
  private lastLayout = 0;
  private lastArcRefresh = 0;
  private arcsStale = false;
  private perfPart = { layout: 0, tick: 0, gl: 0, labels: 0 };

  constructor(
    private container: HTMLElement,
    private index: GraphIndex,
    store: Store,
    private theme: Theme,
    private events: GlobeEvents,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'globe-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute(
      'aria-label',
      'Interactive globe of entities and their connections. Use the search box and the lists to reach every entity without the globe.',
    );
    // throws when WebGL is unavailable; the caller shows a fallback
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);

    this.sphere = createSphere(theme);
    this.world.add(this.sphere);
    this.land = createLand(theme, this.dpr);
    this.world.add(this.land);
    this.world.add(createGraticule(theme));
    this.nodes = new Nodes(index, theme, this.dpr);
    this.world.add(this.nodes.points);
    this.arcs = new Arcs(index, this.nodes, theme, this.dpr);
    this.world.add(this.arcs.group);
    this.halo = createHalo(theme);
    this.orbit = createOrbit(theme);
    this.scene.add(this.world, this.halo, this.orbit);
    this.screen = new Float32Array(index.entities.length * 3);
    const order = index.entities.map((_, i) => i);
    order.sort((a, b) => this.nodes.influence[b] - this.nodes.influence[a] || a - b);
    this.rank = Int32Array.from(order);

    this.labels = new Labels(index);
    container.append(this.canvas, this.labels.root);

    this.state = store.state;
    new Controls(this.canvas, {
      drag: (dx, dy, dt) => this.onDrag(dx, dy, dt),
      dragEnd: () => {
        this.dragging = false;
      },
      zoom: (f, x, y) => this.zoomBy(f, x, y),
      tap: (x, y, coarse) => {
        const i = this.pick(x, y, coarse ? 22 : 10);
        if (i >= 0) this.events.pick(this.nodes.ids[i]);
      },
      doubleTap: (x, y) => {
        if (this.magTarget >= this.magMax * 0.95) this.zoomBy(1 / this.magTarget);
        else this.zoomBy(2.2, x, y);
      },
      hover: (x, y) => this.onHover(x, y),
      leave: () => this.setHover(-1, 0, 0),
      interact: () => this.interacted(),
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    // initial view: Atlantic, tilted north so Europe + North America are in frame
    this.rotY = 30 * DEG;
    this.rotX = 28 * DEG;
    this.update(store.state, new Set(['selected', 'categories', 'kinds']));
    this.nodes.layout(this.pxPerRad * DEG, this.zf, true);
    this.arcs.refresh();
    store.subscribe((s, changed) => this.update(s, changed));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reduced = e.matches;
      this.invalidate();
    });
  }

  /* ---------------- public API ---------------- */

  start(): void {
    if (this.running || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.loadGeography();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Reserve screen space covered by overlaid panels; the globe centres in what's left. */
  setInsets(i: Insets, immediate = false): void {
    this.insetsTarget = { ...i };
    if (immediate || this.reduced) {
      this.insets = { ...i };
      this.updateCamera();
    }
    this.invalidate();
  }

  /** Screen boxes (CSS px, container-relative) covered by UI panels; labels avoid them. */
  setOccluders(boxes: Box[]): void {
    this.occluders = boxes;
    this.invalidate();
  }

  /** Multiply the zoom; with (x, y) the surface point under that screen position stays put. */
  zoomBy(f: number, x?: number, y?: number): void {
    const next = Math.min(this.magMax, Math.max(ZOOM_MIN, this.magTarget * f));
    const k = next / this.magTarget;
    this.magTarget = next;
    if (x !== undefined && y !== undefined && Math.abs(k - 1) > 1e-4) {
      const p = this.latLonAt(x, y);
      if (p) {
        const t = this.rotationKeeping(p.lat, p.lon, x, y, next);
        this.fly = null;
        this.nudgeX = t.x - this.rotX;
        this.nudgeY = t.y - this.rotY;
      }
    }
    this.interacted();
  }

  resetView(): void {
    this.magTarget = 1;
    this.nudgeX = this.nudgeY = 0;
    this.interacted();
    const sel = this.state.selected;
    if (sel) this.flyTo(sel);
    else this.flyToLatLon(28, -30);
  }

  /** Rotate so entity `id` faces the camera. */
  flyTo(id: string): void {
    const i = this.nodes.indexOf.get(id);
    if (i === undefined) return;
    const [lat, lon] = this.nodes.displayedLatLon(i);
    this.flyToLatLon(lat, lon);
    if (this.magTarget < 1.15) this.magTarget = 1.15;
  }

  /** Screen position (CSS px, relative to the container) of an entity, or null when hidden. */
  screenOf(id: string): { x: number; y: number } | null {
    const i = this.nodes.indexOf.get(id);
    if (i === undefined || this.screen[i * 3 + 2] < 0.05) return null;
    return { x: this.screen[i * 3], y: this.screen[i * 3 + 1] };
  }

  /** Debug / test info: zoom state and CPU time spent per rendered frame. */
  debug(): Record<string, number> {
    const p = this.perf;
    return {
      mag: this.mag,
      magMax: this.magMax,
      zf: this.zf,
      altitude: this.altitude(),
      pxPerDeg: this.pxPerRad * DEG,
      frames: p.frames,
      avgFrameMs: p.frames ? p.total / p.frames : 0,
      maxFrameMs: p.max,
      layoutMs: this.perfPart.layout / Math.max(1, p.frames),
      tickMs: this.perfPart.tick / Math.max(1, p.frames),
      glMs: this.perfPart.gl / Math.max(1, p.frames),
      labelsMs: this.perfPart.labels / Math.max(1, p.frames),
    };
  }

  resetPerf(): void {
    this.perf = { frames: 0, total: 0, max: 0 };
    this.perfPart = { layout: 0, tick: 0, gl: 0, labels: 0 };
  }

  /** Jump the view (tests): centre on lat/lon at zoom `mag` (clamped). */
  view(lat: number, lon: number, mag: number): void {
    this.fly = null;
    this.nudgeX = this.nudgeY = 0;
    this.velX = this.velY = 0;
    this.rotX = Math.max(-1.25, Math.min(1.25, lat * DEG));
    this.rotY = -lon * DEG;
    this.magTarget = this.mag = Math.min(this.magMax, Math.max(ZOOM_MIN, mag));
    this.interacted();
    this.updateCamera();
    this.nodes.layout(this.pxPerRad * DEG, this.zf, true);
    this.arcs.refresh();
  }

  invalidate(): void {
    this.dirty = true;
  }

  /* ---------------- internals ---------------- */

  private loadGeography(): void {
    if (this.geoRequested) return;
    this.geoRequested = true;
    const later = (fn: () => void) =>
      'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 400);
    later(() => {
      loadLandMask()
        .then((m) => {
          setLandMask(this.sphere, m);
          this.maskReady = true;
          this.updateCamera();
          this.invalidate();
        })
        .catch((e) => console.warn('land mask unavailable', e));
      loadBorders(1.0007)
        .then((b) => {
          this.borders = createBorders(this.theme, b);
          this.world.add(this.borders);
          this.updateCamera();
          this.invalidate();
        })
        .catch((e) => console.warn('borders unavailable', e));
      loadCountries()
        .then((c) => {
          this.labels.setCountries(c);
          this.invalidate();
        })
        .catch(() => {});
    });
  }

  private flyToLatLon(lat: number, lon: number): void {
    const tx = Math.max(-1.25, Math.min(1.25, lat * DEG));
    const ty = this.rotY + wrapPi(-lon * DEG - this.rotY);
    this.velX = this.velY = 0;
    this.nudgeX = this.nudgeY = 0;
    if (this.reduced) {
      this.rotX = tx;
      this.rotY = ty;
      this.fly = null;
    } else {
      const dist = Math.hypot(tx - this.rotX, (ty - this.rotY) * Math.cos((tx + this.rotX) / 2));
      // zoomed in and flying far: pull out mid-flight so the hop stays readable
      const needed = Math.max(1, 1.1 / Math.max(dist, 1e-3));
      const dip = Math.max(1, this.magTarget / needed);
      const dur = 700 + Math.min(900, dist * 420) + (dip > 1.5 ? Math.min(700, Math.log(dip) * 160) : 0);
      this.fly = { fx: this.rotX, fy: this.rotY, tx, ty, t0: performance.now(), dur, dip };
    }
    this.invalidate();
  }

  private interacted(): void {
    this.autoRotate = false;
    this.lastInteract = performance.now();
    this.invalidate();
  }

  private altitude(): number {
    const alt0 = this.alt0();
    return Math.max(ALT_MIN, alt0 / (this.mag / this.flyDip));
  }

  /** camera altitude (globe radii) of the fitted overview */
  private alt0(): number {
    const k0 = this.h / (2 * TAN * this.baseRadius);
    return Math.sqrt(1 + k0 * k0) - 1;
  }

  private onDrag(dx: number, dy: number, dtMs: number): void {
    this.dragging = true;
    this.fly = null;
    this.nudgeX = this.nudgeY = 0;
    if (dx === 0 && dy === 0) {
      // finger rested before lifting: no inertia
      this.velX = this.velY = 0;
      return;
    }
    // grab the surface: 1px of pointer movement ≈ 1px of surface movement at the globe centre
    const r = this.pxPerRad;
    const ay = dx / (r * Math.max(0.35, Math.cos(this.rotX)));
    const ax = dy / r;
    this.rotY += ay;
    this.rotX = Math.max(-1.3, Math.min(1.3, this.rotX + ax));
    const k = Math.max(1, dtMs);
    // smoothed velocity in rad/ms for inertia (already scaled by the zoom through pxPerRad)
    this.velY = this.velY * 0.5 + (ay / k) * 0.5;
    this.velX = this.velX * 0.5 + (ax / k) * 0.5;
    this.invalidate();
  }

  /**
   * Rotation that puts surface point (lat, lon) at screen (x, y) once the zoom is `mag`.
   * Starts from the linear estimate and refines it against the real perspective projection.
   */
  private rotationKeeping(lat: number, lon: number, x: number, y: number, mag: number): { x: number; y: number } {
    const alt = Math.max(ALT_MIN, this.alt0() / mag);
    const d = 1 + alt;
    const f = this.h / (2 * TAN);
    const pxr = f / alt;
    const r = this.mag / mag;
    let rx = lat + (this.rotX - lat) * r;
    let ry = this.rotY + wrapPi(-lon - this.rotY) * (1 - r);
    const cl = Math.cos(lat);
    const px = cl * Math.sin(lon);
    const py = Math.sin(lat);
    const pz = cl * Math.cos(lon);
    for (let it = 0; it < 8; it++) {
      // world = Rx(rx) · Ry(ry) · p
      const x1 = px * Math.cos(ry) + pz * Math.sin(ry);
      const z1 = -px * Math.sin(ry) + pz * Math.cos(ry);
      const y2 = py * Math.cos(rx) - z1 * Math.sin(rx);
      const z2 = py * Math.sin(rx) + z1 * Math.cos(rx);
      if (z2 <= 0.05) break;
      const sx = this.cx + (x1 / (d - z2)) * f;
      const sy = this.cy - (y2 / (d - z2)) * f;
      const ex = x - sx;
      const ey = y - sy;
      if (Math.abs(ex) < 0.05 && Math.abs(ey) < 0.05) break;
      ry += ex / (pxr * Math.max(0.35, Math.cos(rx)));
      rx = Math.max(-1.3, Math.min(1.3, rx + ey / pxr));
    }
    return { x: rx, y: ry };
  }

  /** Surface point (local lat/lon, radians) under a screen position, or null when off the globe. */
  private latLonAt(x: number, y: number): { lat: number; lon: number } | null {
    this.world.rotation.set(this.rotX, this.rotY, 0);
    this.world.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new Vector2((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1), this.camera);
    const { origin, direction } = this.raycaster.ray;
    const b = origin.dot(direction);
    const c = origin.lengthSq() - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    const p = origin.clone().addScaledVector(direction, t);
    this.invWorld.copy(this.world.matrixWorld).invert();
    p.applyMatrix4(this.invWorld);
    return { lat: Math.asin(Math.max(-1, Math.min(1, p.y))), lon: Math.atan2(p.x, p.z) };
  }

  private buildPickGrid(): Map<number, number[]> {
    if (this.pickGrid && this.pickFrame === this.frameNo) return this.pickGrid;
    const grid = new Map<number, number[]>();
    const s = this.screen;
    for (let i = 0; i < this.nodes.ids.length; i++) {
      if (s[i * 3 + 2] < 0.08) continue;
      const key = Math.floor(s[i * 3 + 1] / PICK_CELL) * 4096 + Math.floor(s[i * 3] / PICK_CELL);
      const arr = grid.get(key);
      if (arr) arr.push(i);
      else grid.set(key, [i]);
    }
    this.pickGrid = grid;
    this.pickFrame = this.frameNo;
    return grid;
  }

  /** Does any visible marker (other than `self`) intersect box b? Uses the screen grid. */
  private hitsMarker(b: Box, self: number): boolean {
    const grid = this.buildPickGrid();
    const m = 12;
    for (let gy = Math.floor((b.y - m) / PICK_CELL); gy <= Math.floor((b.y + b.h + m) / PICK_CELL); gy++) {
      for (let gx = Math.floor((b.x - m) / PICK_CELL); gx <= Math.floor((b.x + b.w + m) / PICK_CELL); gx++) {
        const arr = grid.get(gy * 4096 + gx);
        if (!arr) continue;
        for (const i of arr) {
          if (i === self) continue;
          const r = this.nodes.radiusPx(i) * 0.8;
          const x = this.screen[i * 3];
          const y = this.screen[i * 3 + 1];
          if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return true;
        }
      }
    }
    return false;
  }

  /** Nearest visible marker within `radius` px of (x, y), via a screen-space grid. */
  private pick(x: number, y: number, radius: number): number {
    const grid = this.buildPickGrid();
    const reach = radius + 14;
    let best = -1;
    let bestD = Infinity;
    for (let gy = Math.floor((y - reach) / PICK_CELL); gy <= Math.floor((y + reach) / PICK_CELL); gy++) {
      for (let gx = Math.floor((x - reach) / PICK_CELL); gx <= Math.floor((x + reach) / PICK_CELL); gx++) {
        const arr = grid.get(gy * 4096 + gx);
        if (!arr) continue;
        for (const i of arr) {
          const d = Math.hypot(this.screen[i * 3] - x, this.screen[i * 3 + 1] - y) - this.nodes.radiusPx(i);
          if (d < radius && (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && this.nodes.influence[i] > this.nodes.influence[best]))) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  private onHover(x: number, y: number): void {
    this.setHover(this.pick(x, y, 8), x, y);
  }

  private setHover(i: number, x: number, y: number): void {
    this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
    if (i === this.hoverIdx) {
      if (i >= 0) this.events.hover(this.nodes.ids[i], x, y);
      return;
    }
    this.hoverIdx = i;
    this.nodes.setHover(i);
    this.events.hover(i >= 0 ? this.nodes.ids[i] : null, x, y);
    this.invalidate();
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.renderer.setSize(this.w, this.h, false);
    this.arcs.setResolution(this.w * this.dpr, this.h * this.dpr);
    this.updateCamera();
    this.invalidate();
    // render synchronously so the canvas never shows a stretched frame
    if (this.running) this.render();
  }

  private updateCamera(): void {
    const { w, h } = this;
    const i = this.insets;
    const availW = Math.max(120, w - i.left - i.right);
    const availH = Math.max(120, h - i.top - i.bottom);
    // phones: let the globe fill the width even when the sheet leaves a short strip above it
    this.baseRadius = isCompact()
      ? Math.max(60, Math.min(availW * 0.47, availH * 0.62))
      : Math.max(60, Math.min(availW * 0.43, availH * 0.43));
    const cx = i.left + availW / 2;
    const cy = i.top + availH / 2;
    this.cx = cx;
    this.cy = cy;
    const alt0 = this.alt0();
    this.magMax = Math.max(2, alt0 / ALT_MIN);
    if (this.magTarget > this.magMax) this.magTarget = this.magMax;
    if (this.mag > this.magMax) this.mag = this.magMax;
    const alt = this.altitude();
    const d = 1 + alt;
    this.pxPerRad = h / (2 * TAN * alt);
    const pxPerDeg = this.pxPerRad * DEG;
    this.zf = this.mag > 1 ? Math.min(1, Math.log(this.mag / this.flyDip) / Math.log(this.magMax)) : 0;
    this.zf = Math.max(0, this.zf);
    const zf = this.zf;

    this.camera.aspect = w / h;
    this.camera.position.set(0, 0, d);
    this.camera.lookAt(0, 0, 0);
    this.camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    this.camera.near = Math.max(0.0015, alt * 0.45);
    this.camera.far = d + 1.5;
    this.camera.updateProjectionMatrix();
    // rim/atmosphere disc sits in the silhouette plane
    this.halo.position.set(0, 0, 1 / d);
    (this.halo.material as ShaderMaterial).uniforms.uRs.value = Math.sqrt(1 - 1 / (d * d));
    const orbitLine = this.orbit.children[0] as Line;
    const om = orbitLine.material as LineDashedMaterial;
    om.opacity = 0.16 * (1 - smoothstep(0, 0.22, zf));
    orbitLine.visible = om.opacity > 0.005;

    // markers grow only a little when zoomed in
    this.nodes.setScale(0.85 + 0.3 * zf);

    // land: coarse point matrix far out, procedural fine matrix (sphere shader) when zoomed in
    const grid = this.maskReady ? smoothstep(8.5, 13, 1.05 * pxPerDeg) : 0;
    const su = (this.sphere.material as ShaderMaterial).uniforms;
    const target = 8 / pxPerDeg; // ~8px between dots
    const L = Math.max(0, Math.min(6, Math.log2(1.05 / target)));
    const L0 = Math.min(5, Math.floor(L));
    su.uS0.value = 1.05 / 2 ** L0;
    su.uS1.value = 1.05 / 2 ** (L0 + 1);
    su.uMix.value = Math.min(1, L - L0);
    su.uGrid.value = grid;
    su.uDot.value = this.dpr * (0.8 + 0.3 * zf);
    const lm = this.land.material as ShaderMaterial;
    lm.uniforms.uDim.value = 1 - grid;
    lm.uniforms.uSize.value = this.dpr * Math.min(2.4, 1.5 + 0.12 * Math.max(0, this.mag - 1));
    if (this.borders) {
      const bm = this.borders.material as ShaderMaterial;
      bm.uniforms.uBorderA.value = 0.06 + 0.34 * smoothstep(0.02, 0.55, zf);
      bm.uniforms.uCoastA.value = 0.03 + 0.3 * smoothstep(0.08, 0.6, zf);
    }
    // arcs: low lift when close so short (same-city) links don't tower over the view
    if (this.arcs.setLiftScale(Math.max(0.01, Math.min(1, 1 / this.mag)))) this.arcs.refresh();
  }

  private update(s: State, changed: Set<keyof State>): void {
    this.state = s;
    if (changed.has('kinds') || changed.has('selected')) {
      const kinds = s.kinds;
      const ents = this.index.entities;
      if (this.nodes.setActive((i) => kinds.has(ents[i].kind) || ents[i].id === s.selected)) {
        this.nodes.layout(this.pxPerRad * DEG, this.zf);
        if (this.hoverIdx >= 0 && !this.nodes.active[this.hoverIdx]) this.setHover(-1, 0, 0);
      }
    }
    const filters = changed.has('categories') || changed.has('includePast') || changed.has('kinds');
    if (filters || changed.has('selected')) {
      this.arcs.setAmbient(this.ambientEdges(s));
    }
    if (changed.has('selected') && s.selected) {
      this.flyTo(s.selected);
      this.autoRotate = false;
      this.lastInteract = performance.now();
    }
    if (changed.has('selected') && !s.selected) this.lastInteract = performance.now() - AUTO_RESUME_MS + 6000;
    this.applyFocus();
    this.invalidate();
  }

  /** The ambient web: the strongest edges (between influential entities) under the filters. */
  private ambientEdges(s: State): Edge[] {
    const edges = edgesFrom(visibleLinks(this.index, this.index.links, s));
    const inf = this.index.influence;
    const strength = (e: Edge) => Math.min(inf.get(e.a) ?? 0, inf.get(e.b) ?? 0);
    for (const e of edges) (e as Edge & { s: number }).s = strength(e);
    edges.sort((x, y) => (y as Edge & { s: number }).s - (x as Edge & { s: number }).s);
    return edges.slice(0, AMBIENT_MAX);
  }

  private applyFocus(): void {
    const s = this.state;
    const focusId = s.hoverEntity && entityVisible(this.index, s.hoverEntity, s) ? (s.selected ?? s.hoverEntity) : s.selected;
    const focusLinks = focusId ? visibleLinks(this.index, this.index.linksOf.get(focusId) ?? [], s) : [];
    const edges = edgesFrom(focusLinks);
    // highlighted row -> its edge, recoloured to the row's category
    const rowKey = s.selected ? (s.hoverRow ?? s.expanded) : null;
    let hlKey: string | null = null;
    let hlCounterpart: string | null = null;
    if (rowKey && s.selected) {
      const { category, counterpart } = parseRowKey(rowKey);
      const e = edges.find((x) => other(x, s.selected!) === counterpart);
      if (e) {
        e.category = category;
        hlKey = e.key;
        hlCounterpart = counterpart;
      }
    }
    this.arcs.setFocus(edges, hlKey, !!hlKey, s.selected ? 0.95 : 0.7);
    this.arcs.setAmbientAlpha(s.selected ? 0 : focusId ? 0.35 : 1);

    // node states
    const inf = this.index.influence;
    const states = new Map<string, { state: NodeState; color?: Color }>();
    const labels: { id: string; tier: LabelTier }[] = [];
    if (s.selected) {
      states.set(s.selected, { state: NodeState.Selected });
      labels.push({ id: s.selected, tier: 'selected' });
      if (hlCounterpart) labels.push({ id: hlCounterpart, tier: 'highlight' });
      if (s.hoverEntity && s.hoverEntity !== s.selected) labels.push({ id: s.hoverEntity, tier: 'hover' });
      const neigh: string[] = [];
      for (const e of edges) {
        const o = other(e, s.selected);
        const c = this.theme.category[e.category].clone();
        if (hlKey && e.key !== hlKey) c.multiplyScalar(0.55);
        states.set(o, { state: NodeState.Neighbour, color: c });
        neigh.push(o);
      }
      neigh.sort((x, y) => (inf.get(y) ?? 0) - (inf.get(x) ?? 0)).forEach((id) => labels.push({ id, tier: 'neighbour' }));
    } else if (s.hoverEntity && focusId) {
      labels.push({ id: s.hoverEntity, tier: 'hover' });
      for (const e of edges) states.set(other(e, s.hoverEntity), { state: NodeState.Neighbour, color: this.theme.category[e.category] });
    }
    this.labels.setFixed(labels);
    this.nodes.setStates(states, s.selected);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const t0 = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    let animating = false;
    let camera = false;

    // panel insets (bottom sheet moving etc.)
    const it = this.insetsTarget;
    const ic = this.insets;
    for (const k of ['top', 'right', 'bottom', 'left'] as const) {
      const d = it[k] - ic[k];
      if (Math.abs(d) > 0.5) {
        ic[k] += d * Math.min(1, dt * 9);
        camera = true;
      } else if (d !== 0) {
        ic[k] = it[k];
        camera = true;
      }
    }

    // zoom easing (log space) + the matching anchor rotation
    const k = Math.min(1, dt * 10);
    const lz = Math.log(this.magTarget / this.mag);
    if (Math.abs(lz) > 1e-4) {
      this.mag *= Math.exp(lz * k);
      if (Math.abs(Math.log(this.magTarget / this.mag)) < 1e-4) this.mag = this.magTarget;
      camera = true;
    }
    if (Math.abs(this.nudgeX) > 1e-7 || Math.abs(this.nudgeY) > 1e-7) {
      const kk = Math.abs(lz) > 1e-4 ? k : 1;
      this.rotX = Math.max(-1.3, Math.min(1.3, this.rotX + this.nudgeX * kk));
      this.rotY += this.nudgeY * kk;
      this.nudgeX *= 1 - kk;
      this.nudgeY *= 1 - kk;
      animating = true;
    }

    // rotation: fly-to > drag > inertia > auto-rotate
    if (this.fly) {
      const f = this.fly;
      const t = Math.min(1, (now - f.t0) / f.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.rotX = f.fx + (f.tx - f.fx) * e;
      this.rotY = f.fy + (f.ty - f.fy) * e;
      this.flyDip = f.dip > 1 ? Math.pow(f.dip, Math.sin(Math.PI * e)) : 1;
      if (t >= 1) {
        this.fly = null;
        this.flyDip = 1;
      }
      camera = true;
    } else if (!this.dragging && (Math.abs(this.velX) > 1e-7 || Math.abs(this.velY) > 1e-7)) {
      const ms = dt * 1000;
      this.rotY += this.velY * ms;
      this.rotX = Math.max(-1.3, Math.min(1.3, this.rotX + this.velX * ms));
      const decay = Math.exp(-ms / 320);
      this.velX *= decay;
      this.velY *= decay;
      // stop once the surface moves < ~0.02 px/ms
      if (Math.hypot(this.velX, this.velY) * this.pxPerRad < 0.02) this.velX = this.velY = 0;
      animating = true;
    } else if (!this.reduced && !this.state.selected) {
      if (!this.autoRotate && !this.dragging && now - this.lastInteract > AUTO_RESUME_MS) this.autoRotate = true;
      if (this.autoRotate) {
        this.rotY += (AUTO_SPEED * dt) / Math.max(1, this.mag);
        animating = true;
      }
    }

    const tA = performance.now();
    if (camera) {
      this.updateCamera();
      this.layoutPending = true;
      animating = true;
    }
    // re-spread markers for the new zoom, throttled while the zoom is still moving
    if (this.layoutPending && (!camera || now - this.lastLayout > 110)) {
      this.layoutPending = false;
      this.lastLayout = now;
      this.nodes.layout(this.pxPerRad * DEG, this.zf);
    }
    const tB = performance.now();
    if (this.nodes.tick()) {
      // arcs follow moving markers; rebuilding every frame is wasteful, ~20 fps is plenty
      if (now - this.lastArcRefresh > 50) {
        this.arcs.refresh();
        this.lastArcRefresh = now;
        this.arcsStale = false;
      } else this.arcsStale = true;
      animating = true;
    } else if (this.arcsStale) {
      this.arcs.refresh();
      this.arcsStale = false;
      animating = true;
    }
    const tC = performance.now();
    this.perfPart.layout += tB - tA;
    this.perfPart.tick += tC - tB;
    if (this.arcs.hasFocus && !this.reduced) {
      this.time += dt;
      animating = true;
    }

    if (animating || this.dirty) {
      this.render();
      // CPU time of the whole frame (layout, arc rebuilds, projection, labels, draw submission)
      const ms = performance.now() - t0;
      this.perf.frames++;
      this.perf.total += ms;
      if (ms > this.perf.max) this.perf.max = ms;
    }
  };

  private render(): void {
    this.dirty = false;
    this.frameNo++;
    this.world.rotation.set(this.rotX, this.rotY, 0);
    this.world.updateMatrixWorld(true);
    const t0 = performance.now();
    this.arcs.tick(this.time, !this.reduced);
    this.renderer.render(this.scene, this.camera);
    const t1 = performance.now();
    this.perfPart.gl += t1 - t0;

    this.nodes.project(this.world, this.camera, this.w, this.h, this.screen);
    const sel = this.state.selected;
    const blockers: Box[] = [...this.occluders];
    if (sel) {
      const i = this.nodes.indexOf.get(sel)!;
      const vis = this.screen[i * 3 + 2] > 0.05;
      const b = this.labels.placeReticle(this.screen[i * 3], this.screen[i * 3 + 1], vis);
      if (b) blockers.push(b);
    } else this.labels.placeReticle(0, 0, false);
    const v = new Vector3();
    const cam = this.camera;
    const mw = this.world.matrixWorld;
    this.labels.layout({
      screen: this.screen,
      radius: (i) => this.nodes.radiusPx(i),
      rank: this.rank,
      influence: this.nodes.influence,
      indexOf: this.nodes.indexOf,
      selected: sel,
      w: this.w,
      h: this.h,
      zf: this.zf,
      ambient: sel ? (this.zf > 0.45 ? 'dim' : 'off') : this.state.hoverEntity ? 'dim' : 'full',
      blockers,
      hitsMarker: (b, self) => this.hitsMarker(b, self),
      project: (lat, lon) => {
        toVec3(lat, lon, 1, v).applyMatrix4(mw);
        const f = (v.x * (cam.position.x - v.x) + v.y * (cam.position.y - v.y) + v.z * (cam.position.z - v.z)) / v.distanceTo(cam.position);
        v.project(cam);
        return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, f: v.z < 1 ? f : -1 };
      },
    });
    this.perfPart.labels += performance.now() - t1;
  }
}

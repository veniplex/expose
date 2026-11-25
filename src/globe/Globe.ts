import { Color, Group, Mesh, PerspectiveCamera, Points, Scene, ShaderMaterial, WebGLRenderer } from 'three';
import type { Link } from '../types';
import type { GraphIndex } from '../data';
import type { State, Store } from '../store';
import type { Theme } from '../theme';
import { edgesFrom, other, parseRowKey, type Edge } from '../data';
import { isPast } from '../format';
import { reducedMotion } from '../dom';
import { Nodes, NodeState } from './Nodes';
import { Arcs } from './Arcs';
import { Labels, type LabelTier } from './Labels';
import { Controls } from './Controls';
import { createGraticule, createHalo, createLand, createOrbit, createSphere } from './layers';
import { DEG, wrapPi } from './geo';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const FOV = 32;
const TAN = Math.tan((FOV / 2) * DEG);
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 5;
const AUTO_SPEED = 0.045; // rad/s
const AUTO_RESUME_MS = 25000;

export interface GlobeEvents {
  /** pointer hovering a node (mouse only) */
  hover(id: string | null, x: number, y: number): void;
  pick(id: string): void;
}

/** visible links under the current filters */
export function visibleLinks(links: Link[], s: State): Link[] {
  return links.filter((l) => s.categories.has(l.category) && (s.includePast || !isPast(l)));
}

/** The WebGL globe: scene, camera rig, render loop and selection visuals. */
export class Globe {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
  private world = new Group();
  private halo: Mesh;
  private land: Points;
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
  private zoom = 1;
  private zoomTarget = 1;
  private fly: { fx: number; fy: number; tx: number; ty: number; t0: number; dur: number } | null = null;
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

    this.world.add(createSphere(theme));
    this.land = createLand(theme, this.dpr);
    this.world.add(this.land);
    this.world.add(createGraticule(theme));
    this.nodes = new Nodes(index, theme, this.dpr);
    this.world.add(this.nodes.points);
    this.arcs = new Arcs(index, this.nodes, theme, this.dpr);
    this.world.add(this.arcs.group);
    this.halo = createHalo(theme);
    this.scene.add(this.world, this.halo, createOrbit(theme));
    this.screen = new Float32Array(index.entities.length * 3);

    this.labels = new Labels(index);
    container.append(this.canvas, this.labels.root);

    this.state = store.state;
    new Controls(this.canvas, {
      drag: (dx, dy, dt) => this.onDrag(dx, dy, dt),
      dragEnd: () => {
        this.dragging = false;
      },
      zoom: (f) => this.zoomBy(f),
      tap: (x, y, coarse) => {
        const i = this.pick(x, y, coarse ? 26 : 12);
        if (i >= 0) this.events.pick(this.nodes.ids[i]);
      },
      doubleTap: () => this.zoomBy(this.zoomTarget >= ZOOM_MAX * 0.95 ? 1 / this.zoomTarget : 1.8),
      hover: (x, y) => this.onHover(x, y),
      leave: () => this.setHover(-1, 0, 0),
      interact: () => this.interacted(),
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    // initial view: Atlantic, tilted north so Europe + North America are in frame
    this.rotY = 30 * DEG;
    this.rotX = 28 * DEG;
    this.nodes.layout(this.radiusPx(), 11, true);
    this.update(store.state, new Set(['selected', 'categories']));
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
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Reserve screen space covered by overlaid panels; the globe centres in what's left. */
  setInsets(i: Insets, immediate = false): void {
    this.insetsTarget = { ...i };
    if (immediate || this.reduced) this.insets = { ...i };
    this.invalidate();
  }

  zoomBy(f: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomTarget * f));
    this.interacted();
  }

  resetView(): void {
    this.zoomTarget = 1;
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
    if (this.zoomTarget < 1.15) this.zoomTarget = 1.15;
  }

  /** Screen position (CSS px, relative to the container) of an entity, or null when hidden. */
  screenOf(id: string): { x: number; y: number } | null {
    const i = this.nodes.indexOf.get(id);
    if (i === undefined || this.screen[i * 3 + 2] < 0.05) return null;
    return { x: this.screen[i * 3], y: this.screen[i * 3 + 1] };
  }

  invalidate(): void {
    this.dirty = true;
  }

  /* ---------------- internals ---------------- */

  private flyToLatLon(lat: number, lon: number): void {
    const tx = Math.max(-1.25, Math.min(1.25, lat * DEG));
    const ty = this.rotY + wrapPi(-lon * DEG - this.rotY);
    this.velX = this.velY = 0;
    if (this.reduced) {
      this.rotX = tx;
      this.rotY = ty;
      this.fly = null;
    } else {
      const dist = Math.hypot(tx - this.rotX, ty - this.rotY);
      this.fly = { fx: this.rotX, fy: this.rotY, tx, ty, t0: performance.now(), dur: 700 + Math.min(900, dist * 420) };
    }
    this.invalidate();
  }

  private interacted(): void {
    this.autoRotate = false;
    this.lastInteract = performance.now();
    this.invalidate();
  }

  private radiusPx(): number {
    return this.baseRadius * this.zoom;
  }

  /** Screen px per radian of rotation for the surface point at the globe centre (perspective-correct). */
  private surfacePxPerRad(): number {
    const d = this.camera.position.z;
    return this.h / 2 / (TAN * Math.max(0.05, d - 1));
  }

  private onDrag(dx: number, dy: number, dtMs: number): void {
    this.dragging = true;
    this.fly = null;
    // grab the surface: 1px of pointer movement ≈ 1px of surface movement at the globe centre
    const r = this.surfacePxPerRad();
    const ay = dx / (r * Math.max(0.35, Math.cos(this.rotX)));
    const ax = dy / r;
    this.rotY += ay;
    this.rotX = Math.max(-1.3, Math.min(1.3, this.rotX + ax));
    const k = Math.max(1, dtMs);
    // smoothed velocity in rad/ms for inertia
    this.velY = this.velY * 0.5 + (ay / k) * 0.5;
    this.velX = this.velX * 0.5 + (ax / k) * 0.5;
    this.invalidate();
  }

  private pick(x: number, y: number, radius: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.ids.length; i++) {
      if (this.screen[i * 3 + 2] < 0.08) continue;
      const d = Math.hypot(this.screen[i * 3] - x, this.screen[i * 3 + 1] - y) - this.nodes.size[i] / 2;
      if (d < radius && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private onHover(x: number, y: number): void {
    this.setHover(this.pick(x, y, 10), x, y);
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
    this.baseRadius = Math.max(60, Math.min(availW * 0.43, availH * 0.43));
    const cx = i.left + availW / 2;
    const cy = i.top + availH / 2;
    const R = this.radiusPx();
    const k = h / 2 / (TAN * R);
    const d = Math.sqrt(1 + k * k);
    this.camera.aspect = w / h;
    this.camera.position.set(0, 0, d);
    this.camera.lookAt(0, 0, 0);
    this.camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    this.camera.near = Math.max(0.01, d - 1.6);
    this.camera.far = d + 2;
    this.camera.updateProjectionMatrix();
    // rim/atmosphere disc sits in the silhouette plane
    this.halo.position.set(0, 0, 1 / d);
    (this.halo.material as ShaderMaterial).uniforms.uRs.value = Math.sqrt(1 - 1 / (d * d));
    // markers and land dots grow a little when zoomed in
    this.nodes.setScale(Math.min(1.5, 0.85 + 0.15 * this.zoom));
    (this.land.material as ShaderMaterial).uniforms.uSize.value = this.dpr * Math.min(2.6, 1.5 + 0.22 * (this.zoom - 1) + (R > 500 ? 0.2 : 0));
  }

  private update(s: State, changed: Set<keyof State>): void {
    this.state = s;
    const filters = changed.has('categories') || changed.has('includePast');
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

  /** The ambient web: the strongest edges (between well-connected entities) under the filters. */
  private ambientEdges(s: State): Edge[] {
    const edges = edgesFrom(visibleLinks(this.index.links, s));
    const strength = (e: Edge) => Math.min(this.index.degree.get(e.a) ?? 0, this.index.degree.get(e.b) ?? 0);
    edges.sort((x, y) => strength(y) - strength(x));
    return edges.slice(0, 520);
  }

  private applyFocus(): void {
    const s = this.state;
    const focusId = s.selected ?? s.hoverEntity;
    const focusLinks = focusId ? visibleLinks(this.index.linksOf.get(focusId) ?? [], s) : [];
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
      neigh
        .sort((x, y) => (this.index.degree.get(y) ?? 0) - (this.index.degree.get(x) ?? 0))
        .forEach((id) => labels.push({ id, tier: 'neighbour' }));
    } else {
      if (s.hoverEntity) {
        labels.push({ id: s.hoverEntity, tier: 'hover' });
        for (const e of edges) states.set(other(e, s.hoverEntity), { state: NodeState.Neighbour, color: this.theme.category[e.category] });
      }
      const top = Math.min(16, Math.max(6, Math.round(this.index.entities.length / 20)));
      for (const e of this.index.ranked.slice(0, top)) labels.push({ id: e.id, tier: 'top' });
    }
    const seen = new Set<string>();
    this.labels.setCandidates(labels.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))));
    this.nodes.setStates(states, s.selected);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    let animating = false;

    // panel insets (bottom sheet moving etc.)
    const it = this.insetsTarget;
    const ic = this.insets;
    let insetMoved = false;
    for (const k of ['top', 'right', 'bottom', 'left'] as const) {
      const d = it[k] - ic[k];
      if (Math.abs(d) > 0.5) {
        ic[k] += d * Math.min(1, dt * 9);
        insetMoved = true;
      } else ic[k] = it[k];
    }

    // zoom easing
    const zd = this.zoomTarget - this.zoom;
    if (Math.abs(zd) > 1e-4 || insetMoved) {
      this.zoom += zd * Math.min(1, dt * 10);
      if (Math.abs(this.zoomTarget - this.zoom) < 1e-4) this.zoom = this.zoomTarget;
      this.updateCamera();
      this.nodes.layout(this.radiusPx(), 11);
      animating = true;
    }

    // rotation: fly-to > drag > inertia > auto-rotate
    if (this.fly) {
      const f = this.fly;
      const t = Math.min(1, (now - f.t0) / f.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.rotX = f.fx + (f.tx - f.fx) * e;
      this.rotY = f.fy + (f.ty - f.fy) * e;
      if (t >= 1) this.fly = null;
      animating = true;
    } else if (!this.dragging && (Math.abs(this.velX) > 1e-6 || Math.abs(this.velY) > 1e-6)) {
      const ms = dt * 1000;
      this.rotY += this.velY * ms;
      this.rotX = Math.max(-1.3, Math.min(1.3, this.rotX + this.velX * ms));
      const decay = Math.exp(-ms / 320);
      this.velX *= decay;
      this.velY *= decay;
      if (Math.abs(this.velX) < 2e-6 && Math.abs(this.velY) < 2e-6) this.velX = this.velY = 0;
      animating = true;
    } else if (!this.reduced && !this.state.selected) {
      if (!this.autoRotate && !this.dragging && now - this.lastInteract > AUTO_RESUME_MS) this.autoRotate = true;
      if (this.autoRotate) {
        this.rotY += AUTO_SPEED * dt;
        animating = true;
      }
    }

    if (this.nodes.tick()) {
      this.arcs.refresh();
      animating = true;
    }
    if (this.arcs.hasFocus && !this.reduced) {
      this.time += dt;
      animating = true;
    }

    if (animating || this.dirty) this.render();
  };

  private render(): void {
    this.dirty = false;
    this.world.rotation.set(this.rotX, this.rotY, 0);
    this.world.updateMatrixWorld(true);
    this.arcs.tick(this.time, !this.reduced);
    this.renderer.render(this.scene, this.camera);

    this.nodes.project(this.world, this.camera, this.w, this.h, this.screen);
    const sel = this.state.selected;
    const blockers = [];
    if (sel) {
      const i = this.nodes.indexOf.get(sel)!;
      const vis = this.screen[i * 3 + 2] > 0.05;
      const b = this.labels.placeReticle(this.screen[i * 3], this.screen[i * 3 + 1], vis);
      if (b) blockers.push(b);
    } else this.labels.placeReticle(0, 0, false);
    this.labels.layout(this.screen, this.nodes.indexOf, this.nodes.size, sel, this.w, this.h, blockers);
  }
}

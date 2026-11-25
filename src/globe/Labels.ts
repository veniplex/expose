import type { GraphIndex } from '../data';
import type { CountryLabel } from './geoAssets';

export type LabelTier = 'selected' | 'hover' | 'highlight' | 'neighbour' | 'top' | 'dim' | 'country';

interface LabelEl {
  el: HTMLDivElement;
  w: number;
  h: number;
  tier: LabelTier | '';
  shown: boolean;
  x: number;
  y: number;
  o: number;
  /** frame in which it was last placed (for pool eviction) */
  seen: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelFrame {
  /** x, y, facing per node index (facing < 0: hidden / behind) */
  screen: Float32Array;
  /** on-screen marker radius per node index, CSS px */
  radius: (i: number) => number;
  /** node indices in label priority order (most influential first) */
  rank: Int32Array;
  influence: Float64Array;
  indexOf: Map<string, number>;
  selected: string | null;
  w: number;
  h: number;
  /** 0 = overview … 1 = closest zoom */
  zf: number;
  /** show general (non-focus) labels, and how prominently */
  ambient: 'full' | 'dim' | 'off';
  blockers: Box[];
  /** project lat/lon to CSS px; `f` = facing (≤ 0: behind) */
  project(lat: number, lon: number): { x: number; y: number; f: number };
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const POOL_MAX = 220;

/**
 * Crisp HTML labels over the canvas with greedy collision avoidance, plus the targeting reticle.
 * Focus labels (selected, hovered, neighbours) come first; then — progressively with zoom —
 * the most influential visible entities, then country names at close zoom. The number of label
 * elements touched per frame is capped, so the DOM cost doesn't grow with the dataset.
 */
export class Labels {
  readonly root: HTMLDivElement;
  private pool = new Map<string, LabelEl>();
  private fixed: { id: string; tier: LabelTier }[] = [];
  private reticle: HTMLDivElement;
  private countries: CountryLabel[] = [];
  private frameNo = 0;

  constructor(private index: GraphIndex) {
    this.root = document.createElement('div');
    this.root.className = 'globe-labels';
    this.root.setAttribute('aria-hidden', 'true');
    this.reticle = document.createElement('div');
    this.reticle.className = 'reticle';
    this.reticle.innerHTML =
      '<svg viewBox="-20 -20 40 40" width="40" height="40"><circle r="10" /><path d="M-17 0h6M11 0h6M0 -17v6M0 11v6" /><circle class="core" r="3" /></svg>';
    this.root.appendChild(this.reticle);
    // label widths depend on the web fonts: re-measure once they are in
    document.fonts?.ready.then(() => {
      for (const l of this.pool.values()) l.w = 0;
    });
  }

  /** Focus labels in priority order (first = most important). */
  setFixed(list: { id: string; tier: LabelTier }[]): void {
    this.fixed = list;
  }

  setCountries(list: CountryLabel[]): void {
    this.countries = list;
  }

  private get(key: string, text: string, tier: LabelTier, rank: string): LabelEl {
    let l = this.pool.get(key);
    if (!l) {
      const el = document.createElement('div');
      el.className = tier === 'country' ? 'glabel country' : 'glabel';
      el.textContent = text.length > 28 ? text.slice(0, 26).trimEnd() + '…' : text;
      el.style.visibility = 'hidden';
      this.root.appendChild(el);
      l = { el, w: 0, h: 0, tier: '', shown: false, x: NaN, y: NaN, o: -1, seen: 0 };
      this.pool.set(key, l);
    }
    if (l.tier !== tier || l.el.dataset.rank !== rank) {
      l.tier = tier;
      l.el.dataset.tier = tier;
      l.el.dataset.rank = rank;
      l.w = 0;
    }
    return l;
  }

  private rankOf(inf: number): string {
    return inf >= 0.66 ? '1' : inf >= 0.33 ? '2' : '3';
  }

  layout(fr: LabelFrame): void {
    const { screen, w, h } = fr;
    this.frameNo++;
    const onScreen = (x: number, y: number, f: number) => f > 0.12 && x > -60 && x < w + 60 && y > -30 && y < h + 30;

    // ---- 1. collect candidates (no DOM writes yet) ----
    type Cand = { l: LabelEl; x: number; y: number; f: number; gap: number; self: Box | null; center: boolean };
    const cands: Cand[] = [];
    const used = new Set<number>();
    for (const c of this.fixed) {
      const i = fr.indexOf.get(c.id);
      if (i === undefined || used.has(i)) continue;
      used.add(i);
      const x = screen[i * 3];
      const y = screen[i * 3 + 1];
      const f = screen[i * 3 + 2];
      if (!onScreen(x, y, f)) continue;
      const e = this.index.byId.get(c.id);
      const r = fr.radius(i);
      cands.push({
        l: this.get(c.id, e?.name ?? c.id, c.tier, this.rankOf(fr.influence[i])),
        x,
        y,
        f,
        gap: c.id === fr.selected ? 16 : r + 5,
        self: { x: x - r - 1, y: y - r - 1, w: 2 * r + 2, h: 2 * r + 2 },
        center: false,
      });
    }
    const nFixed = cands.length;
    if (fr.ambient !== 'off') {
      const area = Math.max(0.3, Math.min(1, (w * h) / (1440 * 860)));
      const zf = fr.zf;
      const cap = Math.round((7 + 48 * Math.pow(zf, 1.2)) * area) * (fr.ambient === 'dim' ? 0.5 : 1);
      // consider only the top share of entities by influence; the share grows as you zoom in
      const limit = Math.max(cap * 2, Math.round(fr.rank.length * (0.03 + 0.97 * Math.pow(zf, 1.4))));
      let taken = 0;
      const tier: LabelTier = fr.ambient === 'dim' ? 'dim' : 'top';
      for (let k = 0; k < Math.min(limit, fr.rank.length) && taken < cap * 2; k++) {
        const i = fr.rank[k];
        if (used.has(i)) continue;
        const x = screen[i * 3];
        const y = screen[i * 3 + 1];
        const f = screen[i * 3 + 2];
        if (!onScreen(x, y, f) || x < 0 || x > w || y < 0 || y > h) continue;
        used.add(i);
        const id = this.index.entities[i].id;
        const r = fr.radius(i);
        cands.push({
          l: this.get(id, this.index.entities[i].name, tier, this.rankOf(fr.influence[i])),
          x,
          y,
          f,
          gap: r + 4,
          self: { x: x - r - 1, y: y - r - 1, w: 2 * r + 2, h: 2 * r + 2 },
          center: false,
        });
        taken++;
      }
    }
    if (this.countries.length && fr.zf > 0.22) {
      const n = Math.round(this.countries.length * Math.min(1, (fr.zf - 0.22) / 0.5));
      let taken = 0;
      for (let k = 0; k < n && taken < 30; k++) {
        const [name, lat, lon] = this.countries[k];
        const p = fr.project(lat, lon);
        if (!(p.f > 0.25) || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
        cands.push({ l: this.get(`c:${name}`, name, 'country', ''), x: p.x, y: p.y, f: p.f, gap: 0, self: null, center: true });
        taken++;
      }
    }

    // ---- 2. measure new labels in one batch (one forced layout at most) ----
    const fresh = cands.filter((c) => !c.l.w);
    if (fresh.length) {
      for (const c of fresh) c.l.el.style.transform = 'translate(-9999px,0)';
      for (const c of fresh) {
        c.l.w = c.l.el.offsetWidth;
        c.l.h = c.l.el.offsetHeight;
      }
    }

    // ---- 3. greedy placement ----
    const placed: Box[] = [...fr.blockers];
    // reserve the markers of focus labels so labels don't sit on them
    for (let k = 0; k < nFixed; k++) {
      const s = cands[k].self;
      if (s) placed.push(s);
    }
    const out = new Set<LabelEl>();
    for (const c of cands) {
      const { l, x, y, gap } = c;
      const tries: Box[] = c.center
        ? [{ x: x - l.w / 2, y: y - l.h / 2, w: l.w, h: l.h }]
        : [
            { x: x + gap, y: y - l.h / 2, w: l.w, h: l.h },
            { x: x - gap - l.w, y: y - l.h / 2, w: l.w, h: l.h },
            { x: x - l.w / 2, y: y - gap - l.h, w: l.w, h: l.h },
            { x: x - l.w / 2, y: y + gap, w: l.w, h: l.h },
          ];
      const self = c.self;
      const choice = tries.find(
        (b) =>
          b.x >= 2 &&
          b.x + b.w <= w - 2 &&
          b.y >= 2 &&
          b.y + b.h <= h - 2 &&
          !placed.some((p) => p !== self && overlap(b, p)),
      );
      if (!choice) continue;
      placed.push(choice);
      // ambient labels also reserve their own marker so later labels don't cover it
      if (self && !placed.includes(self)) placed.push(self);
      out.add(l);
      l.seen = this.frameNo;
      const px = Math.round(choice.x);
      const py = Math.round(choice.y);
      if (px !== l.x || py !== l.y) {
        l.x = px;
        l.y = py;
        l.el.style.transform = `translate(${px}px,${py}px)`;
      }
      const o = Math.round(Math.min(1, (c.f - 0.12) * 6) * 20) / 20;
      if (o !== l.o) {
        l.o = o;
        l.el.style.opacity = String(o);
      }
      if (!l.shown) {
        l.shown = true;
        l.el.style.visibility = 'visible';
      }
    }
    // ---- 4. hide the rest; evict long-unused elements ----
    for (const [key, l] of this.pool) {
      if (out.has(l)) continue;
      if (l.shown) {
        l.shown = false;
        l.el.style.visibility = 'hidden';
      }
      if (this.pool.size > POOL_MAX && this.frameNo - l.seen > 120) {
        l.el.remove();
        this.pool.delete(key);
      }
    }
  }

  /** Place the reticle; returns its box (or null when hidden). */
  placeReticle(x: number, y: number, visible: boolean): Box | null {
    this.reticle.style.display = visible ? 'block' : 'none';
    if (!visible) return null;
    this.reticle.style.transform = `translate(${x - 20}px,${y - 20}px)`;
    return { x: x - 14, y: y - 14, w: 28, h: 28 };
  }
}

import type { GraphIndex } from '../data';

export type LabelTier = 'selected' | 'hover' | 'highlight' | 'neighbour' | 'top';

interface LabelEl {
  el: HTMLDivElement;
  w: number;
  h: number;
  tier: LabelTier;
  shown: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Crisp HTML labels over the canvas with greedy collision avoidance, plus the targeting reticle.
 * Candidates arrive in priority order; each is tried right of its marker, then left; if both
 * collide with an already placed label it is hidden for this frame.
 */
export class Labels {
  readonly root: HTMLDivElement;
  private pool = new Map<string, LabelEl>();
  private order: { id: string; tier: LabelTier }[] = [];
  private reticle: HTMLDivElement;

  constructor(private index: GraphIndex) {
    this.root = document.createElement('div');
    this.root.className = 'globe-labels';
    this.root.setAttribute('aria-hidden', 'true');
    this.reticle = document.createElement('div');
    this.reticle.className = 'reticle';
    this.reticle.innerHTML =
      '<svg viewBox="-20 -20 40 40" width="40" height="40"><circle r="10" /><path d="M-17 0h6M11 0h6M0 -17v6M0 11v6" /><circle class="core" r="3" /></svg>';
    this.root.appendChild(this.reticle);
  }

  /** Set the candidate list in priority order (first = most important). */
  setCandidates(list: { id: string; tier: LabelTier }[]): void {
    this.order = list;
    const keep = new Set(list.map((c) => c.id));
    for (const [id, l] of this.pool) {
      if (!keep.has(id)) {
        l.el.remove();
        this.pool.delete(id);
      }
    }
    for (const c of list) {
      let l = this.pool.get(c.id);
      if (!l) {
        const el = document.createElement('div');
        el.className = 'glabel';
        const name = this.index.byId.get(c.id)?.name ?? c.id;
        el.textContent = name.length > 28 ? name.slice(0, 26).trimEnd() + '…' : name;
        this.root.appendChild(el);
        l = { el, w: 0, h: 0, tier: c.tier, shown: true };
        this.pool.set(c.id, l);
      }
      if (l.tier !== c.tier || !l.w) {
        l.tier = c.tier;
        l.el.dataset.tier = c.tier;
        l.w = 0;
      }
    }
    // measure in one pass (avoid interleaved layout reads/writes)
    for (const l of this.pool.values()) {
      if (!l.w) {
        l.el.style.transform = 'translate(-9999px,0)';
        l.el.style.visibility = 'visible';
      }
    }
    for (const l of this.pool.values()) {
      if (!l.w) {
        l.w = l.el.offsetWidth;
        l.h = l.el.offsetHeight;
      }
    }
  }

  /**
   * Position labels. `screen` holds x, y, facing per node index; `size` marker sizes in px.
   * `obstacles` are boxes (e.g. the reticle) labels must not cover.
   */
  layout(
    screen: Float32Array,
    indexOf: Map<string, number>,
    size: Float32Array,
    selected: string | null,
    w: number,
    h: number,
    blockers: Box[],
  ): void {
    const placed: Box[] = [...blockers];
    // reserve every visible marker of a label candidate so labels don't sit on other markers
    for (const c of this.order) {
      const i = indexOf.get(c.id);
      if (i === undefined || screen[i * 3 + 2] < 0.12) continue;
      const r = size[i] / 2 + 1;
      placed.push({ x: screen[i * 3] - r, y: screen[i * 3 + 1] - r, w: r * 2, h: r * 2 });
    }
    for (const c of this.order) {
      const l = this.pool.get(c.id);
      const i = indexOf.get(c.id);
      if (!l || i === undefined) continue;
      const x = screen[i * 3];
      const y = screen[i * 3 + 1];
      const f = screen[i * 3 + 2];
      let ok = f > 0.12 && x > -50 && x < w + 50 && y > -20 && y < h + 20;
      if (ok) {
        const gap = (c.id === selected ? 16 : size[i] / 2 + 5);
        const tryBoxes: Box[] = [
          { x: x + gap, y: y - l.h / 2, w: l.w, h: l.h },
          { x: x - gap - l.w, y: y - l.h / 2, w: l.w, h: l.h },
          { x: x - l.w / 2, y: y - gap - l.h, w: l.w, h: l.h },
          { x: x - l.w / 2, y: y + gap, w: l.w, h: l.h },
        ];
        const self = { x: x - size[i] / 2 - 1, y: y - size[i] / 2 - 1, w: size[i] + 2, h: size[i] + 2 };
        const choice = tryBoxes.find(
          (b) =>
            b.x >= 2 && b.x + b.w <= w - 2 && b.y >= 2 && b.y + b.h <= h - 2 &&
            !placed.some((p) => !(p.x === self.x && p.y === self.y) && overlap(b, p)),
        );
        if (choice) {
          placed.push(choice);
          l.el.style.transform = `translate(${Math.round(choice.x)}px,${Math.round(choice.y)}px)`;
          l.el.style.opacity = String(Math.min(1, (f - 0.12) * 6));
        } else ok = false;
      }
      if (ok !== l.shown) {
        l.shown = ok;
        l.el.style.visibility = ok ? 'visible' : 'hidden';
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

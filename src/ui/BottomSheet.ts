import { isCompact, reducedMotion } from '../dom';

export type Snap = 'peek' | 'half' | 'full';

/**
 * Turns the dossier into a draggable bottom sheet on compact screens.
 * Snap points: peek (title only) / half / full. Driven by pointer events on the grip and the
 * dossier header; the list inside scrolls natively. Publishes its visible height as --sheet-h.
 */
export class BottomSheet {
  snap: Snap = 'peek';
  private height = 0;
  private drag: { y0: number; h0: number; t: number; lastY: number; lastT: number; v: number; moved: boolean } | null = null;
  private listeners: ((h: number) => void)[] = [];

  constructor(
    private app: HTMLElement,
    private sheet: HTMLElement,
    private grip: HTMLElement,
    private peekHeight: () => number,
    private topLimit: () => number,
  ) {
    // delegated: the grip and the dossier header (re-rendered per entity) start a drag
    sheet.addEventListener('pointerdown', this.down);
    sheet.addEventListener('pointermove', this.move);
    sheet.addEventListener('pointerup', this.up);
    sheet.addEventListener('pointercancel', this.up);
    grip.addEventListener('click', (e) => {
      // keyboard / tap on the grip cycles the snap points
      if ((e as PointerEvent).detail === 0 || !this.lastDragMoved) this.cycle();
    });
    const onResize = () => this.apply(false);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.matchMedia('(max-width: 820px)').addEventListener('change', onResize);
    this.apply(false);
  }

  private lastDragMoved = false;

  onChange(fn: (h: number) => void): void {
    this.listeners.push(fn);
  }

  /** visible height in px (0 when not in compact mode) */
  get visibleHeight(): number {
    return isCompact() ? this.height : 0;
  }

  private viewportH(): number {
    return window.visualViewport?.height ?? window.innerHeight;
  }

  private heightFor(s: Snap): number {
    const vh = this.viewportH();
    const full = Math.max(200, vh - this.topLimit());
    const peek = Math.min(full, Math.max(96, this.peekHeight()));
    if (s === 'peek') return peek;
    if (s === 'half') return Math.min(full, Math.max(peek + 40, Math.round(vh * 0.5)));
    return full;
  }

  setSnap(s: Snap, animate = true): void {
    this.snap = s;
    this.apply(animate);
  }

  /** re-measure (content changed) and keep the current snap */
  refresh(): void {
    this.apply(true);
  }

  private cycle(): void {
    this.setSnap(this.snap === 'peek' ? 'half' : this.snap === 'half' ? 'full' : 'peek');
  }

  private apply(_animate: boolean): void {
    if (!isCompact()) {
      this.sheet.style.removeProperty('--sheet-h');
      this.app.style.removeProperty('--sheet-h');
      this.sheet.removeAttribute('data-snap');
      this.app.removeAttribute('data-sheet');
      this.emit(0);
      return;
    }
    this.setHeight(this.heightFor(this.snap));
    this.sheet.dataset.snap = this.snap;
    this.app.dataset.sheet = this.snap;
    this.grip.setAttribute('aria-label', `Resize panel (currently ${this.snap})`);
  }

  private setHeight(px: number): void {
    this.height = Math.round(px);
    this.app.style.setProperty('--sheet-h', `${this.height}px`);
    this.emit(this.height);
  }

  private emit(h: number): void {
    for (const fn of this.listeners) fn(h);
  }

  private down = (e: PointerEvent) => {
    if (!isCompact()) return;
    const t = e.target as HTMLElement;
    if (!t.closest('.sheet-grip, .d-head') || t.closest('a, input, .close')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const now = performance.now();
    this.drag = { y0: e.clientY, h0: this.height, t: now, lastY: e.clientY, lastT: now, v: 0, moved: false };
    this.sheet.setPointerCapture?.(e.pointerId);
  };

  private move = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 6) return;
    if (!d.moved) {
      d.moved = true;
      this.app.classList.add('sheet-dragging');
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.v = d.v * 0.6 + ((e.clientY - d.lastY) / dt) * 0.4; // px/ms, + = downward
    d.lastY = e.clientY;
    d.lastT = now;
    const min = this.heightFor('peek') * 0.7;
    const max = this.heightFor('full');
    this.setHeight(Math.max(min, Math.min(max, d.h0 - dy)));
  };

  private up = () => {
    const d = this.drag;
    this.drag = null;
    this.lastDragMoved = !!d?.moved;
    if (!d || !d.moved) return;
    this.app.classList.remove('sheet-dragging');
    // project with velocity, then snap to the nearest point
    const projected = this.height - d.v * (reducedMotion() ? 0 : 180);
    const snaps: Snap[] = ['peek', 'half', 'full'];
    let best: Snap = 'peek';
    let bestD = Infinity;
    for (const s of snaps) {
      const dist = Math.abs(this.heightFor(s) - projected);
      if (dist < bestD) {
        bestD = dist;
        best = s;
      }
    }
    this.setSnap(best);
  };
}

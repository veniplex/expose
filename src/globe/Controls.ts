/**
 * Pointer / touch / wheel input for the globe canvas.
 * One pointer drags (rotate), two pointers pinch (zoom), short low-movement presses are taps,
 * two quick taps are a double tap. Works the same for mouse, pen and touch.
 */
export interface ControlHandlers {
  /** pointer moved by (dx, dy) CSS px while dragging */
  drag(dx: number, dy: number, dtMs: number): void;
  dragEnd(): void;
  /** multiply zoom by `factor`, keeping the surface point under (x, y) in place when given */
  zoom(factor: number, x?: number, y?: number): void;
  tap(x: number, y: number, coarse: boolean): void;
  doubleTap(x: number, y: number): void;
  hover(x: number, y: number): void;
  leave(): void;
  /** any user interaction (stops auto-rotate) */
  interact(): void;
}

export class Controls {
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number; type: string }>();
  private pinchDist = 0;
  private moved = 0;
  private wasMulti = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private lastMove = 0;

  constructor(
    private el: HTMLElement,
    private h: ControlHandlers,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pointers.size) this.h.leave();
    });
    el.addEventListener('wheel', this.wheel, { passive: false });
    // the canvas handles its own gestures; never let the browser zoom/scroll from it
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('contextmenu', (e) => {
      if (this.pointers.size) e.preventDefault();
    });
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.el.setPointerCapture?.(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), type: e.pointerType });
    if (this.pointers.size === 1) {
      this.moved = 0;
      this.wasMulti = false;
    } else {
      this.wasMulti = true;
      this.pinchDist = this.spread();
    }
    this.lastMove = performance.now();
    this.h.interact();
    this.el.classList.add('dragging');
  };

  private spread(): number {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return 0;
    return Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  private move = (e: PointerEvent) => {
    const p = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) {
      if (e.pointerType === 'mouse') this.h.hover(p.x, p.y);
      return;
    }
    const now = performance.now();
    if (this.pointers.size >= 2) {
      ptr.x = p.x;
      ptr.y = p.y;
      const d = this.spread();
      if (this.pinchDist > 0 && d > 0) {
        const ps = [...this.pointers.values()];
        this.h.zoom(d / this.pinchDist, (ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2);
      }
      this.pinchDist = d;
      this.moved += 100;
      return;
    }
    const dx = p.x - ptr.x;
    const dy = p.y - ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;
    this.moved = Math.max(this.moved, Math.hypot(p.x - ptr.sx, p.y - ptr.sy));
    if (!this.wasMulti && this.moved > 3) this.h.drag(dx, dy, now - this.lastMove);
    this.lastMove = now;
  };

  private up = (e: PointerEvent) => {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1) {
      // pinch -> one finger left: re-anchor so the remaining finger doesn't jump
      const rest = [...this.pointers.values()][0];
      rest.sx = rest.x;
      rest.sy = rest.y;
      this.pinchDist = 0;
      return;
    }
    if (this.pointers.size > 0) return;
    this.el.classList.remove('dragging');
    const coarse = ptr.type !== 'mouse';
    const threshold = coarse ? 10 : 5;
    const dur = performance.now() - ptr.t;
    if (!this.wasMulti && this.moved <= threshold && dur < 600) {
      const now = performance.now();
      const p = { x: ptr.x, y: ptr.y };
      if (now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
        this.lastTap.t = 0;
        this.h.doubleTap(p.x, p.y);
      } else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        this.h.tap(p.x, p.y, coarse);
      }
    } else if (!this.wasMulti) {
      // stale drags (finger rested before lifting) get no inertia
      if (performance.now() - this.lastMove > 80) this.h.drag(0, 0, 1);
      this.h.dragEnd();
    }
  };

  private cancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (!this.pointers.size) this.el.classList.remove('dragging');
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.h.interact();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const p = this.local(e);
    // clamp so a single fast trackpad fling can't jump across the whole zoom range
    this.h.zoom(Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.0022), p.x, p.y);
  };
}

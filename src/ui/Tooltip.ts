import { h } from '../dom';

/** Pointer-following tooltip (mouse only; touch users get the same info by tapping = selecting). */
export class Tooltip {
  readonly el = h('div.tooltip.panel', { role: 'tooltip', 'aria-hidden': 'true' });

  show(x: number, y: number, title: string, sub: string): void {
    this.el.replaceChildren(h('div.name', null, title), h('div.sub', null, sub));
    this.el.classList.add('on');
    const r = this.el.getBoundingClientRect();
    let left = x + 16;
    let top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 16;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    this.el.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }

  hide(): void {
    this.el.classList.remove('on');
  }
}

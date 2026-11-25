import { h } from '../dom';

/** "ESTABLISHING LINK…" overlay shown while data loads and the globe builds (≤ ~1s, skippable). */
export class BootScreen {
  readonly el: HTMLDivElement;
  private bar: HTMLElement;
  private pct: HTMLElement;
  private status: HTMLElement;
  private finished = false;

  constructor(skip: boolean) {
    this.bar = h('i');
    this.pct = h('span', null, '00%');
    this.status = h('span', null, 'ESTABLISHING LINK…');
    this.el = h(
      'div.boot',
      { role: 'status', 'aria-live': 'polite' },
      h(
        'div.boot-inner',
        null,
        h('div.brand', null, h('i'), 'EXPOSE'),
        h('div.boot-line', null, this.status, this.pct),
        h('div.boot-bar', null, this.bar),
        h('span.eyebrow.boot-skip', null, 'Press any key to skip'),
      ),
    );
    if (skip) this.el.classList.add('done');
    const done = () => this.done();
    this.el.addEventListener('click', done);
    window.addEventListener('keydown', done, { once: true });
  }

  progress(p: number, label?: string): void {
    const v = Math.max(0, Math.min(1, p));
    this.bar.style.transform = `scaleX(${v})`;
    this.pct.textContent = `${String(Math.round(v * 100)).padStart(2, '0')}%`;
    if (label) this.status.textContent = label;
  }

  done(): void {
    if (this.finished) return;
    this.finished = true;
    this.el.classList.add('done');
    setTimeout(() => this.el.remove(), 500);
  }
}

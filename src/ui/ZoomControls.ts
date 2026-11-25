import { h, icon, ICONS } from '../dom';

/** On-screen zoom in / out / reset view — for touch users and mice without a wheel. */
export function ZoomControls(p: { zoom(f: number): void; reset(): void }): HTMLDivElement {
  const btn = (label: string, ico: string, fn: () => void) =>
    h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ico, 16));
  return h(
    'div.zoom-ctrl',
    { role: 'group', 'aria-label': 'Globe view' },
    btn('Zoom in', ICONS.plus, () => p.zoom(2)),
    btn('Zoom out', ICONS.minus, () => p.zoom(1 / 2)),
    btn('Reset view', ICONS.reset, p.reset),
  );
}

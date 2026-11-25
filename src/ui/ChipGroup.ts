import { h } from '../dom';

export interface ChipItem<T extends string> {
  id: T;
  label: string;
  /** leading glyph (e.g. a KindIcon); when absent the chip shows its colour bar (`token`) */
  icon?: Element;
  /** CSS custom property with the chip colour, e.g. "--r-own" */
  token?: string;
  count?: number;
}

export interface ChipGroupProps<T extends string> {
  label: string;
  /** accessible name of the group */
  ariaLabel: string;
  items: ChipItem<T>[];
  isOn(id: T): boolean;
  toggle(id: T): void;
  /** show only this one */
  solo(id: T): void;
  setAll(on: boolean): void;
}

export interface ChipGroup {
  el: HTMLDivElement;
  sync(): void;
}

const LONG_PRESS_MS = 480;

/**
 * A labelled group of multi-toggle chips (the shared component for entity-type and
 * connection-type filters). Click toggles; double-click or long-press shows only that chip;
 * "All" / "None" reset the group.
 */
export function ChipGroup<T extends string>(p: ChipGroupProps<T>): ChipGroup {
  const chips = p.items.map((it) => {
    let timer = 0;
    let longPressed = false;
    const chip = h(
      `button.chip${it.icon ? '.with-icon' : ''}`,
      {
        type: 'button',
        'aria-pressed': 'true',
        style: it.token ? `--c: var(${it.token})` : null,
        title: `${it.label} — click to show/hide · double-click or long-press to show only this`,
        onclick: () => {
          if (longPressed) {
            longPressed = false;
            return;
          }
          p.toggle(it.id);
        },
        ondblclick: (e: Event) => {
          e.preventDefault();
          p.solo(it.id);
        },
        onpointerdown: (e: Event) => {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          longPressed = false;
          clearTimeout(timer);
          timer = window.setTimeout(() => {
            longPressed = true;
            navigator.vibrate?.(12);
            p.solo(it.id);
          }, LONG_PRESS_MS);
        },
        onpointerup: () => clearTimeout(timer),
        onpointercancel: () => clearTimeout(timer),
        onpointerleave: () => clearTimeout(timer),
        oncontextmenu: (e: Event) => {
          // long-press on touch would otherwise open the context menu
          if (longPressed || timer) e.preventDefault();
        },
      },
      it.icon ?? null,
      h('span.lbl', null, it.label),
      it.count !== undefined ? h('span.count', null, it.count.toLocaleString('en-US')) : null,
    );
    return chip;
  });
  const all = h('button.text-btn', { type: 'button', onclick: () => p.setAll(true) }, 'All');
  const none = h('button.text-btn', { type: 'button', onclick: () => p.setAll(false) }, 'None');
  const el = h(
    'div.chip-group',
    { role: 'group', 'aria-label': p.ariaLabel },
    h('div.chip-group-h', null, h('span.eyebrow', null, p.label), h('span.chip-group-actions', null, all, none)),
    h('div.chip-row', null, chips),
  );
  const sync = () => {
    let on = 0;
    p.items.forEach((it, i) => {
      const v = p.isOn(it.id);
      on += Number(v);
      chips[i].setAttribute('aria-pressed', String(v));
    });
    all.disabled = on === p.items.length;
    none.disabled = on === 0;
  };
  sync();
  return { el, sync };
}

import { Color } from 'three';
import type { LinkCategory } from './types';
import { CATEGORIES } from './config';

/** Colours for the WebGL scene, read once from the CSS tokens so CSS stays the single source of truth. */
export interface Theme {
  ink: Color;
  muted: Color;
  signal: Color;
  dot: Color;
  atm: Color;
  atmAlpha: number;
  discA: Color;
  discB: Color;
  category: Record<LinkCategory, Color>;
}

export function readTheme(el: Element = document.documentElement): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const rgb = (n: string, fallback: string) => {
    const s = v(n);
    return new Color(s ? `rgb(${s})` : fallback);
  };
  const col = (n: string, fallback: string) => new Color(v(n) || fallback);
  const category = {} as Record<LinkCategory, Color>;
  for (const c of CATEGORIES) category[c.id] = col(c.token, '#ffffff');
  return {
    ink: col('--ink', '#ededf0'),
    muted: col('--muted', '#7c7c85'),
    signal: col('--signal', '#ff3b30'),
    dot: rgb('--globe-dot', '#ebebf5'),
    atm: rgb('--globe-atm', '#ffffff'),
    atmAlpha: parseFloat(v('--globe-atm-a')) || 0.07,
    discA: col('--globe-disc-a', '#0d0d10'),
    discB: col('--globe-disc-b', '#000000'),
    category,
  };
}

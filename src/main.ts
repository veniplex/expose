import '@fontsource/oxanium/500.css';
import '@fontsource/oxanium/600.css';
import '@fontsource/oxanium/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

import { loadGraph, type GraphIndex } from './data';
import { Store } from './store';
import { readTheme } from './theme';
import { h, isCompact, reducedMotion } from './dom';
import { KIND_LABEL } from './config';
import { plural } from './format';
import { Globe } from './globe/Globe';
import { SearchBox } from './ui/SearchBox';
import { StatBar } from './ui/StatBar';
import { FilterChips } from './ui/FilterChips';
import { Dossier } from './ui/Dossier';
import { Tooltip } from './ui/Tooltip';
import { AboutModal } from './ui/AboutModal';
import { BootScreen } from './ui/BootScreen';
import { BottomSheet } from './ui/BottomSheet';
import { ZoomControls } from './ui/ZoomControls';

const root = document.getElementById('app')!;
const reduced = reducedMotion();
const boot = new BootScreen(reduced);
document.body.appendChild(boot.el);
const bootStart = performance.now();

async function main(): Promise<void> {
  // animate the bar a little ahead of the real work so it reads as one smooth motion
  boot.progress(0.08);
  let index: GraphIndex;
  try {
    index = await loadGraph((p) => boot.progress(p * 0.8, 'ESTABLISHING LINK…'));
  } catch (err) {
    boot.done();
    root.replaceChildren(
      h('div.fallback.panel', null, h('span.eyebrow', null, 'Signal lost'), h('p', null, 'The dataset could not be loaded. Please try again later.')),
    );
    console.error(err);
    return;
  }
  boot.progress(0.85, 'DECRYPTING DOSSIERS…');
  mount(index);
  boot.progress(1, 'LINK ESTABLISHED');
  // keep the boot moment brief: at most ~1s total, never less than a beat
  const wait = reduced ? 0 : Math.max(0, Math.min(350, 700 - (performance.now() - bootStart)));
  setTimeout(() => boot.done(), wait);
}

function mount(index: GraphIndex): void {
  const store = new Store();
  const about = new AboutModal();
  const tooltip = new Tooltip();
  const stage = h('div.stage', { id: 'stage' });
  const search = new SearchBox(index, (id) => store.select(id));
  const header = h(
    'header.top',
    null,
    h('a.brand', { href: '#/', 'aria-label': 'EXPOSE — home' }, h('i'), 'EXPOSE', h('small', null, 'who is connected to whom')),
    search.el,
    StatBar(index),
    h('button.chip.about-btn', { type: 'button', onclick: () => about.open(), style: '--c: var(--signal)' }, 'About'),
  );
  const filters = FilterChips(store);
  const dossier = new Dossier(index, store, { openAbout: () => about.open() });
  const hint = h('div.hint', { 'aria-hidden': 'true' }, 'Drag to rotate · scroll to zoom · click a marker');

  let globe: Globe | null = null;
  const zoom = ZoomControls({ zoom: (f) => globe?.zoomBy(f), reset: () => globe?.resetView() });

  root.replaceChildren(stage, header, filters, hint, zoom, dossier.el, tooltip.el, about.el);

  // ---- bottom sheet (compact layout) ----
  const sheet = new BottomSheet(
    root,
    dossier.el,
    dossier.grip,
    () => dossier.peekHeight(),
    () => header.getBoundingClientRect().bottom + 4,
  );

  // ---- globe ----
  try {
    globe = new Globe(stage, index, store, readTheme(), {
      hover: (id, x, y) => {
        store.set({ hoverEntity: id });
        if (!id) return tooltip.hide();
        const e = index.byId.get(id)!;
        const r = stage.getBoundingClientRect();
        tooltip.show(
          x + r.left,
          y + r.top,
          e.name,
          `${KIND_LABEL[e.kind] ?? e.kind}${e.place ? ' · ' + e.place : ''} · ${plural(index.degree.get(id) ?? 0, 'connection')}`,
        );
      },
      pick: (id) => {
        tooltip.hide();
        store.select(id);
      },
    });
  } catch (err) {
    console.warn('WebGL unavailable', err);
    zoom.remove();
    hint.remove();
    stage.append(
      h(
        'div.fallback.panel.bracket',
        { role: 'note' },
        h('span.eyebrow', null, '3D view unavailable'),
        h(
          'p',
          null,
          'Your browser could not start WebGL, so the globe is switched off. Everything is still reachable: use the search box and the lists in the dossier.',
        ),
      ),
    );
  }

  // ---- layout → globe insets ----
  const measure = () => {
    root.style.setProperty('--top-h', `${Math.round(header.getBoundingClientRect().bottom)}px`);
    if (!globe) return;
    if (isCompact()) {
      const top = filters.getBoundingClientRect().bottom;
      globe.setInsets({ top: top + 4, right: 0, bottom: sheet.visibleHeight, left: 0 });
    } else {
      const d = dossier.el.getBoundingClientRect();
      globe.setInsets({ top: 56, right: window.innerWidth - d.left + 8, bottom: 24, left: 0 });
    }
  };
  sheet.onChange(() => measure());
  new ResizeObserver(() => measure()).observe(root);
  measure();
  globe?.setInsets({ ...{ top: 0, right: 0, bottom: 0, left: 0 } }, false);
  measure();

  // ---- routing / selection side-effects ----
  store.subscribe((s, ch) => {
    if (ch.has('selected')) {
      document.title = s.selected ? `${index.byId.get(s.selected)?.name} — EXPOSE` : 'EXPOSE — who is connected to whom';
      dossier.resetScroll();
      if (isCompact()) sheet.setSnap(s.selected ? (sheet.snap === 'full' ? 'full' : 'half') : 'peek');
    }
  });
  store.initRouting((id) => index.byId.has(id));
  if (isCompact()) sheet.setSnap(store.state.selected ? 'half' : 'peek', false);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || about.el.open) return;
    const t = e.target as HTMLElement;
    if (t.closest('input')) return;
    if (store.state.expanded) store.set({ expanded: null });
    else if (store.state.selected) store.select(null);
  });

  // tiny read-only hook for automated UI tests (no effect on the app)
  (window as unknown as { __expose: unknown }).__expose = {
    screenOf: (id: string) => globe?.screenOf(id) ?? null,
    selected: () => store.state.selected,
    sheet: () => sheet.snap,
  };

  requestAnimationFrame(() => {
    stage.classList.add('ready');
    globe?.start();
  });
}

void main();

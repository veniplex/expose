import { kindMeta } from '../kinds';

const NS = 'http://www.w3.org/2000/svg';

/**
 * The entity-kind glyph as inline SVG (filled with currentColor). Same path data as the globe
 * markers (see src/kinds.ts), so search results, dossier, lists and filter chips match the map.
 */
export function KindIcon(kind: string, size = 10): SVGSVGElement {
  const k = kindMeta(kind);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'kind-ico');
  svg.setAttribute('viewBox', '-12 -12 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.kind = k.id;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', k.path);
  path.setAttribute('fill-rule', 'evenodd');
  svg.appendChild(path);
  return svg;
}

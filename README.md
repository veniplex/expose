# EXPOSE — who is connected to whom

An interactive 3D globe that shows how powerful people, companies, funds, parties, governments,
media and other organisations are connected — and why. Every connection links to the public
sources it rests on (Wikidata, Wikipedia, GLEIF, LittleSis and cited publications).

A connection is a documented relationship, not an accusation.

## Local development

Requires Node 22.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/
```

The app is a static Vite + TypeScript + three.js site with no UI framework. It loads
`./data/graph.json` at runtime (relative URL, so it works under any sub-path) and falls back to
the small fixture `public/data/graph.sample.json` when that file is missing.

- `src/types.ts` — the data contract shared with the pipeline
- `src/data.ts`, `src/store.ts`, `src/search.ts`, `src/filters.ts` — loading/indexing, state + URL hash
  (`#/e/<id>?types=…&links=…&past=0`, filters also kept in localStorage), search, filter rules
- `src/kinds.ts` — the one definition of the seven entity kinds and their symbols
  (● person, ■ company, ◆ fund, ▲ party, ★ government, ◎ media, ✚ organisation). The same SVG paths
  drive the UI icon (`src/ui/KindIcon.ts`) and the globe's marker atlas (`src/globe/glyphAtlas.ts`)
- `src/globe/` — WebGL globe (land dots, borders, markers, arcs, labels, input)
- `src/ui/` — reusable UI components; all styling comes from `src/styles/tokens.css`
- `tools/gen-land.mjs` — build-time generator of the overview land dot matrix (`world-atlas` + `d3-geo`);
  its output `src/globe/land-dots.gen.ts` is committed. Run `node tools/gen-land.mjs --force` to regenerate.
- `tools/gen-geo.mjs` — build-time generator of the close-zoom geography from `world-atlas` 50m:
  country borders + coastlines (`src/globe/gen/borders.bin`, quantised varint polylines, ~175 kB),
  a 4096×2048 land mask for the procedural fine dot matrix (`land-mask.bin`, run-length encoded,
  ~80 kB) and country label anchors (`countries.json`). They are committed and lazy-loaded as
  separate assets after the globe is up. Run `node tools/gen-geo.mjs --force` to regenerate.

### Globe zoom and level of detail

The camera zooms from the whole-globe overview down to about 1.034 globe radii (≈ 220 km above
the surface, one metro area fills the view). As you zoom in, a finer procedural land dot matrix,
country borders, coastlines and country names fade in; co-located markers spread apart until each
one is separately tappable, and more labels appear, most influential first.

### Influence

`Entity.influence` (0..1) comes from the data pipeline: it is computed from notability, wealth /
size and connectedness — an approximation, not a judgement. It sets the marker size (diameter
5–18 px, growing slightly faster than linearly), label priority and weight, the emphasis of the
ambient connection web and the default order of lists. Old data without the field falls back to
the log-normalised number of connections (shown as “est.” in the dossier).

## Data pipeline

```sh
npm run data       # node scripts/build-data.mjs -> public/data/graph.json
```

The script reads `data/seed.json` (the list of entities, by English Wikipedia title) and
`data/curated.json` (hand-written connections), pulls Wikipedia and Wikidata, and writes
`public/data/graph.json`. It has no dependencies. If the network fails, the committed
`graph.json` is kept.

## Adding a curated connection

Add an entry to `data/curated.json`:

```json
{
  "a": "Microsoft",
  "b": "OpenAI",
  "category": "investment",
  "label": "Investor",
  "inverseLabel": "Backed by",
  "since": 2019,
  "note": "One or two neutral sentences explaining the connection.",
  "sources": [
    { "publisher": "Wikipedia", "title": "OpenAI", "url": "https://en.wikipedia.org/wiki/OpenAI" }
  ]
}
```

`a` and `b` are Wikipedia titles of entities listed in `data/seed.json`; `category` is one of
`ownership`, `leadership`, `founder`, `investment`, `politics`; `label` reads from `a`'s side,
`inverseLabel` from `b`'s side. At least one public source is required. Run `npm run data`, check the
result with `npm run dev`, and open a pull request.

Found an error? Please open an issue with the entity, what is wrong and a source for the correct
information.

## Deployment

The site is deployed with Vercel, which builds every push to `main` (production) and every
pull request (preview). The build uses the committed `public/data/graph.json`; to refresh the
data, run `npm run data` locally and commit the result.

## Sources and licences

- [Wikidata](https://www.wikidata.org/) — CC0.
- [Wikipedia](https://www.wikipedia.org/) / Wikimedia Commons — text under CC BY-SA 4.0, images under
  their respective file licences.
- [GLEIF](https://www.gleif.org/) Legal Entity Identifier data (corporate parent / subsidiary
  relations) — CC0.
- [LittleSis](https://littlesis.org/) — CC BY-SA 4.0 (© LittleSis contributors).
- Curated entries cite their own public sources (e.g. SEC EDGAR filings, reputable reporting).
- Map geometry: Natural Earth (public domain) via [world-atlas](https://github.com/topojson/world-atlas).

Imported rows are credited in the expanded dossier row (“via Wikidata”, “via LittleSis”, “via GLEIF”,
“via SEC EDGAR”).

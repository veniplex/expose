# EXPOSE — who is connected to whom

An interactive 3D globe that shows how powerful people, companies, funds and governments are
connected — and why. Every connection links to the public sources it rests on
(Wikidata, Wikipedia and cited publications).

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
- `src/data.ts`, `src/store.ts`, `src/search.ts` — loading/indexing, state + URL hash (`#/e/<id>`), search
- `src/globe/` — WebGL globe (land dots, markers, arcs, labels, input)
- `src/ui/` — reusable UI components; all styling comes from `src/styles/tokens.css`
- `tools/gen-land.mjs` — build-time generator of the land dot matrix (`world-atlas` + `d3-geo`);
  its output `src/globe/land-dots.gen.ts` is committed. Run `node tools/gen-land.mjs --force` to regenerate.

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
pull request (preview). `vercel.json` sets the build command: it refreshes the data from
Wikidata first and falls back to the committed `public/data/graph.json` if that fails.

## Licences

Wikidata content is CC0. Text and images from Wikipedia / Wikimedia Commons are available under
CC BY-SA 4.0 or their respective file licences.

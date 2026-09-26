# Mapimator

A static web app for loading multiple GPX tracks and animating them **simultaneously on a shared clock** over a switchable OpenStreetMap basemap.

Built for comparing repeat runs of the same course: each track's **own first timestamp is its `t0`**, so every marker starts together at the start line, and at elapsed `10:00` you see exactly where each run was ten minutes in. The finished state is deliberately server-free — files are parsed in the browser and never leave the machine.

> **Status: phase 1 of 7 complete.** The map, the basemap switcher, and the application shell work today. GPX upload, the track legend, the animation, and the chart are planned but **not implemented yet** — the dropzone, playback controls, and chart are visible placeholders. See [Roadmap](#roadmap).

## Features

Working now:

- **Five OpenStreetMap basemaps** — Liberty, Positron, Bright, Fiord, Dark — served as vector tiles by [OpenFreeMap](https://openfreemap.org). No API key, no signup, no rate limit.
- **Seamless background switching** — the map is never re-created, and position, zoom, bearing, and pitch are carried across every switch. Application overlays are re-attached automatically, so a full cycle through all five basemaps is lossless.
- **Persisted selection** — your basemap choice is remembered in `localStorage` across reloads.
- **Map navigation** via mouse, touch, and keyboard, with zoom and attribution controls, in a responsive dark shell.

## Requirements

- **Node.js `^20.19.0` or `>=22.12.0`** (required by Vite 8)
- **A browser with WebGL2.** MapLibre GL JS v6 dropped WebGL1; without WebGL2 the `Map` constructor throws a `GPUInitializationError` and you get a blank grey map. Current Chrome, Firefox, Edge, and Safari 15+ all qualify.

## Getting started

```bash
npm install       # install dependencies
npm run dev       # start the dev server on http://localhost:5173
```

Other commands:

| Command                | What it does                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `npm run dev`          | Vite dev server with hot module replacement                    |
| `npm run typecheck`    | `tsc --noEmit` — types only, no emit                           |
| `npm run build`        | Typecheck, then build the static site into `dist/`             |
| `npm run preview`      | Serve the built `dist/` locally to verify the production build |
| `npm run format`       | Reformat everything with Prettier                              |
| `npm run format:check` | Verify formatting without writing (useful in CI)               |
| `npm test`             | Unit tests (Vitest)                                            |
| `npm run test:watch`   | Unit tests in watch mode                                       |
| `npm run test:e2e`     | End-to-end checks against the built app (Playwright)           |
| `npm run test:all`     | Typecheck → unit tests → build → end-to-end                    |

`npm run build` writes a fully static bundle to `dist/`. There is no server component, no database, and no API of your own to deploy.

## Using the app

1. `npm run dev` and open the printed URL.
2. Pick a basemap from the buttons in the top-right. Try **Dark** or **Fiord** for a low-glare basemap, **Positron** for maximum contrast against track colours.
3. Pan and zoom as usual. The attribution line at the bottom-left credits the data source and must stay visible.

The dropzone, the track list, the chart, and the playback bar are placeholders in this phase. Each one is labelled with the phase that will make it work, so the interface does not advertise anything that does not exist yet.

## Testing

There are two layers, and they answer different questions.

**Unit tests** (`npm test`) cover the logic that has no business being tested through a browser: here, the basemap table, the id validation, and the `localStorage` read/write fallback. They run in a Node environment with no DOM, so they are fast — the whole suite is well under a second.

**End-to-end checks** (`npm run test:e2e`) drive the real built app in a real browser. They verify the things only a browser can: that the basemap styles really paint differently, that the camera survives a switch, that the application overlays are re-attached after `setStyle()` drops them, and that a choice survives a reload. The suite serves `dist/` through `vite preview` on a free port, writes any GPX fixtures to the OS temp directory, and takes no arguments.

The E2E suite uses the Chromium that Playwright manages, not your system browser, so results do not depend on what you happen to have installed:

```bash
npx playwright install chromium   # once
npm run test:e2e
```

`e2e/run.mjs` discovers every `e2e/*.spec.mjs` and runs it against a fresh browser context, so adding a spec needs no edit to the runner. The checks assert real values — exact layer counts, expected mean luma per style, exact pixel-difference thresholds — rather than merely asserting that nothing threw. Screenshots from the runs land in the system temp directory for inspection when a check fails.

`npm run test:all` runs the whole chain in the order you would want it: types, then unit tests, then a build, then the end-to-end checks against that build.

## Deploying

`dist/` is a plain static directory — host it anywhere: GitHub Pages, Cloudflare Pages, Netlify, S3, nginx, or a local file server.

`vite.config.ts` sets `base: './'`, so all asset URLs are **relative**. The build therefore works unchanged from a domain root _or_ a subpath, which is what GitHub Pages project sites (`https://user.github.io/mapimator/`) need. No rewrite rules required.

Two deployment notes:

- **Serve over HTTPS** (or `localhost`). The MapLibre worker is bundled and served from your own origin, so a Content Security Policy only needs `worker-src 'self'` — no `blob:` exception is required, which is only needed when loading MapLibre from a CDN.
- A single-page app needs no history fallback; `index.html` at the root is enough.

## Basemaps and attribution

All five styles are vector styles from OpenFreeMap, built on OpenMapTiles and OpenStreetMap data. OpenStreetMap data is licensed **ODbL**, so crediting it is a licence requirement, not a courtesy — the attribution is rendered by MapLibre's `AttributionControl` and is read from the tileset's TileJSON, so it stays correct if the upstream data changes.

Adding or removing a basemap means editing one array in `src/map/basemaps.ts`. Each entry is just an `{ id, label, styleUrl }`, so any MapLibre style URL works, not only OpenFreeMap's.

## Project structure

```
index.html                    application shell markup
vite.config.ts                build config (relative base, es2022, ES workers)
vitest.config.ts              unit test config (src/**/*.test.ts, Node env)
tsconfig.json                 strict TypeScript, bundler module resolution
.prettierrc                   formatter settings
.editorconfig                 indentation rules for editors that support it
public/favicon.svg
src/
  main.ts                     bootstrap and wiring
  style.css                   dark UI shell
  types.ts                    Track, SamplePoint, BasemapDef, TrackState
  map/
    basemaps.ts               the five styles + localStorage persistence
    basemaps.test.ts          style table, id validation, storage fallback
    mapView.ts                MapLibre setup, style switching, layer attach
  ui/
    basemapSwitcher.ts        basemap buttons
e2e/
  run.mjs                     orchestrator: build check, server, specs, summary
  harness.mjs                 suite reporter, vite preview, bundled Chromium
  make-fixtures.mjs           GPX fixtures, written only when a spec asks for them
  basemap.spec.mjs            shell, basemap switching, overlays, persistence
```

`e2e/*.spec.mjs` files are picked up automatically; a spec may export a `fixtures` list of GPX files it loads, and only those are written to disk.

## Code style

Formatting is handled by **Prettier** (`.prettierrc`), not by hand:

- **4 spaces** for TypeScript, CSS, HTML, and SVG
- **2 spaces** for `.json` files, matching the convention npm itself uses — so `package-lock.json` stays exactly as npm generates it and does not churn on every install
- Single quotes, semicolons, 100-column line width

Run `npm run format` to apply it, or `npm run format:check` to verify without writing. `.editorconfig` mirrors the same rules, so editors that support it (VS Code, JetBrains, and others) indent new files correctly even before Prettier has run.

Two-space indentation is the more common default in the wider TypeScript ecosystem; four is equally common and is what the TypeScript compiler's own codebase uses. Neither is more correct — the point is that the choice is recorded in configuration so every contributor and every editor agrees automatically.

Track data is designed to be modelled as **typed arrays** (`Float64Array` for coordinates and times, `Float32Array` for elevation and distance) rather than objects, so a 200,000-point track costs a few megabytes instead of hundreds, and the parse worker can transfer the buffers to the main thread without copying. The shapes are declared in `src/types.ts`; phase 2 populates them.

## Roadmap

| Phase                                                                      | Status   |
| -------------------------------------------------------------------------- | -------- |
| 1. Shell, MapLibre setup, basemap switching                                | **Done** |
| 2. GPX parser, Web Worker, dropzone, legend, static polylines              | Planned  |
| 3. Shared clock, interpolation, simultaneous marker animation              | Planned  |
| 4. Timeline scrubbing, speed multiplier, keyboard transport, live readouts | Planned  |
| 5. Chart panel (elevation/speed, time/distance axis)                       | Planned  |
| 6. Legend toggles, follow camera, rendering polish                         | Planned  |
| 7. Single-file build for easy sharing                                      | Planned  |

Planned behaviours, for reference:

- Each track is parsed in a **Web Worker** by a single-pass scanner, so large files never block the UI.
- Time gaps over 60 s inside one track are recorded as **segment breaks**, so the renderer dashes them and the marker does not glide across a straight line while a watch was paused.
- Playback offers 1×–300× speed, so a one-hour run finishes in seconds.
- A track that runs out of points freezes at its last position and dims.

## Troubleshooting

**Blank grey map, and the console shows `Worker failed to load`.**
MapLibre v6 ships ESM only, and its worker must be registered explicitly when bundled. `src/map/mapView.ts` does this with `setWorkerUrl()` and a `?worker&url` import. If you see this error, check that import survived — and keep `?worker&url` rather than plain `?url`, because the dist worker imports a sibling chunk that `?url` does not emit.

**Blank map, no errors.**
Almost always missing WebGL2. Check `chrome://gpu` or the browser's WebGL report.

**Map renders but labels are missing or blurry.**
The OpenFreeMap tileset goes to zoom 14, so zooming past z14 overzooms the maximum-zoom tiles. Zoom is allowed to 19 for inspection; expect softness beyond 14.

**`localStorage` selection is not remembered.**
Some privacy modes block storage. The app catches this and falls back to the default basemap rather than failing.

## License

Application code is released under the [MIT License](LICENSE). Map data is © OpenStreetMap contributors, licensed ODbL. Basemap tiles are provided by [OpenFreeMap](https://openfreemap.org), built on OpenMapTiles. Both are credited automatically in the map's attribution control and that credit must remain visible — the MIT license covers this repository's code only, not the map data it displays.

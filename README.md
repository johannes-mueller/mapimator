# Mapimator

A static web app for loading multiple GPX tracks and animating them **simultaneously on a shared clock** over a switchable OpenStreetMap basemap.

Built for comparing repeat runs of the same course: each track's **own first timestamp is its `t0`**, so every marker starts together at the start line, and at elapsed `10:00` you see exactly where each run was ten minutes in. The finished state is deliberately server-free — files are parsed in the browser and never leave the machine.

> **Status: phases 1–4 of 7 complete.** Loading GPX files, the track legend, and driving a run with simultaneous markers on a shared clock all work today. The chart panel, legend toggles, follow camera, and single-file sharing are planned but **not implemented yet**. See [Roadmap](#roadmap).

## Features

Working now:

- **Five OpenStreetMap basemaps** — Liberty, Positron, Bright, Fiord, Dark — served as vector tiles by [OpenFreeMap](https://openfreemap.org). No API key, no signup, no rate limit.
- **Seamless background switching** — the map is never re-created, and position, zoom, bearing, and pitch are carried across every switch. Application overlays are re-attached automatically, so a full cycle through all five basemaps is lossless.
- **Persisted selection** — your basemap choice is remembered in `localStorage` across reloads.
- **Map navigation** via mouse, touch, and keyboard, with zoom and attribution controls, in a responsive dark shell.
- **GPX loading by drag-and-drop or file picker**, parsed in a Web Worker so a 6 MB file never freezes the page. Timestamped and untimestamped files both work; names survive entities, `CDATA`, and windows-1252 exports.
- **A track legend** with per-track colour, point count, distance, and duration, each removable.
- **Static polylines** drawn as a `MultiLineString`, so a recorded pause is left blank rather than joined by a straight line.
- **Simultaneous animation** on one shared clock — press play and every track advances together, each measured from its own `t0`. Tracks recorded hours apart start side by side and the legend records how far apart they were recorded; a track that runs out of points freezes and dims. See [Playback](#playback).
- **Transport you can actually operate with** — scrub the timeline and the map follows the pointer, run at 1× to 300×, and drive it all from the keyboard. Per-track readouts in the legend show where each ride has got, counting from its own start.

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
2. Drop one or more `.gpx` files onto the panel at the top-left, or click it to browse. Several files at once is fine, and one file containing several `<trk>` elements is split into several tracks.
3. The map fits itself to the first track you load. The list below the dropzone shows each track's colour, name, point count, distance, and duration; the `×` button removes it.
4. Pick a basemap from the buttons in the top-right. Try **Dark** or **Fiord** for a low-glare basemap, **Positron** for maximum contrast against track colours.
5. Pan and zoom as usual. The attribution line at the bottom-left credits the data source and must stay visible.

The chart and the playback bar are still placeholders, each labelled with the phase that will make it work, so the interface does not advertise anything that does not exist yet.

## Testing

There are two layers, and they answer different questions.

**Unit tests** (`npm test`) cover the logic that has no business being tested through a browser: the basemap table and `localStorage` fallback, the GPX scanner, the decoding fallback, the store's subscriptions, segment splitting, the E2E harness itself, and formatting. They run in a Node environment with no DOM and need no network, so they are fast — the whole suite takes under a second.

**End-to-end checks** (`npm run test:e2e`) drive the real built app in a real browser. They verify the things only a browser can: that the basemap styles really paint differently, that overlay layers survive a `setStyle()` switch, that a polyline and a moving marker actually change pixels on the map, that playback does not hijack the camera, that a recorded pause parks the marker instead of gliding it across the gap, that `dist/` really works from a subpath, and that a 60,000-point file never blocks the main thread. The suite serves `dist/` on a free port, writes its GPX fixtures to the OS temp directory, and takes no arguments.

The E2E suite needs **live network access to `tiles.openfreemap.org`** — it renders the real styles and the real tiles, because a recorded snapshot would test the recording rather than the app. It preflights that endpoint before launching a browser, so a connectivity problem reports itself as an environment problem instead of a 30-second timeout:

```bash
npx playwright install chromium   # once
npm run test:e2e
```

The e2e checks assert real values — exact point counts, exact segment-break indices, exact decoded names, expected mean luma per basemap style, exact asset-URL shapes — rather than merely asserting that nothing threw. Screenshots from the runs land in the system temp directory for inspection when a check fails.

`npm run test:all` runs the whole chain in the order you would want it: types, then unit tests, then a build, then the end-to-end checks against that build.

Contributors should read [`AGENTS.md`](AGENTS.md): every claim of correctness belongs in this suite, written with the feature rather than after it, and no behaviour is done until a check for it exists and passes.

## How GPX files are read

Parsing happens in a **Web Worker** (`src/gpx/parseWorker.ts`) so a large file never freezes the UI, and the parsed typed arrays are **transferred** rather than copied back to the main thread. A 6 MB file with 60,000 points parses in roughly 0.4 s with the main thread never blocked for more than about 60 ms.

`src/gpx/parseGpx.ts` is a hand-written single-pass scanner rather than a general XML parser. GPX has a rigid, well-known shape, and the scanner is what makes the speed numbers above possible. The trade-off is deliberate and worth stating: a hand-rolled scanner is not as forgiving as a spec-compliant XML parser for pathological input. What it _does_ handle, because real exports contain all of it:

- single- or double-quoted attributes, and arbitrary whitespace (`<trkpt   lat = '47.0'`)
- `<ele>` and the older `<elevation>` spelling
- `<name>` containing XML entities and `CDATA` sections
- files declared as UTF-8 that are actually windows-1252 (the strict UTF-8 decode fails, so the file is re-decoded as Latin-1)
- timestamps with `Z`, with a numeric offset, with fractional seconds, or missing entirely

A file with no `<time>` elements is still usable: timestamps are synthesised from distance at an assumed walking pace, so the track can be animated in later phases. Points missing only some timestamps inherit the previous point's, so a track is never non-monotonic because a few points went unlogged.

**Pauses are not drawn as straight lines.** A gap longer than 60 s inside one track, or a new `<trkseg>`, is recorded as a _segment break_ and the track is rendered as a `MultiLineString`. The same break parks the animation marker at the end of the segment for the length of the gap, so a watch paused for lunch does not send a marker gliding across open country. See [Playback](#playback).

## Deploying

`dist/` is a plain static directory — host it anywhere: GitHub Pages, Cloudflare Pages, Netlify, S3, nginx, or a local file server.

`vite.config.ts` sets `base: './'`, so all asset URLs are **relative**. The build therefore works unchanged from a domain root _or_ a subpath, which is what GitHub Pages project sites (`https://user.github.io/mapimator/`) need. No rewrite rules required. This is checked, not just asserted: `e2e/subpath.spec.mjs` serves the built `dist/` under a `/mapimator/` prefix with a server that refuses to answer outside it, so a regression to an absolute `base` turns every asset into a 404.

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
vitest.config.ts              unit test config (src/**, e2e/harness.test.mjs, Node env)
tsconfig.json                 strict TypeScript, bundler module resolution
AGENTS.md                     working agreements, including the verification rule
.prettierrc                   formatter settings
.editorconfig                 indentation rules for editors that support it
public/favicon.svg
src/
  main.ts                     bootstrap and wiring
  style.css                   dark UI shell
  types.ts                    Track, SamplePoint, BasemapDef, TrackState
  format.ts                   distance / duration / count formatting
  gpx/
    parseGpx.ts               single-pass GPX scanner
    parseGpx.test.ts          scanner, decoding, and timestamp unit tests
    parseWorker.ts            worker entry
    parseClient.ts            main-thread handle, transferable buffers
    protocol.ts               worker message types
  tracks/
    trackStore.ts             track state, ids, colours, notifications
    trackStore.test.ts
    palette.ts                the twelve track colours
    lineFeatures.ts           Track -> GeoJSON MultiLineString
    lineFeatures.test.ts
  playback/
    clock.ts                  the shared clock, speed, seek, total span
    clock.test.ts
    interpolate.ts            sample lookup, gap parking, distance at a position
    interpolate.test.ts
    markerFeatures.ts         TrackState + elapsed time -> playhead markers
    markerFeatures.test.ts
    readout.ts                per-track elapsed time and distance covered
    readout.test.ts
  map/
    basemaps.ts               the five styles + localStorage persistence
    basemaps.test.ts          style table, id validation, storage fallback
    mapView.ts                MapLibre setup and style switching
    trackLayers.ts            overlay sources, layers, rendering, fitBounds
  ui/
    basemapSwitcher.ts        basemap buttons
    dropzone.ts               drag-and-drop, file picker, parse status
    legend.ts                 track list
    transport.ts              play, scrub, speed, keys, readout, frame loop
    transport.test.ts
    transportKeys.ts          key bindings and the focused-control filter
    transportKeys.test.ts
  format.test.ts
e2e/
  run.mjs                     orchestrator: preflight, server, specs, summary
  harness.mjs                 reporter, pixel helpers, servers, bundled Chromium
  harness.test.mjs            the harness's own logic, under unit test
  make-fixtures.mjs           GPX fixtures, written only when a spec asks for them
  basemap.spec.mjs            shell, basemap switching, overlays, persistence
  subpath.spec.mjs            dist/ served from a subpath, as a project site is
  tracks.spec.mjs             parsing, geometry, gaps, errors, large file
  playback.spec.mjs           the shared clock, markers, play/pause, gap parking
  transport.spec.mjs          scrubbing, speed, keyboard, legend readouts
```

`e2e/*.spec.mjs` files are picked up automatically, so adding a spec needs no edit to the runner. A spec may export a `fixtures` list naming the GPX files it loads; only those are written to disk, so a spec that loads no GPX writes nothing. The fixture directory is emptied before each run, so a file left behind by an earlier run can never stand in for one that has stopped being generated.

## Code style

Formatting is handled by **Prettier** (`.prettierrc`), not by hand:

- **4 spaces** for TypeScript, CSS, HTML, and SVG
- **2 spaces** for `.json` files, matching the convention npm itself uses — so `package-lock.json` stays exactly as npm generates it and does not churn on every install
- Single quotes, semicolons, 100-column line width

Run `npm run format` to apply it, or `npm run format:check` to verify without writing. `.editorconfig` mirrors the same rules, so editors that support it (VS Code, JetBrains, and others) indent new files correctly even before Prettier has run.

Two-space indentation is the more common default in the wider TypeScript ecosystem; four is equally common and is what the TypeScript compiler's own codebase uses. Neither is more correct — the point is that the choice is recorded in configuration so every contributor and every editor agrees automatically.

Track data is designed to be modelled as **typed arrays** (`Float64Array` for coordinates and times, `Float32Array` for elevation and distance) rather than objects, so a 200,000-point track costs a few megabytes instead of hundreds, and the parse worker can transfer the buffers to the main thread without copying. The shapes are declared in `src/types.ts` and populated by the parser.

One consequence worth knowing before editing: `Track.tRel` is in **seconds** while `Track.durationMs` is in **milliseconds**. `src/playback/interpolate.ts` converts once, at the boundary, and `interpolate.test.ts` has a check that fails if that conversion is ever dropped.

## Roadmap

| Phase                                                                      | Status   |
| -------------------------------------------------------------------------- | -------- |
| 1. Shell, MapLibre setup, basemap switching                                | **Done** |
| 2. GPX parser, Web Worker, dropzone, legend, static polylines              | **Done** |
| 3. Shared clock, interpolation, simultaneous marker animation              | **Done** |
| 4. Timeline scrubbing, speed multiplier, keyboard transport, live readouts | **Done** |
| 5. Chart panel (elevation/speed, time/distance axis)                       | Planned  |
| 6. Legend toggles, follow camera, rendering polish                         | Planned  |
| 7. Single-file build for easy sharing                                      | Planned  |

## Playback

Pressing play advances **one shared elapsed-time clock**, and every track is read against it directly. Because each track is measured from its own first point, two rides of the same course recorded hours apart start side by side on the start line and stay side by side: at ten minutes in you are looking at where each ride was ten minutes in. The timestamps are not discarded — the legend says how much later each ride was recorded, relative to the first — they just do not decide what the playhead means. The run lasts as long as the **longest** ride in it, since the gap between two recordings is not part of either. A track that runs out of points freezes on its last position and its line dims, while the others carry on.

A marker inside a **recorded pause** stops at the end of the segment it has just finished and waits there for the length of the gap, then resumes at the first point of the next one. This is the same segment break that leaves the line undrawn across the gap, and it is why a lunch stop does not send a marker gliding across open country. The shared clock keeps counting throughout the gap, so the track is simply _waiting_ rather than being behind: its legend row still shows the distance it had covered when it stopped, and jumps forward the moment it starts again.

### Driving a run

- **Play / pause** with the button, with <kbd>Space</kbd>, or with <kbd>K</kbd>.
- **Scrub** by dragging the timeline. The map follows the pointer rather than jumping on release, and the camera never moves.
- **1× to 300×** from the speed control, so a one-hour ride finishes in seconds. The choice survives pausing, scrubbing and loading more tracks — it is a setting, not a one-off.
- **Step** with <kbd>←</kbd> and <kbd>→</kbd>, five times as far with <kbd>Shift</kbd>, and jump to either end with <kbd>Home</kbd> and <kbd>End</kbd>. The step is a share of the run rather than a fixed number of seconds, so one gesture behaves the same on a four-minute clip and on a thirty-hour ride.
- **Read** each legend row, which counts from that ride's own start: how long it has been going, and how far it has got.

### Notes for whoever edits this

Arrow steps are a percentage of the total on purpose, and the keyboard handler deliberately declines keys that a focused control already handles. Pressing <kbd>Space</kbd> on the focused play button would otherwise toggle twice — once from the click the browser sends, and once from the key. The same goes for the arrows on a focused timeline, which already seek through their own `input` event. Space is the one key taken back from the timeline, because a range does nothing with it and a drag leaves focus there.

Frames stay cheap. The frame loop only runs while playing, redraws come from the clock's change notification rather than the frame callback, DOM writes are skipped when the text has not changed, and the line geometry is rebuilt only when the set of finished tracks actually changes — `buildLineFeatures` walks every sample of every track, and doing that sixty times a second would make a large file unplayable. Playback never moves the camera.

## Troubleshooting

**Blank grey map, and the console shows `Worker failed to load`.**
MapLibre v6 ships ESM only, and its worker must be registered explicitly when bundled. `src/map/mapView.ts` does this with `setWorkerUrl()` and a `?worker&url` import. If you see this error, check that import survived — and keep `?worker&url` rather than plain `?url`, because the dist worker imports a sibling chunk that `?url` does not emit.

**Blank map, no errors.**
Almost always missing WebGL2. Check `chrome://gpu` or the browser's WebGL report.

**Map renders but labels are missing or blurry.**
The OpenFreeMap tileset goes to zoom 14, so zooming past z14 overzooms the maximum-zoom tiles. Zoom is allowed to 19 for inspection; expect softness beyond 14.

**`localStorage` selection is not remembered.**
Some privacy modes block storage. The app catches this and falls back to the default basemap rather than failing.

**A file is rejected with "No track points found".**
The file parsed, but contained no `<trkpt>` — only waypoints or routes, or a route-only export. Mapimator animates recorded tracks, not planned routes. Re-export from your tracking app as a GPX track.

**A dropped file is ignored with no message.**
Only `.gpx` is accepted. An explicit extension is trusted over the browser's MIME label, so a `.txt` or `.tcx` file is refused rather than handed to the parser and reported as an empty track.

**Track names look wrong, or a file fails to parse outright.**
Garbled accented characters usually mean the file is not UTF-8. The decoder retries as windows-1252, which covers most western-European exports, but a file in some other legacy encoding will still be mis-decoded. Re-save as UTF-8 from your tracking app.

**A track is drawn as several disconnected pieces.**
That is the segment-break rule working: a pause longer than 60 s, or a new `<trkseg>`, is left blank rather than joined by a straight line.

## License

Application code is released under the [MIT License](LICENSE). Map data is © OpenStreetMap contributors, licensed ODbL. Basemap tiles are provided by [OpenFreeMap](https://openfreemap.org), built on OpenMapTiles. Both are credited automatically in the map's attribution control and that credit must remain visible — the MIT license covers this repository's code only, not the map data it displays.

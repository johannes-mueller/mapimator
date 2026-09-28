# Mapimator

A static web app for loading multiple GPX runs and animating them **simultaneously on a shared clock** over a switchable OpenStreetMap basemap.

Built for comparing repeat runs of the same course: each run's **own first timestamp is its `t0`**, so every marker starts together at the start line, and at elapsed `10:00` you see exactly where each run was ten minutes in. The app has no backend: your GPX files are parsed in the browser and never uploaded anywhere. The one thing that does leave the machine is a set of small requests to the elevation tile host, to read the ground's height along each route — see [Elevation comes from a model](#elevation-comes-from-a-model).

> **Status: phases 1–5 of 7 complete, and most of phase 6.** Loading GPX files, the run legend, driving a run with simultaneous markers on a shared clock, and the elevation/speed chart all work today. A run can be switched off in the legend, and the camera now follows a played run without being asked. Rendering polish and single-file sharing are planned but **not implemented yet**. A terrain model supplies the elevation, so two runs of one course can be compared even when their recorded altitudes disagree. See [Roadmap](#roadmap).

## Features

Working now:

- **Five OpenStreetMap basemaps** — Liberty, Positron, Bright, Fiord, Dark — served as vector tiles by [OpenFreeMap](https://openfreemap.org). No API key, no signup, no rate limit.
- **Seamless background switching** — the map is never re-created, and position, zoom, bearing, and pitch are carried across every switch. Application overlays are re-attached automatically, so a full cycle through all five basemaps is lossless.
- **Persisted selection** — your basemap choice is remembered in `localStorage` across reloads.
- **Map navigation** via mouse, touch, and keyboard, with zoom and attribution controls, in a responsive dark shell.
- **GPX loading by drag-and-drop or file picker**, parsed in a Web Worker so a 6 MB file never freezes the page. Timestamped and untimestamped files both work; names survive entities, `CDATA`, and windows-1252 exports.
- **A run legend** with per-run colour, point count, distance, and duration. Each row can be **switched off** — the run leaves the map and the chart but stays in the comparison — or removed outright. See [Hiding a run](#hiding-a-run).
- **Static polylines** drawn as a `MultiLineString`, so a recorded pause is left blank rather than joined by a straight line.
- **Simultaneous animation** on one shared clock — press play and every run advances together, each measured from its own `t0`. Runs recorded hours apart start side by side and the legend records how far apart they were recorded; a run that runs out of points freezes and dims. See [Playback](#playback).
- **Transport you can actually operate with** — scrub the timeline and the map follows the pointer, run at 1× to 300×, and drive it all from the keyboard. Per-run readouts in the legend show where each run has got, counting from its own start.
- **An elevation and speed chart** for every loaded run, drawn against distance in each run's own colour, with a marker per run following the playhead and a click anywhere on the chart to seek to it. See [The chart](#the-chart).
- **Elevation from a terrain model, not from your watch** — the profile is the height of the ground, so two runs of one course can be compared against each other even when their recorded altitudes do not agree. See [Elevation comes from a model](#elevation-comes-from-a-model).
- **A camera that follows a played run**, panning just enough to keep it in view and never zooming. Touch the map yourself and it steps back until you press play again. See [Follow camera](#follow-camera).

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
2. Drop one or more `.gpx` files onto the panel at the top-left, or click it to browse. Several files at once is fine, and one file containing several `<trk>` elements is split into several runs.
3. The map fits itself to the first run you load. The list below the dropzone shows each run's colour, name, point count, distance, and duration; the `×` button removes it.
4. Pick a basemap from the buttons in the top-right. Try **Dark** or **Fiord** for a low-glare basemap, **Positron** for maximum contrast against run colours.
5. Pan and zoom as usual. The attribution line at the bottom-left credits the data source and must stay visible.

6. Read the chart along the bottom: a marker per run follows the playhead, the toggle switches the whole panel between elevation and speed, and clicking anywhere on the chart seeks to that point in the run.

## Testing

There are two layers, and they answer different questions.

**Unit tests** (`npm test`) cover the logic that has no business being tested through a browser: the basemap table and `localStorage` fallback, the GPX scanner, the decoding fallback, the store's subscriptions, segment splitting, the E2E harness itself, the chart's profile building, decimation, distance inversion, and one-unit axis labels, and formatting. They run in a Node environment with no DOM and need no network, so they are fast — the whole suite takes under a second.

**End-to-end checks** (`npm run test:e2e`) drive the real built app in a real browser. They verify the things only a browser can: that the basemap styles really paint differently, that overlay layers survive a `setStyle()` switch, that a polyline and a moving marker actually change pixels on the map, that the follow camera brings a run back into view and a real drag on the map actually suspends it, that a recorded pause parks the marker instead of gliding it across the gap, that a clicked chart really seeks the run, that the About overlay opens and announces itself as a modal and closes by the ×, Escape, or a click outside, and that `dist/` really works from a subpath. It also charts a 60,000-point file, so a profile too long to draw point for point is exercised in a real browser. The suite serves `dist/` on a free port, writes its GPX fixtures to the OS temp directory, and takes no arguments.

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

A file with no `<time>` elements is still usable: timestamps are synthesised from distance at an assumed walking pace, so the run can be animated in later phases. Points missing only some timestamps inherit the previous point's, so a run is never non-monotonic because a few points went unlogged.

**Pauses are not drawn as straight lines.** A gap longer than 60 s inside one run, or a new `<trkseg>`, is recorded as a _segment break_ and the run is rendered as a `MultiLineString`. The same break parks the animation marker at the end of the segment for the length of the gap, so a watch paused for lunch does not send a marker gliding across open country. See [Playback](#playback).

## Deploying

`dist/` is a plain static directory — host it anywhere: GitHub Pages, Cloudflare Pages, Netlify, S3, nginx, or a local file server.

`vite.config.ts` sets `base: './'`, so all asset URLs are **relative**. The build therefore works unchanged from a domain root _or_ a subpath, which is what GitHub Pages project sites (`https://user.github.io/mapimator/`) need. No rewrite rules required. This is checked, not just asserted: `e2e/subpath.spec.mjs` serves the built `dist/` under a `/mapimator/` prefix with a server that refuses to answer outside it, so a regression to an absolute `base` turns every asset into a 404.

Two deployment notes:

- **Serve over HTTPS** (or `localhost`). The MapLibre worker is bundled and served from your own origin, so a Content Security Policy only needs `worker-src 'self'` — no `blob:` exception is required, which is only needed when loading MapLibre from a CDN.
- A single-page app needs no history fallback; `index.html` at the root is enough.

### GitHub Pages, kept in sync by two workflows

**`.github/workflows/test.yml`** runs the full check suite — typecheck, unit tests, a build, and the E2E suite in a real browser — against every pull request into `master`. It is also a **reusable workflow** (`on: workflow_call`), so it is called rather than copied wherever else the same bar is needed, which today is the deploy workflow below.

**`.github/workflows/deploy.yml`** runs on every push to `master`, and its first job calls `test.yml` before doing anything else — the same check a PR gets, run again against the actual merge commit rather than trusted to have already covered it. Only once that passes does the second job build its own fresh copy of `dist/` and publish it, so a third-party tile host being briefly unreachable delays a deploy rather than shipping something the suite never actually checked. `workflow_dispatch` is there too, for a manual re-run without an empty commit.

The deploy job's build is deliberately its own, separate from the one `test.yml` did to prove the build succeeds: it builds fresh on its own runner rather than reusing an artifact handed between jobs, so what ships is never more than one build step removed from what was just checked.

**One manual, one-time step neither workflow can do for you:** in the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**. Until that is set, `deploy.yml`'s build and test steps still run (and still gate on failure), but the deploy step has nothing to publish to.

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
.github/workflows/test.yml     test:all — a PR check, and reusable by deploy.yml
.github/workflows/deploy.yml   calls test.yml, then deploys dist/ to GitHub Pages
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
    palette.ts                the twelve run colours
    lineFeatures.ts           run -> GeoJSON MultiLineString
    lineFeatures.test.ts
  playback/
    clock.ts                  the shared clock, speed, seek, total span
    clock.test.ts
    interpolate.ts            sample lookup, gap parking, distance at a position
    interpolate.test.ts
    markerFeatures.ts         TrackState + elapsed time -> playhead markers
    markerFeatures.test.ts
    readout.ts                per-run elapsed time and distance covered
    readout.test.ts
  terrain/
    elevation.ts             tile maths, Terrarium decode, sampling, fallback
    elevation.test.ts
    demClient.ts             tile fetch, decode, cache, concurrency
    demClient.test.ts
  map/
    basemaps.ts               the five styles + localStorage persistence
    basemaps.test.ts          style table, id validation, storage fallback
    mapView.ts                MapLibre setup and style switching
    trackLayers.ts            overlay sources, layers, rendering, fitBounds
    followCamera.ts           the follow-camera pan: margin, worst-marker rule
    followCamera.test.ts
  chart/
    profile.ts                the metric against distance, decimation, inverses
    profile.test.ts
  ui/
    about.ts                  the About overlay: open, close, backdrop click
    basemapSwitcher.ts        basemap buttons
    dropzone.ts               drag-and-drop, file picker, parse status
    legend.ts                 run list, visibility toggles
    chart.ts                  the chart panel: axes, profiles, markers, seek
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
  about.spec.mjs              the About overlay: open, content, close paths
  subpath.spec.mjs            dist/ served from a subpath, as a project site is
  tracks.spec.mjs             parsing, geometry, gaps, errors, large file
  playback.spec.mjs           the shared clock, markers, play/pause, gap parking
  chart.spec.mjs              the chart panel: axes, profiles, markers, click-to-seek
  transport.spec.mjs          scrubbing, speed, keyboard, legend readouts
  legend.spec.mjs             hiding a run: map, chart, readouts, focus, wording
  terrain.spec.mjs            DEM sampling, fallback, a blocked tile host
  followcamera.spec.mjs       real projection, a real drag, suspend and resume
```

`e2e/*.spec.mjs` files are picked up automatically, so adding a spec needs no edit to the runner. A spec may export a `fixtures` list naming the GPX files it loads; only those are written to disk, so a spec that loads no GPX writes nothing. The fixture directory is emptied before each run, so a file left behind by an earlier run can never stand in for one that has stopped being generated.

## Code style

Formatting is handled by **Prettier** (`.prettierrc`), not by hand:

- **4 spaces** for TypeScript, CSS, HTML, and SVG
- **2 spaces** for `.json` files, matching the convention npm itself uses — so `package-lock.json` stays exactly as npm generates it and does not churn on every install
- Single quotes, semicolons, 100-column line width

Run `npm run format` to apply it, or `npm run format:check` to verify without writing. `.editorconfig` mirrors the same rules, so editors that support it (VS Code, JetBrains, and others) indent new files correctly even before Prettier has run.

Two-space indentation is the more common default in the wider TypeScript ecosystem; four is equally common and is what the TypeScript compiler's own codebase uses. Neither is more correct — the point is that the choice is recorded in configuration so every contributor and every editor agrees automatically.

A run's data is designed to be modelled as **typed arrays** (`Float64Array` for coordinates and times, `Float32Array` for elevation and distance) rather than objects, so a 200,000-point run costs a few megabytes instead of hundreds, and the parse worker can transfer the buffers to the main thread without copying. The shapes are declared in `src/types.ts` and populated by the parser.

One consequence worth knowing before editing: `Track.tRel` is in **seconds** while `Track.durationMs` is in **milliseconds**. `src/playback/interpolate.ts` converts once, at the boundary, and `interpolate.test.ts` has a check that fails if that conversion is ever dropped.

## Roadmap

| Phase                                                                      | Status                              |
| -------------------------------------------------------------------------- | ----------------------------------- |
| 1. Shell, MapLibre setup, basemap switching                                | **Done**                            |
| 2. GPX parser, Web Worker, dropzone, legend, static polylines              | **Done**                            |
| 3. Shared clock, interpolation, simultaneous marker animation              | **Done**                            |
| 4. Timeline scrubbing, speed multiplier, keyboard transport, live readouts | **Done**                            |
| 5. Chart panel (elevation/speed, time/distance axis)                       | **Done**                            |
| 6. Legend toggles, follow camera, rendering polish                         | Mostly done — rendering polish left |
| 7. Single-file build for easy sharing                                      | Planned                             |

## Playback

Pressing play advances **one shared elapsed-time clock**, and every run is read against it directly. Because each run is measured from its own first point, two runs of the same course recorded hours apart start side by side on the start line and stay side by side: at ten minutes in you are looking at where each run was ten minutes in. The timestamps are not discarded — the legend says how much later each run was recorded, relative to the first — they just do not decide what the playhead means. It lasts as long as the **longest** run in it, since the gap between two recordings is not part of either. A run that runs out of points freezes on its last position and its line dims, while the others carry on.

A marker inside a **recorded pause** stops at the end of the segment it has just finished and waits there for the length of the gap, then resumes at the first point of the next one. This is the same segment break that leaves the line undrawn across the gap, and it is why a lunch stop does not send a marker gliding across open country. The shared clock keeps counting throughout the gap, so the run is simply _waiting_ rather than being behind: its legend row still shows the distance it had covered when it stopped, and jumps forward the moment it starts again.

### Driving a run

- **Play / pause** with the button, with <kbd>Space</kbd>, or with <kbd>K</kbd>.
- **Scrub** by dragging the timeline. The map follows the pointer rather than jumping on release; the drag itself never moves the camera, though the follow camera can still nudge it back into view if you scrub while playing. See [Follow camera](#follow-camera).
- **1× to 300×** from the speed control, so a one-hour run finishes in seconds. The choice survives pausing, scrubbing and loading more runs — it is a setting, not a one-off.
- **Step** with <kbd>←</kbd> and <kbd>→</kbd>, five times as far with <kbd>Shift</kbd>, and jump to either end with <kbd>Home</kbd> and <kbd>End</kbd>. The step is a share of the run rather than a fixed number of seconds, so one gesture behaves the same on a four-minute clip and on a thirty-hour run.
- **Read** each legend row, which counts from that run's own start: how long it has been going, and how far it has got.

### Notes for whoever edits this

Arrow steps are a percentage of the total on purpose, and the keyboard handler deliberately declines keys that a focused control already handles. Pressing <kbd>Space</kbd> on the focused play button would otherwise toggle twice — once from the click the browser sends, and once from the key. The same goes for the arrows on a focused timeline, which already seek through their own `input` event. Space is the one key taken back from the timeline, because a range does nothing with it and a drag leaves focus there.

Frames stay cheap. The frame loop only runs while playing, redraws come from the clock's change notification rather than the frame callback, DOM writes are skipped when the text has not changed, and the line geometry is rebuilt only when the set of finished runs actually changes — `buildLineFeatures` walks every sample of every run, and doing that sixty times a second would make a large file unplayable.

## Follow camera

While playing, the camera keeps every **visible** marker inside a margin — the middle 70% of the map — panning just enough to bring one back once it drifts past it. It never zooms: a marker at the edge is pulled back to the edge of the margin, not to the centre, so the camera does the least it can to keep a run in view.

Each marker is checked on its own, not as a group, so this works the same with one run or several: whichever one is furthest past the margin decides the correction, and pulling it back only ever helps the others. Two markers past _opposite_ edges of the same axis by equal amounts cannot both be satisfied by one pan, so the corrections cancel and the camera holds still rather than oscillating between them — an accepted limit of following by panning alone, not a bug. A hidden run (see [Hiding a run](#hiding-a-run)) is never part of the calculation, because it has no marker to keep in view.

**Touch the map yourself and following steps back.** A real drag, scroll, or pinch suspends it until you press play again — even if it was already playing, pressing play is the one gesture that re-arms it. The correction's own camera movement does not trip this itself: MapLibre tells a genuine user gesture apart from a programmatic one by whether the event it fires carries the original mouse/touch/wheel event, and only a real one counts.

## The chart

The panel along the bottom draws **every loaded run against distance**, each in its own colour, and there is a toggle for which quantity to plot: **elevation** in metres, or **speed** in m/s or km/h. A marker on each line follows the playhead, so the panel and the map are showing the same moment from two directions, and **clicking anywhere on the chart seeks** to that point in the run.

**Distance is the x-axis, so the two directions of the same run are not the same thing.** A marker's position along the line is where that run has got, which is its distance — but its _height_ on the line is the metric at the playhead, read by time. The two differ exactly where a run is interesting: across a recorded stop, the distance stops changing while the speed does not, and a stop plotted against distance is a **vertical drop** through the same distance twice. Read by distance, a rider waiting at a junction would report the speed they had on the way in. Read by time, the marker sits at the foot of the drop, where the line actually shows the run standing still.

**Speed is smoothed over 15 seconds**, centred on each fix. Raw speed between two GPS fixes is mostly noise — one bad coordinate implies a sprint or a standstill that never happened — and averaging the distance covered across a short window gives a number a rider would recognise. The window is centred rather than trailing because a profile shows the whole run, and a trailing window would read half a minute late at the end of every one. The window is clipped at the ends of a run rather than padded, so the first and last fixes average over the samples that actually exist instead of over a window that reaches past the start of the run.

**A click seeks against the run nearest the pointer.** One click cannot put every run exactly where the pointer is, because one moment in time and one distance are different things for runs of different lengths. So the chart inverts the profile it was aimed at: the run you pointed at lands exactly there, and the others arrive at the same moment. It is the same rule the map follows, and clicking past the end of a line means the end of that run rather than the end of the timeline.

Two things about the drawing that are deliberate rather than incidental. **Both ends of an axis are labelled in one unit**, chosen from the larger end of the range — a speed axis from 0 to 5.4 m/s labelled `19.4 km/h` at the top and `0.0 m/s` at the bottom would ask the reader to convert between its own labels. And a profile is **decimated to at most 1200 points** by averaging, not sampling: a 200,000-point run has far more points than the panel has pixels, and picking every Nth sample would alias badly whenever a climb landed between two chosen ones. The axis is measured from the decimated profile, so it is always wide enough for what is drawn and nothing can fall off the top of it.

## Hiding a run

Every row in the legend has a switch, and pressing it takes that run off the map and off the chart: its line, its marker, and its profile all go, and the row is dimmed rather than removed, so it is still there to bring back. The other runs are untouched, and the chart redraws against what is left, so the axis stops covering a run you are not looking at.

**Hiding is only about what is drawn.** The run keeps its data, keeps its place in the comparison, and still counts towards the length of the timeline. That is the deliberate half: a run you cannot see still sets how long the run lasts, and a timeline that moved when you pressed a switch would make the same moment in the run mean two different things depending on what you could see. So a hidden run still reports its elapsed time and distance in the legend, and it still decides when playback ends. To take a run out of the comparison altogether, remove it.

**The rows are written in place, not rebuilt.** A rebuild would replace the button you had just pressed, and a button that is replaced takes the keyboard focus with it — so a switch operated from the keyboard would lose focus on every press, and a second press would go nowhere. Rows are therefore reused and only moved when they are genuinely in the wrong place, which is the one case where preserving them would be wrong. The E2E suite pins this by pressing the switch with the keyboard and checking focus is still on it afterwards.

**Hiding every run is its own state**, and the chart says so rather than claiming there is nothing to draw: _"Every run is switched off. Turn one on in the legend to draw it."_ An empty plot with no explanation would be a state a user hits by accident and cannot diagnose.

## Elevation comes from a model

A GPX file's altitudes are whatever the watch that wrote it believed, and two watches rarely agree. Barometric watches drift, satellite watches wander by several metres, and a watch reset mid-run can be a couple of hundred metres out for the rest of the file. For an app whose whole purpose is comparing one run against another, that is the wrong input: the interesting difference between two runs gets buried under an instrumentation difference that has nothing to do with the running.

So elevation is read from a terrain model instead, from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) in the [Terrarium](https://github.com/tilezen/joerd/blob/master/docs/terrarium.md) encoding, as SRTM-derived heightmaps at up to z14. Every run's `ele` array is replaced with elevations sampled from the model, which is what the chart draws and what anything else reading the run gets. The tile host is `s3.amazonaws.com`; there is no key, no account, and no rate limit.

**The run appears immediately and is corrected a moment later.** A file is never held back waiting for a network. It loads and draws with the altitudes it arrived with, and each is upgraded in place when its model answers. Nothing on screen is ever a half-applied mixture of the two.

**When the model cannot be reached, the recorded altitude is kept, silently.** A blocked request, an offline browser, or a host that is down leaves the profile exactly as the file had it. This is deliberately not reported as an error: an elevation that is 10 m out is a better answer than no chart, and a warning that cannot be acted on is noise. Nothing is retried, and no run is held back. A model that answers for some tiles and not others falls back point by point, so a hole in the data costs one fix rather than the whole run.

**What the model is good for, and what it is not.** Heights are good to roughly ±10 m, which is better than most consumer watches and far better than a watch that has drifted. It reads the **ground**, not the rider: a bridge is the height of the river under it and a tunnel is the height of the hillside over it, so a run whose profile drops into a tunnel loses a climb it actually made. It is a model of the surface, resampled and generalised, and it knows nothing about a road that has been cut or a bridge that has been built since it was measured. Treat a profile as the shape of the ground, not as a record of what a barometer did.

**What it costs in privacy.** No GPX file is uploaded, and no coordinate is sent to the elevation host. What is sent is a handful of requests for map tiles covering the area a run passes through — so the _general area_ of a run is visible to that host and to whoever watches the connection, in the same way the basemap tiles already reveal the area you are looking at. A run on a private road, a trail, or a route you would rather not be known about, is known to the tile host by its tile and nothing more. Blocking that host is a supported way to run the app: every profile falls back to the recorded altitude, which is how it behaved before this existed.

## Troubleshooting

**Blank grey map, and the console shows `Worker failed to load`.**
MapLibre v6 ships ESM only, and its worker must be registered explicitly when bundled. `src/map/mapView.ts` does this with `setWorkerUrl()` and a `?worker&url` import. If you see this error, check that import survived — and keep `?worker&url` rather than plain `?url`, because the dist worker imports a sibling chunk that `?url` does not emit.

**Blank map, no errors.**
Almost always missing WebGL2. Check `chrome://gpu` or the browser's WebGL report.

**Map renders but labels are missing or blurry.**
The OpenFreeMap tileset goes to zoom 14, so zooming past z14 overzooms the maximum-zoom tiles. Zoom is allowed to 19 for inspection; expect softness beyond 14.

**`localStorage` selection is not remembered.**
Some privacy modes block storage. The app catches this and falls back to the default basemap rather than failing.

**The profile looks like my watch's, not like a map's.**
The terrain model was not reached, so the recorded altitudes were kept. Check whether requests to `s3.amazonaws.com/elevation-tiles-prod` are being blocked, by a content blocker, a privacy extension, or an offline machine. This is silent by design and there is no banner: a chart drawing the file's own altitudes is exactly what a blocked model looks like.

**A file is rejected with "No track points found".**
The file parsed, but contained no `<trkpt>` — only waypoints or routes, or a route-only export. Mapimator animates recorded runs, not planned routes. Re-export from your tracking app as a GPX track.

**A dropped file is ignored with no message.**
Only `.gpx` is accepted. An explicit extension is trusted over the browser's MIME label, so a `.txt` or `.tcx` file is refused rather than handed to the parser and reported as an empty run.

**Run names look wrong, or a file fails to parse outright.**
Garbled accented characters usually mean the file is not UTF-8. The decoder retries as windows-1252, which covers most western-European exports, but a file in some other legacy encoding will still be mis-decoded. Re-save as UTF-8 from your tracking app.

**A run is drawn as several disconnected pieces.**
That is the segment-break rule working: a pause longer than 60 s, or a new `<trkseg>`, is left blank rather than joined by a straight line.

## License

Application code is released under the [MIT License](LICENSE). Map data is © OpenStreetMap contributors, licensed ODbL. Basemap tiles are provided by [OpenFreeMap](https://openfreemap.org), built on OpenMapTiles. Both are credited automatically in the map's attribution control and that credit must remain visible — the MIT license covers this repository's code only, not the map data it displays.

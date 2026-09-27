# Working agreements for Mapimator

## Verification

**Every claim of correctness lives in the test suite.** There are no throwaway
verification scripts, one-off probes, or "I checked it manually" steps.

- A behaviour is not done until a check for it exists in `src/**/*.test.ts`
  (Vitest, Node env) or `e2e/*.spec.mjs` (Playwright, real browser).
- Write the test **with** the feature, not retrofitted after it works.
- Never verify with an ad-hoc script, a scratch file, or a temporary
  `node -e`. If a check is worth doing once it is worth keeping.
- Prefer the cheapest layer that can actually catch the bug: a unit test for
  logic, an E2E check for anything only a browser or a real network can show.
- Assert exact values, not merely "nothing threw". A check that cannot fail is
  not a verification — if you add one, break the code deliberately and confirm
  it goes red, then revert.
- `npm run test:all` must be green before any commit: typecheck → unit tests →
  build → E2E.
- The E2E suite needs live network access to `tiles.openfreemap.org`. It
  preflights that and says so plainly, so a network failure is never mistaken
  for a code failure.

## Before starting a phase

Agree the check list first. For each phase, write down which behaviours get a
unit test and which need a browser, then implement against that list. The
phase is done when the list exists and passes — not when the feature appears to
work.

## Code style

Formatting is Prettier's job, not yours (`npm run format`). The rules it
enforces, which you should match by hand while editing:

- **4 spaces** for TypeScript, CSS, HTML, and SVG.
- **2 spaces** for `.json`, so npm's own `package-lock.json` does not churn.
- Single quotes, semicolons, 100-column width.

## Conventions worth knowing

- **MapLibre GL JS v6 is ESM-only and does not resolve its own worker** inside a
  bundler module graph. The worker must be registered via `setWorkerUrl()` and a
  `?worker&url` import — plain `?url` leaves the sibling chunk unemitted and the
  map silently renders nothing. The E2E suite catches this via its console-error
  and tiles-painted checks; do not "simplify" that import.
- **Basemap switching uses `setStyle(url, { diff: false })`** so `style.load`
  fires reliably and overlays are re-attached without losing the camera.
- **`areTilesLoaded()` can report `true` mid-transition**, while `setStyle` has
  already dropped the overlay source. Count `style.load` events instead.
- **MapLibre v6 stores source data as `_data.geojson`**, not `_data`.
- **The GPX parser is a hand-written single-pass scanner** (`src/gpx/parseGpx.ts`),
  not a general XML parser, and it stays dependency-free. This is deliberate: the
  scanner is what makes the parse fast enough to transfer typed arrays. Do not
  swap in `DOMParser` or an XML library.
- **Track samples are typed arrays** — `Float64Array` coordinates and times,
  `Float32Array` elevation and distance — so they can be transferred from the
  worker rather than copied.
- **Track legend names are inserted with `textContent`**, never `innerHTML`, so
  a `<name>` containing markup cannot inject script.
- **No `AGENTS.md`-worthy deviation from the above without asking first.**

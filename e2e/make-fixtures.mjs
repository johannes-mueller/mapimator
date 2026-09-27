import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const gpx = (inner, decl = '') =>
    `<?xml version="1.0" encoding="UTF-8"?>
${decl}<gpx version="1.1" creator="fixture" xmlns="http://www.topografix.com/GPX/1/1">
${inner}
</gpx>`;

const pt = (lat, lon, ele, time) =>
    `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele>${time ? `<time>${time}</time>` : ''}</trkpt>`;

const iso = (base, seconds) => new Date(base + seconds * 1000).toISOString().replace('.000Z', 'Z');
const T0 = Date.parse('2024-03-01T08:00:00Z');

/**
 * Each GPX fixture targets one case the parser has to get right. The unit
 * tests in `src/gpx/parseGpx.test.ts` cover the same ground far more
 * precisely; these exist to prove the values survive the whole trip through
 * the worker, the store, and the map source. A spec names the fixtures it
 * needs, so nothing is written that no spec will load.
 */
const builders = {
    'ride.gpx': () =>
        gpx(`  <trk>
    <name>Morning Ride</name>
    <trkseg>
${[0, 1, 2, 3, 4]
    .map((i) => `  ${pt(47.37 + i * 0.01, 8.54 + i * 0.012, 400 + i * 5, iso(T0, i * 60))}`)
    .join('\n')}
    </trkseg>
  </trk>`),

    'two-tracks.gpx': () =>
        gpx(`  <trk><name>Track A</name><trkseg>
${[0, 1, 2].map((i) => `  ${pt(46.9 + i * 0.01, 7.4 + i * 0.01, 500, iso(T0, i * 30))}`).join('\n')}
  </trkseg></trk>
  <trk><name>Track B</name><trkseg>
${[0, 1, 2].map((i) => `  ${pt(46.95 + i * 0.01, 7.45 + i * 0.01, 520, iso(T0, i * 30))}`).join('\n')}
  </trkseg></trk>`),

    // One 2-hour gap, with neighbouring intervals under the 60 s threshold.
    'gaps.gpx': () =>
        gpx(`  <trk><name>Gappy</name><trkseg>
  ${pt(48.0, 11.0, 500, iso(T0, 0))}
  ${pt(48.01, 11.01, 510, iso(T0, 60))}
  ${pt(48.5, 11.5, 520, iso(T0, 60 + 7200))}
  ${pt(48.51, 11.51, 530, iso(T0, 60 + 7260))}
  </trkseg></trk>`),

    'notime.gpx': () =>
        gpx(`  <trk><name>No Timestamps</name><trkseg>
${[0, 1, 2, 3].map((i) => `  ${pt(45.0 + i * 0.01, 6.0 + i * 0.01, 300 + i)}`).join('\n')}
  </trkseg></trk>`),

    'twoseg.gpx': () =>
        gpx(`  <trk><name>Two Segs</name>
  <trkseg>
  ${pt(49.0, 12.0, 100, iso(T0, 0))}
  ${pt(49.01, 12.01, 110, iso(T0, 60))}
  </trkseg>
  <trkseg>
  ${pt(49.5, 12.5, 120, iso(T0, 120))}
  ${pt(49.51, 12.51, 130, iso(T0, 180))}
  </trkseg>
  </trk>`),

    'messy.gpx': () =>
        `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="fixture">
  <metadata><name>ignored &amp; skipped</name></metadata>
  <wpt lat="1" lon="2"><name>waypoint not a track</name></wpt>
  <trk>
    <name>Messy &amp; <![CDATA[weird]]> Track</name>
    <extensions><note>ignore me</note></extensions>
    <trkseg>
      <trkpt   lat = '47.0'   lon = '8.0' >
        <elevation>450</elevation>
        <time>2024-03-01T08:00:00Z</time>
        <extensions><hr>105</hr></extensions>
      </trkpt>
      <trkpt lat='47.01' lon='8.01'>
        <elevation>460</elevation>
        <time>2024-03-01T08:01:00Z</time>
      </trkpt>
      <trkpt lat='47.02' lon='8.02'><elevation>470</elevation></trkpt>
    </trkseg>
  </trk>
  <trk><name>Empty</name><trkseg/></trk>
</gpx>`,

    // windows-1252 bytes with an accented name, written as raw bytes.
    'latin1.gpx': () => {
        const text = gpx(`  <trk><name>Caf&#233; R&#233;gl&#233;e</name><trkseg>
  <trkpt lat="50.0" lon="6.0"><ele>50</ele><time>2024-03-01T08:00:00Z</time></trkpt>
  <trkpt lat="50.01" lon="6.01"><ele>55</ele><time>2024-03-01T08:02:00Z</time></trkpt>
  </trkseg></trk>`);
        return Buffer.from(text, 'latin1');
    },

    'waypoints-only.gpx': () =>
        gpx(`  <wpt lat="47.0" lon="8.0"><name>Just a waypoint</name></wpt>`),

    'garbage.gpx': () => 'this file is definitely not a gpx document\n',

    'routes-only.gpx': () => gpx(`  <rte><name>A route</name><rtept lat="47" lon="8"/></rte>`),

    'notes.txt': () => 'ignored by the dropzone',

    // Two tracks recorded from the same instant, so they animate side by side.
    // Coordinates step by exactly 0.01 per minute, which makes an interpolated
    // marker position an exact expectation rather than an approximate one.
    'simultaneous.gpx': () =>
        gpx(`  <trk><name>Rider A</name><trkseg>
${[0, 1, 2, 3, 4]
    .map((i) => `  ${pt(47.0 + i * 0.01, 8.0 + i * 0.01, 400, iso(T0, i * 60))}`)
    .join('\n')}
  </trkseg></trk>
  <trk><name>Rider B</name><trkseg>
${[0, 1, 2, 3, 4]
    .map((i) => `  ${pt(46.0 + i * 0.01, 7.0 + i * 0.01, 400, iso(T0, i * 60))}`)
    .join('\n')}
  </trkseg></trk>`),

    // One track finishes at 1:00 while the other runs to 10:00, so the shorter
    // one can be checked for going dim and stopping while the playhead is still
    // well inside the longer one. Samples are 30 s apart deliberately: the
    // parser treats any gap over 60 s as a recorded pause, so wider spacing would
    // split both tracks into segments instead.
    'early-finisher.gpx': () =>
        gpx(`  <trk><name>Sprint</name><trkseg>
${[0, 1, 2].map((i) => `  ${pt(45.0 + i * 0.01, 6.0 + i * 0.01, 300, iso(T0, i * 30))}`).join('\n')}
  </trkseg></trk>
  <trk><name>Marathon</name><trkseg>
${Array.from(
    { length: 21 },
    (_, i) => `  ${pt(44.0 + i * 0.005, 5.0 + i * 0.005, 300, iso(T0, i * 30))}`,
).join('\n')}
  </trkseg></trk>`),

    // Two rides ninety seconds apart, so the shared clock reaches the second one
    // late and it is legitimately *pending* rather than sitting at zero. Steps by
    // 0.01 degrees every 30 s along one straight line, which makes the distance at
    // any point along the track a fixed share of its total.
    'offset-riders.gpx': () =>
        gpx(`  <trk><name>Early Rider</name><trkseg>
${[0, 1, 2, 3, 4, 5, 6]
    .map((i) => `  ${pt(47.0 + i * 0.01, 8.0 + i * 0.01, 400, iso(T0, i * 30))}`)
    .join('\n')}
  </trkseg></trk>
  <trk><name>Late Rider</name><trkseg>
${[0, 1, 2, 3, 4, 5, 6]
    .map((i) => `  ${pt(45.0 + i * 0.01, 6.0 + i * 0.01, 400, iso(T0, 90 + i * 30))}`)
    .join('\n')}
  </trkseg></trk>`),

    // 60k points, to confirm the worker path stays off the main thread.
    'bulk.gpx': () => {
        const rows = [];
        for (let i = 0; i < 60000; i += 1) {
            const lat = 47.0 + (i / 60000) * 0.4;
            const lon = 8.0 + Math.sin(i / 900) * 0.1 + (i / 60000) * 0.4;
            rows.push(
                `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${(400 + (i % 300)).toFixed(1)}</ele><time>${iso(T0, i * 2)}</time></trkpt>`,
            );
        }
        return gpx(`  <trk><name>Bulk</name><trkseg>\n${rows.join('\n')}\n    </trkseg></trk>`);
    },
};

/** Writes the named fixtures into `dir`, as text or raw bytes. */
export function writeFixtures(dir, names) {
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
        const build = builders[name];
        if (!build) {
            throw new Error(`Unknown fixture '${name}'`);
        }
        const content = build();
        writeFileSync(
            join(dir, name),
            typeof content === 'string' ? content : Buffer.from(content),
        );
    }
    return dir;
}

export const FIXTURE_NAMES = Object.keys(builders);

// Allow `node e2e/make-fixtures.mjs <dir> [name...]` for inspecting the files by hand.
if (process.argv[1] && process.argv[1].endsWith('make-fixtures.mjs')) {
    const dir = process.argv[2] ?? join(process.cwd(), 'e2e', '.fixtures');
    const names = process.argv.slice(3);
    console.log(
        'fixtures written to',
        writeFixtures(dir, names.length > 0 ? names : FIXTURE_NAMES),
    );
}

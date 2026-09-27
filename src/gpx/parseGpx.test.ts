import { describe, expect, it } from 'vitest';
import { decodeGpx, GpxParseError, MAX_SEGMENT_GAP_MS, parseGpx } from './parseGpx';

const gpx = (inner: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
${inner}
</gpx>`;

const pt = (lat: number, lon: number, time?: string, ele?: number): string =>
    `<trkpt lat="${lat}" lon="${lon}">${ele === undefined ? '' : `<ele>${ele}</ele>`}${
        time === undefined ? '' : `<time>${time}</time>`
    }</trkpt>`;

const T0 = Date.parse('2024-03-01T08:00:00Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

const track = (name: string, body: string): string =>
    gpx(`<trk><name>${name}</name><trkseg>${body}</trkseg></trk>`);

describe('parseGpx', () => {
    it('reads a single track with timestamps', () => {
        const [t] = parseGpx(
            track('Morning Ride', pt(47.37, 8.54, at(0)) + pt(47.38, 8.55, at(60))),
            'a.gpx',
        );

        expect(t.name).toBe('Morning Ride');
        expect(t.lat).toHaveLength(2);
        expect(t.t0).toBe(T0);
        expect(t.tRel[0]).toBe(0);
        expect(t.tRel[1]).toBe(60);
        expect(t.durationMs).toBe(60_000);
        expect(t.renderLine).toEqual([8.54, 47.37, 8.55, 47.38]);
        expect(t.bounds).toEqual({ minLon: 8.54, minLat: 47.37, maxLon: 8.55, maxLat: 47.38 });
    });

    it('never mistakes <trkpt> for a <trk> opening tag', () => {
        const body = [0, 1, 2].map((i) => pt(47 + i * 0.01, 8 + i * 0.01, at(i))).join('');
        const parsed = parseGpx(track('One', body), 'a.gpx');

        expect(parsed).toHaveLength(1);
        expect(parsed[0].lat).toHaveLength(3);
    });

    it('treats each <trk> as a separate track', () => {
        const parsed = parseGpx(
            gpx(
                `<trk><name>A</name><trkseg>${pt(46.9, 7.4, at(0))}${pt(46.91, 7.41, at(30))}</trkseg></trk>` +
                    `<trk><name>B</name><trkseg>${pt(46.95, 7.45, at(0))}${pt(46.96, 7.46, at(30))}</trkseg></trk>`,
            ),
            'two.gpx',
        );

        expect(parsed.map((t) => t.name)).toEqual(['A', 'B']);
    });

    it('accumulates distance with the haversine formula', () => {
        // 0.001 degrees of latitude is about 111.2 m anywhere on the globe.
        const [t] = parseGpx(track('D', pt(47, 8, at(0)) + pt(47.001, 8, at(60))), 'd.gpx');
        expect(t.dist[1]).toBeGreaterThan(111);
        expect(t.dist[1]).toBeLessThan(112);
        expect(t.dist[0]).toBe(0);
        expect(t.distanceM).toBe(t.dist[1]);
    });

    describe('segment breaks', () => {
        const gappy = (gapSeconds: number) =>
            parseGpx(
                track(
                    'G',
                    pt(48, 11, at(0)) +
                        pt(48.01, 11.01, at(60)) +
                        pt(48.5, 11.5, at(60 + gapSeconds)),
                ),
                'g.gpx',
            )[0];

        it(`records a break for a gap longer than ${MAX_SEGMENT_GAP_MS / 1000}s`, () => {
            expect(Array.from(gappy(7200).segmentBreaks)).toEqual([2]);
        });

        it('does not record a break at exactly the threshold', () => {
            expect(Array.from(gappy(MAX_SEGMENT_GAP_MS / 1000).segmentBreaks)).toEqual([]);
        });

        it('does not record a break just below the threshold', () => {
            expect(Array.from(gappy(59).segmentBreaks)).toEqual([]);
        });

        it('records a break at a new <trkseg>', () => {
            const [t] = parseGpx(
                gpx(
                    `<trk><name>S</name><trkseg>${pt(49, 12, at(0))}${pt(49.01, 12.01, at(60))}</trkseg>` +
                        `<trkseg>${pt(49.5, 12.5, at(120))}${pt(49.51, 12.51, at(180))}</trkseg></trk>`,
                ),
                's.gpx',
            );
            expect(Array.from(t.segmentBreaks)).toEqual([2]);
        });

        it('keeps distance accumulating across a break', () => {
            const t = gappy(7200);
            expect(t.dist[2]).toBeGreaterThan(t.dist[1]);
            expect(t.distanceM).toBe(t.dist[2]);
        });

        it('sorts and de-duplicates overlapping break sources', () => {
            // A time gap and a trkseg boundary at the same index.
            const [t] = parseGpx(
                gpx(
                    `<trk><name>D</name><trkseg>${pt(48, 11, at(0))}${pt(48.01, 11.01, at(30))}</trkseg>` +
                        `<trkseg>${pt(48.5, 11.5, at(30 + 7200))}${pt(48.51, 11.51, at(40 + 7200))}</trkseg></trk>`,
                ),
                'd.gpx',
            );
            expect(Array.from(t.segmentBreaks)).toEqual([2]);
        });
    });

    describe('timestamps', () => {
        it('synthesises times when a file has none', () => {
            const [t] = parseGpx(track('N', pt(45, 6) + pt(45.001, 6)), 'n.gpx');
            expect(t.t0).toBe(0);
            expect(t.tRel[0]).toBe(0);
            expect(t.tRel[1]).toBeGreaterThan(0);
            expect(t.durationMs).toBeGreaterThan(0);
            expect(t.segmentBreaks).toHaveLength(0);
        });

        it('forward-fills points that are missing a <time>', () => {
            const [t] = parseGpx(
                track('P', pt(47, 8, at(0)) + pt(47.01, 8) + pt(47.02, 8, at(120))),
                'p.gpx',
            );
            expect(t.tRel[0]).toBe(0);
            expect(t.tRel[1]).toBe(0);
            expect(t.tRel[2]).toBe(120);
        });

        it('applies a numeric timezone offset', () => {
            const z = parseGpx(track('Z', pt(47, 8, '2024-03-01T08:00:00Z')), 'z.gpx')[0];
            const plus2 = parseGpx(track('Z', pt(47, 8, '2024-03-01T10:00:00+02:00')), 'z.gpx')[0];
            expect(plus2.t0).toBe(z.t0);
        });

        it('reads fractional seconds', () => {
            const [t] = parseGpx(
                track('F', pt(47, 8, at(0)) + pt(47.01, 8, '2024-03-01T08:00:01.500Z')),
                'f.gpx',
            );
            expect(t.tRel[1]).toBeCloseTo(1.5, 6);
        });

        it('anchors untimed leading points to the first known time', () => {
            // Inventing a time for the unlogged first point would fabricate a
            // 90 s jump, so it is placed at the same instant instead.
            const [t] = parseGpx(track('N', pt(47, 8) + pt(47.01, 8, at(90))), 'n.gpx');
            expect(t.t0).toBe(T0 + 90_000);
            expect(t.tRel[0]).toBe(0);
            expect(t.tRel[1]).toBe(0);
        });
    });

    describe('awkward but legal input', () => {
        it('accepts single-quoted attributes and stray whitespace', () => {
            const [t] = parseGpx(track('Q', `<trkpt lat = '47.0'   lon = '8.0'></trkpt>`), 'q.gpx');
            expect(t.lat[0]).toBe(47);
            expect(t.lon[0]).toBe(8);
        });

        it('falls back to <elevation> when <ele> is absent', () => {
            const [t] = parseGpx(
                track('E', '<trkpt lat="47" lon="8"><elevation>450</elevation></trkpt>'),
                'e.gpx',
            );
            expect(t.ele[0]).toBe(450);
        });

        it('defaults missing elevation to 0 rather than NaN', () => {
            const [t] = parseGpx(track('E', pt(47, 8, at(0))), 'e.gpx');
            expect(t.ele[0]).toBe(0);
        });

        it('decodes entities and CDATA in a name', () => {
            const [t] = parseGpx(
                track('Messy &amp; <![CDATA[weird]]> Track', pt(47, 8, at(0))),
                'm.gpx',
            );
            expect(t.name).toBe('Messy & weird Track');
        });

        it('takes the name from the <trk>, not a preceding <wpt>', () => {
            const [t] = parseGpx(
                gpx(
                    '<wpt lat="1" lon="2"><name>waypoint</name></wpt>' +
                        `<trk><name>real</name><trkseg>${pt(47, 8, at(0))}</trkseg></trk>`,
                ),
                'w.gpx',
            );
            expect(t.name).toBe('real');
        });

        it('ignores nested <ele>/<time> inside <extensions>', () => {
            const [t] = parseGpx(
                track(
                    'X',
                    '<trkpt lat="47" lon="8"><ele>500</ele><time>2024-03-01T08:00:00Z</time>' +
                        '<extensions><ele>999</ele><time>2030-01-01T00:00:00Z</time></extensions></trkpt>',
                ),
                'x.gpx',
            );
            expect(t.ele[0]).toBe(500);
            expect(t.tRel[0]).toBe(0);
        });
    });

    describe('invalid input', () => {
        it('keeps reading past a self-closing <trkpt/>', () => {
            // Regression: a self-closing point has no </trkpt>, and hunting for
            // one used to swallow every point after it.
            const [t] = parseGpx(
                track(
                    'S',
                    '<trkpt lat="47.00" lon="8.00"/>' +
                        pt(47.01, 8.01, at(60)) +
                        pt(47.02, 8.02, at(120)),
                ),
                's.gpx',
            );
            expect(t.lat).toHaveLength(3);
            expect(Array.from(t.lat)).toEqual([47, 47.01, 47.02]);
        });

        it('mixes self-closing and closed points without losing any', () => {
            const [t] = parseGpx(
                track(
                    'M',
                    pt(47, 8, at(0)) +
                        '<trkpt lat="47.01" lon="8.01"/>' +
                        pt(47.02, 8.02, at(120)) +
                        '<trkpt lat="47.03" lon="8.03"/>',
                ),
                'm.gpx',
            );
            expect(t.lat).toHaveLength(4);
            expect(t.ele).toHaveLength(4);
            expect(t.tRel[2]).toBe(120);
        });

        it('drops points with non-finite or out-of-range coordinates', () => {
            const [t] = parseGpx(
                track(
                    'V',
                    '<trkpt lat="91" lon="8"/><trkpt lat="nope" lon="8"/><trkpt lat="47" lon="181"/>' +
                        pt(47, 8, at(0)),
                ),
                'v.gpx',
            );
            expect(t.lat).toHaveLength(1);
            expect(t.lat[0]).toBe(47);
        });

        it('skips a <trk> with no points', () => {
            const parsed = parseGpx(
                gpx(`<trk><name>Empty</name><trkseg/></trk>${track('Real', pt(47, 8, at(0)))}`),
                'e.gpx',
            );
            expect(parsed).toHaveLength(1);
            expect(parsed[0].name).toBe('Real');
        });

        it('throws a helpful error when there are no track points', () => {
            expect(() =>
                parseGpx(gpx('<wpt lat="1" lon="2"><name>x</name></wpt>'), 'w.gpx'),
            ).toThrow(GpxParseError);
            expect(() =>
                parseGpx(gpx('<rte><name>r</name><rtept lat="1" lon="2"/></rte>'), 'r.gpx'),
            ).toThrow(/No track points/);
        });

        it('throws on input that is not XML at all', () => {
            expect(() => parseGpx('this is not a gpx file', 'g.gpx')).toThrow(GpxParseError);
        });

        it('falls back to a filename when the name is blank', () => {
            const [t] = parseGpx(track('   ', pt(47, 8, at(0))), 'My Ride.gpx');
            expect(t.name).toBe('My Ride.gpx #1');
        });
    });
});

describe('decodeGpx', () => {
    const exact = (bytes: Uint8Array): ArrayBuffer => {
        const copy = new ArrayBuffer(bytes.length);
        new Uint8Array(copy).set(bytes);
        return copy;
    };

    const utf8 = (s: string): ArrayBuffer => exact(new TextEncoder().encode(s));

    // Char codes below 256 are the windows-1252 mapping, so this reproduces the
    // exact byte sequence a Latin-1 export would contain.
    const latin1 = (s: string): ArrayBuffer =>
        exact(Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff)));

    it('decodes UTF-8 including multi-byte characters', () => {
        expect(decodeGpx(utf8('Café Réglée'))).toBe('Café Réglée');
    });

    it('strips a byte order mark', () => {
        expect(decodeGpx(exact(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69])))).toBe('hi');
    });

    it('recovers windows-1252 bytes that are not valid UTF-8', () => {
        // 0xE9 is "é" in windows-1252 and an invalid UTF-8 sequence.
        expect(decodeGpx(latin1('Café'))).toBe('Café');
    });

    it('prefers UTF-8 when the bytes are valid UTF-8', () => {
        // 0xC3 0xA9 is "é" in UTF-8; decoding it as Latin-1 would give "Ã©".
        expect(decodeGpx(utf8('Café'))).toBe('Café');
    });
});

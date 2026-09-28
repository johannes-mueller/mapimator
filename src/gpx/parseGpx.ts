import type { Bounds, Track } from '../types';

/**
 * A track as it comes out of the parser: everything `Track` needs except the
 * fields that belong to the session rather than the file (`id` and `color`),
 * which the store assigns.
 */
export type ParsedTrack = Omit<Track, 'id' | 'color'>;

const DEG = Math.PI / 180;
const EARTH_RADIUS_M = 6371008.8;

/** A gap longer than this inside one track becomes a segment break. */
export const MAX_SEGMENT_GAP_MS = 60_000;

/** Assumed pace (m/s) used to invent timestamps for files that have none. */
const SYNTHETIC_PACE_MPS = 1.4;

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/i;

interface RawTrack {
    name: string;
    lat: number[];
    lon: number[];
    ele: number[];
    timeMs: number[];
    hasTime: boolean;
    /** Indices that begin a new `<trkseg>`, excluding index 0. */
    segStarts: number[];
}

export class GpxParseError extends Error {}

/**
 * Decodes GPX bytes. GPX is specified as UTF-8, but files exported by older
 * tools are frequently Latin-1, which decodes to U+FFFD rather than failing,
 * so the strict decode is what decides, not the presence of replacement chars.
 */
export function decodeGpx(buffer: ArrayBuffer): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        return new TextDecoder('windows-1252').decode(buffer);
    }
}

/**
 * Finds `<tag` at or after `from`, skipping `<tagSomething` so that looking for
 * `trk` never lands on `<trkpt>`. The word-boundary check is the whole reason
 * this is not a plain `indexOf`.
 */
function findTag(text: string, from: number, tag: string): number {
    const needle = `<${tag}`;
    let i = text.indexOf(needle, from);
    while (i >= 0) {
        const next = text.charAt(i + needle.length);
        if (
            next === '>' ||
            next === '/' ||
            next === ' ' ||
            next === '\t' ||
            next === '\n' ||
            next === '\r'
        ) {
            return i;
        }
        i = text.indexOf(needle, i + needle.length);
    }
    return -1;
}

function closeTagIndex(text: string, from: number, tag: string): number {
    return text.indexOf(`</${tag}>`, from);
}

function decodeEntities(value: string): string {
    // CDATA is an alternative escaping mechanism, not markup, so its contents
    // are taken verbatim and the wrapper dropped. Some writers wrap names in it.
    const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
    let out = value.replace(cdata, '$1');

    if (!out.includes('&')) {
        return out;
    }
    return out
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&');
}

/** Returns the text content of the first `<tag>...</tag>` inside [from, to). */
function readTagValue(text: string, from: number, to: number, tag: string): string | null {
    const open = findTag(text, from, tag);
    if (open < 0 || open >= to) {
        return null;
    }
    const gt = text.indexOf('>', open);
    if (gt < 0 || gt >= to || text.charAt(gt - 1) === '/') {
        return null;
    }
    const close = closeTagIndex(text, gt + 1, tag);
    if (close < 0 || close > to) {
        return null;
    }
    return decodeEntities(text.slice(gt + 1, close).trim());
}

function readLatLon(text: string, from: number, to: number): { lat: number; lon: number } {
    const tagText = text.slice(from, to);
    let lat = NaN;
    let lon = NaN;
    ATTR_RE.lastIndex = 0;
    let match = ATTR_RE.exec(tagText);
    while (match !== null) {
        const name = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? '';
        if (name === 'lat') {
            lat = Number.parseFloat(value);
        } else if (name === 'lon') {
            lon = Number.parseFloat(value);
        }
        match = ATTR_RE.exec(tagText);
    }
    return { lat, lon };
}

function isValidCoordinate(lat: number, lon: number): boolean {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
    );
}

/**
 * Converts the `HH:MM[:SS[.FFF]][zone]` tail of an ISO timestamp into
 * milliseconds since the "same day at 00:00 UTC" instant, applying a numeric
 * zone offset. Returns null when the tail is not in that shape.
 */
function timeOfDayToMs(tail: string, dayStartMs: number): number | null {
    const m = TIME_OF_DAY_RE.exec(tail);
    if (!m) {
        return null;
    }
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    const seconds = m[3] === undefined ? 0 : Number(m[3]);
    const frac = m[4] === undefined ? 0 : Number(`0.${m[4]}`);
    let ms = dayStartMs + (hours * 3600 + minutes * 60 + seconds + frac) * 1000;

    const zone = m[5];
    if (zone && zone.toUpperCase() !== 'Z') {
        const sign = zone.startsWith('-') ? 1 : -1;
        const digits = zone.slice(1).replace(':', '');
        const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
        ms += sign * offsetMin * 60_000;
    }
    return ms;
}

/**
 * Builds a time parser that caches the date portion. Every point in a track
 * normally shares the same `YYYY-MM-DD`, so parsing that part once instead of
 * `Date.parse`-ing 200,000 full strings is a large win on long files.
 */
function createTimeParser(): (value: string) => number {
    let cachedDate = '';
    let cachedBase = NaN;

    return (value: string): number => {
        const tIndex = value.indexOf('T');
        if (tIndex < 0) {
            return Date.parse(value);
        }
        const datePart = value.slice(0, tIndex);
        if (datePart !== cachedDate) {
            cachedBase = Date.parse(`${datePart}T00:00:00Z`);
            cachedDate = datePart;
        }
        if (Number.isNaN(cachedBase)) {
            return Date.parse(value);
        }

        const ms = timeOfDayToMs(value.slice(tIndex + 1), cachedBase);
        return ms === null ? Date.parse(value) : ms;
    };
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface TrackElementSpan {
    /** Where the block content begins, just past the opening `>`. */
    contentFrom: number;
    /** Where the block content ends: the `</trk>` index, or end of file. */
    end: number;
    selfClosing: boolean;
    /** Where scanning resumes after this element. */
    next: number;
}

/** The text span of the next `<trk>` element, or null once none remains. */
function nextTrackElement(text: string, from: number): TrackElementSpan | null {
    const open = findTag(text, from, 'trk');
    if (open < 0) {
        return null;
    }
    const gt = text.indexOf('>', open);
    if (gt < 0) {
        return null;
    }
    const selfClosing = text.charAt(gt - 1) === '/';
    const closeIdx = closeTagIndex(text, gt + 1, 'trk');
    const end = closeIdx < 0 ? text.length : closeIdx;
    return {
        contentFrom: gt + 1,
        end,
        selfClosing,
        next: closeIdx < 0 ? text.length : closeIdx + 6,
    };
}

interface TrackPointSpan {
    /** Index of the `<trkpt` opening tag, used to order segments. */
    open: number;
    /** Index of the `>` that closes the opening tag. */
    tagEnd: number;
    /** Where the element's content ends — never past the block's `to`. */
    contentEnd: number;
    /** Where scanning resumes after this element. */
    next: number;
}

/**
 * The span of the next `<trkpt>` at or after `pos`, or null once the block is
 * exhausted. A point's content ends at its `</trkpt>` — or at the block end
 * for a self-closing point, which has no closing tag of its own.
 */
function nextTrackPoint(text: string, pos: number, to: number): TrackPointSpan | null {
    const open = findTag(text, pos, 'trkpt');
    if (open < 0 || open >= to) {
        return null;
    }
    const gt = text.indexOf('>', open);
    if (gt < 0 || gt >= to) {
        return null;
    }

    // A <trkpt> carrying no <ele> and no <time> is commonly written
    // self-closing (`<trkpt lat=".." lon=".."/>`). Such an element has no
    // `</trkpt>` of its own, so searching for one would run on to the *next*
    // point and swallow it along with the rest of the file.
    const selfClosing = text.charAt(gt - 1) === '/';
    const closeIdx = selfClosing ? -1 : closeTagIndex(text, gt + 1, 'trkpt');
    const contentEnd = closeIdx < 0 || closeIdx > to ? to : closeIdx;
    return {
        open,
        tagEnd: gt,
        contentEnd,
        next: selfClosing ? gt + 1 : closeIdx < 0 ? to : closeIdx + 8,
    };
}

/** Opening-tag indices of every `<trkseg>` in the block. */
function findSegmentStartingIndices(text: string, from: number, to: number): number[] {
    const indices: number[] = [];
    for (
        let s = findTag(text, from, 'trkseg');
        s >= 0 && s < to;
        s = findTag(text, s + 7, 'trkseg')
    ) {
        indices.push(s);
    }
    return indices;
}

/**
 * Tracks which `<trkseg>` the scan is inside. Segment opening tags are visited
 * in file order, so one pointer walks past every segment that starts before
 * the current point; each new segment begun after points were already
 * collected is recorded as a break.
 */
function createSegmentTracker(raw: RawTrack, segTagIdx: number[]): (pointOpen: number) => void {
    let segPtr = 0;
    let segSeen = 0;
    return (pointOpen: number): void => {
        while (segPtr < segTagIdx.length && segTagIdx[segPtr] < pointOpen) {
            segPtr += 1;
        }
        if (segPtr > segSeen) {
            segSeen = segPtr;
            if (raw.lat.length > 0) {
                raw.segStarts.push(raw.lat.length);
            }
        }
    };
}

/**
 * Reads the `<ele>`/`<elevation>` and `<time>` children of a validated point.
 * A missing child is recorded as NaN, exactly as the raw arrays store it.
 */
function readPointContent(
    text: string,
    from: number,
    to: number,
    parseTime: (value: string) => number,
): { ele: number; timeMs: number } {
    const eleText =
        readTagValue(text, from, to, 'ele') ?? readTagValue(text, from, to, 'elevation');
    const timeText = readTagValue(text, from, to, 'time');
    return {
        ele: eleText === null ? NaN : Number.parseFloat(eleText),
        timeMs: timeText === null ? NaN : parseTime(timeText),
    };
}

function parseTrackBlock(text: string, from: number, to: number, fallbackName: string): RawTrack {
    const raw: RawTrack = {
        name: readTagValue(text, from, to, 'name') ?? fallbackName,
        lat: [],
        lon: [],
        ele: [],
        timeMs: [],
        hasTime: false,
        segStarts: [],
    };

    const segmentStarts = findSegmentStartingIndices(text, from, to);
    const noteSegment = createSegmentTracker(raw, segmentStarts);
    const parseTime = createTimeParser();
    let pos = from;

    for (;;) {
        const point = nextTrackPoint(text, pos, to);
        if (point === null) {
            break;
        }
        noteSegment(point.open);

        // The +6 skips the `<trkpt` tag name, so only the attributes are scanned.
        const { lat, lon } = readLatLon(text, point.open + 6, point.tagEnd);
        if (isValidCoordinate(lat, lon)) {
            const { ele, timeMs } = readPointContent(
                text,
                point.tagEnd + 1,
                point.contentEnd,
                parseTime,
            );
            raw.lat.push(lat);
            raw.lon.push(lon);
            raw.ele.push(ele);
            raw.timeMs.push(timeMs);
        }
        pos = point.next;
    }

    if (raw.lat.length > 0) {
        raw.hasTime = raw.timeMs.some((t) => Number.isFinite(t));
    }
    return raw;
}

interface Geometry {
    lat: Float64Array;
    lon: Float64Array;
    ele: Float32Array;
    dist: Float32Array;
    renderLine: number[];
    bounds: Bounds;
}

/** Copies a parsed track into its typed arrays, adding distance and bounds. */
function buildGeometry(raw: RawTrack): Geometry {
    const n = raw.lat.length;
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const ele = new Float32Array(n);
    const dist = new Float32Array(n);
    const renderLine = new Array<number>(n * 2);

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    let cumulative = 0;

    for (let i = 0; i < n; i += 1) {
        const la = raw.lat[i];
        const lo = raw.lon[i];
        lat[i] = la;
        lon[i] = lo;
        ele[i] = Number.isFinite(raw.ele[i]) ? raw.ele[i] : 0;

        if (i > 0) {
            cumulative += haversine(raw.lat[i - 1], raw.lon[i - 1], la, lo);
        }
        dist[i] = cumulative;
        renderLine[i * 2] = lo;
        renderLine[i * 2 + 1] = la;

        minLon = Math.min(minLon, lo);
        maxLon = Math.max(maxLon, lo);
        minLat = Math.min(minLat, la);
        maxLat = Math.max(maxLat, la);
    }

    return {
        lat,
        lon,
        ele,
        dist,
        renderLine,
        bounds: { minLon, minLat, maxLon, maxLat },
    };
}

/**
 * The per-point elapsed-time series and its origin. A timed run pins `t0` to
 * the first real timestamp and fills the gaps left by points with no `<time>`
 * (the fill mutates `raw.timeMs`); an untimed run gets a synthetic pace.
 */
function buildRelativeTimes(raw: RawTrack, dist: Float32Array): { t0: number; tRel: Float64Array } {
    const n = raw.lat.length;
    const tRel = new Float64Array(n);

    if (!raw.hasTime) {
        for (let i = 0; i < n; i += 1) {
            tRel[i] = dist[i] / SYNTHETIC_PACE_MPS;
        }
        return { t0: 0, tRel };
    }

    const first = Math.max(
        0,
        raw.timeMs.findIndex((t) => Number.isFinite(t)),
    );
    const t0 = raw.timeMs[first];
    // Fill gaps left by points with no <time>, so a track is never
    // non-monotonic just because a few points were unlogged.
    for (let i = 1; i < n; i += 1) {
        if (!Number.isFinite(raw.timeMs[i])) {
            raw.timeMs[i] = raw.timeMs[i - 1];
        }
    }
    for (let i = first - 1; i >= 0; i -= 1) {
        raw.timeMs[i] = t0;
    }
    for (let i = 0; i < n; i += 1) {
        tRel[i] = (raw.timeMs[i] - t0) / 1000;
    }
    return { t0, tRel };
}

/**
 * The indices where segments begin: a new `<trkseg>`, or a recorded gap longer
 * than MAX_SEGMENT_GAP_MS between adjacent timed points. Index 0 is always
 * removed, since a break at the very start cannot be drawn.
 */
function buildSegmentBreaks(raw: RawTrack, n: number): Uint32Array {
    const breaks = new Set<number>(raw.segStarts);
    if (raw.hasTime) {
        for (let i = 1; i < n; i += 1) {
            if (raw.timeMs[i] - raw.timeMs[i - 1] > MAX_SEGMENT_GAP_MS) {
                breaks.add(i);
            }
        }
    }
    breaks.delete(0);
    return new Uint32Array([...breaks].sort((a, b) => a - b));
}

function finalizeTrack(raw: RawTrack, index: number, fileName: string): ParsedTrack {
    const n = raw.lat.length;
    const { lat, lon, ele, dist, renderLine, bounds } = buildGeometry(raw);
    const { t0, tRel } = buildRelativeTimes(raw, dist);
    const segmentBreaks = buildSegmentBreaks(raw, n);

    const name = raw.name.trim() === '' ? `${fileName} #${index + 1}` : raw.name.trim();

    return {
        name,
        t0,
        tRel,
        lat,
        lon,
        ele,
        dist,
        segmentBreaks,
        durationMs: (tRel[n - 1] ?? 0) * 1000,
        // Taken from the float32 series rather than the float64 accumulator, so
        // the summary and the last stored sample are guaranteed to agree.
        distanceM: dist[n - 1] ?? 0,
        bounds,
        renderLine,
    };
}

/**
 * Parses every `<trk>` in a GPX document. Each track element becomes its own
 * `Track`, because one file legitimately holds several recordings and treating
 * them as one would draw a line between unrelated rides.
 */
export function parseGpx(text: string, fileName: string): ParsedTrack[] {
    const out: ParsedTrack[] = [];
    let cursor = 0;

    for (;;) {
        const element = nextTrackElement(text, cursor);
        if (element === null) {
            break;
        }
        if (!element.selfClosing) {
            const raw = parseTrackBlock(text, element.contentFrom, element.end, fileName);
            if (raw.lat.length > 0) {
                out.push(finalizeTrack(raw, out.length, fileName));
            }
        }
        cursor = element.next;
    }

    if (out.length === 0) {
        throw new GpxParseError(
            'No track points found. The file may not be GPX, or it may contain only waypoints and routes.',
        );
    }
    return out;
}

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

        const m = TIME_OF_DAY_RE.exec(value.slice(tIndex + 1));
        if (!m) {
            return Date.parse(value);
        }
        const hours = Number(m[1]);
        const minutes = Number(m[2]);
        const seconds = m[3] === undefined ? 0 : Number(m[3]);
        const frac = m[4] === undefined ? 0 : Number(`0.${m[4]}`);
        let ms = cachedBase + (hours * 3600 + minutes * 60 + seconds + frac) * 1000;

        const zone = m[5];
        if (zone && zone.toUpperCase() !== 'Z') {
            const sign = zone.startsWith('-') ? 1 : -1;
            const digits = zone.slice(1).replace(':', '');
            const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
            ms += sign * offsetMin * 60_000;
        }
        return ms;
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

    const segTagIdx: number[] = [];
    for (
        let s = findTag(text, from, 'trkseg');
        s >= 0 && s < to;
        s = findTag(text, s + 7, 'trkseg')
    ) {
        segTagIdx.push(s);
    }

    const parseTime = createTimeParser();
    let segPtr = 0;
    let segSeen = 0;
    let pos = from;

    for (;;) {
        const trkptIdx = findTag(text, pos, 'trkpt');
        if (trkptIdx < 0 || trkptIdx >= to) {
            break;
        }
        const gt = text.indexOf('>', trkptIdx);
        if (gt < 0 || gt >= to) {
            break;
        }

        while (segPtr < segTagIdx.length && segTagIdx[segPtr] < trkptIdx) {
            segPtr += 1;
        }
        if (segPtr > segSeen) {
            segSeen = segPtr;
            if (raw.lat.length > 0) {
                raw.segStarts.push(raw.lat.length);
            }
        }

        // A <trkpt> carrying no <ele> and no <time> is commonly written
        // self-closing (`<trkpt lat=".." lon=".."/>`). Such an element has no
        // `</trkpt>` of its own, so searching for one would run on to the *next*
        // point and swallow it along with the rest of the file.
        const selfClosing = text.charAt(gt - 1) === '/';
        const closeIdx = selfClosing ? -1 : closeTagIndex(text, gt + 1, 'trkpt');
        const contentEnd = closeIdx < 0 || closeIdx > to ? to : closeIdx;
        const { lat, lon } = readLatLon(text, trkptIdx + 6, gt);

        if (
            Number.isFinite(lat) &&
            Number.isFinite(lon) &&
            lat >= -90 &&
            lat <= 90 &&
            lon >= -180 &&
            lon <= 180
        ) {
            const eleText =
                readTagValue(text, gt + 1, contentEnd, 'ele') ??
                readTagValue(text, gt + 1, contentEnd, 'elevation');
            const timeText = readTagValue(text, gt + 1, contentEnd, 'time');

            raw.lat.push(lat);
            raw.lon.push(lon);
            raw.ele.push(eleText === null ? NaN : Number.parseFloat(eleText));
            raw.timeMs.push(timeText === null ? NaN : parseTime(timeText));
        }

        pos = selfClosing ? gt + 1 : closeIdx < 0 ? to : closeIdx + 8;
    }

    if (raw.lat.length > 0) {
        raw.hasTime = raw.timeMs.some((t) => Number.isFinite(t));
    }
    return raw;
}

function finalizeTrack(raw: RawTrack, index: number, fileName: string): ParsedTrack {
    const n = raw.lat.length;
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const ele = new Float32Array(n);
    const dist = new Float32Array(n);
    const tRel = new Float64Array(n);
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

        if (lo < minLon) {
            minLon = lo;
        }
        if (lo > maxLon) {
            maxLon = lo;
        }
        if (la < minLat) {
            minLat = la;
        }
        if (la > maxLat) {
            maxLat = la;
        }
    }

    const bounds: Bounds = { minLon, minLat, maxLon, maxLat };

    let t0 = 0;
    if (raw.hasTime) {
        let first = raw.timeMs.findIndex((t) => Number.isFinite(t));
        if (first < 0) {
            first = 0;
        }
        t0 = raw.timeMs[first];
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
    } else {
        for (let i = 0; i < n; i += 1) {
            tRel[i] = dist[i] / SYNTHETIC_PACE_MPS;
        }
    }

    const breaks = new Set<number>(raw.segStarts);
    if (raw.hasTime) {
        for (let i = 1; i < n; i += 1) {
            if (raw.timeMs[i] - raw.timeMs[i - 1] > MAX_SEGMENT_GAP_MS) {
                breaks.add(i);
            }
        }
    }
    breaks.delete(0);
    const segmentBreaks = new Uint32Array([...breaks].sort((a, b) => a - b));

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
        const open = findTag(text, cursor, 'trk');
        if (open < 0) {
            break;
        }
        const gt = text.indexOf('>', open);
        if (gt < 0) {
            break;
        }
        const selfClosing = text.charAt(gt - 1) === '/';
        const closeIdx = closeTagIndex(text, gt + 1, 'trk');
        const end = closeIdx < 0 ? text.length : closeIdx;

        if (!selfClosing) {
            const raw = parseTrackBlock(text, gt + 1, end, fileName);
            if (raw.lat.length > 0) {
                out.push(finalizeTrack(raw, out.length, fileName));
            }
        }

        cursor = closeIdx < 0 ? text.length : closeIdx + 6;
    }

    if (out.length === 0) {
        throw new GpxParseError(
            'No track points found. The file may not be GPX, or it may contain only waypoints and routes.',
        );
    }
    return out;
}

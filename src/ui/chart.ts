import { distanceAt, positionAt } from '../playback/interpolate';
import { distanceAxisLabels, elevationAxisLabels, speedAxisLabels } from '../format';
import {
    buildProfile,
    distanceRange,
    metricValues,
    timeAtDistance,
    valueAtDistance,
    valueRange,
    valueAtTime,
} from '../chart/profile';
import type { Metric, ProfilePoint } from '../chart/profile';
import type { Track, TrackState } from '../types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * How many points a profile may be drawn with. Roughly one per pixel across a
 * wide panel, and a hard ceiling so a resize does not rebuild the profiles: the
 * coordinates are reprojected instead, which is cheap.
 */
const MAX_PROFILE_POINTS = 1200;

/** Room for the y-axis labels, the x-axis labels, and the plot itself. */
const PAD = { left: 46, right: 10, top: 10, bottom: 18 };

/** How much of a track's own colour to use, for a line that must not shout. */
const PROFILE_OPACITY = 0.85;

const METRICS: { id: Metric; label: string }[] = [
    { id: 'elevation', label: 'Elevation' },
    { id: 'speed', label: 'Speed' },
];

export interface ChartDot {
    trackId: string;
    /** In the SVG's own coordinates, which are pixels. */
    x: number;
    y: number;
    distanceM: number;
    value: number;
}

export interface ChartState {
    metric: Metric;
    /** One entry per profile actually drawn, in legend order. */
    trackIds: string[];
    dots: ChartDot[];
    xMax: number;
    yMin: number;
    yMax: number;
    /**
     * The y-axis labels, top first. The x-axis labels, left end first — so both
     * pairs are in the order they appear on screen, which is the only order a test
     * or a screen reader can use without being told which end is which.
     */
    yLabels: [string, string];
    xLabels: [string, string];
    /** The plot rectangle in pixels, so a test can turn a click into a distance. */
    plot: { left: number; width: number; top: number; height: number };
}

export interface ChartHandle {
    render: (states: TrackState[]) => void;
    update: (elapsedMs: number) => void;
    setMetric: (metric: Metric) => void;
    /** Exposed so the E2E suite can assert against the numbers actually drawn. */
    getState: () => ChartState;
}

interface Drawn {
    track: Track;
    points: ProfilePoint[];
    /** The metric at every fix, so a marker can read the playhead off it. */
    values: Float64Array;
    line: SVGPolylineElement;
    dot: SVGCircleElement;
    playhead: SVGLineElement;
    /** What the marker was last told to draw, so the state reports what is on screen. */
    dotDistance: number;
    dotValue: number;
    dotX: number;
}

export function createChart(
    container: HTMLElement,
    onSeek: (elapsedMs: number) => void,
): ChartHandle {
    let states: TrackState[] = [];
    let metric: Metric = 'elevation';
    let drawn: Drawn[] = [];
    let width = 0;
    let height = 0;
    let xMax = 0;
    let yMin = 0;
    let yMax = 1;
    /** The last moment the markers were drawn for, so they can be drawn again. */
    let lastElapsedMs = 0;

    container.replaceChildren();
    container.classList.add('chart');

    const controls = document.createElement('div');
    controls.className = 'chart-metrics';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Chart metric');

    const buttons = new Map<Metric, HTMLButtonElement>();
    for (const { id, label } of METRICS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chart-metric';
        button.textContent = label;
        button.dataset.metric = id;
        button.setAttribute('aria-pressed', String(id === metric));
        button.addEventListener('click', () => {
            if (id !== metric) {
                setMetric(id);
            }
        });
        buttons.set(id, button);
        controls.append(button);
    }

    // A chart is a picture to a screen reader, so it needs a name: without one the
    // role announces an unlabelled image, which is worse than a plain graphic.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'chart-plot');
    svg.setAttribute('role', 'img');
    const describe = (count: number): void => {
        const quantity = metric === 'elevation' ? 'Elevation' : 'Speed';
        svg.setAttribute(
            'aria-label',
            count === 0
                ? 'No chart yet'
                : `${quantity} against distance for ${count} track${count === 1 ? '' : 's'}. Click to seek.`,
        );
    };

    const grid = svgEl('g', { class: 'chart-grid' });
    const xLabels = svgEl('g', { class: 'chart-x-labels' });
    const yLabels = svgEl('g', { class: 'chart-y-labels' });
    const profiles = svgEl('g', { class: 'chart-profiles' });
    const guides = svgEl('g', { class: 'chart-playheads' });
    const dots = svgEl('g', { class: 'chart-dots' });
    svg.append(grid, yLabels, xLabels, profiles, guides, dots);

    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.textContent = 'The chart appears once a track is loaded.';

    const plotWrap = document.createElement('div');
    plotWrap.className = 'chart-plot-wrap';
    plotWrap.append(svg);

    container.append(controls, plotWrap, empty);

    const plot = (): { left: number; width: number; top: number; height: number } => ({
        left: PAD.left,
        width: Math.max(1, width - PAD.left - PAD.right),
        top: PAD.top,
        height: Math.max(1, height - PAD.top - PAD.bottom),
    });

    /** Data distance to a pixel column. */
    const scaleX = (distanceM: number): number => {
        const p = plot();
        return p.left + (xMax > 0 ? (distanceM / xMax) * p.width : 0);
    };

    /** Data value to a pixel row, with the y-axis growing upwards. */
    const scaleY = (value: number): number => {
        const p = plot();
        const span = yMax - yMin;
        const t = span > 0 ? (value - yMin) / span : 0.5;
        return p.top + p.height - t * p.height;
    };

    /** The data distance a pixel column stands for, clamped to the axis. */
    const unscaleX = (x: number): number => {
        const p = plot();
        if (xMax <= 0) {
            return 0;
        }
        const t = (x - p.left) / p.width;
        return Math.min(xMax, Math.max(0, t * xMax));
    };

    /**
     * The two labels at the ends of the y-axis, in whichever unit that axis is
     * drawn in. Both ends share it, so they can be compared without converting.
     */
    const axisLabels = (): [string, string] =>
        metric === 'elevation' ? elevationAxisLabels(yMin, yMax) : speedAxisLabels(yMin, yMax);

    /** The x-axis labels, left end first, so they are in the order they are drawn. */
    const xAxisLabels = (): [string, string] => {
        const [far, near] = distanceAxisLabels(0, xMax);
        return [near, far];
    };

    const measure = (): void => {
        // The SVG is given a viewBox matching its own size so one SVG unit is one
        // CSS pixel. Stroke widths and dot radii then mean what they say, instead
        // of being scaled by whatever ratio the viewBox happens to have.
        //
        // It has to be the SVG's own box and not the wrapper's: the wrapper carries
        // horizontal padding the SVG does not, so sizing the viewBox from it makes
        // the viewBox wider than the element. Every coordinate is then stretched,
        // and the far end of the axis falls outside the element that draws it —
        // the last ride's finish, and the one column a click cannot reach.
        const box = svg.getBoundingClientRect();
        width = Math.max(1, Math.round(box.width));
        height = Math.max(1, Math.round(box.height));
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    };

    const layout = (): void => {
        const p = plot();

        grid.replaceChildren();
        // One rule at each y label, which is as much structure as a 130px panel
        // can carry without turning into graph paper.
        for (const value of [yMax, yMin]) {
            const y = scaleY(value);
            grid.append(
                svgEl('line', {
                    class: 'chart-rule',
                    x1: p.left,
                    y1: y,
                    x2: p.left + p.width,
                    y2: y,
                }),
            );
        }

        yLabels.replaceChildren();
        const [high, low] = axisLabels();
        for (const [value, label] of [
            [yMax, high],
            [yMin, low],
        ] as [number, string][]) {
            const text = svgEl('text', {
                class: 'chart-y-label',
                x: p.left - 6,
                y: scaleY(value) + 3,
                'text-anchor': 'end',
            });
            text.textContent = label;
            yLabels.append(text);
        }

        xLabels.replaceChildren();
        const [near, far] = xAxisLabels();
        for (const [distance, label] of [
            [0, near],
            [xMax, far],
        ] as [number, string][]) {
            const text = svgEl('text', {
                class: 'chart-x-label',
                x: scaleX(distance),
                y: height - 5,
                'text-anchor': distance === 0 ? 'start' : 'end',
            });
            text.textContent = label;
            xLabels.append(text);
        }

        for (const entry of drawn) {
            drawPath(entry);
        }

        // The markers carry pixel coordinates, so any change to the scale or the size
        // leaves them where they were until they are drawn again. A resize and a
        // metric switch both move the axis under them, and a paused ride gets no
        // transport tick to put them right, so they are put right here.
        update(lastElapsedMs);
    };

    /** Rebuild one ride's line, and the values its marker reads, for this metric. */
    const drawProfile = (entry: Drawn): void => {
        entry.points = buildProfile(entry.track, metric, MAX_PROFILE_POINTS);
        entry.values = metricValues(entry.track, metric);
        drawPath(entry);
    };

    const drawPath = (entry: Drawn): void => {
        const line = entry.line;
        let path = '';
        for (let i = 0; i < entry.points.length; i += 1) {
            const { distanceM, value } = entry.points[i];
            path += `${i === 0 ? 'M' : 'L'}${scaleX(distanceM).toFixed(1)} ${scaleY(value).toFixed(1)}`;
        }
        line.setAttribute('d', path);
    };

    /** Rebuild the y-axis, which every profile and dot is measured against. */
    const rescale = (): void => {
        const range = valueRange(drawn.map((entry) => entry.points));
        yMin = range.min;
        yMax = range.max;
        xMax = distanceRange(drawn.map((entry) => entry.points));
    };

    const render = (next: TrackState[]): void => {
        states = next;
        profiles.replaceChildren();
        dots.replaceChildren();
        drawn = [];

        const visible = states.filter(({ visible: shown }) => shown);
        for (const { track } of visible) {
            const line = svgEl('polyline', {
                class: 'chart-profile',
                fill: 'none',
                stroke: track.color,
                'stroke-opacity': PROFILE_OPACITY,
                'data-track-id': track.id,
            });
            const dot = svgEl('circle', {
                class: 'chart-dot',
                r: 3.5,
                fill: track.color,
                'data-track-id': track.id,
            });
            // A dashed guide down the plot at the distance this ride has reached, so
            // the marker can be read against the line and not just against the axis.
            // There is one per ride rather than one for the panel: the axis is
            // distance, so the rides are at different distances, and a single line
            // would have to mean one of them rather than all of them.
            const playhead = svgEl('line', {
                class: 'chart-playhead',
                stroke: track.color,
                'data-track-id': track.id,
            });
            profiles.append(line);
            guides.append(playhead);
            dots.append(dot);
            drawn.push({
                track,
                points: [],
                values: new Float64Array(0),
                line,
                dot,
                playhead,
                dotDistance: 0,
                dotValue: 0,
                dotX: 0,
            });
        }

        // The placeholder is the *empty* state, so it shows only when there is
        // nothing to plot. It is also given no box of its own, so leaving it in
        // while a chart is drawn would push the plot down and squash it.
        setHidden(empty, drawn.length > 0);
        setHidden(svg, drawn.length === 0);
        setHidden(controls, drawn.length === 0);
        describe(drawn.length);

        if (drawn.length === 0) {
            xMax = 0;
            yMin = 0;
            yMax = 1;
            return;
        }

        measure();
        // The profiles are built before the axis is measured, because the axis is
        // measured *from* them: rescaling first would read an empty range off them
        // and draw the whole chart against zero. Building them here rather than in
        // render's element loop also means each is walked once, not drawn against a
        // stale scale and then again against the real one — which on a 60,000 point
        // track is the difference between one pass and two.
        for (const entry of drawn) {
            drawProfile(entry);
        }
        rescale();
        layout();
    };

    const update = (elapsedMs: number): void => {
        lastElapsedMs = elapsedMs;
        if (drawn.length === 0) {
            return;
        }
        const p = plot();
        for (const entry of drawn) {
            const position = positionAt(entry.track, elapsedMs);
            const distanceM = distanceAt(entry.track, position);
            // Read the ride's own value at the playhead rather than looking it up by
            // distance. The two agree except across a recorded stop, where the
            // distance stops changing but the value does not.
            //
            // Plotted against distance, a stop is a vertical drop — the same distance
            // with the speed arriving above it and standing still below. A distance
            // lookup can only find the first of those two points, so a stopped
            // ride's dot would hang in the air at the speed it had on the way in.
            // Reading by time puts it at the foot of the drop, which is where the
            // line actually says the ride is.
            const value = valueAtTime(entry.values, position.index, position.fraction);
            const x = scaleX(distanceM);
            const y = scaleY(value);
            entry.dotDistance = distanceM;
            entry.dotValue = value;
            entry.dotX = x;
            entry.dot.setAttribute('cx', x.toFixed(1));
            entry.dot.setAttribute('cy', y.toFixed(1));
            entry.playhead.setAttribute('x1', x.toFixed(1));
            entry.playhead.setAttribute('y1', String(p.top));
            entry.playhead.setAttribute('x2', x.toFixed(1));
            entry.playhead.setAttribute('y2', String(p.top + p.height));
        }
    };

    const setMetric = (next: Metric): void => {
        if (next === metric) {
            return;
        }
        metric = next;
        for (const [id, button] of buttons) {
            button.setAttribute('aria-pressed', String(id === metric));
        }
        describe(drawn.length);
        for (const entry of drawn) {
            drawProfile(entry);
        }
        rescale();
        layout();
    };

    /**
     * Seek to the click, measured against the profile nearest it.
     *
     * The x-axis is distance but the playhead is a single shared moment, so one
     * click cannot put every ride exactly where the pointer is. It picks the ride
     * whose line the pointer is closest to and inverts *that* one, which lands
     * the ride you aimed at exactly and brings the others to the same moment —
     * the same rule the map follows.
     */
    svg.addEventListener('click', (event) => {
        if (drawn.length === 0 || xMax <= 0) {
            return;
        }
        const box = svg.getBoundingClientRect();
        // The viewBox is the SVG's own pixel size, so client coordinates map
        // straight onto it. Each axis is divided by its own ratio rather than one
        // shared factor, which keeps the click correct in the window between a
        // resize and the next paint, when the two ratios can differ.
        const x = (event.clientX - box.left) * (width > 0 ? width / (box.width || 1) : 1);
        const y = (event.clientY - box.top) * (height > 0 ? height / (box.height || 1) : 1);
        const distanceM = unscaleX(x);

        let nearest: Drawn | null = null;
        let nearestGap = Infinity;
        for (const entry of drawn) {
            const value = valueAtDistance(entry.points, distanceM);
            if (value === null) {
                continue;
            }
            const gap = Math.abs(scaleY(value) - y);
            if (gap < nearestGap) {
                nearestGap = gap;
                nearest = entry;
            }
        }
        if (!nearest) {
            return;
        }
        onSeek(timeAtDistance(nearest.track, distanceM));
    });

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
            if (drawn.length === 0) {
                return;
            }
            measure();
            layout();
        }).observe(container);
    }

    render([]);

    return {
        render,
        update,
        setMetric,
        getState: () => {
            const p = plot();
            return {
                metric,
                trackIds: drawn.map((entry) => entry.track.id),
                dots: drawn.map((entry) => ({
                    trackId: entry.track.id,
                    x: entry.dotX,
                    y: scaleY(entry.dotValue),
                    distanceM: entry.dotDistance,
                    value: entry.dotValue,
                })),
                xMax,
                yMin,
                yMax,
                yLabels: axisLabels(),
                xLabels: xAxisLabels(),
                plot: p,
            };
        },
    };
}

/**
 * SVG elements have no `hidden` property, so hiding goes through the attribute —
 * which is what the CSS keys off, and the only thing that works for both the
 * HTML controls and the plot.
 */
const setHidden = (element: Element, hidden: boolean): void => {
    if (hidden) {
        element.setAttribute('hidden', '');
    } else {
        element.removeAttribute('hidden');
    }
};

const svgEl = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, String(value));
    }
    return element;
};

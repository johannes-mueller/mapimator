export interface Bounds {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
}

export interface Track {
    id: string;
    name: string;
    color: string;
    t0: number;
    tRel: Float64Array;
    lat: Float64Array;
    lon: Float64Array;
    ele: Float32Array;
    dist: Float32Array;
    segmentBreaks: Uint32Array;
    durationMs: number;
    distanceM: number;
    bounds: Bounds;
    renderLine: number[];
}

export interface SamplePoint {
    lat: number;
    lon: number;
    ele: number;
    bearing: number;
    dist: number;
    speedMs: number;
    done: boolean;
}

export interface BasemapDef {
    id: string;
    label: string;
    styleUrl: string;
}

export type AlignMode = 'perTrackStart' | 'globalEarliest';

export interface TrackState {
    track: Track;
    visible: boolean;
    done: boolean;
}

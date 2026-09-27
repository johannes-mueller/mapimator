import type { ParsedTrack } from './parseGpx';

export interface ParseRequest {
    kind: 'parse';
    requestId: number;
    fileName: string;
    buffer: ArrayBuffer;
}

export type ParseResponse =
    | { kind: 'parsed'; requestId: number; tracks: ParsedTrack[] }
    | { kind: 'failed'; requestId: number; fileName: string; message: string };

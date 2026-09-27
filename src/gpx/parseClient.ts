import type { ParsedTrack } from './parseGpx';
import type { ParseRequest, ParseResponse } from './protocol';

export interface ParseResult {
    fileName: string;
    tracks: ParsedTrack[];
}

interface Pending {
    fileName: string;
    resolve: (tracks: ParsedTrack[]) => void;
    reject: (error: Error) => void;
}

/**
 * Main-thread handle on the parse worker. Files are handed over as
 * `ArrayBuffer`s and the parsed typed arrays come back the same way, so a large
 * file is never copied and never blocks the UI thread.
 */
export class GpxParseClient {
    private readonly worker: Worker;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private disposed = false;

    constructor() {
        this.worker = new Worker(new URL('./parseWorker.ts', import.meta.url), {
            type: 'module',
        });
        this.worker.addEventListener('message', this.onMessage);
        this.worker.addEventListener('error', this.onWorkerError);
        this.worker.addEventListener('messageerror', this.onWorkerError);
    }

    parseFile(file: File): Promise<ParseResult> {
        if (this.disposed) {
            return Promise.reject(new Error('Parser has been shut down.'));
        }
        return file.arrayBuffer().then(
            (buffer) =>
                new Promise<ParseResult>((resolve, reject) => {
                    const requestId = this.nextId;
                    this.nextId += 1;
                    this.pending.set(requestId, {
                        fileName: file.name,
                        resolve: (tracks) => {
                            resolve({ fileName: file.name, tracks });
                        },
                        reject,
                    });
                    const request: ParseRequest = {
                        kind: 'parse',
                        requestId,
                        fileName: file.name,
                        buffer,
                    };
                    this.worker.postMessage(request, [buffer]);
                }),
        );
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.worker.removeEventListener('message', this.onMessage);
        this.worker.removeEventListener('error', this.onWorkerError);
        this.worker.removeEventListener('messageerror', this.onWorkerError);
        this.worker.terminate();
        for (const { fileName, reject } of this.pending.values()) {
            reject(new Error(`Parsing "${fileName}" was cancelled.`));
        }
        this.pending.clear();
    }

    private readonly onMessage = (event: MessageEvent<ParseResponse>): void => {
        const response = event.data;
        const entry = this.pending.get(response.requestId);
        if (!entry) {
            return;
        }
        this.pending.delete(response.requestId);

        if (response.kind === 'parsed') {
            entry.resolve(response.tracks);
        } else {
            entry.reject(new Error(response.message));
        }
    };

    private readonly onWorkerError = (event: ErrorEvent | MessageEvent): void => {
        const reason =
            'message' in event && typeof event.message === 'string'
                ? event.message
                : 'The parser worker stopped unexpectedly.';
        for (const [, entry] of this.pending) {
            entry.reject(new Error(reason));
        }
        this.pending.clear();
    };
}

import { decodeGpx, parseGpx } from './parseGpx';
import type { ParseRequest, ParseResponse } from './protocol';

// The app's tsconfig includes both `dom` and `webworker`, so `self` is
// ambiguous; the cast states which scope this module actually runs in.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<ParseRequest>) => {
    const request = event.data;
    if (request.kind !== 'parse') {
        return;
    }

    let response: ParseResponse;
    try {
        const tracks = parseGpx(decodeGpx(request.buffer), request.fileName);
        response = { kind: 'parsed', requestId: request.requestId, tracks };
    } catch (error) {
        response = {
            kind: 'failed',
            requestId: request.requestId,
            fileName: request.fileName,
            message: error instanceof Error ? error.message : String(error),
        };
    }

    const transfer: Transferable[] = [];
    if (response.kind === 'parsed') {
        for (const track of response.tracks) {
            // Hand the buffers over rather than copying them. They are dead on
            // this side once posted, and none of them is aliased or subarrayed.
            transfer.push(
                track.tRel.buffer as ArrayBuffer,
                track.lat.buffer as ArrayBuffer,
                track.lon.buffer as ArrayBuffer,
                track.ele.buffer as ArrayBuffer,
                track.dist.buffer as ArrayBuffer,
                track.segmentBreaks.buffer as ArrayBuffer,
            );
        }
    }

    ctx.postMessage(response, transfer);
});

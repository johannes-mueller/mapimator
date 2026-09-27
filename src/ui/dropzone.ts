export interface DropzoneOptions {
    button: HTMLButtonElement;
    input: HTMLInputElement;
    onFiles: (accepted: File[], rejectedCount: number) => void;
}

export interface Dropzone {
    setBusy: (busy: boolean) => void;
    setStatus: (message: string | null, tone: 'error' | 'info') => void;
}

const GPX_MIME_TYPES = new Set([
    'application/gpx+xml',
    'application/xml',
    'text/xml',
    'text/plain',
]);

/**
 * A dragged file often carries no useful MIME type, so an explicit extension
 * decides. When a name *has* an extension, that is stronger evidence than the
 * type: a `.txt` file is not a GPX file, even though browsers label it
 * `text/plain` and a lenient type-only check would hand it to the parser and
 * report a confusing "no track points" error.
 */
function looksLikeGpx(file: File): boolean {
    const name = file.name.toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
        return name.slice(dot) === '.gpx';
    }
    return GPX_MIME_TYPES.has(file.type);
}

export function createDropzone(options: DropzoneOptions): Dropzone {
    const { button, input, onFiles } = options;
    const title = button.querySelector<HTMLElement>('.dz-title');
    const hint = button.querySelector<HTMLElement>('.dz-hint');
    const idleTitle = title?.textContent ?? 'Drop GPX files';
    const idleHint = hint?.textContent ?? 'or click to browse';

    let busy = false;
    // dragenter/dragleave also fire for child elements, so a depth counter is
    // what keeps the highlight from flickering as the pointer crosses them.
    let dragDepth = 0;

    const setHint = (text: string): void => {
        if (hint) {
            hint.textContent = text;
        }
    };

    const emit = (files: File[]): void => {
        if (busy || files.length === 0) {
            return;
        }
        const accepted = files.filter(looksLikeGpx);
        onFiles(accepted, files.length - accepted.length);
    };

    button.addEventListener('click', () => {
        if (!busy) {
            input.click();
        }
    });

    input.addEventListener('change', () => {
        const files = input.files ? [...input.files] : [];
        // Reset so picking the same file twice in a row still fires `change`.
        input.value = '';
        emit(files);
    });

    button.addEventListener('dragenter', (event) => {
        event.preventDefault();
        dragDepth += 1;
        if (!busy) {
            button.classList.add('is-dragover');
        }
    });

    button.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    });

    button.addEventListener('dragleave', (event) => {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            button.classList.remove('is-dragover');
        }
    });

    button.addEventListener('drop', (event) => {
        event.preventDefault();
        dragDepth = 0;
        button.classList.remove('is-dragover');
        const files = event.dataTransfer?.files;
        emit(files ? [...files] : []);
    });

    return {
        setBusy: (next: boolean) => {
            busy = next;
            button.disabled = next;
            button.setAttribute('aria-busy', String(next));
            if (title) {
                title.textContent = next ? 'Parsing…' : idleTitle;
            }
            if (!next) {
                button.classList.remove('is-dragover');
                dragDepth = 0;
                setHint(idleHint);
            }
        },
        setStatus: (message, tone) => {
            if (!hint) {
                return;
            }
            if (message === null) {
                hint.textContent = idleHint;
                button.classList.remove('has-error', 'has-info');
                return;
            }
            hint.textContent = message;
            button.classList.toggle('has-error', tone === 'error');
            button.classList.toggle('has-info', tone === 'info');
        },
    };
}

/**
 * The About overlay: a button that opens a modal <dialog> describing the app.
 *
 * Backdrop clicks close it too. showModal's backdrop belongs to the dialog
 * element itself, so a click on the backdrop (or on the dialog's own padding)
 * arrives with the dialog as its event target, while a click on the content
 * hits a child element instead. Checking the target is what tells the two
 * apart — closing on every click would also close on the first click on the
 * text. The close happens on `click`, not `pointerdown`: closing any earlier
 * would tear the dialog out from under a gesture still in flight, and the rest
 * of that gesture would land on whatever is underneath and steal the focus the
 * dialog's close is about to hand back to the About button. Escape and the
 * focus shift into and out of the dialog are the native <dialog> behaviour and
 * need no code here.
 */
export function createAboutDialog({
    button,
    dialog,
    closeButton,
}: {
    button: HTMLButtonElement;
    dialog: HTMLDialogElement;
    closeButton: HTMLButtonElement;
}): void {
    button.addEventListener('click', () => dialog.showModal());
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) {
            dialog.close();
        }
    });
}

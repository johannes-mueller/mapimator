/**
 * The About overlay is pure shell behaviour — no GPX files are needed, and the
 * checks drive only the button, the dialog, and the keyboard/mouse.
 */
export const fixtures = [];

const TEXT = {
    title: 'About Mapimator',
    lead: 'Mapimator animates multiple GPX runs at the same time, on a shared clock, over a switchable OpenStreetMap basemap.',
    privacy: 'never uploaded anywhere',
    bullets: [
        'Five switchable basemaps: Liberty, Positron, Bright, Fiord, and Dark',
        'Playback from 1× to 300×, with a scrubbable timeline and full keyboard control',
        'A legend that can hide or remove individual runs',
        'An elevation and speed chart per run, drawn from a terrain model',
        'A camera that follows a played run until you take over',
    ],
};

/** The bits of the dialog worth asserting, read in one round trip. */
async function dialogState(page) {
    return page.evaluate(() => {
        const dialog = document.getElementById('about-dialog');
        const box = dialog?.getBoundingClientRect();
        return {
            open: dialog?.open ?? null,
            display: dialog ? getComputedStyle(dialog).display : null,
            visible: Boolean(box && box.width > 0 && box.height > 0),
            labelledBy: dialog?.getAttribute('aria-labelledby') ?? null,
            ariaModal: dialog?.getAttribute('aria-modal') ?? null,
            title: dialog?.querySelector('#about-title')?.textContent?.trim() ?? null,
            focusInDialog: Boolean(dialog?.contains(document.activeElement)),
            activeId: document.activeElement?.id ?? null,
            text: (dialog?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        };
    });
}

const closedAndFocusedBack = (s) => s.open === false && s.activeId === 'about-button';

export async function run({ page, suite, errors, url }) {
    suite.section('ABOUT OVERLAY');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.mapimator?.areTrackLayersAttached(), null, {
        timeout: 30_000,
    });

    const before = await dialogState(page);
    suite.check(
        'closed before anything asks for it',
        before.open === false && before.display === 'none',
        JSON.stringify({ open: before.open, display: before.display }),
    );

    await page.click('#about-button');
    const open = await dialogState(page);
    suite.check(
        'opens on click of the About button',
        open.open === true && open.visible,
        JSON.stringify({ open: open.open, visible: open.visible }),
    );
    suite.check(
        'and announces itself as a labelled modal',
        open.ariaModal === 'true' && open.labelledBy === 'about-title' && open.title === TEXT.title,
        JSON.stringify({
            ariaModal: open.ariaModal,
            labelledBy: open.labelledBy,
            title: open.title,
        }),
    );
    suite.check(
        'focus moves into the dialog while it is open',
        open.focusInDialog,
        String(open.activeId),
    );

    let pos = -1;
    const described =
        open.text.includes(TEXT.lead) &&
        TEXT.bullets.every((bullet) => {
            const at = open.text.indexOf(bullet);
            const inOrder = at > pos;
            pos = Math.max(pos, at);
            return at !== -1 && inOrder;
        });
    suite.check(
        'the description is the app, in its own run vocabulary',
        described,
        open.text.slice(0, 120),
    );
    suite.check(
        'and it promises no data leaves the machine',
        open.text.includes(TEXT.privacy),
        String(open.text.includes(TEXT.privacy)),
    );

    await page.click('#about-dialog p');
    const stillOpen = await dialogState(page);
    suite.check('clicks inside the content leave it open', stillOpen.open === true);

    await page.click('#about-close');
    const closeByX = await dialogState(page);
    suite.check(
        'the × closes it and hands focus back to About',
        closedAndFocusedBack(closeByX),
        JSON.stringify({ open: closeByX.open, active: closeByX.activeId }),
    );

    // Recover state before each reopen: if a close path above failed, the
    // modal dialog is still open and would swallow the next click into a
    // timeout. Pressing Escape closes a leftover dialog and is a no-op
    // otherwise, so one failure no longer cascades into the next check.
    await page.keyboard.press('Escape');
    await page.click('#about-button');
    await page.keyboard.press('Escape');
    const closeByEsc = await dialogState(page);
    suite.check(
        'Escape closes it and hands focus back to About',
        closedAndFocusedBack(closeByEsc),
        JSON.stringify({ open: closeByEsc.open, active: closeByEsc.activeId }),
    );

    await page.keyboard.press('Escape');
    await page.click('#about-button');
    const box = await page.evaluate(() => {
        const b = document.getElementById('about-dialog').getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    // Top-left of the dialog's box is solidly on the backdrop, nowhere near
    // the content, and the backdrop belongs to the dialog — the check the
    // pointerdown handler relies on.
    await page.mouse.click(
        Math.max(1, Math.round(box.x - 12)),
        Math.max(1, Math.round(box.y - 12)),
    );
    const closeByBackdrop = await dialogState(page);
    suite.check(
        'a click on the backdrop closes it and hands focus back to About',
        closedAndFocusedBack(closeByBackdrop),
        JSON.stringify({ open: closeByBackdrop.open, active: closeByBackdrop.activeId }),
    );

    await page.keyboard.press('Escape');
    await page.click('#about-button');
    const reopened = await dialogState(page);
    suite.check(
        'and it can be opened again afterwards',
        reopened.open === true,
        String(reopened.open),
    );

    suite.section('CONSOLE');
    const realErrors = errors.filter((e) => !/favicon/i.test(e));
    suite.check(
        'no console errors while working the overlay',
        realErrors.length === 0,
        realErrors.slice(0, 3).join(' || '),
    );
}

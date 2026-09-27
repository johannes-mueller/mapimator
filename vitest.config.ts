import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // src/ holds the app's own logic; e2e/ holds the harness the browser
        // suite depends on, which is testable without launching a browser.
        include: ['src/**/*.test.ts', 'e2e/**/*.test.mjs'],
        environment: 'node',
        // The worker and MapLibre are not under test here, so nothing needs a DOM.
        restoreMocks: true,
    },
});

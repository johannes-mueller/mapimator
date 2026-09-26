import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
        // The worker and MapLibre are not under test here, so nothing needs a DOM.
        restoreMocks: true,
    },
});

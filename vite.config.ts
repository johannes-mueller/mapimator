import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        target: 'es2022',
        outDir: 'dist',
        sourcemap: true,
    },
    worker: {
        format: 'es',
    },
    server: {
        port: 5173,
    },
});

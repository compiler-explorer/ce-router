import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules/', 'dist/', '*.config.ts', '*.config.js', 'coverage/', 'test/mocks/**'],
        },
        include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
        mockReset: true,
        restoreMocks: true,
        clearMocks: true,
    },
});

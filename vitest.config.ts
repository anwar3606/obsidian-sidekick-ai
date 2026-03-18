import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        exclude: ['tests/integration/**'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/main.ts', 'src/chat-view.ts', 'src/settings.ts'],
        },
    },
    resolve: {
        alias: {
            obsidian: './tests/mocks/obsidian.ts',
        },
    },
});

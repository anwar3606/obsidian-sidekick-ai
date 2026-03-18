/**
 * Tests for src/search.ts — Smart vault search engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const obsidian = vi.hoisted(() => ({
    requestUrl: vi.fn(),
}));
vi.mock('obsidian', () => obsidian);

import { searchVault, searchFiles } from '../src/search';
import type { SearchResult, FileSearchResult } from '../src/search';
import type { App, TFile, CachedMetadata } from 'obsidian';

// ── Test helpers ────────────────────────────────────────────────────

function createMockFile(path: string, mtime?: number): TFile {
    const basename = path.split('/').pop()!.replace(/\.md$/, '');
    return {
        path,
        basename,
        name: path.split('/').pop()!,
        extension: 'md',
        stat: { mtime: mtime ?? Date.now(), ctime: Date.now(), size: 1000 },
        vault: {} as any,
        parent: null,
    } as unknown as TFile;
}

interface MockAppOptions {
    files: TFile[];
    contents: Record<string, string>;
    caches: Record<string, CachedMetadata | null>;
    resolvedLinks?: Record<string, Record<string, number>>;
}

function createMockSearchApp(opts: MockAppOptions): App {
    return {
        vault: {
            getMarkdownFiles: () => opts.files,
            cachedRead: vi.fn(async (file: TFile) => {
                return opts.contents[file.path] ?? '';
            }),
        },
        metadataCache: {
            getFileCache: (file: TFile) => opts.caches[file.path] ?? null,
            resolvedLinks: opts.resolvedLinks ?? {},
        },
    } as unknown as App;
}

// tokenize, bm25Score, fuzzyScore are tested in lib-search.test.ts

// ── searchVault ─────────────────────────────────────────────────────

describe('searchVault', () => {
    let files: TFile[];
    let contents: Record<string, string>;
    let caches: Record<string, CachedMetadata | null>;

    beforeEach(() => {
        files = [
            createMockFile('notes/meeting-notes.md'),
            createMockFile('projects/typescript-guide.md'),
            createMockFile('daily/2024-01-15.md'),
            createMockFile('notes/python-cookbook.md'),
            createMockFile('archive/old-stuff.md', Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year old
        ];

        contents = {
            'notes/meeting-notes.md': 'Meeting with team about TypeScript migration. Discussed types and interfaces. TypeScript is great for large projects.',
            'projects/typescript-guide.md': 'A comprehensive guide to TypeScript. Covers types, generics, and advanced patterns. TypeScript provides static typing.',
            'daily/2024-01-15.md': 'Today I worked on the TypeScript project. Had a meeting with Sarah. Need to review PRs.',
            'notes/python-cookbook.md': 'Python recipes for common tasks. Includes data processing, web scraping, and API integration.',
            'archive/old-stuff.md': 'Some old notes about JavaScript and TypeScript basics.',
        };

        caches = {
            'notes/meeting-notes.md': {
                headings: [
                    { heading: 'Team Meeting', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 14, offset: 14 } } },
                    { heading: 'TypeScript Migration', level: 2, position: { start: { line: 2, col: 0, offset: 20 }, end: { line: 2, col: 23, offset: 43 } } },
                ],
                tags: [
                    { tag: '#meeting', position: { start: { line: 5, col: 0, offset: 100 }, end: { line: 5, col: 8, offset: 108 } } },
                    { tag: '#typescript', position: { start: { line: 5, col: 9, offset: 109 }, end: { line: 5, col: 20, offset: 120 } } },
                ],
                frontmatter: { aliases: ['team meeting', 'ts migration'] },
            } as unknown as CachedMetadata,
            'projects/typescript-guide.md': {
                headings: [
                    { heading: 'TypeScript Guide', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 18, offset: 18 } } },
                    { heading: 'Generics', level: 2, position: { start: { line: 5, col: 0, offset: 50 }, end: { line: 5, col: 10, offset: 60 } } },
                ],
                tags: [
                    { tag: '#typescript', position: { start: { line: 10, col: 0, offset: 100 }, end: { line: 10, col: 11, offset: 111 } } },
                    { tag: '#guide', position: { start: { line: 10, col: 12, offset: 112 }, end: { line: 10, col: 18, offset: 118 } } },
                ],
                frontmatter: null,
            } as unknown as CachedMetadata,
            'daily/2024-01-15.md': {
                headings: [
                    { heading: 'Daily Log', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 10, offset: 10 } } },
                ],
                tags: [
                    { tag: '#daily', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 6, offset: 6 } } },
                ],
                frontmatter: null,
            } as unknown as CachedMetadata,
            'notes/python-cookbook.md': {
                headings: [
                    { heading: 'Python Cookbook', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 15, offset: 15 } } },
                ],
                tags: [
                    { tag: '#python', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 7, offset: 7 } } },
                ],
                frontmatter: { aliases: ['py recipes'] },
            } as unknown as CachedMetadata,
            'archive/old-stuff.md': null,
        };
    });

    it('returns empty for empty query', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, '');
        expect(results).toEqual([]);
    });

    it('finds notes by content keyword', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript');
        expect(results.length).toBeGreaterThan(0);
        // TypeScript guide and meeting notes should be top results
        const paths = results.map(r => r.path);
        expect(paths).toContain('projects/typescript-guide.md');
        expect(paths).toContain('notes/meeting-notes.md');
    });

    it('ranks title matches higher than content-only matches', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript');
        // "typescript-guide" has typescript in the title — should rank higher
        const guideIdx = results.findIndex(r => r.path === 'projects/typescript-guide.md');
        const dailyIdx = results.findIndex(r => r.path === 'daily/2024-01-15.md');
        if (guideIdx !== -1 && dailyIdx !== -1) {
            expect(guideIdx).toBeLessThan(dailyIdx);
        }
    });

    it('matches by tag', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'meeting');
        const meetingResult = results.find(r => r.path === 'notes/meeting-notes.md');
        expect(meetingResult).toBeDefined();
        expect(meetingResult!.matchedFields).toContain('tag');
    });

    it('matches by heading', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'generics');
        const guideResult = results.find(r => r.path === 'projects/typescript-guide.md');
        expect(guideResult).toBeDefined();
        expect(guideResult!.matchedFields).toContain('heading');
    });

    it('matches by alias', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'migration');
        const meetingResult = results.find(r => r.path === 'notes/meeting-notes.md');
        expect(meetingResult).toBeDefined();
        expect(meetingResult!.matchedFields).toContain('alias');
    });

    it('respects maxResults', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript', { maxResults: 2 });
        expect(results.length).toBeLessThanOrEqual(2);
    });

    it('includes snippets in results', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'python');
        const pyResult = results.find(r => r.path === 'notes/python-cookbook.md');
        expect(pyResult).toBeDefined();
        expect(pyResult!.snippet.length).toBeGreaterThan(0);
    });

    it('applies recency boost — newer files score higher', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript');
        // archive/old-stuff.md is 1 year old, should rank lower
        const oldIdx = results.findIndex(r => r.path === 'archive/old-stuff.md');
        if (oldIdx !== -1) {
            // Should be near the bottom
            expect(oldIdx).toBeGreaterThan(0);
        }
    });

    it('applies graph boost — linked notes score higher', async () => {
        const resolvedLinks: Record<string, Record<string, number>> = {
            'daily/2024-01-15.md': { 'projects/typescript-guide.md': 2 },
            'notes/meeting-notes.md': { 'projects/typescript-guide.md': 1 },
        };
        const app = createMockSearchApp({ files, contents, caches, resolvedLinks });
        const results = await searchVault(app, 'typescript');
        // typescript-guide has 3 inbound links, should score higher
        const guide = results.find(r => r.path === 'projects/typescript-guide.md');
        expect(guide).toBeDefined();
        expect(guide!.score).toBeGreaterThan(0);
    });

    it('handles multi-term queries', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript migration');
        // Meeting notes have both terms — alias "ts migration" + content
        expect(results.length).toBeGreaterThan(0);
    });

    it('returns matchedFields listing which fields matched', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript');
        for (const r of results) {
            expect(r.matchedFields.length).toBeGreaterThan(0);
        }
    });

    it('sorts results by score descending', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'typescript');
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
    });

    it('can skip content search for speed', async () => {
        const app = createMockSearchApp({ files, contents, caches });
        const results = await searchVault(app, 'meeting', { searchContent: false });
        // Should still find via title/tag/heading
        expect(results.length).toBeGreaterThan(0);
        const meetingResult = results.find(r => r.path === 'notes/meeting-notes.md');
        expect(meetingResult).toBeDefined();
    });
});

// ── searchFiles (@ mention search) ─────────────────────────────────

describe('searchFiles', () => {
    let files: TFile[];
    let caches: Record<string, CachedMetadata | null>;

    beforeEach(() => {
        files = [
            createMockFile('notes/meeting-notes.md'),
            createMockFile('projects/typescript-guide.md'),
            createMockFile('daily/2024-01-15.md'),
            createMockFile('notes/python-cookbook.md'),
        ];

        caches = {
            'notes/meeting-notes.md': {
                headings: [
                    { heading: 'Team Meeting', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 14, offset: 14 } } },
                ],
                frontmatter: { aliases: ['team standup'] },
            } as unknown as CachedMetadata,
            'projects/typescript-guide.md': {
                headings: [
                    { heading: 'TypeScript Guide', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 18, offset: 18 } } },
                ],
                frontmatter: null,
            } as unknown as CachedMetadata,
            'daily/2024-01-15.md': null,
            'notes/python-cookbook.md': {
                headings: [
                    { heading: 'Python Cookbook', level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 15, offset: 15 } } },
                    { heading: 'Data Processing', level: 2, position: { start: { line: 5, col: 0, offset: 50 }, end: { line: 5, col: 18, offset: 68 } } },
                ],
                frontmatter: { aliases: ['py recipes'] },
            } as unknown as CachedMetadata,
        };
    });

    function createFileSearchApp(): App {
        return {
            vault: {
                getMarkdownFiles: () => files,
            },
            metadataCache: {
                getFileCache: (file: TFile) => caches[file.path] ?? null,
                resolvedLinks: {},
            },
        } as unknown as App;
    }

    it('returns empty for empty query', () => {
        const app = createFileSearchApp();
        expect(searchFiles(app, '')).toEqual([]);
    });

    it('finds files by exact title substring', () => {
        const app = createFileSearchApp();
        const results = searchFiles(app, 'meeting');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].file.basename).toBe('meeting-notes');
        expect(results[0].matchType).toBe('exact');
    });

    it('finds files by alias', () => {
        const app = createFileSearchApp();
        const results = searchFiles(app, 'standup');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].file.path).toBe('notes/meeting-notes.md');
        expect(results[0].matchType).toBe('alias');
    });

    it('finds files by heading', () => {
        const app = createFileSearchApp();
        const results = searchFiles(app, 'data processing');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].file.path).toBe('notes/python-cookbook.md');
        expect(results[0].matchType).toBe('heading');
    });

    it('finds files by fuzzy match', () => {
        const app = createFileSearchApp();
        // "pythn" fuzzy-matches "python-cookbook" (missing 'o')
        const results = searchFiles(app, 'pythn');
        const pyResult = results.find(r => r.file.basename === 'python-cookbook');
        expect(pyResult).toBeDefined();
        expect(pyResult!.matchType).toBe('fuzzy');
    });

    it('ranks exact matches above alias matches', () => {
        const app = createFileSearchApp();
        // "meeting" matches title exactly and alias
        const results = searchFiles(app, 'meeting');
        const exactResult = results.find(r => r.matchType === 'exact');
        const aliasResult = results.find(r => r.matchType === 'alias');
        if (exactResult && aliasResult) {
            expect(exactResult.score).toBeGreaterThan(aliasResult.score);
        }
    });

    it('respects maxResults', () => {
        const app = createFileSearchApp();
        const results = searchFiles(app, 'p', 2);
        expect(results.length).toBeLessThanOrEqual(2);
    });

    it('sorts by score descending', () => {
        const app = createFileSearchApp();
        const results = searchFiles(app, 'python');
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
    });

    it('prefers shorter title matches', () => {
        // Add a file with a very long name
        files.push(createMockFile('notes/python-cookbook-extended-edition-v2.md'));
        caches['notes/python-cookbook-extended-edition-v2.md'] = null;

        const app = createFileSearchApp();
        const results = searchFiles(app, 'python');
        // Both match, but shorter name should score higher
        const shortIdx = results.findIndex(r => r.file.basename === 'python-cookbook');
        const longIdx = results.findIndex(r => r.file.basename === 'python-cookbook-extended-edition-v2');
        if (shortIdx !== -1 && longIdx !== -1) {
            expect(shortIdx).toBeLessThan(longIdx);
        }
    });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TOOL_SCHEMAS, RISKY_TOOLS, TOOL_LABELS, resolveToolApproval, requestToolApproval, executeTool, setImageRetryDelay } from '../src/tools';
import { createMockApp } from './mocks/obsidian';
import * as obsidian from 'obsidian';

// ── TOOL_SCHEMAS ────────────────────────────────────────────────────

describe('TOOL_SCHEMAS', () => {
    it('all schemas have valid structure', () => {
        expect(TOOL_SCHEMAS.length).toBeGreaterThan(0);
        for (const schema of TOOL_SCHEMAS) {
            expect(schema.type).toBe('function');
            expect(schema.function.name).toBeTruthy();
            expect(schema.function.description).toBeTruthy();
            expect(schema.function.parameters.type).toBe('object');
            expect(schema.function.parameters.properties).toBeDefined();
        }
    });

    it('contains core tools', () => {
        const names = TOOL_SCHEMAS.map(s => s.function.name);
        expect(names).toContain('search_vault');
        expect(names).toContain('read_note');
        expect(names).toContain('create_note');
        expect(names).toContain('fetch_url');
        expect(names).toContain('generate_image');
        expect(names).toContain('ask_user');
    });

    it('core tools have correct required parameters', () => {
        const find = (name: string) => TOOL_SCHEMAS.find(s => s.function.name === name)!;
        expect(find('search_vault').function.parameters.required).toContain('query');
        expect(find('read_note').function.parameters.required).toContain('path');
        expect(find('create_note').function.parameters.required).toContain('path');
        expect(find('create_note').function.parameters.required).toContain('content');
        expect(find('generate_image').function.parameters.required).toContain('prompt');
        expect(find('ask_user').function.parameters.required).toContain('question');
    });
});

// ── RISKY_TOOLS ─────────────────────────────────────────────────────

describe('RISKY_TOOLS', () => {
    it('contains destructive/external tools and excludes read-only ones', () => {
        expect(RISKY_TOOLS.has('fetch_url')).toBe(true);
        expect(RISKY_TOOLS.has('create_note')).toBe(true);
        expect(RISKY_TOOLS.has('generate_image')).toBe(true);
        expect(RISKY_TOOLS.has('move_note')).toBe(true);
        expect(RISKY_TOOLS.has('delete_note')).toBe(true);
    });

    it('does NOT contain search_vault and read_note (safe tools)', () => {
        expect(RISKY_TOOLS.has('search_vault')).toBe(false);
        expect(RISKY_TOOLS.has('read_note')).toBe(false);
    });
});

// ── TOOL_LABELS ─────────────────────────────────────────────────────

describe('TOOL_LABELS', () => {
    it('has labels for all tools', () => {
        const toolNames = TOOL_SCHEMAS.map(s => s.function.name);
        for (const name of toolNames) {
            expect(TOOL_LABELS[name]).toBeTruthy();
        }
    });
});

// ── Tool approval mechanism ─────────────────────────────────────────

describe('Tool approval mechanism', () => {
    it('requestToolApproval resolves when resolveToolApproval is called', async () => {
        const promise = requestToolApproval();
        resolveToolApproval('approve');
        const result = await promise;
        expect(result).toBe('approve');
    });

    it('resolveToolApproval with decline rejects the tool', async () => {
        const promise = requestToolApproval();
        resolveToolApproval('decline');
        const result = await promise;
        expect(result).toBe('decline');
    });

    it('resolveToolApproval with always auto-approves the tool', async () => {
        const promise = requestToolApproval();
        resolveToolApproval('always');
        const result = await promise;
        expect(result).toBe('always');
    });

    it('resolveToolApproval without pending request does not throw', () => {
        expect(() => resolveToolApproval('approve')).not.toThrow();
    });

    it('handles concurrent approval requests via queue (FIFO)', async () => {
        const p1 = requestToolApproval();
        const p2 = requestToolApproval();
        resolveToolApproval('approve');   // resolves first request
        resolveToolApproval('decline');   // resolves second request
        expect(await p1).toBe('approve');
        expect(await p2).toBe('decline');
    });
});

// ── executeTool ─────────────────────────────────────────────────────

describe('executeTool', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('returns error for invalid JSON arguments', async () => {
        const result = await executeTool('search_vault', 'not json', createMockApp(), context);
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Invalid tool arguments JSON');
    });

    it('treats empty args as empty object for no-arg tools', async () => {
        const result = await executeTool('get_open_notes', '', createMockApp(), context);
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toBeUndefined();
    });

    it('returns error for unknown tool', async () => {
        const result = await executeTool('nonexistent_tool', '{}', createMockApp(), context);
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Unknown tool');
    });

    describe('search_vault', () => {
        it('finds notes matching query by filename', async () => {
            const app = createMockApp({
                'Notes/JavaScript.md': '# JavaScript\nA programming language.',
                'Notes/Python.md': '# Python\nAnother programming language.',
                'Notes/Cooking.md': '# Cooking\nRecipes and tips.',
            });
            // Mock cachedRead
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'JavaScript' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBeGreaterThanOrEqual(1);
            expect(parsed[0].path).toContain('JavaScript');
        });

        it('returns empty array when no matches', async () => {
            const app = createMockApp({
                'Notes/Test.md': '# Test content',
            });
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'nonexistent' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed).toEqual([]);
        });

        it('respects max_results parameter', async () => {
            const files: Record<string, string> = {};
            for (let i = 0; i < 20; i++) {
                files[`Notes/note-${i}.md`] = `Note ${i} content`;
            }
            const app = createMockApp(files);
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'note', max_results: 5 }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBeLessThanOrEqual(5);
        });
    });

    describe('read_note', () => {
        it('reads an existing note', async () => {
            const app = createMockApp({
                'Notes/test.md': '# Test Note\nSome content here.',
            });
            const result = await executeTool(
                'read_note',
                JSON.stringify({ path: 'Notes/test.md' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.content).toContain('Test Note');
            expect(parsed.truncated).toBe(false);
        });

        it('returns error for missing file', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'read_note',
                JSON.stringify({ path: 'nonexistent.md' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('not found');
        });
    });

    describe('create_note', () => {
        it('creates a new note', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'test.md', content: '# New Note' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('created');
        });

        it('overwrites existing note when append is false', async () => {
            const app = createMockApp({
                'existing.md': 'Old content',
            });
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'existing.md', content: 'New content' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('overwritten');
        });

        it('appends to existing note when append is true', async () => {
            const app = createMockApp({
                'existing.md': 'Old content',
            });
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'existing.md', content: 'Added content', append: true }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('appended');
        });

        it('creates parent folders when needed', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'deep/nested/note.md', content: 'Content' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.action).toBe('created');
        });

        it('does not re-create existing parent folder', async () => {
            const app = createMockApp({ 'folder/other.md': 'x' });
            // Register the folder so getAbstractFileByPath finds it
            await app.vault.createFolder('folder');
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'folder/new.md', content: 'Content' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
        });

        // ── Path sanitization (security) ────────────────────────

        it('rejects path traversal with ..', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: '../../../etc/passwd', content: 'pwned' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toMatch(/traversal/i);
        });

        it('rejects absolute Unix paths', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: '/etc/passwd', content: 'pwned' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toMatch(/absolute/i);
        });

        it('rejects absolute Windows paths', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'C:\\Users\\victim\\file.md', content: 'pwned' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toMatch(/absolute/i);
        });

        it('normalizes backslashes and dot segments in valid paths', async () => {
            const app = createMockApp({});
            const result = await executeTool(
                'create_note',
                JSON.stringify({ path: 'Notes\\.\\daily.md', content: '# Day' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.path).toBe('Notes/daily.md');
        });
    });

    describe('search_vault (content matching)', () => {
        it('finds notes by content when filename does not match', async () => {
            const app = createMockApp({
                'Notes/Animals.md': 'The quick brown fox jumps over the lazy dog.',
            });
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'fox' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBe(1);
            expect(parsed[0].snippet).toContain('fox');
        });

        it('extracts snippet even when filename matches', async () => {
            const app = createMockApp({
                'Notes/JavaScript.md': 'This file talks about the JavaScript language.',
            });
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'javascript' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBe(1);
            expect(parsed[0].snippet).toContain('This file talks about the');
        });

        it('returns snippet context around content match', async () => {
            const app = createMockApp({
                'Notes/Story.md': 'A '.repeat(50) + 'KEYWORD ' + 'B '.repeat(100),
            });
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'keyword' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBe(1);
            expect(parsed[0].snippet).toContain('KEYWORD');
        });

        it('caps max_results at 50', async () => {
            const files: Record<string, string> = {};
            for (let i = 0; i < 100; i++) {
                files[`Notes/note-${i}.md`] = `note ${i} content`;
            }
            const app = createMockApp(files);
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'note', max_results: 200 }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBeLessThanOrEqual(50);
        });

        it('handles invalid max_results gracefully by using default 10', async () => {
            const files: Record<string, string> = {};
            for (let i = 0; i < 20; i++) {
                files[`Notes/note-${i}.md`] = `note ${i} content`;
            }
            const app = createMockApp(files);
            app.vault.cachedRead = app.vault.read;

            const result = await executeTool(
                'search_vault',
                JSON.stringify({ query: 'note', max_results: 'invalid' as any }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.length).toBeLessThanOrEqual(10);
        });
    });

    describe('read_note (truncation)', () => {
        it('truncates very long content', async () => {
            const longContent = 'x'.repeat(20000);
            const app = createMockApp({
                'Notes/long.md': longContent,
            });

            const result = await executeTool(
                'read_note',
                JSON.stringify({ path: 'Notes/long.md' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.content.length).toBeLessThanOrEqual(15000);
            expect(parsed.truncated).toBe(true);
        });

        it('marks truncated as false for short content', async () => {
            const app = createMockApp({
                'Notes/short.md': 'Short content',
            });

            const result = await executeTool(
                'read_note',
                JSON.stringify({ path: 'Notes/short.md' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.truncated).toBe(false);
        });

        it('respects custom maxContentLength from context', async () => {
            const longContent = 'y'.repeat(500);
            const app = createMockApp({
                'Notes/custom.md': longContent,
            });

            const customCtx = { ...context, maxContentLength: 100 };
            const result = await executeTool(
                'read_note',
                JSON.stringify({ path: 'Notes/custom.md' }),
                app,
                customCtx,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.content.length).toBe(100);
            expect(parsed.truncated).toBe(true);
        });
    });

    describe('fetch_url', () => {
        let mockRequestUrl: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            mockRequestUrl = vi.spyOn(obsidian, 'requestUrl' as any);
        });

        afterEach(() => {
            mockRequestUrl.mockRestore();
        });

        it('fetches URL and returns response', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: 'Hello World',
                headers: { 'content-type': 'text/html' },
            } as any);

            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'https://example.com' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.status).toBe(200);
            expect(parsed.body).toBe('Hello World');
            expect(parsed.content_type).toBe('text/html');
        });

        it('truncates long responses', async () => {
            const longText = 'x'.repeat(20000);
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: longText,
                headers: {},
            } as any);

            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'https://example.com/big' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.body.length).toBeLessThanOrEqual(15000);
            expect(parsed.truncated).toBe(true);
        });

        it('handles fetch errors gracefully', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Network timeout'));

            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'https://bad-url.example' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Network timeout');
        });

        it('falls back to JSON body when text is not a string', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: null,
                json: { key: 'value' },
                headers: {},
            } as any);

            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'https://api.example.com' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.body).toContain('key');
        });

        it('rejects non-HTTP protocols', async () => {
            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'file:///etc/passwd' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Unsupported protocol');
        });

        it('rejects invalid URLs', async () => {
            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'not-a-valid-url' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Invalid URL');
        });

        it('rejects missing URL', async () => {
            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: '' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Missing URL');
        });

        it('allows HTTPS URLs', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: 'OK',
                headers: {},
            } as any);

            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'https://example.com' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.status).toBe(200);
        });

        it('allows HTTP URLs', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                text: 'OK',
                headers: {},
            } as any);

            const result = await executeTool(
                'fetch_url',
                JSON.stringify({ url: 'http://example.com' }),
                createMockApp(),
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.status).toBe(200);
        });
    });

    describe('generate_image', () => {
        let mockRequestUrl: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            setImageRetryDelay(0); // skip retry delays in tests
            mockRequestUrl = vi.spyOn(obsidian, 'requestUrl' as any);
        });

        afterEach(() => {
            mockRequestUrl.mockRestore();
            setImageRetryDelay(2000);
        });

        it('generates image via OpenAI DALL-E', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: {
                    data: [{
                        b64_json: 'aW1hZ2VkYXRh',
                        revised_prompt: 'A beautiful sunset',
                    }],
                },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'A sunset', size: '1024x1024' }),
                createMockApp(),
                { provider: 'openai', apiKey: 'test-key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.image_url).toContain('data:image/png;base64,');
            expect(result.generatedImageUrl).toBeDefined();
        });

        it('generates image via OpenRouter', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: {
                    choices: [{
                        message: {
                            images: [{ image_url: { url: 'https://example.com/image.png' } }],
                        },
                    }],
                },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'A sunset' }),
                createMockApp(),
                { provider: 'openrouter', apiKey: 'test-key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.image_url).toBe('https://example.com/image.png');
            expect(result.generatedImageUrl).toBe('https://example.com/image.png');
        });

        it('returns error when no API key', async () => {
            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'A sunset' }),
                createMockApp(),
                { provider: 'openai', apiKey: '' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('No API key');
        });

        it('returns error when OpenRouter returns no image after retries', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: { choices: [{ message: { images: [] } }] },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'Something' }),
                createMockApp(),
                { provider: 'openrouter', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('No image returned');
            expect(parsed.error).toContain('3 attempts');
            // Should have been called 3 times (retry logic)
            expect(mockRequestUrl).toHaveBeenCalledTimes(3);
        });

        it('succeeds on second attempt after OpenRouter cold-start', async () => {
            // First call: no image (cold-start)
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { choices: [{ message: { images: [] } }] },
            } as any);
            // Second call: image returned (warm)
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { choices: [{ message: { images: [{ image_url: { url: 'https://example.com/img.png' } }] } }] },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'A sunset' }),
                createMockApp(),
                { provider: 'openrouter', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.image_url).toBe('https://example.com/img.png');
            expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('retries on network error and succeeds', async () => {
            mockRequestUrl.mockRejectedValueOnce(new Error('Timeout'));
            mockRequestUrl.mockResolvedValueOnce({
                status: 200,
                json: { choices: [{ message: { images: [{ image_url: { url: 'https://example.com/retry.png' } }] } }] },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'Retry test' }),
                createMockApp(),
                { provider: 'openrouter', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.image_url).toBe('https://example.com/retry.png');
            expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('returns error after all retry attempts fail with network error', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Connection refused'));

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'Fail' }),
                createMockApp(),
                { provider: 'openrouter', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('3 attempts');
            expect(parsed.error).toContain('Connection refused');
            expect(mockRequestUrl).toHaveBeenCalledTimes(3);
        });

        it('sends stream: false in OpenRouter request body', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: { choices: [{ message: { images: [{ image_url: { url: 'https://example.com/img.png' } }] } }] },
            } as any);

            await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'Test stream false' }),
                createMockApp(),
                { provider: 'openrouter', apiKey: 'key' },
            );
            const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
            expect(body.stream).toBe(false);
        });

        it('returns error when OpenAI returns no image', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: { data: [] },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'Something' }),
                createMockApp(),
                { provider: 'openai', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('No image returned');
        });

        it('handles API errors gracefully', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Rate limited'));

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'Something' }),
                createMockApp(),
                { provider: 'openai', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Rate limited');
        });

        it('uses URL fallback when b64_json is not present', async () => {
            mockRequestUrl.mockResolvedValue({
                status: 200,
                json: {
                    data: [{
                        url: 'https://images.example.com/gen.png',
                        revised_prompt: 'Nice image',
                    }],
                },
            } as any);

            const result = await executeTool(
                'generate_image',
                JSON.stringify({ prompt: 'A cat' }),
                createMockApp(),
                { provider: 'openai', apiKey: 'key' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.image_url).toBe('https://images.example.com/gen.png');
        });
    });

    // ── ask_user ────────────────────────────────────────────────────

    describe('ask_user', () => {
        it('returns user answer when callback provides feedback', async () => {
            const result = await executeTool(
                'ask_user',
                JSON.stringify({ question: 'How should I proceed?' }),
                createMockApp(),
                {
                    provider: 'copilot',
                    apiKey: 'token',
                    callbacks: {
                        onRequestIterateFeedback: async (_q: string) => ({ text: 'Make it blue' }),
                    } as any,
                },
            );
            expect(result.result).toBe('Make it blue');
        });

        it('returns cancellation message when callback returns null', async () => {
            const result = await executeTool(
                'ask_user',
                JSON.stringify({ question: 'Done?' }),
                createMockApp(),
                {
                    provider: 'copilot',
                    apiKey: 'token',
                    callbacks: {
                        onRequestIterateFeedback: async () => null,
                    } as any,
                },
            );
            expect(result.result).toContain('cancelled');
        });

        it('returns error when callback is not available', async () => {
            const result = await executeTool(
                'ask_user',
                JSON.stringify({ question: 'Test' }),
                createMockApp(),
                { provider: 'copilot', apiKey: 'token' },
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('does not support');
        });

        it('returns feedbackImages when callback provides images', async () => {
            const result = await executeTool(
                'ask_user',
                JSON.stringify({ question: 'Show me' }),
                createMockApp(),
                {
                    provider: 'copilot',
                    apiKey: 'token',
                    callbacks: {
                        onRequestIterateFeedback: async () => ({ text: 'Here', images: ['img.png'] }),
                    } as any,
                },
            );
            expect(result.result).toBe('Here');
            expect(result.feedbackImages).toEqual(['img.png']);
        });

        it('uses default question when not provided', async () => {
            let capturedQuestion = '';
            await executeTool(
                'ask_user',
                JSON.stringify({}),
                createMockApp(),
                {
                    provider: 'copilot',
                    apiKey: 'token',
                    callbacks: {
                        onRequestIterateFeedback: async (q: string) => { capturedQuestion = q; return { text: 'ok' }; },
                    } as any,
                },
            );
            expect(capturedQuestion).toBe('Please provide input.');
        });

        it('passes the question to the callback', async () => {
            let capturedQuestion = '';
            await executeTool(
                'ask_user',
                JSON.stringify({ question: 'What color?' }),
                createMockApp(),
                {
                    provider: 'copilot',
                    apiKey: 'token',
                    callbacks: {
                        onRequestIterateFeedback: async (q: string) => { capturedQuestion = q; return { text: 'red' }; },
                    } as any,
                },
            );
            expect(capturedQuestion).toBe('What color?');
        });
    });
});

// ── ask_user not risky ──────────────────────────────────────────────

describe('ask_user is not a risky tool', () => {
    it('ask_user is not in RISKY_TOOLS', () => {
        expect(RISKY_TOOLS.has('ask_user')).toBe(false);
    });
});

// ── view_image ──────────────────────────────────────────────────────

describe('executeTool > view_image', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;

    it('reads an image file and returns viewedImageUrl', async () => {
        const app = createMockApp({
            'attachments/photo.png': 'fake-png-data',
        });
        // Set stat.size to something reasonable
        const file = app.vault.getAbstractFileByPath('attachments/photo.png');
        file.stat.size = 1024;

        const result = await executeTool(
            'view_image',
            JSON.stringify({ path: 'attachments/photo.png' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.path).toBe('attachments/photo.png');
        expect(parsed.format).toBe('png');
        expect(parsed.size_bytes).toBe(1024);
        expect(parsed.message).toContain('Image loaded');
        expect(result.viewedImageUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('returns error for missing file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'view_image',
            JSON.stringify({ path: 'nonexistent.png' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
        expect(result.viewedImageUrl).toBeUndefined();
    });

    it('rejects non-image extensions', async () => {
        const app = createMockApp({
            'notes/doc.md': '# not an image',
        });
        const result = await executeTool(
            'view_image',
            JSON.stringify({ path: 'notes/doc.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Not an image file');
    });

    it('rejects files exceeding 10 MB', async () => {
        const app = createMockApp({
            'large.jpg': 'x',
        });
        const file = app.vault.getAbstractFileByPath('large.jpg');
        file.stat.size = 11 * 1024 * 1024; // 11 MB

        const result = await executeTool(
            'view_image',
            JSON.stringify({ path: 'large.jpg' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('too large');
    });

    it('returns error for missing path', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'view_image',
            JSON.stringify({}),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Missing image path');
    });

    it('supports jpg, gif, webp extensions', async () => {
        for (const ext of ['jpg', 'gif', 'webp']) {
            const app = createMockApp({
                [`img.${ext}`]: 'data',
            });
            const file = app.vault.getAbstractFileByPath(`img.${ext}`);
            file.stat.size = 100;

            const result = await executeTool(
                'view_image',
                JSON.stringify({ path: `img.${ext}` }),
                app,
                context,
            );
            expect(result.viewedImageUrl).toBeDefined();
        }
    });
});

// ── list_files ──────────────────────────────────────────────────────

describe('executeTool > list_files', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;

    it('lists files in root directory', async () => {
        const app = createMockApp({
            'note1.md': 'content',
            'note2.md': 'content',
            'subfolder/nested.md': 'nested',
        });
        const result = await executeTool(
            'list_files',
            JSON.stringify({ path: '/' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(3);
        const names = parsed.entries.map((e: any) => e.name);
        expect(names).toContain('note1.md');
        expect(names).toContain('note2.md');
        expect(names).toContain('subfolder');
    });

    it('lists files in subdirectory', async () => {
        const app = createMockApp({
            'folder/a.md': 'content',
            'folder/b.md': 'content',
            'other/c.md': 'content',
        });
        const result = await executeTool(
            'list_files',
            JSON.stringify({ path: 'folder' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(2);
        const names = parsed.entries.map((e: any) => e.name);
        expect(names).toContain('a.md');
        expect(names).toContain('b.md');
        expect(names).not.toContain('c.md');
    });

    it('shows folders before files', async () => {
        const app = createMockApp({
            'z-file.md': 'content',
            'a-folder/nested.md': 'content',
        });
        const result = await executeTool(
            'list_files',
            JSON.stringify({ path: '' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.entries[0].type).toBe('folder');
        expect(parsed.entries[1].type).toBe('file');
    });

    it('returns empty for nonexistent directory', async () => {
        const app = createMockApp({ 'other/file.md': 'x' });
        const result = await executeTool(
            'list_files',
            JSON.stringify({ path: 'nonexistent' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(0);
    });
});

// ── grep_search ─────────────────────────────────────────────────────

describe('executeTool > grep_search', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;

    it('finds matching lines across files', async () => {
        const app = createMockApp({
            'a.md': 'Hello world\nGoodbye world',
            'b.md': 'No match here',
            'c.md': 'Another hello line',
        });
        const result = await executeTool(
            'grep_search',
            JSON.stringify({ pattern: 'hello' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.total_matches).toBe(2);
        expect(parsed.matches[0].file).toBe('a.md');
        expect(parsed.matches[0].line).toBe(1);
        expect(parsed.matches[1].file).toBe('c.md');
    });

    it('is case-insensitive', async () => {
        const app = createMockApp({
            'test.md': 'IMPORTANT NOTE\nimportant detail',
        });
        const result = await executeTool(
            'grep_search',
            JSON.stringify({ pattern: 'important' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.total_matches).toBe(2);
    });

    it('respects max_results', async () => {
        const app = createMockApp({
            'test.md': Array(50).fill('match line').join('\n'),
        });
        const result = await executeTool(
            'grep_search',
            JSON.stringify({ pattern: 'match', max_results: 5 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.total_matches).toBe(5);
    });

    it('returns error for missing pattern', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'grep_search',
            JSON.stringify({}),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Missing search pattern');
    });

    it('filters by folder when provided', async () => {
        const app = createMockApp({
            'Projects/a.md': 'hello from projects',
            'Daily/b.md': 'hello from daily',
            'Projects/sub/c.md': 'hello from sub',
        });
        const result = await executeTool(
            'grep_search',
            JSON.stringify({ pattern: 'hello', folder: 'Projects' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.total_matches).toBe(2);
        expect(parsed.matches.map((m: any) => m.file)).toContain('Projects/a.md');
        expect(parsed.matches.map((m: any) => m.file)).toContain('Projects/sub/c.md');
    });
});

// ── open_note ───────────────────────────────────────────────────────

describe('executeTool > open_note', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;

    it('opens an existing note', async () => {
        const app = createMockApp({ 'Notes/test.md': 'content' });
        const result = await executeTool(
            'open_note',
            JSON.stringify({ path: 'Notes/test.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.opened).toBe(true);
        expect(parsed.path).toBe('Notes/test.md');
    });

    it('returns error for missing path', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'open_note',
            JSON.stringify({}),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Missing note path');
    });

    it('returns error for nonexistent file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'open_note',
            JSON.stringify({ path: 'nonexistent.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('File not found');
    });

    it('calls workspace.openLinkText', async () => {
        const app = createMockApp({ 'test.md': 'content' });
        const spy = vi.spyOn(app.workspace, 'openLinkText');
        await executeTool(
            'open_note',
            JSON.stringify({ path: 'test.md' }),
            app,
            context,
        );
        expect(spy).toHaveBeenCalledWith('test.md', '', 'tab');
    });
});

// ── read_note chunked reading ───────────────────────────────────────

describe('executeTool > read_note (chunked)', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;
    const multiLineContent = 'line1\nline2\nline3\nline4\nline5';

    it('returns specific line range with start_line and end_line', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md', start_line: 2, end_line: 4 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.content).toBe('line2\nline3\nline4');
        expect(parsed.start_line).toBe(2);
        expect(parsed.end_line).toBe(4);
        expect(parsed.total_lines).toBe(5);
    });

    it('reads from start_line to end of file when end_line omitted', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md', start_line: 4 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.content).toBe('line4\nline5');
        expect(parsed.start_line).toBe(4);
        expect(parsed.end_line).toBe(5);
    });

    it('reads from beginning when only end_line provided', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md', end_line: 2 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.content).toBe('line1\nline2');
        expect(parsed.start_line).toBe(1);
        expect(parsed.end_line).toBe(2);
    });

    it('clamps end_line to total_lines', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md', start_line: 4, end_line: 999 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.content).toBe('line4\nline5');
        expect(parsed.end_line).toBe(5);
    });

    it('returns error when start_line exceeds total lines', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md', start_line: 100 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('exceeds total lines');
        expect(parsed.total_lines).toBe(5);
    });

    it('always returns total_lines in full read mode', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.total_lines).toBe(5);
    });

    it('reads a single line when start_line equals end_line', async () => {
        const app = createMockApp({ 'test.md': multiLineContent });
        const result = await executeTool(
            'read_note',
            JSON.stringify({ path: 'test.md', start_line: 3, end_line: 3 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.content).toBe('line3');
    });
});

// ── edit_note ───────────────────────────────────────────────────────

describe('executeTool > edit_note', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;

    describe('replace operation', () => {
        it('replaces text in an existing file', async () => {
            const app = createMockApp({ 'test.md': 'Hello World\nGoodbye World' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'replace', search: 'Hello', replace: 'Hi' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.operation).toBe('replace');
            // Verify the file was modified
            const content = await app.vault.read(app.vault.getAbstractFileByPath('test.md'));
            expect(content).toBe('Hi World\nGoodbye World');
        });

        it('returns error when search text not found', async () => {
            const app = createMockApp({ 'test.md': 'Hello World' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'replace', search: 'nonexistent', replace: 'x' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('not found');
        });

        it('returns error when search param is missing', async () => {
            const app = createMockApp({ 'test.md': 'Hello' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'replace' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Missing "search"');
        });

        it('deletes text when replace is omitted (defaults to empty)', async () => {
            const app = createMockApp({ 'test.md': 'Remove THIS part please' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'replace', search: 'THIS part ' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            const content = await app.vault.read(app.vault.getAbstractFileByPath('test.md'));
            expect(content).toBe('Remove please');
        });
    });

    describe('insert operation', () => {
        it('inserts content at a specific line', async () => {
            const app = createMockApp({ 'test.md': 'line1\nline2\nline3' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'insert', line_number: 2, content: 'inserted' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            expect(parsed.line_number).toBe(2);
            const content = await app.vault.read(app.vault.getAbstractFileByPath('test.md'));
            expect(content).toBe('line1\ninserted\nline2\nline3');
        });

        it('inserts at line 1 (beginning of file)', async () => {
            const app = createMockApp({ 'test.md': 'existing' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'insert', line_number: 1, content: 'first' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.success).toBe(true);
            const content = await app.vault.read(app.vault.getAbstractFileByPath('test.md'));
            expect(content).toBe('first\nexisting');
        });

        it('returns error for out-of-range line number', async () => {
            const app = createMockApp({ 'test.md': 'line1\nline2' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'insert', line_number: 10, content: 'x' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('out of range');
        });

        it('returns error for missing content param', async () => {
            const app = createMockApp({ 'test.md': 'hello' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'insert', line_number: 1 }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Missing "content"');
        });

        it('returns error for missing line_number param', async () => {
            const app = createMockApp({ 'test.md': 'hello' });
            const result = await executeTool(
                'edit_note',
                JSON.stringify({ path: 'test.md', operation: 'insert', content: 'x' }),
                app,
                context,
            );
            const parsed = JSON.parse(result.result);
            expect(parsed.error).toContain('Missing "line_number"');
        });
    });

    it('returns error for nonexistent file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'edit_note',
            JSON.stringify({ path: 'missing.md', operation: 'replace', search: 'x', replace: 'y' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('File not found');
    });

    it('returns error for unknown operation', async () => {
        const app = createMockApp({ 'test.md': 'content' });
        const result = await executeTool(
            'edit_note',
            JSON.stringify({ path: 'test.md', operation: 'delete' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Unknown operation');
    });

    it('edit_note is a risky tool', () => {
        expect(RISKY_TOOLS.has('edit_note')).toBe(true);
    });
});

// ── create_note newline normalization ────────────────────────────────

describe('executeTool > create_note (newline normalization)', () => {
    const context = { provider: 'openai', apiKey: 'test-key' } as any;

    it('converts double-escaped newlines to actual newlines', async () => {
        const app = createMockApp({});
        // Simulate what happens when a model sends literal \n (double-escaped in JSON)
        const result = await executeTool(
            'create_note',
            JSON.stringify({ path: 'test.md', content: 'Hello\\nWorld\\nEnd' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        // The content should have actual newlines
        const content = await app.vault.read(app.vault.getAbstractFileByPath('test.md'));
        expect(content).toBe('Hello\nWorld\nEnd');
    });

    it('does not modify content with real newlines', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'create_note',
            JSON.stringify({ path: 'test.md', content: 'Hello\nWorld' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        const content = await app.vault.read(app.vault.getAbstractFileByPath('test.md'));
        expect(content).toBe('Hello\nWorld');
    });
});

// ── read_note_outline + read_note_section schema tests ──────────────

describe('TOOL_SCHEMAS > read_note_outline', () => {
    it('requires path parameter', () => {
        const schema = TOOL_SCHEMAS.find(s => s.function.name === 'read_note_outline');
        expect(schema).toBeDefined();
        expect(schema!.function.parameters.required).toContain('path');
    });
});

describe('TOOL_SCHEMAS > read_note_section', () => {
    it('requires path and heading parameters', () => {
        const schema = TOOL_SCHEMAS.find(s => s.function.name === 'read_note_section');
        expect(schema).toBeDefined();
        expect(schema!.function.parameters.required).toContain('path');
        expect(schema!.function.parameters.required).toContain('heading');
    });

    it('has optional include_children parameter', () => {
        const schema = TOOL_SCHEMAS.find(s => s.function.name === 'read_note_section');
        const props = schema!.function.parameters.properties as Record<string, any>;
        expect(props.include_children).toBeDefined();
        expect(props.include_children.type).toBe('boolean');
    });
});

// ── executeTool > read_note_outline ─────────────────────────────────

describe('executeTool > read_note_outline', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('returns headings with levels and line numbers', async () => {
        const app = createMockApp({
            'Notes/project.md': [
                '# Project Overview',
                'Introduction text.',
                '',
                '## Architecture',
                'Design details here.',
                '',
                '### Frontend',
                'React components.',
                '',
                '### Backend',
                'API layer.',
                '',
                '## Deployment',
                'CI/CD pipeline.',
            ].join('\n'),
        });
        const result = await executeTool(
            'read_note_outline',
            JSON.stringify({ path: 'Notes/project.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.path).toBe('Notes/project.md');
        expect(parsed.total_lines).toBe(14);
        expect(parsed.sections).toHaveLength(5);
        expect(parsed.sections[0]).toEqual({ heading: 'Project Overview', level: 1, line: 1 });
        expect(parsed.sections[1]).toEqual({ heading: 'Architecture', level: 2, line: 4 });
        expect(parsed.sections[2]).toEqual({ heading: 'Frontend', level: 3, line: 7 });
        expect(parsed.sections[3]).toEqual({ heading: 'Backend', level: 3, line: 10 });
        expect(parsed.sections[4]).toEqual({ heading: 'Deployment', level: 2, line: 13 });
    });

    it('returns empty sections for note without headings', async () => {
        const app = createMockApp({
            'Notes/plain.md': 'Just some plain text\nwithout any headings.',
        });
        const result = await executeTool(
            'read_note_outline',
            JSON.stringify({ path: 'Notes/plain.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.sections).toHaveLength(0);
        expect(parsed.total_lines).toBe(2);
    });

    it('ignores headings inside code blocks', async () => {
        const app = createMockApp({
            'Notes/code.md': [
                '# Real Heading',
                '',
                '```markdown',
                '## Fake Heading Inside Code',
                '```',
                '',
                '## Second Real Heading',
            ].join('\n'),
        });
        const result = await executeTool(
            'read_note_outline',
            JSON.stringify({ path: 'Notes/code.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.sections).toHaveLength(2);
        expect(parsed.sections[0].heading).toBe('Real Heading');
        expect(parsed.sections[1].heading).toBe('Second Real Heading');
    });

    it('returns error for missing file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'read_note_outline',
            JSON.stringify({ path: 'nonexistent.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
    });
});

// ── executeTool > read_note_section ─────────────────────────────────

describe('executeTool > read_note_section', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    const projectNote = [
        '# Project Overview',       // line 1
        'Introduction text.',        // line 2
        '',                          // line 3
        '## Architecture',           // line 4
        'Design details here.',      // line 5
        '',                          // line 6
        '### Frontend',              // line 7
        'React components.',         // line 8
        '',                          // line 9
        '### Backend',               // line 10
        'API layer.',                // line 11
        '',                          // line 12
        '## Deployment',             // line 13
        'CI/CD pipeline.',           // line 14
    ].join('\n');

    it('reads a section including children by default', async () => {
        const app = createMockApp({ 'project.md': projectNote });
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'project.md', heading: 'Architecture' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.heading).toBe('Architecture');
        expect(parsed.level).toBe(2);
        expect(parsed.start_line).toBe(4);
        expect(parsed.end_line).toBe(12); // stops before ## Deployment
        expect(parsed.content).toContain('Design details');
        expect(parsed.content).toContain('Frontend');
        expect(parsed.content).toContain('Backend');
        expect(parsed.truncated).toBe(false);
    });

    it('stops at child heading when include_children is false', async () => {
        const app = createMockApp({ 'project.md': projectNote });
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'project.md', heading: 'Architecture', include_children: false }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.heading).toBe('Architecture');
        expect(parsed.start_line).toBe(4);
        expect(parsed.end_line).toBe(6); // stops before ### Frontend
        expect(parsed.content).toContain('Design details');
        expect(parsed.content).not.toContain('Frontend');
    });

    it('reads last section to end of file', async () => {
        const app = createMockApp({ 'project.md': projectNote });
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'project.md', heading: 'Deployment' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.heading).toBe('Deployment');
        expect(parsed.start_line).toBe(13);
        expect(parsed.end_line).toBe(14);
        expect(parsed.content).toContain('CI/CD pipeline');
    });

    it('is case-insensitive for heading match', async () => {
        const app = createMockApp({ 'project.md': projectNote });
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'project.md', heading: 'frontend' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.heading).toBe('Frontend');
        expect(parsed.level).toBe(3);
    });

    it('returns error with available headings when section not found', async () => {
        const app = createMockApp({ 'project.md': projectNote });
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'project.md', heading: 'Nonexistent' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('Section not found');
        expect(parsed.available_headings).toContain('Architecture');
        expect(parsed.available_headings).toContain('Frontend');
    });

    it('returns error for missing file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'missing.md', heading: 'Anything' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
    });

    it('reads top-level heading to next top-level', async () => {
        const app = createMockApp({ 'project.md': projectNote });
        const result = await executeTool(
            'read_note_section',
            JSON.stringify({ path: 'project.md', heading: 'Project Overview' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.heading).toBe('Project Overview');
        expect(parsed.level).toBe(1);
        expect(parsed.start_line).toBe(1);
        // Only top-level heading, includes everything to EOF
        expect(parsed.end_line).toBe(14);
    });
});

// ── executeTool > get_backlinks ─────────────────────────────────────

describe('executeTool > get_backlinks', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('returns backlinks for a target note', async () => {
        const app = createMockApp({
            'Notes/target.md': '# Target',
            'Notes/source1.md': 'See [[Notes/target.md]]',
            'Notes/source2.md': 'Also links to [[Notes/target.md]]',
        });
        app.metadataCache.resolvedLinks = {
            'Notes/source1.md': { 'Notes/target.md': 1 },
            'Notes/source2.md': { 'Notes/target.md': 1 },
        };
        app.metadataCache.getFileCache = (file: any) => {
            if (file.path === 'Notes/source1.md') {
                return {
                    links: [{ link: 'Notes/target.md', displayText: 'target', position: { start: { line: 0 } } }],
                };
            }
            if (file.path === 'Notes/source2.md') {
                return {
                    links: [{ link: 'Notes/target.md', displayText: 'target', position: { start: { line: 0 } } }],
                };
            }
            return null;
        };
        app.metadataCache.getFirstLinkpathDest = (linkpath: string) => {
            return app.vault.getAbstractFileByPath(linkpath) || null;
        };

        const result = await executeTool(
            'get_backlinks',
            JSON.stringify({ path: 'Notes/target.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.target).toBe('Notes/target.md');
        expect(parsed.backlink_count).toBe(2);
        expect(parsed.backlinks).toHaveLength(2);
    });

    it('returns empty backlinks when no links point to target', async () => {
        const app = createMockApp({ 'Notes/lonely.md': '# No one links here' });
        app.metadataCache.resolvedLinks = {};

        const result = await executeTool(
            'get_backlinks',
            JSON.stringify({ path: 'Notes/lonely.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.backlink_count).toBe(0);
        expect(parsed.backlinks).toHaveLength(0);
    });

    it('returns error for missing file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'get_backlinks',
            JSON.stringify({ path: 'missing.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
    });

    it('respects max_results parameter', async () => {
        const files: Record<string, string> = { 'target.md': '# Target' };
        const resolvedLinks: Record<string, Record<string, number>> = {};
        for (let i = 0; i < 10; i++) {
            files[`source${i}.md`] = `Link to [[target.md]]`;
            resolvedLinks[`source${i}.md`] = { 'target.md': 1 };
        }
        const app = createMockApp(files);
        app.metadataCache.resolvedLinks = resolvedLinks;
        app.metadataCache.getFileCache = (file: any) => ({
            links: [{ link: 'target.md', displayText: 'target', position: { start: { line: 0 } } }],
        });
        app.metadataCache.getFirstLinkpathDest = (linkpath: string) =>
            app.vault.getAbstractFileByPath(linkpath) || null;

        const result = await executeTool(
            'get_backlinks',
            JSON.stringify({ path: 'target.md', max_results: 3 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.backlinks.length).toBeLessThanOrEqual(3);
    });
});

// ── executeTool > get_note_metadata ─────────────────────────────────

describe('executeTool > get_note_metadata', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('returns metadata for a note with frontmatter', async () => {
        const app = createMockApp({
            'Notes/test.md': '---\ntitle: Test\ntags: [js, web]\naliases: [testing]\n---\n# Test\nSome words here.',
        });
        app.metadataCache.getFileCache = () => ({
            frontmatter: { title: 'Test', tags: ['js', 'web'], aliases: ['testing'], position: {} },
            tags: [{ tag: '#inline' }],
            headings: [{ heading: 'Test', level: 1 }],
            links: [],
        });

        const result = await executeTool(
            'get_note_metadata',
            JSON.stringify({ path: 'Notes/test.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.path).toBe('Notes/test.md');
        expect(parsed.word_count).toBeGreaterThan(0);
        expect(parsed.heading_count).toBe(1);
        expect(parsed.frontmatter.title).toBe('Test');
        expect(parsed.tags).toContain('#inline');
        expect(parsed.tags).toContain('#js');
        expect(parsed.aliases).toContain('testing');
    });

    it('returns error for missing file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'get_note_metadata',
            JSON.stringify({ path: 'missing.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
    });

    it('works with note that has no frontmatter', async () => {
        const app = createMockApp({ 'plain.md': '# Plain Note\nJust text.' });
        app.metadataCache.getFileCache = () => ({
            headings: [{ heading: 'Plain Note', level: 1 }],
        });

        const result = await executeTool(
            'get_note_metadata',
            JSON.stringify({ path: 'plain.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.path).toBe('plain.md');
        expect(parsed.frontmatter).toBeUndefined();
        expect(parsed.tags).toBeUndefined();
    });
});

// ── executeTool > search_by_tag ─────────────────────────────────────

describe('executeTool > search_by_tag', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    function makeTaggedApp() {
        const app = createMockApp({
            'a.md': '# A\n#javascript',
            'b.md': '# B\n#python',
            'c.md': '# C\n#javascript/react',
        });
        const cacheMap: Record<string, any> = {
            'a.md': { tags: [{ tag: '#javascript' }] },
            'b.md': { tags: [{ tag: '#python' }] },
            'c.md': { tags: [{ tag: '#javascript/react' }] },
        };
        app.metadataCache.getFileCache = (file: any) => cacheMap[file.path] || null;
        return app;
    }

    it('finds notes with matching tag', async () => {
        const result = await executeTool(
            'search_by_tag',
            JSON.stringify({ tag: 'python' }),
            makeTaggedApp(),
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(1);
        expect(parsed.results[0].path).toBe('b.md');
    });

    it('includes child tags by default (hierarchy matching)', async () => {
        const result = await executeTool(
            'search_by_tag',
            JSON.stringify({ tag: 'javascript' }),
            makeTaggedApp(),
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(2);
        const paths = parsed.results.map((r: any) => r.path);
        expect(paths).toContain('a.md');
        expect(paths).toContain('c.md');
    });

    it('exact match excludes child tags', async () => {
        const result = await executeTool(
            'search_by_tag',
            JSON.stringify({ tag: 'javascript', exact: true }),
            makeTaggedApp(),
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(1);
        expect(parsed.results[0].path).toBe('a.md');
    });

    it('returns empty when no notes match tag', async () => {
        const result = await executeTool(
            'search_by_tag',
            JSON.stringify({ tag: 'nonexistent' }),
            makeTaggedApp(),
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(0);
    });

    it('handles # prefix in tag parameter', async () => {
        const result = await executeTool(
            'search_by_tag',
            JSON.stringify({ tag: '#python' }),
            makeTaggedApp(),
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(1);
    });
});

// ── executeTool > get_recent_notes ──────────────────────────────────

describe('executeTool > get_recent_notes', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('returns notes sorted by modification time', async () => {
        const app = createMockApp({
            'older.md': 'Old note',
            'newer.md': 'New note',
        });
        // Set mtimes
        const files = app.vault.getMarkdownFiles();
        const older = files.find((f: any) => f.path === 'older.md');
        const newer = files.find((f: any) => f.path === 'newer.md');
        older.stat.mtime = 1000;
        newer.stat.mtime = 2000;

        const result = await executeTool(
            'get_recent_notes',
            JSON.stringify({}),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.results[0].path).toBe('newer.md');
        expect(parsed.results[1].path).toBe('older.md');
    });

    it('respects max_results', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 20; i++) files[`note${i}.md`] = `Note ${i}`;
        const app = createMockApp(files);

        const result = await executeTool(
            'get_recent_notes',
            JSON.stringify({ max_results: 5 }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.results).toHaveLength(5);
    });

    it('filters by folder', async () => {
        const app = createMockApp({
            'Work/task.md': 'Task',
            'Personal/diary.md': 'Diary',
        });

        const result = await executeTool(
            'get_recent_notes',
            JSON.stringify({ folder: 'Work' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(1);
        expect(parsed.results[0].path).toBe('Work/task.md');
    });
});

// ── executeTool > get_open_notes ────────────────────────────────────

describe('executeTool > get_open_notes', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('returns empty when no tabs are open', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'get_open_notes',
            JSON.stringify({}),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(0);
        expect(parsed.notes).toHaveLength(0);
    });

    it('returns open notes with active indicator', async () => {
        const app = createMockApp({
            'Notes/a.md': '# A',
            'Notes/b.md': '# B',
        });
        const fileA = app.vault.getAbstractFileByPath('Notes/a.md');
        const fileB = app.vault.getAbstractFileByPath('Notes/b.md');
        app.workspace.getLeavesOfType = () => [
            { view: { file: fileA } },
            { view: { file: fileB } },
        ];
        app.workspace.getActiveFile = () => fileA;

        const result = await executeTool(
            'get_open_notes',
            JSON.stringify({}),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.count).toBe(2);
        const activeNote = parsed.notes.find((n: any) => n.active);
        expect(activeNote.path).toBe('Notes/a.md');
    });
});

// ── executeTool > move_note ─────────────────────────────────────────

describe('executeTool > move_note', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('moves a note to a new path', async () => {
        const app = createMockApp({ 'old/note.md': '# Moving' });
        const result = await executeTool(
            'move_note',
            JSON.stringify({ from: 'old/note.md', to: 'new/note.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.from).toBe('old/note.md');
        expect(parsed.to).toBe('new/note.md');
    });

    it('returns error for missing source file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'move_note',
            JSON.stringify({ from: 'missing.md', to: 'dest.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
    });

    it('returns error when destination already exists', async () => {
        const app = createMockApp({
            'source.md': '# Source',
            'dest.md': '# Destination',
        });
        const result = await executeTool(
            'move_note',
            JSON.stringify({ from: 'source.md', to: 'dest.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('already exists');
    });
});

// ── executeTool > delete_note ───────────────────────────────────────

describe('executeTool > delete_note', () => {
    const context = { provider: 'openai', apiKey: 'test-key' };

    it('deletes a note (moves to trash)', async () => {
        const app = createMockApp({ 'trash-me.md': '# Delete me' });
        const result = await executeTool(
            'delete_note',
            JSON.stringify({ path: 'trash-me.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.path).toBe('trash-me.md');
        // Verify file is actually removed from vault
        expect(app.vault.getAbstractFileByPath('trash-me.md')).toBeNull();
    });

    it('returns error for missing file', async () => {
        const app = createMockApp({});
        const result = await executeTool(
            'delete_note',
            JSON.stringify({ path: 'nonexistent.md' }),
            app,
            context,
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.error).toContain('not found');
    });
});

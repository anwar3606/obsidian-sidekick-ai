import { describe, it, expect, beforeEach } from 'vitest';
import { ChatStorage } from '../src/storage';
import { createMockApp } from './mocks/obsidian';
import type { Conversation, ChatMessage, IterateState } from '../src/types';

// ── Helpers ─────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
    return {
        id: 'test-conv-1',
        title: 'Test Conversation',
        messages: [
            { role: 'user', content: 'Hello!' },
            { role: 'assistant', content: 'Hi there! How can I help?' },
        ],
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        pinned: false,
        provider: 'openai',
        model: 'gpt-4.1-nano',
        ...overrides,
    };
}

// ── ChatStorage ─────────────────────────────────────────────────────

describe('ChatStorage', () => {
    let app: any;
    let storage: ChatStorage;

    beforeEach(() => {
        app = createMockApp({});
        storage = new ChatStorage(app, 'copilot/conversations');
    });

    // ── generateId ──────────────────────────────────────────────────

    describe('generateId', () => {
        it('returns a non-empty string', () => {
            const id = storage.generateId();
            expect(id).toBeTruthy();
            expect(typeof id).toBe('string');
        });

        it('generates unique IDs', () => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                ids.add(storage.generateId());
            }
            // Due to Date.now() + random, all should be unique
            expect(ids.size).toBe(100);
        });

        it('generates IDs of reasonable length', () => {
            const id = storage.generateId();
            expect(id.length).toBeGreaterThan(5);
            expect(id.length).toBeLessThan(30);
        });
    });

    // ── setChatFolder ───────────────────────────────────────────────

    describe('setChatFolder', () => {
        it('updates the chat folder', () => {
            storage.setChatFolder('New Folder');
            // Internal state changed — verify by saving and checking path
            // This is an indirect test; the path will use the new folder
        });
    });

    // ── saveConversation ────────────────────────────────────────────

    describe('saveConversation', () => {
        it('creates a new conversation file', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            expect(file).toBeTruthy();
        });

        it('saves conversation with correct frontmatter', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).toContain('---');
            expect(content).toContain('id: "test-conv-1"');
            expect(content).toContain('title: "Test Conversation"');
            expect(content).toContain('provider: "openai"');
            expect(content).toContain('model: "gpt-4.1-nano"');
        });

        it('saves user and assistant messages', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).toContain('### User');
            expect(content).toContain('Hello!');
            expect(content).toContain('### Assistant');
            expect(content).toContain('Hi there! How can I help?');
        });

        it('does not save cost information to the note', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Question' },
                    {
                        role: 'assistant',
                        content: 'Answer',
                        cost: { total: 0.001234, tokensPrompt: 100, tokensCompletion: 50 },
                    },
                ],
            });
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).not.toContain('Cost:');
            expect(content).toContain('Answer');
        });

        it('filters out system and tool messages', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'system', content: 'System message' },
                    { role: 'user', content: 'User message' },
                    { role: 'tool', content: 'Tool result', tool_call_id: 'tc1' },
                    { role: 'assistant', content: 'Response' },
                ],
            });
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).not.toContain('System message');
            expect(content).not.toContain('Tool result');
            expect(content).toContain('User message');
            expect(content).toContain('Response');
        });

        it('escapes quotes in title', async () => {
            const conv = makeConversation({ title: 'He said "hello"' });
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).toContain('title: "He said \\"hello\\""');
        });

        it('updates existing conversation', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);

            // Update the conversation
            conv.messages.push({ role: 'user', content: 'Follow up' });
            conv.updatedAt = 1700000002000;
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).toContain('Follow up');
        });

        it('saves pinned status', async () => {
            const conv = makeConversation({ pinned: true });
            await storage.saveConversation(conv);

            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file);
            expect(content).toContain('pinned: true');
        });
    });

    // ── loadConversation ────────────────────────────────────────────

    describe('loadConversation', () => {
        it('loads a saved conversation', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation('test-conv-1');

            expect(loaded).not.toBeNull();
            expect(loaded!.id).toBe('test-conv-1');
            expect(loaded!.title).toBe('Test Conversation');
            expect(loaded!.provider).toBe('openai');
            expect(loaded!.model).toBe('gpt-4.1-nano');
        });

        it('loads messages correctly', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation('test-conv-1');

            expect(loaded!.messages.length).toBe(2);
            expect(loaded!.messages[0].role).toBe('user');
            expect(loaded!.messages[0].content).toBe('Hello!');
            expect(loaded!.messages[1].role).toBe('assistant');
        });

        it('strips legacy cost lines when loading', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Q' },
                    {
                        role: 'assistant',
                        content: 'A',
                    },
                ],
            });
            await storage.saveConversation(conv);

            // Manually inject a legacy cost line into the file
            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            let content = await app.vault.read(file);
            content = content.replace(
                '### Assistant\n\nA',
                '### Assistant\n\nA\n\n> Cost: $0.005 | Prompt: 200 tokens | Completion: 100 tokens',
            );
            await app.vault.modify(file, content);

            const loaded = await storage.loadConversation('test-conv-1');
            const assistantMsg = loaded!.messages.find(m => m.role === 'assistant');
            expect(assistantMsg!.content).toBe('A');
            expect(assistantMsg!.content).not.toContain('Cost:');
        });

        it('returns null for non-existent conversation', async () => {
            const loaded = await storage.loadConversation('nonexistent');
            expect(loaded).toBeNull();
        });

        it('preserves pinned status', async () => {
            const conv = makeConversation({ pinned: true });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation('test-conv-1');
            expect(loaded!.pinned).toBe(true);
        });

        it('preserves timestamps', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation('test-conv-1');
            expect(loaded!.createdAt).toBe(1700000000000);
            expect(loaded!.updatedAt).toBe(1700000001000);
        });
    });

    // ── loadAllConversations ────────────────────────────────────────

    describe('loadAllConversations', () => {
        it('returns empty array when no conversations', async () => {
            const convs = await storage.loadAllConversations();
            expect(convs).toEqual([]);
        });

        it('loads multiple conversations', async () => {
            await storage.saveConversation(makeConversation({ id: 'conv-1', title: 'First' }));
            await storage.saveConversation(makeConversation({ id: 'conv-2', title: 'Second' }));
            await storage.saveConversation(makeConversation({ id: 'conv-3', title: 'Third' }));

            const convs = await storage.loadAllConversations();
            expect(convs.length).toBe(3);
        });

        it('sorts by updatedAt ascending (oldest first, newest at bottom)', async () => {
            await storage.saveConversation(makeConversation({
                id: 'old', title: 'Old', updatedAt: 1700000000000,
            }));
            await storage.saveConversation(makeConversation({
                id: 'new', title: 'New', updatedAt: 1700000002000,
            }));
            await storage.saveConversation(makeConversation({
                id: 'mid', title: 'Mid', updatedAt: 1700000001000,
            }));

            const convs = await storage.loadAllConversations();
            expect(convs[0].id).toBe('old');
            expect(convs[1].id).toBe('mid');
            expect(convs[2].id).toBe('new');
        });

        it('pinned conversations come last (most accessible at bottom)', async () => {
            await storage.saveConversation(makeConversation({
                id: 'unpinned', title: 'Unpinned', updatedAt: 1700000002000, pinned: false,
            }));
            await storage.saveConversation(makeConversation({
                id: 'pinned', title: 'Pinned', updatedAt: 1700000000000, pinned: true,
            }));

            const convs = await storage.loadAllConversations();
            expect(convs[0].id).toBe('unpinned');
            expect(convs[1].id).toBe('pinned');
        });
    });

    // ── deleteConversation ─────────────────────────────────────────

    describe('deleteConversation', () => {
        it('deletes an existing conversation file', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);

            // Verify it exists
            const before = await storage.loadConversation('test-conv-1');
            expect(before).not.toBeNull();

            await storage.deleteConversation('test-conv-1');

            const after = await storage.loadConversation('test-conv-1');
            expect(after).toBeNull();
        });

        it('does nothing when conversation does not exist', async () => {
            // Should not throw
            await expect(storage.deleteConversation('nonexistent')).resolves.not.toThrow();
        });
    });

    // ── Edge cases in parsing ───────────────────────────────────────

    describe('markdownToConversation edge cases', () => {
        it('returns null for content without frontmatter', async () => {
            const path = 'copilot/conversations/broken.md';
            await app.vault.create(path, 'No frontmatter here!');
            const loaded = await storage.loadConversation('broken');
            expect(loaded).toBeNull();
        });

        it('returns null when frontmatter id is missing', async () => {
            const content = '---\ntitle: "No ID"\ncreated: 1700000000000\nupdated: 1700000000000\npinned: false\nprovider: "openai"\nmodel: "gpt-4"\n---\n\n### User\n\nHello';
            await app.vault.create('copilot/conversations/fallback-id.md', content);
            const loaded = await storage.loadConversation('fallback-id');
            expect(loaded).toBeNull();
        });

        it('handles conversation with empty messages', async () => {
            const conv = makeConversation({ messages: [] });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation('test-conv-1');
            expect(loaded).not.toBeNull();
            expect(loaded!.messages.length).toBe(0);
        });

        it('skips sections without proper ### headers', async () => {
            const content = '---\nid: "test"\ntitle: "Test"\ncreated: 1000\nupdated: 1000\npinned: false\nprovider: "openai"\nmodel: "gpt-4"\n---\n\nSome random text without a header\n\n### User\n\nActual message';
            await app.vault.create('copilot/conversations/test.md', content);
            const loaded = await storage.loadConversation('test');
            expect(loaded).not.toBeNull();
            // Should only find the properly headed message
            expect(loaded!.messages.some(m => m.content === 'Actual message')).toBe(true);
        });
    });

    // ── Round-trip integrity ────────────────────────────────────────

    describe('round-trip integrity', () => {
        it('conversation survives save/load cycle', async () => {
            const original = makeConversation({
                title: 'Complex "quoted" title',
                pinned: true,
                messages: [
                    { role: 'user', content: 'What is 2+2?' },
                    {
                        role: 'assistant',
                        content: 'The answer is **4**.\n\n```js\nconsole.log(2+2); // 4\n```',
                        cost: { total: 0.000123, tokensPrompt: 50, tokensCompletion: 30 },
                    },
                    { role: 'user', content: 'Thanks!' },
                    { role: 'assistant', content: 'You\'re welcome!' },
                ],
            });

            await storage.saveConversation(original);
            const loaded = await storage.loadConversation(original.id);

            expect(loaded!.id).toBe(original.id);
            expect(loaded!.title).toBe('Complex "quoted" title');
            expect(loaded!.pinned).toBe(true);
            expect(loaded!.provider).toBe(original.provider);
            expect(loaded!.model).toBe(original.model);
            expect(loaded!.messages.length).toBe(4);
        });

        it('preserves titles with special characters on round-trip', async () => {
            const titles = [
                'He said "hello" and "goodbye"',
                'Quotes at the "end"',
                '"Quotes at the start"',
                'Backslash \\\\ in title',
                'Title with colons: key: value',
            ];
            for (const title of titles) {
                const conv = makeConversation({ id: `title-test-${Math.random()}`, title });
                await storage.saveConversation(conv);
                const loaded = await storage.loadConversation(conv.id);
                expect(loaded).not.toBeNull();
                expect(loaded!.title).toBe(title);
            }
        });

        it('preserves multiline content', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Line 1\nLine 2\nLine 3' },
                    { role: 'assistant', content: 'Response line 1\nResponse line 2' },
                ],
            });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);

            expect(loaded!.messages[0].content).toContain('Line 1\nLine 2\nLine 3');
        });

        it('preserves markdown formatting', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: '**bold** and _italic_ and `code`' },
                    { role: 'assistant', content: '# Heading\n\n- List item\n- Another item' },
                ],
            });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);

            expect(loaded!.messages[0].content).toContain('**bold**');
            expect(loaded!.messages[1].content).toContain('# Heading');
        });

        it('preserves horizontal rules inside message content', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Review this' },
                    {
                        role: 'assistant',
                        content: '## Errors\n\n| Error | Type |\n|---|---|\n| foo | bar |\n\n---\n\n## Corrected Sentences\n\nHere are the corrections.',
                    },
                ],
            });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);

            expect(loaded!.messages.length).toBe(2);
            expect(loaded!.messages[1].content).toContain('## Errors');
            expect(loaded!.messages[1].content).toContain('## Corrected Sentences');
            expect(loaded!.messages[1].content).toContain('Here are the corrections.');
        });

        it('preserves multiple horizontal rules inside a single message', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Tell me about sections' },
                    {
                        role: 'assistant',
                        content: 'Section 1\n\n---\n\nSection 2\n\n---\n\nSection 3',
                    },
                ],
            });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);

            expect(loaded!.messages.length).toBe(2);
            expect(loaded!.messages[1].content).toContain('Section 1');
            expect(loaded!.messages[1].content).toContain('Section 2');
            expect(loaded!.messages[1].content).toContain('Section 3');
        });

        it('preserves tables with --- separators in content', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Make a table' },
                    {
                        role: 'assistant',
                        content: '| Name | Value |\n|---|---|\n| A | 1 |\n| B | 2 |',
                    },
                ],
            });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);

            expect(loaded!.messages.length).toBe(2);
            expect(loaded!.messages[1].content).toContain('| A | 1 |');
            expect(loaded!.messages[1].content).toContain('| B | 2 |');
        });

        it('handles --- in content followed by non-header content', async () => {
            const conv = makeConversation({
                messages: [
                    { role: 'user', content: 'Q' },
                    {
                        role: 'assistant',
                        content: 'Before rule\n\n---\n\n## Not a message header\n\nAfter rule',
                    },
                    { role: 'user', content: 'Follow up' },
                    { role: 'assistant', content: 'Final answer' },
                ],
            });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);

            expect(loaded!.messages.length).toBe(4);
            expect(loaded!.messages[1].content).toContain('Before rule');
            expect(loaded!.messages[1].content).toContain('After rule');
            expect(loaded!.messages[2].content).toBe('Follow up');
            expect(loaded!.messages[3].content).toBe('Final answer');
        });
    });

    // ── iterateSessionPaused in frontmatter ─────────────────────────

    describe('iterateSessionPaused frontmatter', () => {
        it('saves iterateSessionPaused: true in frontmatter', async () => {
            const conv = makeConversation({ iterateSessionPaused: true });
            await storage.saveConversation(conv);
            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file as any);
            expect(content).toContain('iterateSessionPaused: true');
        });

        it('omits iterateSessionPaused from frontmatter when false/undefined', async () => {
            const conv = makeConversation({ iterateSessionPaused: false });
            await storage.saveConversation(conv);
            const file = app.vault.getAbstractFileByPath('copilot/conversations/test-conv-1.md');
            const content = await app.vault.read(file as any);
            expect(content).not.toContain('iterateSessionPaused');
        });

        it('loads iterateSessionPaused: true from frontmatter', async () => {
            const conv = makeConversation({ iterateSessionPaused: true });
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);
            expect(loaded!.iterateSessionPaused).toBe(true);
        });

        it('loads iterateSessionPaused as undefined when not set', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);
            const loaded = await storage.loadConversation(conv.id);
            expect(loaded!.iterateSessionPaused).toBeUndefined();
        });
    });

    // ── Iterate state sidecar (JSON) ────────────────────────────────

    describe('iterate state sidecar', () => {
        const mockState: IterateState = {
            apiMessages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'ask_user', arguments: '{"question":"How?"}' } }] },
                { role: 'tool', tool_call_id: 'call_1', content: 'User cancelled or closed the prompt.' },
            ],
            displayAccumulated: 'Some accumulated display text',
            toolRound: 3,
        };

        it('saves and loads iterate state', async () => {
            await storage.saveIterateState('conv-123', mockState);
            const loaded = await storage.loadIterateState('conv-123');
            expect(loaded).not.toBeNull();
            expect(loaded!.apiMessages).toHaveLength(4);
            expect(loaded!.apiMessages[0].role).toBe('system');
            expect(loaded!.displayAccumulated).toBe('Some accumulated display text');
            expect(loaded!.toolRound).toBe(3);
        });

        it('returns null for non-existent iterate state', async () => {
            const loaded = await storage.loadIterateState('nonexistent');
            expect(loaded).toBeNull();
        });

        it('overwrites existing iterate state', async () => {
            await storage.saveIterateState('conv-123', mockState);
            const updated: IterateState = { ...mockState, toolRound: 7 };
            await storage.saveIterateState('conv-123', updated);
            const loaded = await storage.loadIterateState('conv-123');
            expect(loaded!.toolRound).toBe(7);
        });

        it('deletes iterate state', async () => {
            await storage.saveIterateState('conv-123', mockState);
            await storage.deleteIterateState('conv-123');
            const loaded = await storage.loadIterateState('conv-123');
            expect(loaded).toBeNull();
        });

        it('deleteIterateState is safe for non-existent state', async () => {
            // Should not throw
            await storage.deleteIterateState('nonexistent');
        });

        it('deleteConversation also deletes iterate state', async () => {
            const conv = makeConversation();
            await storage.saveConversation(conv);
            await storage.saveIterateState(conv.id, mockState);
            await storage.deleteConversation(conv.id);
            const loaded = await storage.loadIterateState(conv.id);
            expect(loaded).toBeNull();
        });

        it('preserves full apiMessages structure through round-trip', async () => {
            await storage.saveIterateState('conv-rt', mockState);
            const loaded = await storage.loadIterateState('conv-rt');
            expect(loaded!.apiMessages[2].tool_calls).toBeDefined();
            expect(loaded!.apiMessages[2].tool_calls![0].function.name).toBe('ask_user');
            expect(loaded!.apiMessages[3].tool_call_id).toBe('call_1');
        });
    });
});

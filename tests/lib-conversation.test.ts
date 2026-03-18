import { describe, it, expect } from 'vitest';
import {
    formatTimeAgo,
    getPreviewSnippet,
    sortConversations,
    filterConversations,
    categorizeByTime,
    groupByCollection,
    conversationToMarkdown,
    markdownToConversation,
    buildExportMarkdown,
    parseTitleResponse,
    buildTitlePromptMessages,
} from '../lib/conversation';
import type { ConversationData, Collection } from '../lib/conversation';

function makeConv(overrides: Partial<ConversationData> = {}): ConversationData {
    return {
        id: 'test-1',
        title: 'Test Conversation',
        messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        pinned: false,
        provider: 'openai',
        model: 'gpt-4o',
        ...overrides,
    };
}

describe('lib/conversation', () => {
    describe('formatTimeAgo', () => {
        const now = 1700000000000;

        it('returns "just now" for recent timestamps', () => {
            expect(formatTimeAgo(now - 30000, now)).toBe('just now');
        });

        it('returns minutes ago', () => {
            expect(formatTimeAgo(now - 5 * 60 * 1000, now)).toBe('5m ago');
        });

        it('returns hours ago', () => {
            expect(formatTimeAgo(now - 3 * 60 * 60 * 1000, now)).toBe('3h ago');
        });

        it('returns days ago', () => {
            expect(formatTimeAgo(now - 5 * 24 * 60 * 60 * 1000, now)).toBe('5d ago');
        });

        it('returns months ago', () => {
            expect(formatTimeAgo(now - 60 * 24 * 60 * 60 * 1000, now)).toBe('2mo ago');
        });
    });

    describe('getPreviewSnippet', () => {
        it('returns first user message content', () => {
            const conv = makeConv();
            expect(getPreviewSnippet(conv)).toBe('Hello');
        });

        it('strips markdown formatting', () => {
            const conv = makeConv({
                messages: [{ role: 'user', content: '**Bold** _italic_ `code`' }],
            });
            expect(getPreviewSnippet(conv)).toBe('Bold italic code');
        });

        it('truncates long messages', () => {
            const long = 'a'.repeat(200);
            const conv = makeConv({ messages: [{ role: 'user', content: long }] });
            const snippet = getPreviewSnippet(conv);
            expect(snippet.length).toBeLessThanOrEqual(101); // 100 + ellipsis
        });

        it('returns empty for no user messages', () => {
            const conv = makeConv({ messages: [{ role: 'assistant', content: 'Hi' }] });
            expect(getPreviewSnippet(conv)).toBe('');
        });
    });

    describe('sortConversations', () => {
        const convs = [
            makeConv({ id: 'a', title: 'Zebra', updatedAt: 100, messages: [{ role: 'user', content: 'x' }] }),
            makeConv({ id: 'b', title: 'Alpha', updatedAt: 300, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }] }),
            makeConv({ id: 'c', title: 'Middle', updatedAt: 200, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }),
        ];

        it('sorts by date ascending', () => {
            const sorted = sortConversations(convs, 'date', 'asc');
            expect(sorted.map(c => c.id)).toEqual(['a', 'c', 'b']);
        });

        it('sorts by date descending', () => {
            const sorted = sortConversations(convs, 'date', 'desc');
            expect(sorted.map(c => c.id)).toEqual(['b', 'c', 'a']);
        });

        it('sorts by title ascending', () => {
            const sorted = sortConversations(convs, 'title', 'asc');
            expect(sorted.map(c => c.title)).toEqual(['Alpha', 'Middle', 'Zebra']);
        });

        it('sorts by size ascending', () => {
            const sorted = sortConversations(convs, 'size', 'asc');
            expect(sorted.map(c => c.messages.length)).toEqual([1, 2, 3]);
        });

        it('does not mutate original array', () => {
            const original = [...convs];
            sortConversations(convs, 'date', 'desc');
            expect(convs.map(c => c.id)).toEqual(original.map(c => c.id));
        });
    });

    describe('filterConversations', () => {
        const convs = [
            makeConv({ id: '1', title: 'React Hooks', provider: 'openai', model: 'gpt-4o' }),
            makeConv({ id: '2', title: 'Python Tips', provider: 'openrouter', model: 'claude-3' }),
            makeConv({ id: '3', title: 'General Chat', provider: 'copilot', model: 'gpt-4o' }),
        ];

        it('returns all for empty query', () => {
            expect(filterConversations(convs, '')).toHaveLength(3);
        });

        it('filters by title', () => {
            expect(filterConversations(convs, 'react')).toHaveLength(1);
        });

        it('filters by model', () => {
            expect(filterConversations(convs, 'gpt-4o')).toHaveLength(2);
        });

        it('filters by provider', () => {
            expect(filterConversations(convs, 'openrouter')).toHaveLength(1);
        });

        it('uses providerLabelFn if provided', () => {
            const labelFn = (p: string) => p === 'copilot' ? 'GitHub Copilot' : p;
            expect(filterConversations(convs, 'GitHub', labelFn)).toHaveLength(1);
        });

        it('filters by message content', () => {
            const withContent = [
                makeConv({ id: '1', title: 'A', messages: [{ role: 'user', content: 'Tell me about TypeScript' }] }),
                makeConv({ id: '2', title: 'B', messages: [{ role: 'user', content: 'Tell me about Python' }] }),
            ];
            expect(filterConversations(withContent, 'typescript')).toHaveLength(1);
        });
    });

    describe('categorizeByTime', () => {
        // Use a fixed "now" for deterministic tests
        const now = new Date('2026-03-01T12:00:00Z').getTime();
        const todayStart = new Date('2026-03-01T00:00:00Z').getTime();

        it('puts recent conversations in Today', () => {
            const convs = [makeConv({ updatedAt: todayStart + 1000 })];
            const groups = categorizeByTime(convs, now);
            expect(groups.find(g => g.label === 'Today')?.conversations).toHaveLength(1);
        });

        it('separates pinned conversations', () => {
            const convs = [
                makeConv({ id: '1', pinned: true, updatedAt: todayStart + 1000 }),
                makeConv({ id: '2', pinned: false, updatedAt: todayStart + 2000 }),
            ];
            const groups = categorizeByTime(convs, now);
            expect(groups.find(g => g.label === '📌 Pinned')?.conversations).toHaveLength(1);
        });

        it('puts old conversations in Older', () => {
            const convs = [makeConv({ updatedAt: now - 60 * 86400000 })];
            const groups = categorizeByTime(convs, now);
            expect(groups.find(g => g.label === 'Older')?.conversations).toHaveLength(1);
        });

        it('returns empty array for no conversations', () => {
            expect(categorizeByTime([], now)).toEqual([]);
        });
    });

    describe('conversationToMarkdown / markdownToConversation', () => {
        it('round-trips a conversation', () => {
            const conv = makeConv({ id: 'rt-1', title: 'Round Trip Test' });
            const md = conversationToMarkdown(conv);
            const restored = markdownToConversation(md);
            expect(restored).not.toBeNull();
            expect(restored!.id).toBe('rt-1');
            expect(restored!.title).toBe('Round Trip Test');
            expect(restored!.messages).toHaveLength(2);
            expect(restored!.messages[0].role).toBe('user');
            expect(restored!.messages[0].content).toBe('Hello');
            expect(restored!.messages[1].role).toBe('assistant');
            expect(restored!.messages[1].content).toBe('Hi there!');
        });

        it('preserves pinned flag', () => {
            const conv = makeConv({ pinned: true });
            const md = conversationToMarkdown(conv);
            const restored = markdownToConversation(md);
            expect(restored!.pinned).toBe(true);
        });

        it('preserves iterate session paused flag', () => {
            const conv = makeConv({ iterateSessionPaused: true });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('iterateSessionPaused: true');
            const restored = markdownToConversation(md);
            expect(restored!.iterateSessionPaused).toBe(true);
        });

        it('preserves alwaysAllowedTools', () => {
            const conv = makeConv({ alwaysAllowedTools: ['create_note', 'edit_note'] });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('alwaysAllowedTools:');
            const restored = markdownToConversation(md);
            expect(restored!.alwaysAllowedTools).toEqual(['create_note', 'edit_note']);
        });

        it('omits alwaysAllowedTools when empty', () => {
            const conv = makeConv({ alwaysAllowedTools: [] });
            const md = conversationToMarkdown(conv);
            expect(md).not.toContain('alwaysAllowedTools');
        });

        it('handles missing alwaysAllowedTools gracefully', () => {
            const conv = makeConv({});
            const md = conversationToMarkdown(conv);
            const restored = markdownToConversation(md);
            expect(restored!.alwaysAllowedTools).toBeUndefined();
        });

        it('handles image embeds', () => {
            const conv = makeConv({
                messages: [
                    { role: 'user', content: 'Check this image', images: ['path/to/image.png'] },
                ],
            });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('![[path/to/image.png]]');
            const restored = markdownToConversation(md);
            expect(restored!.messages[0].images).toEqual(['path/to/image.png']);
        });

        it('filters out system/tool messages', () => {
            const conv = makeConv({
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'Hello' },
                    { role: 'tool', content: 'Tool output' },
                    { role: 'assistant', content: 'Hi' },
                ],
            });
            const md = conversationToMarkdown(conv);
            expect(md).not.toContain('System prompt');
            expect(md).not.toContain('Tool output');
        });

        it('returns null for invalid input', () => {
            expect(markdownToConversation('not valid')).toBeNull();
        });

        it('returns null for missing id in frontmatter', () => {
            const md = '---\ntitle: "No ID"\n---\n';
            expect(markdownToConversation(md)).toBeNull();
        });

        it('escapes title quotes', () => {
            const conv = makeConv({ title: 'He said "hello"' });
            const md = conversationToMarkdown(conv);
            const restored = markdownToConversation(md);
            expect(restored!.title).toBe('He said "hello"');
        });

        it('roundtrips backslashes in title', () => {
            const conv = makeConv({ title: 'C:\\notes\\data' });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('C:\\\\notes\\\\data');
            const restored = markdownToConversation(md);
            expect(restored!.title).toBe('C:\\notes\\data');
        });

        it('roundtrips title with both backslashes and quotes', () => {
            const conv = makeConv({ title: 'path\\to\\"file"' });
            const md = conversationToMarkdown(conv);
            const restored = markdownToConversation(md);
            expect(restored!.title).toBe('path\\to\\"file"');
        });

        it('roundtrips usage stats in frontmatter', () => {
            const conv = makeConv({
                usage: { tokensPrompt: 1500, tokensCompletion: 800, totalCost: 0.0345, toolCalls: 7, apiRounds: 3 },
            });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('tokensPrompt: 1500');
            expect(md).toContain('tokensCompletion: 800');
            expect(md).toContain('totalCost: 0.0345');
            expect(md).toContain('toolCalls: 7');
            expect(md).toContain('apiRounds: 3');
            const restored = markdownToConversation(md);
            expect(restored!.usage).toEqual({ tokensPrompt: 1500, tokensCompletion: 800, totalCost: 0.0345, toolCalls: 7, apiRounds: 3 });
        });

        it('parses conversations without usage as undefined', () => {
            const conv = makeConv();
            const md = conversationToMarkdown(conv);
            const restored = markdownToConversation(md);
            expect(restored!.usage).toBeUndefined();
        });

        it('round-trips thumbs up rating via frontmatter', () => {
            const conv = makeConv({
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Great answer', rating: 1 },
                ],
            });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('ratings: {"1":1}');
            expect(md).not.toContain('<!-- rating:');
            const restored = markdownToConversation(md);
            expect(restored!.messages[1].rating).toBe(1);
            expect(restored!.messages[1].content).toBe('Great answer');
        });

        it('round-trips thumbs down rating via frontmatter', () => {
            const conv = makeConv({
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Bad answer', rating: -1 },
                ],
            });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('ratings: {"1":-1}');
            const restored = markdownToConversation(md);
            expect(restored!.messages[1].rating).toBe(-1);
            expect(restored!.messages[1].content).toBe('Bad answer');
        });

        it('omits ratings from frontmatter when none set', () => {
            const conv = makeConv();
            const md = conversationToMarkdown(conv);
            expect(md).not.toContain('ratings:');
            const restored = markdownToConversation(md);
            expect(restored!.messages[0].rating).toBeUndefined();
            expect(restored!.messages[1].rating).toBeUndefined();
        });

        it('reads legacy HTML comment ratings for backward compat', () => {
            // Simulate old format with HTML comment rating
            const md = `---\nid: "legacy"\ntitle: "Legacy"\ncreated: 1700000000000\nupdated: 1700000000000\npinned: false\nprovider: "openai"\nmodel: "gpt-4o"\n---\n### User\n\nHello\n\n---\n\n### Assistant\n\nOld answer\n\n<!-- rating: 1 -->`;
            const restored = markdownToConversation(md);
            expect(restored!.messages[1].rating).toBe(1);
            expect(restored!.messages[1].content).toBe('Old answer');
        });
    });

    describe('buildExportMarkdown', () => {
        it('builds export with title and messages', () => {
            const messages = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there!' },
            ];
            const md = buildExportMarkdown('Test Chat', messages);
            expect(md).toContain('# Chat — Test Chat');
            expect(md).toContain('**You**');
            expect(md).toContain('**Assistant**');
            expect(md).toContain('Hello');
            expect(md).toContain('Hi there!');
        });

        it('skips system and tool messages', () => {
            const messages = [
                { role: 'system', content: 'System' },
                { role: 'user', content: 'Hello' },
                { role: 'tool', content: 'Tool result' },
                { role: 'assistant', content: 'Hi' },
            ];
            const md = buildExportMarkdown('Test', messages);
            expect(md).not.toContain('System');
            expect(md).not.toContain('Tool result');
        });

        it('includes image embeds', () => {
            const messages = [
                { role: 'user', content: 'Look', images: ['img.png'] },
            ];
            const md = buildExportMarkdown('Test', messages);
            expect(md).toContain('![[img.png]]');
        });

        it('includes YAML frontmatter when metadata is provided', () => {
            const messages = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
            ];
            const md = buildExportMarkdown('Test', messages, {
                model: 'gpt-4o',
                provider: 'copilot',
                createdAt: 1700000000000,
                messageCount: 2,
                totalTokens: 500,
                totalCost: 0.0012,
            });
            expect(md).toContain('---');
            expect(md).toContain('model: gpt-4o');
            expect(md).toContain('provider: copilot');
            expect(md).toContain('messages: 2');
            expect(md).toContain('tokens: 500');
            expect(md).toContain('cost: 0.001200');
            expect(md).toContain('# Chat — Test');
        });

        it('omits frontmatter when no metadata given', () => {
            const md = buildExportMarkdown('Test', [{ role: 'user', content: 'Hi' }]);
            expect(md).not.toMatch(/^---/);
            expect(md).toMatch(/^# Chat — Test/);
        });
    });

    // ── Auto-title generation ───────────────────────────────────────

    describe('parseTitleResponse', () => {
        it('returns a clean title from a simple response', () => {
            expect(parseTitleResponse('TypeScript Debugging Tips')).toBe('TypeScript Debugging Tips');
        });

        it('strips surrounding quotes', () => {
            expect(parseTitleResponse('"TypeScript Debugging"')).toBe('TypeScript Debugging');
            expect(parseTitleResponse("'Single Quotes'")).toBe('Single Quotes');
        });

        it('removes trailing period', () => {
            expect(parseTitleResponse('TypeScript Tips.')).toBe('TypeScript Tips');
        });

        it('takes only first line', () => {
            expect(parseTitleResponse('First Line\nSecond Line')).toBe('First Line');
        });

        it('truncates long titles to 60 chars', () => {
            const long = 'A'.repeat(80);
            const result = parseTitleResponse(long);
            expect(result).toHaveLength(58); // 57 + '…'
            expect(result).toMatch(/…$/);
        });

        it('trims whitespace', () => {
            expect(parseTitleResponse('  Hello World  ')).toBe('Hello World');
        });

        it('returns Chat for empty response', () => {
            expect(parseTitleResponse('')).toBe('Chat');
            expect(parseTitleResponse('   ')).toBe('Chat');
        });
    });

    describe('buildTitlePromptMessages', () => {
        it('returns system + user messages', () => {
            const msgs = buildTitlePromptMessages('What is TypeScript?', 'TypeScript is a language...');
            expect(msgs).toHaveLength(2);
            expect(msgs[0].role).toBe('system');
            expect(msgs[1].role).toBe('user');
        });

        it('truncates long inputs to 200 chars', () => {
            const longUser = 'x'.repeat(300);
            const longAssistant = 'y'.repeat(300);
            const msgs = buildTitlePromptMessages(longUser, longAssistant);
            expect(msgs[1].content.length).toBeLessThan(450);
        });

        it('system prompt mentions short title', () => {
            const msgs = buildTitlePromptMessages('hi', 'hello');
            expect(msgs[0].content.toLowerCase()).toContain('title');
        });
    });

    // ── Collection grouping ─────────────────────────────────────

    describe('groupByCollection', () => {
        const collections: Collection[] = [
            { id: 'work', name: 'Work', order: 1 },
            { id: 'personal', name: 'Personal', order: 2 },
        ];

        it('groups conversations by their collectionId', () => {
            const convs = [
                makeConv({ id: '1', collectionId: 'work' }),
                makeConv({ id: '2', collectionId: 'personal' }),
                makeConv({ id: '3', collectionId: 'work' }),
            ];
            const groups = groupByCollection(convs, collections);
            expect(groups).toHaveLength(2);
            expect(groups[0].label).toBe('Work');
            expect(groups[0].conversations).toHaveLength(2);
            expect(groups[1].label).toBe('Personal');
            expect(groups[1].conversations).toHaveLength(1);
        });

        it('puts uncollected conversations in "Uncollected" group', () => {
            const convs = [
                makeConv({ id: '1', collectionId: 'work' }),
                makeConv({ id: '2' }), // no collectionId
            ];
            const groups = groupByCollection(convs, collections);
            const uncollected = groups.find(g => g.label === 'Uncollected');
            expect(uncollected).toBeDefined();
            expect(uncollected!.conversations).toHaveLength(1);
        });

        it('puts pinned conversations in separate group', () => {
            const convs = [
                makeConv({ id: '1', collectionId: 'work', pinned: true }),
                makeConv({ id: '2', collectionId: 'work' }),
            ];
            const groups = groupByCollection(convs, collections);
            const pinned = groups.find(g => g.label === '📌 Pinned');
            expect(pinned).toBeDefined();
            expect(pinned!.conversations).toHaveLength(1);
            const work = groups.find(g => g.label === 'Work');
            expect(work!.conversations).toHaveLength(1);
        });

        it('respects collection order', () => {
            const reversed: Collection[] = [
                { id: 'personal', name: 'Personal', order: 1 },
                { id: 'work', name: 'Work', order: 2 },
            ];
            const convs = [
                makeConv({ id: '1', collectionId: 'work' }),
                makeConv({ id: '2', collectionId: 'personal' }),
            ];
            const groups = groupByCollection(convs, reversed);
            expect(groups[0].label).toBe('Personal');
            expect(groups[1].label).toBe('Work');
        });

        it('omits empty collections from result', () => {
            const convs = [
                makeConv({ id: '1', collectionId: 'work' }),
            ];
            const groups = groupByCollection(convs, collections);
            expect(groups.find(g => g.label === 'Personal')).toBeUndefined();
        });

        it('treats unknown collectionId as uncollected', () => {
            const convs = [
                makeConv({ id: '1', collectionId: 'deleted-collection' }),
            ];
            const groups = groupByCollection(convs, collections);
            const uncollected = groups.find(g => g.label === 'Uncollected');
            expect(uncollected).toBeDefined();
            expect(uncollected!.conversations).toHaveLength(1);
        });

        it('returns empty array for no conversations', () => {
            const groups = groupByCollection([], collections);
            expect(groups).toHaveLength(0);
        });

        it('handles empty collections list', () => {
            const convs = [makeConv({ id: '1' })];
            const groups = groupByCollection(convs, []);
            expect(groups).toHaveLength(1);
            expect(groups[0].label).toBe('Uncollected');
        });
    });

    // ── Collection serialization ────────────────────────────────

    describe('collectionId serialization', () => {
        it('serializes collectionId to frontmatter', () => {
            const conv = makeConv({ collectionId: 'work' });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('collection: "work"');
        });

        it('omits collection field when no collectionId', () => {
            const conv = makeConv();
            const md = conversationToMarkdown(conv);
            expect(md).not.toContain('collection:');
        });

        it('deserializes collectionId from frontmatter', () => {
            const conv = makeConv({ collectionId: 'personal' });
            const md = conversationToMarkdown(conv);
            const parsed = markdownToConversation(md);
            expect(parsed).not.toBeNull();
            expect(parsed!.collectionId).toBe('personal');
        });

        it('returns undefined collectionId when not in frontmatter', () => {
            const conv = makeConv();
            const md = conversationToMarkdown(conv);
            const parsed = markdownToConversation(md);
            expect(parsed).not.toBeNull();
            expect(parsed!.collectionId).toBeUndefined();
        });

        it('round-trips collectionId through serialize/deserialize', () => {
            const conv = makeConv({ collectionId: 'my-collection' });
            const md = conversationToMarkdown(conv);
            const parsed = markdownToConversation(md);
            expect(parsed!.collectionId).toBe('my-collection');
        });

        it('escapes quotes in collectionId', () => {
            const conv = makeConv({ collectionId: 'team-"backend"' });
            const md = conversationToMarkdown(conv);
            expect(md).toContain('collection: "team-\\"backend\\""');
            const parsed = markdownToConversation(md);
            expect(parsed!.collectionId).toBe('team-"backend"');
        });

        it('escapes backslashes in collectionId', () => {
            const conv = makeConv({ collectionId: 'C:\\shared\\projects' });
            const md = conversationToMarkdown(conv);
            const parsed = markdownToConversation(md);
            expect(parsed!.collectionId).toBe('C:\\shared\\projects');
        });
    });
});

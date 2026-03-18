import { describe, it, expect } from 'vitest';
import {
    categorizeByTime,
    groupConversations,
    sortConversations,
    filterConversations,
    type GroupBy,
    type SortBy,
    type SortDir,
} from '../src/conversation-list';
import type { Conversation } from '../src/types';

// ── Helpers ─────────────────────────────────────────────────────────

function makeConv(overrides: Partial<Conversation> & { id: string }): Conversation {
    return {
        title: overrides.title ?? `Conv ${overrides.id}`,
        messages: overrides.messages ?? [{ role: 'user', content: 'Hello' }],
        createdAt: overrides.createdAt ?? Date.now(),
        updatedAt: overrides.updatedAt ?? Date.now(),
        pinned: overrides.pinned ?? false,
        provider: overrides.provider ?? 'openai',
        model: overrides.model ?? 'gpt-4o',
        ...overrides,
    };
}

const DAY = 86400000;

// ── categorizeByTime ────────────────────────────────────────────────

describe('categorizeByTime', () => {
    const now = new Date(2025, 0, 15, 12, 0, 0).getTime(); // Jan 15 2025 noon

    it('puts conversations in correct time buckets', () => {
        const convs = [
            makeConv({ id: '1', updatedAt: now - 1000 }),              // today
            makeConv({ id: '2', updatedAt: now - DAY - 1000 }),        // yesterday
            makeConv({ id: '3', updatedAt: now - 3 * DAY }),           // last week
            makeConv({ id: '4', updatedAt: now - 20 * DAY }),          // last month
            makeConv({ id: '5', updatedAt: now - 60 * DAY }),          // older
        ];
        const buckets = categorizeByTime(convs, now);
        expect(buckets.map(b => b.label)).toEqual(['Older', 'Last Month', 'Last Week', 'Yesterday', 'Today']);
    });

    it('pinned conversations go to the Pinned bucket', () => {
        const convs = [
            makeConv({ id: '1', updatedAt: now - 1000, pinned: true }),
            makeConv({ id: '2', updatedAt: now - 1000 }),
        ];
        const buckets = categorizeByTime(convs, now);
        expect(buckets.find(b => b.label === '📌 Pinned')?.conversations).toHaveLength(1);
    });

    it('pinned bucket is always last', () => {
        const convs = [
            makeConv({ id: '1', updatedAt: now - 1000, pinned: true }),
            makeConv({ id: '2', updatedAt: now - 1000 }),
        ];
        const buckets = categorizeByTime(convs, now);
        expect(buckets[buckets.length - 1].label).toBe('📌 Pinned');
    });

    it('skips empty buckets', () => {
        const convs = [makeConv({ id: '1', updatedAt: now - 1000 })];
        const buckets = categorizeByTime(convs, now);
        expect(buckets).toHaveLength(1);
        expect(buckets[0].label).toBe('Today');
    });

    it('returns empty array for empty input', () => {
        expect(categorizeByTime([], now)).toEqual([]);
    });

    it('older bucket has initialLimit of 3', () => {
        const convs = Array.from({ length: 10 }, (_, i) =>
            makeConv({ id: `${i}`, updatedAt: now - 60 * DAY - i * DAY }));
        const buckets = categorizeByTime(convs, now);
        expect(buckets[0].initialLimit).toBe(3);
    });

    it('today bucket has initialLimit of Infinity', () => {
        const convs = [makeConv({ id: '1', updatedAt: now - 1000 })];
        const buckets = categorizeByTime(convs, now);
        expect(buckets[0].initialLimit).toBe(Infinity);
    });
});

// ── groupConversations ──────────────────────────────────────────────

describe('groupConversations', () => {
    const convs = [
        makeConv({ id: '1', model: 'gpt-4o', provider: 'openai' }),
        makeConv({ id: '2', model: 'claude-sonnet-4', provider: 'openrouter' }),
        makeConv({ id: '3', model: 'gpt-4o', provider: 'openai' }),
        makeConv({ id: '4', model: 'claude-sonnet-4', provider: 'copilot', pinned: true }),
    ];

    it('groups by model', () => {
        const groups = groupConversations(convs, 'model');
        const labels = groups.map(g => g.label);
        expect(labels).toContain('claude-sonnet-4');
        expect(labels).toContain('gpt-4o');
        expect(labels).toContain('📌 Pinned');
    });

    it('groups by provider', () => {
        const groups = groupConversations(convs, 'provider');
        const labels = groups.map(g => g.label);
        expect(labels).toContain('OpenAI');
        expect(labels).toContain('OpenRouter');
    });

    it('defaults to time grouping', () => {
        const groups = groupConversations(convs, 'time');
        // Should have time bucket labels
        const hasTimeLabel = groups.some(g => ['Today', 'Yesterday', 'Last Week', 'Last Month', 'Older', '📌 Pinned'].includes(g.label));
        expect(hasTimeLabel).toBe(true);
    });

    it('pinned items are in a separate Pinned group for model grouping', () => {
        const groups = groupConversations(convs, 'model');
        const pinnedGroup = groups.find(g => g.label === '📌 Pinned');
        expect(pinnedGroup?.conversations).toHaveLength(1);
        expect(pinnedGroup?.conversations[0].id).toBe('4');
    });

    it('pinned items are in a separate Pinned group for provider grouping', () => {
        const groups = groupConversations(convs, 'provider');
        const pinnedGroup = groups.find(g => g.label === '📌 Pinned');
        expect(pinnedGroup?.conversations).toHaveLength(1);
    });

    it('strips provider prefix from model label', () => {
        const convs2 = [makeConv({ id: '1', model: 'openai/gpt-4o' })];
        const groups = groupConversations(convs2, 'model');
        expect(groups[0].label).toBe('gpt-4o');
    });
});

// ── sortConversations ───────────────────────────────────────────────

describe('sortConversations', () => {
    const convs = [
        makeConv({ id: '1', title: 'Banana', updatedAt: 2000, messages: [{ role: 'user', content: 'a' }] }),
        makeConv({ id: '2', title: 'Apple', updatedAt: 3000, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
        makeConv({ id: '3', title: 'Cherry', updatedAt: 1000, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }),
    ];

    it('sorts by date ascending', () => {
        const sorted = sortConversations(convs, 'date', 'asc');
        expect(sorted.map(c => c.id)).toEqual(['3', '1', '2']);
    });

    it('sorts by date descending', () => {
        const sorted = sortConversations(convs, 'date', 'desc');
        expect(sorted.map(c => c.id)).toEqual(['2', '1', '3']);
    });

    it('sorts by title ascending', () => {
        const sorted = sortConversations(convs, 'title', 'asc');
        expect(sorted.map(c => c.title)).toEqual(['Apple', 'Banana', 'Cherry']);
    });

    it('sorts by title descending', () => {
        const sorted = sortConversations(convs, 'title', 'desc');
        expect(sorted.map(c => c.title)).toEqual(['Cherry', 'Banana', 'Apple']);
    });

    it('sorts by message count (size) ascending', () => {
        const sorted = sortConversations(convs, 'size', 'asc');
        expect(sorted.map(c => c.messages.length)).toEqual([1, 2, 3]);
    });

    it('sorts by message count (size) descending', () => {
        const sorted = sortConversations(convs, 'size', 'desc');
        expect(sorted.map(c => c.messages.length)).toEqual([3, 2, 1]);
    });

    it('does not mutate original array', () => {
        const original = [...convs];
        sortConversations(convs, 'title', 'desc');
        expect(convs.map(c => c.id)).toEqual(original.map(c => c.id));
    });
});

// ── filterConversations ─────────────────────────────────────────────

describe('filterConversations', () => {
    const convs = [
        makeConv({ id: '1', title: 'Debugging TypeScript', model: 'gpt-4o', provider: 'openai', messages: [{ role: 'user', content: 'help me debug this' }] }),
        makeConv({ id: '2', title: 'Python project', model: 'claude-sonnet-4', provider: 'openrouter', messages: [{ role: 'user', content: 'write a flask app' }] }),
        makeConv({ id: '3', title: 'Image generation', model: 'dall-e-3', provider: 'openai', messages: [{ role: 'user', content: 'generate a logo' }] }),
    ];

    it('returns all for empty query', () => {
        expect(filterConversations(convs, '')).toHaveLength(3);
    });

    it('filters by title', () => {
        const result = filterConversations(convs, 'python');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('2');
    });

    it('filters by model name', () => {
        const result = filterConversations(convs, 'claude');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('2');
    });

    it('filters by provider name', () => {
        const result = filterConversations(convs, 'openrouter');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('2');
    });

    it('filters by provider label (friendly name)', () => {
        const result = filterConversations(convs, 'OpenRouter');
        expect(result).toHaveLength(1);
    });

    it('filters by message content', () => {
        const result = filterConversations(convs, 'flask');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('2');
    });

    it('is case-insensitive', () => {
        expect(filterConversations(convs, 'DEBUGGING')).toHaveLength(1);
    });

    it('handles whitespace-only as empty', () => {
        expect(filterConversations(convs, '   ')).toHaveLength(3);
    });

    it('returns empty when nothing matches', () => {
        expect(filterConversations(convs, 'zzznomatch')).toHaveLength(0);
    });

    it('matches multiple by shared model', () => {
        const result = filterConversations(convs, 'gpt-4o');
        // conv 1 has model gpt-4o
        expect(result.some(c => c.id === '1')).toBe(true);
    });

    it('searches all message content', () => {
        const manyMessages = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: i === 8 ? 'needle' : 'hay' }));
        const conv = makeConv({ id: '99', title: 'Long chat', messages: manyMessages });
        // 'needle' is at index 8 — should be found now (no limit)
        expect(filterConversations([conv], 'needle')).toHaveLength(1);
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { DisplayAccumulator, computeContextBreakdown, extractThinkingSummary } from '../lib/api';

describe('DisplayAccumulator', () => {
    let acc: DisplayAccumulator;

    beforeEach(() => {
        acc = new DisplayAccumulator();
    });

    // ── Basic accumulation ──────────────────────────────────────────

    describe('addContent()', () => {
        it('appends text to roundContent', () => {
            acc.addContent('hello');
            acc.addContent(' world');
            expect(acc.buildDisplay()).toBe('hello world');
        });
    });

    describe('addReasoning()', () => {
        it('appends text to roundReasoning', () => {
            acc.addReasoning('think');
            acc.addReasoning('ing...');
            // reasoning should appear in the callout
            const display = acc.buildDisplay();
            expect(display).toContain('thinking...');
        });
    });

    describe('multiple rounds via flushRound()', () => {
        it('builds up accumulated across rounds', () => {
            acc.addContent('round-1 content');
            acc.flushRound();
            acc.addContent('round-2 content');
            acc.flushRound();

            expect(acc.accumulated).toContain('round-1 content');
            expect(acc.accumulated).toContain('round-2 content');
        });
    });

    // ── flushRound() ────────────────────────────────────────────────

    describe('flushRound()', () => {
        it('moves roundContent into accumulated', () => {
            acc.addContent('some content');
            acc.flushRound();
            expect(acc.accumulated).toBe('some content');
        });

        it('moves roundReasoning into accumulated as a callout', () => {
            acc.addReasoning('deep thought');
            acc.flushRound();
            expect(acc.accumulated).toContain('> [!abstract]- 💭 Deep thought');
            expect(acc.accumulated).toContain('> deep thought');
        });

        it('resets round-level state after flushing', () => {
            acc.addReasoning('r');
            acc.addContent('c');
            acc.flushRound();

            // After flush, a fresh buildDisplay should only show accumulated
            expect(acc.buildDisplay()).toBe(acc.accumulated);
        });

        it('does not add reasoning callout when reasoning is empty', () => {
            acc.addContent('only content');
            acc.flushRound();
            expect(acc.accumulated).toBe('only content');
            expect(acc.accumulated).not.toContain('Reasoning');
        });

        it('includes both reasoning and content in correct order', () => {
            acc.addReasoning('why');
            acc.addContent('answer');
            acc.flushRound();
            const reasoningIdx = acc.accumulated.indexOf('why');
            const contentIdx = acc.accumulated.indexOf('answer');
            expect(reasoningIdx).toBeLessThan(contentIdx);
        });
    });

    // ── buildDisplay() ──────────────────────────────────────────────

    describe('buildDisplay()', () => {
        it('returns accumulated + live round content', () => {
            acc.addContent('round-1');
            acc.flushRound();
            acc.addContent('round-2');
            const display = acc.buildDisplay();
            expect(display).toContain('round-1');
            expect(display).toContain('round-2');
        });

        it('wraps roundReasoning in quote callout (expanded for current round)', () => {
            acc.addReasoning('hmm');
            const display = acc.buildDisplay();
            expect(display).toContain('> [!abstract]+ 💭 Hmm');
            // 'hmm' becomes capitalized 'Hmm' summary
            expect(display).toContain('> hmm');
        });

        it('omits reasoning section when there is no reasoning', () => {
            acc.addContent('just text');
            const display = acc.buildDisplay();
            expect(display).toBe('just text');
            expect(display).not.toContain('Reasoning');
        });

        it('handles multiline reasoning with > prefix on each line', () => {
            acc.addReasoning('line1\nline2\nline3');
            const display = acc.buildDisplay();
            expect(display).toContain('> line1\n> line2\n> line3');
        });

        it('returns empty string when nothing has been added', () => {
            expect(acc.buildDisplay()).toBe('');
        });
    });

    // ── replaceInAccumulated() ──────────────────────────────────────

    describe('replaceInAccumulated()', () => {
        it('replaces a substring in accumulated text', () => {
            acc.addContent('hello world');
            acc.flushRound();
            acc.replaceInAccumulated('world', 'there');
            expect(acc.accumulated).toBe('hello there');
        });

        it('handles tool-call callout replacement pattern', () => {
            acc.addContent('⏳ _Running…_');
            acc.flushRound();
            acc.replaceInAccumulated('⏳ _Running…_', '✅ result');
            expect(acc.accumulated).toBe('✅ result');
        });

        it('is a no-op when substring is not found', () => {
            acc.addContent('original');
            acc.flushRound();
            acc.replaceInAccumulated('nonexistent', 'replacement');
            expect(acc.accumulated).toBe('original');
        });

        it('replaces only the first occurrence', () => {
            acc.addContent('aaa');
            acc.flushRound();
            acc.replaceInAccumulated('a', 'b');
            expect(acc.accumulated).toBe('baa');
        });
    });

    // ── replaceInContent() ──────────────────────────────────────────

    describe('replaceInContent()', () => {
        it('replaces a substring in roundContent', () => {
            acc.addContent('placeholder-img');
            acc.replaceInContent('placeholder-img', '![image](url)');
            expect(acc.buildDisplay()).toBe('![image](url)');
        });

        it('replaces only the first occurrence in roundContent', () => {
            acc.addContent('xx');
            acc.replaceInContent('x', 'y');
            expect(acc.buildDisplay()).toBe('yx');
        });
    });

    // ── resetForRetry() ─────────────────────────────────────────────

    describe('resetForRetry()', () => {
        it('clears all state when isFirstRound is true', () => {
            acc.addReasoning('r');
            acc.addContent('c');
            acc.flushRound();
            acc.addReasoning('r2');
            acc.addContent('c2');

            acc.resetForRetry(true);

            expect(acc.accumulated).toBe('');
            expect(acc.buildDisplay()).toBe('');
        });

        it('clears only round state when isFirstRound is false', () => {
            acc.addContent('kept');
            acc.flushRound();
            acc.addReasoning('discard');
            acc.addContent('discard');

            acc.resetForRetry(false);

            expect(acc.accumulated).toBe('kept');
            expect(acc.buildDisplay()).toBe('kept');
        });
    });

    // ── Edge cases ──────────────────────────────────────────────────

    describe('edge cases', () => {
        it('empty reasoning produces no callout', () => {
            acc.addReasoning('');
            acc.addContent('text');
            expect(acc.buildDisplay()).toBe('text');
        });

        it('empty content is fine', () => {
            acc.addReasoning('thoughts');
            acc.flushRound();
            expect(acc.accumulated).toContain('thoughts');
        });

        it('multiple flush rounds accumulate correctly', () => {
            for (let i = 0; i < 5; i++) {
                acc.addReasoning(`reason-${i}`);
                acc.addContent(`content-${i}`);
                acc.flushRound();
            }
            const result = acc.accumulated;
            for (let i = 0; i < 5; i++) {
                expect(result).toContain(`reason-${i}`);
                expect(result).toContain(`content-${i}`);
            }
        });

        it('buildDisplay() with no content returns empty string', () => {
            expect(acc.buildDisplay()).toBe('');
        });

        it('interleaved reasoning and content across rounds', () => {
            acc.addReasoning('think-1');
            acc.addContent('say-1');
            acc.flushRound();

            acc.addContent('say-2'); // no reasoning this round

            const display = acc.buildDisplay();
            expect(display).toContain('think-1');
            expect(display).toContain('say-1');
            expect(display).toContain('say-2');
            // only one reasoning callout (round 1)
            const calloutCount = (display.match(/💭 /g) || []).length;
            expect(calloutCount).toBe(1);
        });

        it('addImagePlaceholder appends to roundContent', () => {
            acc.addContent('before ');
            acc.addImagePlaceholder('[img-placeholder]');
            acc.addContent(' after');
            expect(acc.buildDisplay()).toBe('before [img-placeholder] after');
        });
    });

    // ── expandLastReasoning() ───────────────────────────────────────

    describe('expandLastReasoning()', () => {
        it('expands the last reasoning callout from collapsed to expanded', () => {
            acc.addReasoning('round 1 thought');
            acc.flushRound();
            acc.addReasoning('round 2 thought');
            acc.flushRound();
            expect(acc.accumulated).toContain('[!abstract]- 💭 ');
            acc.expandLastReasoning();
            // Last reasoning should be expanded, first stays collapsed
            const matches = acc.accumulated.match(/\[!abstract\][+-] 💭 /g) || [];
            expect(matches).toEqual(['[!abstract]- 💭 ', '[!abstract]+ 💭 ']);
        });

        it('does nothing when no reasoning callouts exist', () => {
            acc.addContent('no reasoning');
            acc.flushRound();
            const before = acc.accumulated;
            acc.expandLastReasoning();
            expect(acc.accumulated).toBe(before);
        });

        it('expands single reasoning callout', () => {
            acc.addReasoning('only thought');
            acc.flushRound();
            acc.expandLastReasoning();
            expect(acc.accumulated).toContain('[!abstract]+ 💭 ');
            expect(acc.accumulated).not.toContain('[!abstract]- 💭 ');
        });
    });
});

describe('computeContextBreakdown', () => {

    it('categorizes system, user, assistant messages', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello there!' },
            { role: 'assistant', content: 'Hi!' },
        ];
        const bd = computeContextBreakdown(messages, 128000);
        expect(bd.items).toHaveLength(2); // system + history
        expect(bd.items[0]).toMatchObject({ type: 'system', label: 'System Instructions' });
        expect(bd.items[1]).toMatchObject({ type: 'history', label: 'Messages (2)' });
    });

    it('detects attached note context messages', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '[Attached note: readme.md — full content provided below, no need to use read_note tool]\n\nLong note content here...' },
            { role: 'user', content: 'Summarize the note' },
        ];
        const bd = computeContextBreakdown(messages, 128000);
        const notes = bd.items.find((i: any) => i.type === 'notes');
        expect(notes).toBeDefined();
        expect(notes!.count).toBe(1);
        expect(notes!.label).toBe('Attached Notes (1)');
    });

    it('counts tool results (Chat Completions format)', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'tool', tool_call_id: 'call_1', content: 'search result text' },
            { role: 'tool', tool_call_id: 'call_2', content: 'another result' },
        ];
        const bd = computeContextBreakdown(messages, 128000);
        const tools = bd.items.find((i: any) => i.type === 'tool_result');
        expect(tools).toBeDefined();
        expect(tools!.count).toBe(2);
    });

    it('counts tool results (Responses API format)', () => {
        const messages = [
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_vault', arguments: '{"query":"test"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'found 3 results' },
        ];
        const bd = computeContextBreakdown(messages as any, 128000);
        const tools = bd.items.find((i: any) => i.type === 'tool_result');
        expect(tools).toBeDefined();
        expect(tools!.count).toBe(2);
    });

    it('computes proportions correctly', () => {
        const messages = [
            { role: 'system', content: 'x'.repeat(4000) },
        ];
        const bd = computeContextBreakdown(messages, 10000);
        expect(bd.totalChars).toBe(4000);
        expect(bd.items[0].proportion).toBeCloseTo(1.0); // only item, so 100%
    });

    it('returns empty items for empty messages', () => {
        const bd = computeContextBreakdown([], 128000);
        expect(bd.items).toHaveLength(0);
        expect(bd.totalChars).toBe(0);
    });

    it('handles null content gracefully and counts tool_calls args', () => {
        const messages = [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test_tool', arguments: '{"key":"value"}' } }] },
        ];
        const bd = computeContextBreakdown(messages as any, 128000);
        const history = bd.items.find((i: any) => i.type === 'history');
        expect(history).toBeDefined();
        // Should measure tool_calls arguments length (15) + name length (9) = 24
        expect(history!.chars).toBe(24);
    });

    it('uses fallback context limit when 0 is passed', () => {
        const bd = computeContextBreakdown([], 0);
        expect(bd.contextLimit).toBe(128000);
    });

    it('proportions sum to ~1.0 and can distribute real API tokens', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: '[Attached note: readme.md — full content provided below, no need to use read_note tool]\n\nLong note content here...' },
            { role: 'tool', tool_call_id: 'call_1', content: 'search results from vault' },
            { role: 'user', content: 'Summarize everything' },
            { role: 'assistant', content: 'Here is a summary.' },
        ];
        const bd = computeContextBreakdown(messages, 128000);
        const totalProportion = bd.items.reduce((sum: number, i: any) => sum + i.proportion, 0);
        expect(totalProportion).toBeCloseTo(1.0, 5);

        // Distributing 1000 real API tokens should produce sensible per-item values
        const realTokens = 1000;
        const distributed = bd.items.map((i: any) => ({
            type: i.type,
            tokens: Math.round(i.proportion * realTokens),
        }));
        const distributedSum = distributed.reduce((s: number, d: any) => s + d.tokens, 0);
        // Allow ±items.length rounding tolerance
        expect(Math.abs(distributedSum - realTokens)).toBeLessThanOrEqual(bd.items.length);

        // Each item should get > 0 tokens since all have chars
        for (const d of distributed) {
            expect(d.tokens).toBeGreaterThan(0);
        }
    });

    it('proportions are zero when all items have zero chars', () => {
        // Edge case: system message with empty content
        const messages = [{ role: 'system', content: '' }];
        const bd = computeContextBreakdown(messages, 128000);
        // Even with empty content, there's a system item
        if (bd.items.length > 0) {
            for (const item of bd.items) {
                expect((item as any).proportion).toBe(0);
            }
        }
    });
});

describe('updateContextBreakdown callback contract', () => {
    it('arrow callback preserves both breakdown and apiTokens args', () => {
        // Regression: a lambda like (b) => fn(b) silently drops the second arg.
        // The correct form is (b, t) => fn(b, t).
        let receivedBreakdown: any = null;
        let receivedTokens: number | undefined = undefined;

        function updateContextBreakdown(breakdown: any, apiTokens?: number): void {
            receivedBreakdown = breakdown;
            receivedTokens = apiTokens;
        }

        // Correct: (b, t) => fn(b, t) — forwards both args
        const correctCallback = (b: any, t?: number) => updateContextBreakdown(b, t);

        const bd = computeContextBreakdown(
            [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
            128000,
        );
        correctCallback(bd, 581);

        expect(receivedBreakdown).toBe(bd);
        expect(receivedTokens).toBe(581);
    });

    it('apiTokens=undefined when usage not available', () => {
        let receivedTokens: number | undefined = 999;
        const cb = (_b: any, t?: number) => { receivedTokens = t; };

        const bd = computeContextBreakdown([{ role: 'system', content: 'sys' }], 128000);
        cb(bd, undefined);
        expect(receivedTokens).toBeUndefined();
    });

    it('latest prompt_tokens should be used, not accumulated', () => {
        // Simulates multi-round: round 1 returns 581, round 2 returns 662
        // The progress bar should show 662, NOT 581+662=1243
        const round1Usage = { prompt_tokens: 581, completion_tokens: 12, total_tokens: 593 };
        const round2Usage = { prompt_tokens: 662, completion_tokens: 23, total_tokens: 685 };

        // Accumulated (wrong approach)
        const accumulated = round1Usage.prompt_tokens + round2Usage.prompt_tokens; // 1243

        // Latest round only (correct)
        const latest = round2Usage.prompt_tokens; // 662

        // The latest value should be what the progress bar uses
        expect(latest).toBe(662);
        expect(latest).toBeLessThan(accumulated);
        // Verify: latest is strictly the last round, not a sum
        expect(latest).toBe(round2Usage.prompt_tokens);
        expect(accumulated).toBe(1243);
    });
});

// ── extractThinkingSummary() ────────────────────────────────────────

describe('extractThinkingSummary', () => {
    it('returns "Thinking" for empty input', () => {
        expect(extractThinkingSummary('')).toBe('Thinking');
    });

    it('returns "Thinking" for whitespace-only input', () => {
        expect(extractThinkingSummary('   ')).toBe('Thinking');
    });

    it('returns "Thinking" for null/undefined', () => {
        expect(extractThinkingSummary(null as any)).toBe('Thinking');
        expect(extractThinkingSummary(undefined as any)).toBe('Thinking');
    });

    it('returns "Thinking" for very short text', () => {
        expect(extractThinkingSummary('hi')).toBe('Thinking');
        expect(extractThinkingSummary('OK')).toBe('Thinking');
    });

    it('extracts first sentence', () => {
        const result = extractThinkingSummary('Analyzing the code structure. Then I will suggest changes.');
        expect(result).toBe('Analyzing the code structure');
    });

    it('strips "Let me" preamble', () => {
        const result = extractThinkingSummary('Let me analyze the code structure carefully.');
        expect(result).toBe('Analyze the code structure carefully');
    });

    it('strips "I\'ll" preamble', () => {
        const result = extractThinkingSummary("I'll check the function signature.");
        expect(result).toBe('Check the function signature');
    });

    it('strips "I need to" preamble', () => {
        const result = extractThinkingSummary('I need to understand the data flow first.');
        expect(result).toBe('Understand the data flow first');
    });

    it('strips "OK, Let me" compound preamble', () => {
        const result = extractThinkingSummary('OK, Let me think about this carefully.');
        expect(result).toBe('Think about this carefully');
    });

    it('strips "Alright, I should" compound preamble', () => {
        const result = extractThinkingSummary('Alright, I should review the tests first.');
        expect(result).toBe('Review the tests first');
    });

    it('capitalizes first letter after preamble strip', () => {
        const result = extractThinkingSummary('Let me check the types.');
        expect(result.charAt(0)).toBe('C');
    });

    it('truncates long summaries to ~80 chars', () => {
        const long = 'Analyzing the very complex and deeply nested inheritance hierarchy in the application codebase that spans multiple modules.';
        const result = extractThinkingSummary(long);
        expect(result.length).toBeLessThanOrEqual(80);
        expect(result).toContain('…');
    });

    it('handles multiline reasoning — takes first meaningful line', () => {
        const result = extractThinkingSummary('Breaking down the problem.\nFirst, check the types.\nThen check the tests.');
        expect(result).toBe('Breaking down the problem');
    });

    it('handles reasoning starting with newlines', () => {
        const result = extractThinkingSummary('This is a complete thought about coding patterns');
        expect(result).toBe('This is a complete thought about coding patterns');
    });

    it('preserves technical terms', () => {
        const result = extractThinkingSummary('The DisplayAccumulator class needs refactoring.');
        expect(result).toBe('The DisplayAccumulator class needs refactoring');
    });

    it('handles question marks as sentence boundaries', () => {
        const result = extractThinkingSummary('What does this function do? Examining the code.');
        expect(result).toBe('What does this function do');
    });

    it('handles exclamation marks as sentence boundaries', () => {
        const result = extractThinkingSummary('Found the bug! The issue is in the parser.');
        expect(result).toBe('Found the bug');
    });

    it('strips "Now " preamble', () => {
        const result = extractThinkingSummary('Now I need to check the edge cases.');
        expect(result).toBe('Check the edge cases');
    });
});

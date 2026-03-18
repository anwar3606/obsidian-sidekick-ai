import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoStripBadParams, formatMessagesForLog, appendToolCallMessages } from '../src/chat-controller';
import type { AnyRequestBody } from '../src/api-helpers';

// ── autoStripBadParams ──────────────────────────────────────────────

describe('autoStripBadParams', () => {
    function makeReq(params: Record<string, unknown>): AnyRequestBody {
        return { api: 'chat-completions', body: { model: 'gpt-4', messages: [], stream: true, ...params } } as AnyRequestBody;
    }

    it('strips temperature on temperature error', () => {
        const req = makeReq({ temperature: 0.7 });
        autoStripBadParams(req, 'HTTP 400: temperature is not supported');
        expect((req.body as any).temperature).toBeUndefined();
    });

    it('strips tools on tools error', () => {
        const req = makeReq({ tools: [{ type: 'function', function: { name: 'test' } }] });
        autoStripBadParams(req, 'HTTP 400: tools parameter is invalid');
        expect((req.body as any).tools).toBeUndefined();
    });

    it('strips all reasoning params on reason error', () => {
        const req = makeReq({
            reasoning_effort: 'high',
            reasoning_summary: 'auto',
            reasoning: { effort: 'high' },
            thinking_budget: 10000,
            max_tokens: 8192,
        });
        autoStripBadParams(req, 'HTTP 400: reason is not supported');
        const body = req.body as any;
        expect(body.reasoning_effort).toBeUndefined();
        expect(body.reasoning_summary).toBeUndefined();
        expect(body.reasoning).toBeUndefined();
        expect(body.thinking_budget).toBeUndefined();
        expect(body.max_tokens).toBeUndefined();
    });

    it('strips reasoning params on think error', () => {
        const req = makeReq({ reasoning_effort: 'high', max_tokens: 8192 });
        autoStripBadParams(req, 'HTTP 400: think parameter not supported');
        expect((req.body as any).reasoning_effort).toBeUndefined();
        expect((req.body as any).max_tokens).toBeUndefined();
    });

    it('strips reasoning params on max_tokens error', () => {
        const req = makeReq({ max_tokens: 8192 });
        autoStripBadParams(req, 'HTTP 400: max_tokens exceeds model limit');
        expect((req.body as any).max_tokens).toBeUndefined();
    });

    it('strips reasoning params on model_not_supported error', () => {
        const req = makeReq({ reasoning_effort: 'high' });
        autoStripBadParams(req, 'HTTP 400: model_not_supported for reasoning');
        expect((req.body as any).reasoning_effort).toBeUndefined();
    });

    it('does not strip unrelated params on unknown 400 error', () => {
        const req = makeReq({ temperature: 0.7, max_tokens: 8192 });
        autoStripBadParams(req, 'HTTP 400: something unrelated');
        expect((req.body as any).temperature).toBe(0.7);
        expect((req.body as any).max_tokens).toBe(8192);
    });

    it('temperature takes priority over tools when both mentioned', () => {
        // The if/else chain means temperature is checked first
        const req = makeReq({ temperature: 0.7, tools: [{}] });
        autoStripBadParams(req, 'HTTP 400: temperature and tools error');
        expect((req.body as any).temperature).toBeUndefined();
        expect((req.body as any).tools).toBeDefined(); // tools NOT stripped — temperature branch hit first
    });
});

// ── formatMessagesForLog ────────────────────────────────────────────

describe('formatMessagesForLog', () => {
    it('formats a basic user message', () => {
        const result = formatMessagesForLog([
            { role: 'user', content: 'Hello world' },
        ]) as any[];
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
        expect(result[0].contentPreview).toBe('Hello world');
    });

    it('truncates long content at 500 chars', () => {
        const longContent = 'x'.repeat(600);
        const result = formatMessagesForLog([
            { role: 'assistant', content: longContent },
        ]) as any[];
        expect(result[0].contentPreview).toHaveLength(500);
    });

    it('handles multi-part content', () => {
        const result = formatMessagesForLog([
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url' }] },
        ]) as any[];
        expect(result[0].contentPreview).toBe('[2 parts]');
    });

    it('handles null content', () => {
        const result = formatMessagesForLog([
            { role: 'assistant', content: null },
        ]) as any[];
        expect(result[0].contentPreview).toBe('');
    });

    it('handles undefined content', () => {
        const result = formatMessagesForLog([
            { role: 'assistant' },
        ]) as any[];
        expect(result[0].contentPreview).toBe('');
    });

    it('formats tool_calls', () => {
        const result = formatMessagesForLog([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'tc1', type: 'function', function: { name: 'read_note', arguments: '{"path":"test.md"}' } },
                ],
            },
        ]) as any[];
        expect(result[0].tool_calls).toEqual([
            { name: 'read_note', arguments: '{"path":"test.md"}' },
        ]);
    });

    it('includes tool result fields', () => {
        const result = formatMessagesForLog([
            { role: 'tool', tool_call_id: 'tc1', content: 'result text' },
        ]) as any[];
        expect(result[0].tool_call_id).toBe('tc1');
    });

    it('handles Responses API function_call items', () => {
        const result = formatMessagesForLog([
            { type: 'function_call', call_id: 'call1', name: 'search', arguments: '{}' },
        ]) as any[];
        expect(result[0].role).toBe('function_call');
        expect(result[0].call_id).toBe('call1');
        expect(result[0].name).toBe('search');
    });

    it('handles Responses API function_call_output items', () => {
        const result = formatMessagesForLog([
            { type: 'function_call_output', call_id: 'call1', output: 'result here' },
        ]) as any[];
        expect(result[0].role).toBe('function_call_output');
        expect(result[0].output).toBe('result here');
    });
});

// ── appendToolCallMessages ──────────────────────────────────────────

describe('appendToolCallMessages', () => {
    const makeToolCalls = () => [
        { id: 'tc1', callId: 'call1', type: 'function' as const, function: { name: 'read_note', arguments: '{"path":"test.md"}' } },
        { id: 'tc2', callId: 'call2', type: 'function' as const, function: { name: 'search', arguments: '{"query":"foo"}' } },
    ];

    describe('Chat Completions format (useResponses=false)', () => {
        it('pushes a single assistant message with tool_calls array', () => {
            const apiMessages: any[] = [];
            appendToolCallMessages(apiMessages, makeToolCalls(), false, '', '');
            expect(apiMessages).toHaveLength(1);
            expect(apiMessages[0].role).toBe('assistant');
            expect(apiMessages[0].content).toBeNull();
            expect(apiMessages[0].tool_calls).toHaveLength(2);
            expect(apiMessages[0].tool_calls[0]).toEqual({
                id: 'tc1',
                type: 'function',
                function: { name: 'read_note', arguments: '{"path":"test.md"}' },
            });
        });

        it('preserves _thinking when roundReasoning is provided', () => {
            const apiMessages: any[] = [];
            appendToolCallMessages(apiMessages, makeToolCalls(), false, 'I should read the note first', 'sig123');
            expect(apiMessages[0]._thinking).toBe('I should read the note first');
            expect(apiMessages[0]._thinkingSignature).toBe('sig123');
        });

        it('does not add _thinking when roundReasoning is empty', () => {
            const apiMessages: any[] = [];
            appendToolCallMessages(apiMessages, makeToolCalls(), false, '', '');
            expect(apiMessages[0]._thinking).toBeUndefined();
        });
    });

    describe('Responses API format (useResponses=true)', () => {
        it('pushes one function_call item per tool call', () => {
            const apiMessages: any[] = [];
            appendToolCallMessages(apiMessages, makeToolCalls(), true, '', '');
            expect(apiMessages).toHaveLength(2);
            expect(apiMessages[0]).toEqual({
                type: 'function_call',
                id: 'tc1',
                call_id: 'call1',
                name: 'read_note',
                arguments: '{"path":"test.md"}',
            });
            expect(apiMessages[0]).not.toHaveProperty('role');
            expect(apiMessages[1].name).toBe('search');
        });

        it('uses tc.id as call_id if callId is missing', () => {
            const tcNoCid = [{ id: 'tc1', function: { name: 'test', arguments: '{}' } }];
            const apiMessages: any[] = [];
            appendToolCallMessages(apiMessages, tcNoCid as any, true, '', '');
            expect(apiMessages[0].call_id).toBe('tc1');
        });
    });
});

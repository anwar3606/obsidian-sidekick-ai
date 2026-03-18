/**
 * Tool Call Round-Trip Tests
 *
 * Tests the FULL tool call lifecycle: streaming → ToolCall object → format for API.
 *
 * These tests exist because a critical bug was missed by 733 unit tests that only
 * tested functions in isolation: Responses API tool calls lost the `fc_` item ID,
 * causing 400 errors. Round-trip tests ensure the contract between streaming output
 * and format-function input is never broken.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { streamChatCompletions, streamResponsesAPI } from '../lib/streaming';
import {
    formatFunctionCallForResponses,
    formatToolResultForResponses,
    formatToolResultForChatCompletions,
    formatAssistantToolCalls,
} from '../lib/api';
import type { ToolCall, ChunkType, ApiMessage } from '../lib/types';

// ── Mock https/http for streamResponsesAPI ──────────────────────────

const { mockHttpsRequest } = vi.hoisted(() => ({ mockHttpsRequest: vi.fn() }));
vi.mock('https', () => ({ default: { request: mockHttpsRequest }, request: mockHttpsRequest }));
vi.mock('http', () => ({ default: { request: mockHttpsRequest }, request: mockHttpsRequest }));

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a mock fetch Response that streams SSE lines for Chat Completions. */
function mockFetchResponse(lines: string[], status = 200) {
    const body = lines.join('\n') + '\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
        },
    });
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        body: stream,
        text: async () => body,
    } as unknown as Response;
}

/** Single SSE data line. */
function sseData(obj: Record<string, unknown>): string {
    return `data: ${JSON.stringify(obj)}`;
}

/** Chat Completions tool_calls delta chunk. */
function ccToolCallChunk(tc: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}, id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: { tool_calls: [tc] }, finish_reason: null }],
    });
}

/** Chat Completions finish chunk. */
function ccFinishChunk(reason = 'tool_calls', id = 'gen-1') {
    return sseData({ id, choices: [{ delta: {}, finish_reason: reason }] });
}

/** Create a mock Node.js IncomingMessage for Responses API SSE. */
function mockNodeIncoming(events: Array<{ event: string; data: any }>, statusCode = 200) {
    const lines: string[] = [];
    for (const ev of events) {
        lines.push(`event: ${ev.event}`);
        lines.push(`data: ${JSON.stringify(ev.data)}`);
        lines.push('');
    }
    const body = lines.join('\n') + '\n';
    const readable = new Readable({
        read() {
            this.push(Buffer.from(body));
            this.push(null);
        },
    });
    (readable as any).statusCode = statusCode;
    (readable as any).statusMessage = statusCode === 200 ? 'OK' : 'Error';
    return readable;
}

/** Set up the https.request mock with Responses API events. */
function setupHttpsMock(events: Array<{ event: string; data: any }>, statusCode = 200) {
    const incoming = mockNodeIncoming(events, statusCode);
    mockHttpsRequest.mockImplementation((_options: any, callback: any) => {
        process.nextTick(() => callback(incoming));
        return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    });
}

/** Create a ToolCall with Responses API dual-ID shape. */
function responsesToolCall(opts: {
    id: string;
    callId: string;
    name: string;
    args: string;
}): ToolCall {
    return {
        id: opts.id,
        callId: opts.callId,
        type: 'function',
        function: { name: opts.name, arguments: opts.args },
    };
}

/** Create a ToolCall with Chat Completions single-ID shape. */
function chatCompletionsToolCall(opts: {
    id: string;
    name: string;
    args: string;
}): ToolCall {
    return {
        id: opts.id,
        type: 'function',
        function: { name: opts.name, arguments: opts.args },
    };
}

// ═════════════════════════════════════════════════════════════════════
// Category 1: Round-Trip Contract Tests
// ═════════════════════════════════════════════════════════════════════

describe('Round-Trip Contract Tests', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        mockHttpsRequest.mockReset();
    });

    describe('Responses API: stream → ToolCall → formatFunctionCallForResponses', () => {
        it('preserves both fc_ item ID and call_ call ID through the full round trip', async () => {
            // Step 1: Stream a Responses API tool call with realistic IDs
            setupHttpsMock([
                { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_abc123', call_id: 'call_def456', name: 'search_vault', arguments: '' } } },
                { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_abc123', call_id: 'call_def456', delta: '{"query":' } },
                { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_abc123', call_id: 'call_def456', delta: ' "obsidian"}' } },
                { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_abc123', call_id: 'call_def456', name: 'search_vault', arguments: '{"query": "obsidian"}' } } },
                { event: 'response.completed', data: { response: { id: 'resp-rt1', status: 'completed', usage: { input_tokens: 50, output_tokens: 20 } } } },
            ]);

            const chunks: any[] = [];
            const result = await streamResponsesAPI(
                'https://api.copilot.com/responses', {}, {},
                (token, type, tc) => chunks.push({ token, type, tc }),
            );

            // Step 2: Verify the ToolCall object has both IDs
            expect(result.toolCalls).toHaveLength(1);
            const tc = result.toolCalls[0];
            expect(tc.id).toBe('fc_abc123');
            expect(tc.callId).toBe('call_def456');
            expect(tc.function.name).toBe('search_vault');
            expect(tc.function.arguments).toBe('{"query": "obsidian"}');

            // Step 3: Feed into formatFunctionCallForResponses and verify output
            const formatted = formatFunctionCallForResponses(tc);
            expect(formatted.type).toBe('function_call');
            expect(formatted.id).toBe('fc_abc123');
            expect(formatted.call_id).toBe('call_def456');
            expect(formatted.name).toBe('search_vault');
            expect(formatted.arguments).toBe('{"query": "obsidian"}');
        });

        it('full Responses API round: stream → function_call → function_call_output', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_read1', call_id: 'call_read1', name: 'read_note', arguments: '' } } },
                { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_read1', call_id: 'call_read1', delta: '{"path":"daily/2026-03-01.md"}' } },
                { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_read1', call_id: 'call_read1', name: 'read_note', arguments: '{"path":"daily/2026-03-01.md"}' } } },
                { event: 'response.completed', data: { response: { id: 'resp-rt2', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI(
                'https://api.copilot.com/responses', {}, {},
                () => {},
            );

            const tc = result.toolCalls[0];

            // Format the function_call item for the next request
            const fnCallMsg = formatFunctionCallForResponses(tc);
            expect(fnCallMsg.type).toBe('function_call');
            expect(fnCallMsg.id).toBe('fc_read1');
            expect(fnCallMsg.call_id).toBe('call_read1');

            // Format the function_call_output — must use callId (call_xxx), not id (fc_xxx)
            const fnOutputMsg = formatToolResultForResponses(
                tc.callId || tc.id,
                'Note content: Today I worked on the plugin.',
            );
            expect(fnOutputMsg.type).toBe('function_call_output');
            expect(fnOutputMsg.call_id).toBe('call_read1');
            expect(fnOutputMsg.output).toBe('Note content: Today I worked on the plugin.');

            // The assembled input array for the next API call
            const input: ApiMessage[] = [fnCallMsg, fnOutputMsg];
            // Verify the call_id on function_call matches the call_id on function_call_output
            expect(input[0].call_id).toBe(input[1].call_id);
        });
    });

    describe('Chat Completions API: stream → ToolCall → formatAssistantToolCalls', () => {
        it('preserves tool call ID through stream → format', async () => {
            fetchSpy.mockResolvedValue(mockFetchResponse([
                ccToolCallChunk({ index: 0, id: 'call_chat789', type: 'function', function: { name: 'search_vault', arguments: '' } }),
                ccToolCallChunk({ index: 0, function: { arguments: '{"query":"test"}' } }),
                ccFinishChunk('tool_calls'),
                'data: [DONE]',
            ]));

            const result = await streamChatCompletions(
                'https://api.openai.com/v1/chat/completions',
                { Authorization: 'Bearer key' },
                { model: 'gpt-4' },
                () => {},
            );

            // Step 1: Verify ToolCall shape
            expect(result.toolCalls).toHaveLength(1);
            const tc = result.toolCalls[0];
            expect(tc.id).toBe('call_chat789');
            expect(tc.callId).toBeUndefined();
            expect(tc.function.name).toBe('search_vault');

            // Step 2: Format as assistant message
            const assistantMsg = formatAssistantToolCalls(result.toolCalls);
            expect(assistantMsg.role).toBe('assistant');
            expect(assistantMsg.content).toBeNull();
            expect(assistantMsg.tool_calls).toHaveLength(1);
            expect(assistantMsg.tool_calls![0].id).toBe('call_chat789');
            expect(assistantMsg.tool_calls![0].function.name).toBe('search_vault');

            // Step 3: Format tool result
            const toolResult = formatToolResultForChatCompletions(tc.id, 'Found 3 notes.');
            expect(toolResult.role).toBe('tool');
            expect(toolResult.tool_call_id).toBe('call_chat789');
            expect(toolResult.content).toBe('Found 3 notes.');
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// Category 2: ID Contract Validation
// ═════════════════════════════════════════════════════════════════════

describe('ID Contract Validation', () => {
    describe('formatFunctionCallForResponses contracts', () => {
        it('output `id` field must NEVER start with `call_`', () => {
            const tc = responsesToolCall({ id: 'fc_item1', callId: 'call_fn1', name: 'search_vault', args: '{}' });
            const msg = formatFunctionCallForResponses(tc);
            expect(msg.id).not.toMatch(/^call_/);
            expect(msg.id).toBe('fc_item1');
        });

        it('output `call_id` field equals tc.callId when present', () => {
            const tc = responsesToolCall({ id: 'fc_item2', callId: 'call_fn2', name: 'read_note', args: '{}' });
            const msg = formatFunctionCallForResponses(tc);
            expect(msg.call_id).toBe('call_fn2');
        });

        it('output `call_id` falls back to tc.id when callId is absent', () => {
            const tc = chatCompletionsToolCall({ id: 'call_fallback', name: 'search_vault', args: '{}' });
            const msg = formatFunctionCallForResponses(tc);
            expect(msg.call_id).toBe('call_fallback');
        });

        it('preserves both IDs independently — id and call_id must differ', () => {
            const tc = responsesToolCall({ id: 'fc_aaa', callId: 'call_bbb', name: 'get_note', args: '{"path":"x"}' });
            const msg = formatFunctionCallForResponses(tc);
            expect(msg.id).toBe('fc_aaa');
            expect(msg.call_id).toBe('call_bbb');
            expect(msg.id).not.toBe(msg.call_id);
        });
    });

    describe('formatToolResultForResponses contracts', () => {
        it('call_id must match the callId, not the item id', () => {
            const tc = responsesToolCall({ id: 'fc_item3', callId: 'call_fn3', name: 'search_vault', args: '{}' });
            const msg = formatToolResultForResponses(tc.callId || tc.id, 'result text');
            expect(msg.call_id).toBe('call_fn3');
            // Crucially: NOT 'fc_item3'
            expect(msg.call_id).not.toMatch(/^fc_/);
        });

        it('type is function_call_output', () => {
            const msg = formatToolResultForResponses('call_abc', 'data');
            expect(msg.type).toBe('function_call_output');
        });
    });

    describe('Responses API streaming: ToolCall ID invariants', () => {
        beforeEach(() => {
            mockHttpsRequest.mockReset();
        });

        it('ToolCall.id must NOT equal ToolCall.callId when both are provided by API', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_unique1', call_id: 'call_unique1', name: 'search_vault', arguments: '' } } },
                { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_unique1', call_id: 'call_unique1', name: 'search_vault', arguments: '{}' } } },
                { event: 'response.completed', data: { response: { id: 'r1', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});
            const tc = result.toolCalls[0];
            expect(tc.id).not.toBe(tc.callId);
        });

        it('ToolCall.id starts with `fc_` (Responses API convention)', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_convention', call_id: 'call_convention', name: 'read_note', arguments: '' } } },
                { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_convention', call_id: 'call_convention', name: 'read_note', arguments: '{"p":"a"}' } } },
                { event: 'response.completed', data: { response: { id: 'r2', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});
            const tc = result.toolCalls[0];
            expect(tc.id).toMatch(/^fc_/);
        });

        it('ToolCall.callId starts with `call_` (Responses API convention)', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_cidtest', call_id: 'call_cidtest', name: 'get_note', arguments: '' } } },
                { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_cidtest', call_id: 'call_cidtest', name: 'get_note', arguments: '{}' } } },
                { event: 'response.completed', data: { response: { id: 'r3', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});
            const tc = result.toolCalls[0];
            expect(tc.callId).toMatch(/^call_/);
        });
    });

    describe('Chat Completions streaming: ToolCall ID invariants', () => {
        let fetchSpy: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            fetchSpy = vi.fn();
            vi.stubGlobal('fetch', fetchSpy);
        });

        it('ToolCall.id starts with `call_` (Chat Completions convention)', async () => {
            fetchSpy.mockResolvedValue(mockFetchResponse([
                ccToolCallChunk({ index: 0, id: 'call_cc1', type: 'function', function: { name: 'search_vault', arguments: '{}' } }),
                ccFinishChunk('tool_calls'),
                'data: [DONE]',
            ]));

            const result = await streamChatCompletions(
                'https://api.openai.com/v1/chat/completions', {}, { model: 'gpt-4' }, () => {},
            );
            expect(result.toolCalls[0].id).toMatch(/^call_/);
        });

        it('ToolCall.callId is undefined for Chat Completions', async () => {
            fetchSpy.mockResolvedValue(mockFetchResponse([
                ccToolCallChunk({ index: 0, id: 'call_cc2', type: 'function', function: { name: 'read_note', arguments: '{}' } }),
                ccFinishChunk('tool_calls'),
                'data: [DONE]',
            ]));

            const result = await streamChatCompletions(
                'https://api.openai.com/v1/chat/completions', {}, { model: 'gpt-4' }, () => {},
            );
            expect(result.toolCalls[0].callId).toBeUndefined();
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// Category 3: Edge Cases
// ═════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
    beforeEach(() => {
        mockHttpsRequest.mockReset();
    });

    it('Responses API with missing call_id in SSE — falls back to id for callId', async () => {
        // Some edge cases may omit call_id entirely; the streaming code should
        // fall back to using the item id as callId
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_nocallid', name: 'search_vault', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_nocallid', delta: '{"q":"x"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_nocallid', name: 'search_vault', arguments: '{"q":"x"}' } } },
            { event: 'response.completed', data: { response: { id: 'r-fallback', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});

        expect(result.toolCalls).toHaveLength(1);
        const tc = result.toolCalls[0];
        // id should be the fc_ id
        expect(tc.id).toBe('fc_nocallid');
        // callId should fall back to the id since call_id was not provided
        expect(tc.callId).toBe('fc_nocallid');

        // Format should still work — call_id falls back to id
        const formatted = formatFunctionCallForResponses(tc);
        expect(formatted.id).toBe('fc_nocallid');
        expect(formatted.call_id).toBe('fc_nocallid');
    });

    it('multiple parallel tool calls preserve distinct IDs', async () => {
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_p1', call_id: 'call_p1', name: 'search_vault', arguments: '' } } },
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_p2', call_id: 'call_p2', name: 'read_note', arguments: '' } } },
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_p3', call_id: 'call_p3', name: 'list_notes', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_p1', delta: '{"q":"search"}' } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_p2', delta: '{"path":"note.md"}' } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_p3', delta: '{"folder":"/"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_p1', call_id: 'call_p1', name: 'search_vault', arguments: '{"q":"search"}' } } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_p2', call_id: 'call_p2', name: 'read_note', arguments: '{"path":"note.md"}' } } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_p3', call_id: 'call_p3', name: 'list_notes', arguments: '{"folder":"/"}' } } },
            { event: 'response.completed', data: { response: { id: 'resp-par', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});

        expect(result.toolCalls).toHaveLength(3);

        // Each tool call has unique, correct IDs
        const ids = result.toolCalls.map(tc => tc.id);
        const callIds = result.toolCalls.map(tc => tc.callId);
        expect(new Set(ids).size).toBe(3);
        expect(new Set(callIds).size).toBe(3);

        // Round-trip each through format functions
        for (const tc of result.toolCalls) {
            const fnCall = formatFunctionCallForResponses(tc);
            const fnOutput = formatToolResultForResponses(tc.callId || tc.id, `result for ${tc.function.name}`);
            // IDs match correctly
            expect(fnCall.id).toBe(tc.id);
            expect(fnCall.call_id).toBe(tc.callId);
            expect(fnOutput.call_id).toBe(tc.callId);
            // Cross-check: fnCall.call_id === fnOutput.call_id
            expect(fnCall.call_id).toBe(fnOutput.call_id);
        }
    });

    it('tool call from response.completed output array (not streaming events)', async () => {
        // Sometimes the API sends tool calls only in the response.completed output array
        setupHttpsMock([
            { event: 'response.completed', data: { response: {
                id: 'resp-completed-only',
                status: 'completed',
                output: [
                    { type: 'function_call', id: 'fc_fromcompleted', call_id: 'call_fromcompleted', name: 'search_vault', arguments: '{"q":"test"}' },
                ],
            } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});

        expect(result.toolCalls).toHaveLength(1);
        const tc = result.toolCalls[0];
        expect(tc.id).toBe('fc_fromcompleted');
        expect(tc.callId).toBe('call_fromcompleted');

        // Format round-trip works
        const fnCall = formatFunctionCallForResponses(tc);
        expect(fnCall.id).toBe('fc_fromcompleted');
        expect(fnCall.call_id).toBe('call_fromcompleted');
    });

    it('function_call_arguments.delta arriving before output_item.added', async () => {
        // The accumulator should create an entry on-the-fly for the item_id
        setupHttpsMock([
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_early', call_id: 'call_early', delta: '{"q":"early"}' } },
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_early', call_id: 'call_early', name: 'search_vault', arguments: '' } } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_early', call_id: 'call_early', name: 'search_vault', arguments: '{"q":"early"}' } } },
            { event: 'response.completed', data: { response: { id: 'resp-early', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});

        expect(result.toolCalls).toHaveLength(1);
        const tc = result.toolCalls[0];
        expect(tc.id).toBe('fc_early');
        expect(tc.function.name).toBe('search_vault');
        expect(tc.function.arguments).toBe('{"q":"early"}');
    });

    it('empty tool call name is filtered out', async () => {
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_noname', call_id: 'call_noname', name: '', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_noname', delta: '{}' } },
            // output_item.done also has empty name
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_noname', call_id: 'call_noname', name: '', arguments: '{}' } } },
            { event: 'response.completed', data: { response: { id: 'resp-empty', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => {});

        // Tool calls with empty name should be filtered out
        expect(result.toolCalls).toHaveLength(0);
    });

    it('multiple Chat Completions tool calls preserve distinct IDs', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        fetchSpy.mockResolvedValue(mockFetchResponse([
            // First tool call
            ccToolCallChunk({ index: 0, id: 'call_multi1', type: 'function', function: { name: 'search_vault', arguments: '' } }),
            ccToolCallChunk({ index: 0, function: { arguments: '{"q":"a"}' } }),
            // Second tool call
            ccToolCallChunk({ index: 1, id: 'call_multi2', type: 'function', function: { name: 'read_note', arguments: '' } }),
            ccToolCallChunk({ index: 1, function: { arguments: '{"path":"b.md"}' } }),
            ccFinishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const result = await streamChatCompletions(
            'https://api.openai.com/v1/chat/completions', {}, { model: 'gpt-4' }, () => {},
        );

        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[0].id).toBe('call_multi1');
        expect(result.toolCalls[0].function.name).toBe('search_vault');
        expect(result.toolCalls[1].id).toBe('call_multi2');
        expect(result.toolCalls[1].function.name).toBe('read_note');

        // Format as assistant message
        const msg = formatAssistantToolCalls(result.toolCalls);
        expect(msg.tool_calls).toHaveLength(2);
        expect(msg.tool_calls![0].id).toBe('call_multi1');
        expect(msg.tool_calls![1].id).toBe('call_multi2');
    });

    it('parallel tool calls with same index but different IDs are separated (Gemini bug)', async () => {
        // Reproduces the exact bug: provider sends 3 parallel tool calls all
        // with index 0 but different tc.id values. Previously these got
        // concatenated: name "list_filesget_recent_notessearch_vault",
        // args '{"path":"/"}{\"max_results\":5}{"query":"Obsidian"}'.
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        fetchSpy.mockResolvedValue(mockFetchResponse([
            ccToolCallChunk({ index: 0, id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }),
            ccToolCallChunk({ index: 0, id: 'call_b', type: 'function', function: { name: 'get_recent_notes', arguments: '{"max_results":5}' } }),
            ccToolCallChunk({ index: 0, id: 'call_c', type: 'function', function: { name: 'search_vault', arguments: '{"query":"Obsidian"}' } }),
            ccFinishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const result = await streamChatCompletions(
            'https://api.openai.com/v1/chat/completions', {}, { model: 'gemini-3-flash' }, () => {},
        );

        // Must produce 3 separate tool calls, not 1 concatenated one
        expect(result.toolCalls).toHaveLength(3);

        expect(result.toolCalls[0].id).toBe('call_a');
        expect(result.toolCalls[0].function.name).toBe('list_files');
        expect(result.toolCalls[0].function.arguments).toBe('{"path":"/"}');

        expect(result.toolCalls[1].id).toBe('call_b');
        expect(result.toolCalls[1].function.name).toBe('get_recent_notes');
        expect(result.toolCalls[1].function.arguments).toBe('{"max_results":5}');

        expect(result.toolCalls[2].id).toBe('call_c');
        expect(result.toolCalls[2].function.name).toBe('search_vault');
        expect(result.toolCalls[2].function.arguments).toBe('{"query":"Obsidian"}');

        // Format should produce 3 distinct tool calls
        const msg = formatAssistantToolCalls(result.toolCalls);
        expect(msg.tool_calls).toHaveLength(3);
        expect(msg.tool_calls![0].id).toBe('call_a');
        expect(msg.tool_calls![1].id).toBe('call_b');
        expect(msg.tool_calls![2].id).toBe('call_c');
    });

    it('parallel tool calls with same index 0 and streamed args are separated', async () => {
        // Variant: each tool call arrives in two chunks (name then args)
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        fetchSpy.mockResolvedValue(mockFetchResponse([
            // Tool 1: name chunk, then args chunk
            ccToolCallChunk({ index: 0, id: 'call_x', type: 'function', function: { name: 'search_vault', arguments: '' } }),
            ccToolCallChunk({ index: 0, id: 'call_x', function: { arguments: '{"q":"test"}' } }),
            // Tool 2: name chunk, then args chunk (same index 0, different id)
            ccToolCallChunk({ index: 0, id: 'call_y', type: 'function', function: { name: 'read_note', arguments: '' } }),
            ccToolCallChunk({ index: 0, id: 'call_y', function: { arguments: '{"path":"a.md"}' } }),
            ccFinishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const result = await streamChatCompletions(
            'https://api.openai.com/v1/chat/completions', {}, { model: 'gpt-4' }, () => {},
        );

        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[0].function.name).toBe('search_vault');
        expect(result.toolCalls[0].function.arguments).toBe('{"q":"test"}');
        expect(result.toolCalls[1].function.name).toBe('read_note');
        expect(result.toolCalls[1].function.arguments).toBe('{"path":"a.md"}');
    });
});

// ═════════════════════════════════════════════════════════════════════
// Category 4: Chat Controller Message Assembly Simulation
// ═════════════════════════════════════════════════════════════════════

describe('Chat Controller Message Assembly Simulation', () => {
    describe('Responses API: assembled input array', () => {
        it('function_call + function_call_output share consistent call_id', () => {
            // Simulate what chat-controller does after tool execution
            const toolCalls: ToolCall[] = [
                responsesToolCall({ id: 'fc_asm1', callId: 'call_asm1', name: 'search_vault', args: '{"q":"test"}' }),
                responsesToolCall({ id: 'fc_asm2', callId: 'call_asm2', name: 'read_note', args: '{"path":"x.md"}' }),
            ];
            const toolResults = ['Found 5 notes', 'Note content here'];

            // Build the input array as chat-controller would
            const input: ApiMessage[] = [];
            for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i];
                input.push(formatFunctionCallForResponses(tc));
                input.push(formatToolResultForResponses(tc.callId || tc.id, toolResults[i]));
            }

            // Verify structure
            expect(input).toHaveLength(4);

            // First pair
            expect(input[0].type).toBe('function_call');
            expect(input[0].id).toBe('fc_asm1');
            expect(input[0].call_id).toBe('call_asm1');
            expect(input[1].type).toBe('function_call_output');
            expect(input[1].call_id).toBe('call_asm1');
            // call_id links function_call to its output
            expect(input[0].call_id).toBe(input[1].call_id);

            // Second pair
            expect(input[2].type).toBe('function_call');
            expect(input[2].id).toBe('fc_asm2');
            expect(input[2].call_id).toBe('call_asm2');
            expect(input[3].type).toBe('function_call_output');
            expect(input[3].call_id).toBe('call_asm2');
            expect(input[2].call_id).toBe(input[3].call_id);
        });

        it('function_call.id is never overwritten by call_id', () => {
            const tc = responsesToolCall({ id: 'fc_distinct', callId: 'call_distinct', name: 'search_vault', args: '{}' });
            const fnCall = formatFunctionCallForResponses(tc);

            // The `id` field (item ID) must remain fc_distinct
            expect(fnCall.id).toBe('fc_distinct');
            // The `call_id` field (function call ID) must remain call_distinct
            expect(fnCall.call_id).toBe('call_distinct');
            // They must be different
            expect(fnCall.id).not.toBe(fnCall.call_id);
        });

        it('Responses API messages have no `role` field (uses type instead)', () => {
            const tc = responsesToolCall({ id: 'fc_norole', callId: 'call_norole', name: 'search_vault', args: '{}' });
            const fnCall = formatFunctionCallForResponses(tc);
            const fnOutput = formatToolResultForResponses(tc.callId || tc.id, 'result');

            // Responses API items use `type`, not `role`
            expect(fnCall.type).toBe('function_call');
            expect(fnOutput.type).toBe('function_call_output');
        });
    });

    describe('Chat Completions API: assembled messages array', () => {
        it('assistant + tool messages form correct pairs', () => {
            const toolCalls: ToolCall[] = [
                chatCompletionsToolCall({ id: 'call_cc_a1', name: 'search_vault', args: '{"q":"test"}' }),
                chatCompletionsToolCall({ id: 'call_cc_a2', name: 'read_note', args: '{"path":"x.md"}' }),
            ];
            const toolResults = ['Found 5 notes', 'Note content here'];

            // Build messages as chat-controller would
            const messages: ApiMessage[] = [];
            // First: assistant message with all tool_calls
            messages.push(formatAssistantToolCalls(toolCalls));
            // Then: one tool message per tool call
            for (let i = 0; i < toolCalls.length; i++) {
                messages.push(formatToolResultForChatCompletions(toolCalls[i].id, toolResults[i]));
            }

            expect(messages).toHaveLength(3);

            // Assistant message
            expect(messages[0].role).toBe('assistant');
            expect(messages[0].content).toBeNull();
            expect(messages[0].tool_calls).toHaveLength(2);
            expect(messages[0].tool_calls![0].id).toBe('call_cc_a1');
            expect(messages[0].tool_calls![1].id).toBe('call_cc_a2');

            // Tool result messages reference the correct tool call IDs
            expect(messages[1].role).toBe('tool');
            expect(messages[1].tool_call_id).toBe('call_cc_a1');
            expect(messages[1].content).toBe('Found 5 notes');

            expect(messages[2].role).toBe('tool');
            expect(messages[2].tool_call_id).toBe('call_cc_a2');
            expect(messages[2].content).toBe('Note content here');
        });

        it('tool_call_id in result matches tool_calls[].id in assistant message', () => {
            const tc = chatCompletionsToolCall({ id: 'call_matchtest', name: 'search_vault', args: '{}' });
            const assistantMsg = formatAssistantToolCalls([tc]);
            const toolResultMsg = formatToolResultForChatCompletions(tc.id, 'result');

            // The ID used in the tool result matches the one in the assistant message
            expect(toolResultMsg.tool_call_id).toBe(assistantMsg.tool_calls![0].id);
        });
    });

    describe('Cross-API contract: same ToolCall, different formats', () => {
        it('same ToolCall formatted for both APIs produces correct structures', () => {
            // A ToolCall with both IDs (as produced by Responses API streaming)
            const tc = responsesToolCall({
                id: 'fc_crossapi',
                callId: 'call_crossapi',
                name: 'search_vault',
                args: '{"q":"dual"}',
            });

            // Responses API format
            const responsesMsg = formatFunctionCallForResponses(tc);
            expect(responsesMsg.type).toBe('function_call');
            expect(responsesMsg.id).toBe('fc_crossapi');
            expect(responsesMsg.call_id).toBe('call_crossapi');

            // Chat Completions format (formatAssistantToolCalls uses tc.id)
            const chatMsg = formatAssistantToolCalls([tc]);
            // For Chat Completions, the id in tool_calls is whatever tc.id is
            expect(chatMsg.tool_calls![0].id).toBe('fc_crossapi');

            // The two formats use different ID fields for different purposes
            // Responses: id = item ID (fc_), call_id = function call ID (call_)
            // Chat Completions: id = the single identifier used for tool_call_id matching
        });

        it('Responses API result uses callId; Chat Completions result uses id', () => {
            const tc = responsesToolCall({
                id: 'fc_resultdiff',
                callId: 'call_resultdiff',
                name: 'read_note',
                args: '{}',
            });

            // Responses API: result keyed by callId
            const responsesResult = formatToolResultForResponses(tc.callId || tc.id, 'responses output');
            expect(responsesResult.call_id).toBe('call_resultdiff');

            // Chat Completions: result keyed by id
            const ccResult = formatToolResultForChatCompletions(tc.id, 'cc output');
            expect(ccResult.tool_call_id).toBe('fc_resultdiff');

            // They use different identifiers — this is correct and expected
            expect(responsesResult.call_id).not.toBe(ccResult.tool_call_id);
        });
    });
});

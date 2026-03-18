import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { streamSSE, streamResponsesAPI, streamMessagesAPI, formatApiError } from '../src/streaming';
import type { ChunkType, ToolCall } from '../src/types';

// ── Mock https/http for streamResponsesAPI (Node.js transport) ──────
const { mockHttpsRequest } = vi.hoisted(() => ({ mockHttpsRequest: vi.fn() }));
vi.mock('https', () => ({ default: { request: mockHttpsRequest }, request: mockHttpsRequest }));
vi.mock('http', () => ({ default: { request: mockHttpsRequest }, request: mockHttpsRequest }));

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build a mock fetch Response whose body streams the given SSE lines.
 */
function mockFetchResponse(lines: string[], status = 200, statusText = 'OK') {
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
        statusText,
        body: stream,
        text: async () => body,
    } as unknown as Response;
}

/** Shorthand for a single SSE data line. */
function sseData(obj: Record<string, unknown>): string {
    return `data: ${JSON.stringify(obj)}`;
}

/** Build a standard delta-content SSE chunk. */
function contentChunk(content: string, id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: { content }, finish_reason: null }],
    });
}

/** Build a reasoning chunk. */
function reasoningChunk(reasoning: string, id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: { reasoning }, finish_reason: null }],
    });
}

/** Build a reasoning_details chunk (OpenAI format). */
function reasoningDetailsChunk(text: string, id = 'gen-1') {
    return sseData({
        id,
        choices: [{
            delta: {
                reasoning_details: [{ type: 'reasoning.text', text }],
            },
            finish_reason: null,
        }],
    });
}

/** Build a finish chunk. */
function finishChunk(reason = 'stop', id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: {}, finish_reason: reason }],
    });
}

/** Build tool_calls delta chunk. */
function toolCallChunk(tc: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }, id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: { tool_calls: [tc] }, finish_reason: null }],
    });
}

/** Image delta chunk. */
function imageChunk(url: string, id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: { images: [{ image_url: { url } }] }, finish_reason: null }],
    });
}

/** Image in message (non-delta completion). */
function messageImageChunk(url: string, id = 'gen-1') {
    return sseData({
        id,
        choices: [{ delta: {}, message: { images: [{ image_url: { url } }] } }],
    });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('streamSSE', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
    });

    // ── Basic content streaming ─────────────────────────────────

    it('streams content tokens and returns generationId', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('Hello'),
            contentChunk(' world'),
            finishChunk('stop'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        const result = await streamSSE(
            'https://api.example.com/chat',
            { Authorization: 'Bearer key' },
            { model: 'gpt-4' },
            (token, type) => chunks.push({ token, type }),
        );

        expect(result.generationId).toBe('gen-1');
        expect(result.finishReason).toBe('stop');
        expect(result.toolCalls).toEqual([]);
        expect(chunks).toEqual([
            { token: 'Hello', type: 'content' },
            { token: ' world', type: 'content' },
        ]);
    });

    it('sends correct request parameters', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse(['data: [DONE]']));

        await streamSSE(
            'https://api.example.com/chat',
            { Authorization: 'Bearer test-key' },
            { model: 'gpt-4', messages: [] },
            () => { },
        );

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://api.example.com/chat',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer test-key',
                },
                body: JSON.stringify({ model: 'gpt-4', messages: [] }),
            }),
        );
    });

    // ── Error handling ──────────────────────────────────────────

    it('throws on non-OK response', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse(
            ['Error details'], 400, 'Bad Request',
        ));

        await expect(
            streamSSE('https://api.example.com/chat', {}, {}, () => { }),
        ).rejects.toThrow('API 400');
    });

    it('includes error detail text', async () => {
        const errorResponse = {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: async () => '{"error":"rate limited"}',
            body: null,
        } as unknown as Response;
        fetchSpy.mockResolvedValue(errorResponse);

        await expect(
            streamSSE('https://api.example.com/chat', {}, {}, () => { }),
        ).rejects.toThrow('{"error":"rate limited"}');
    });

    it('uses statusText when error body is unreadable', async () => {
        const errorResponse = {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => { throw new Error('no body'); },
            body: null,
        } as unknown as Response;
        fetchSpy.mockResolvedValue(errorResponse);

        await expect(
            streamSSE('https://api.example.com/chat', {}, {}, () => { }),
        ).rejects.toThrow('API 500: Internal Server Error');
    });

    it('throws when response body is null', async () => {
        const nullBodyResponse = {
            ok: true,
            status: 200,
            statusText: 'OK',
            body: null,
        } as unknown as Response;
        fetchSpy.mockResolvedValue(nullBodyResponse);

        await expect(
            streamSSE('https://api.example.com/chat', {}, {}, () => { }),
        ).rejects.toThrow('Response body is null');
    });

    // ── [DONE] handling ─────────────────────────────────────────

    it('returns result on [DONE]', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('hi', 'gen-abc'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.generationId).toBe('gen-abc');
    });

    it('returns result when stream ends without [DONE]', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('hi'),
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.generationId).toBe('gen-1');
        expect(result.toolCalls).toEqual([]);
    });

    // ── Reasoning tokens ────────────────────────────────────────

    it('streams reasoning tokens via delta.reasoning', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            reasoningChunk('thinking...'),
            reasoningChunk(' more thought'),
            contentChunk('answer'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: 'thinking...', type: 'reasoning' },
            { token: ' more thought', type: 'reasoning' },
            { token: 'answer', type: 'content' },
        ]);
    });

    it('streams reasoning_details format', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            reasoningDetailsChunk('step 1'),
            reasoningDetailsChunk('step 2'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: 'step 1', type: 'reasoning' },
            { token: 'step 2', type: 'reasoning' },
        ]);
    });

    it('ignores reasoning_details with non-matching type', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({
                id: 'gen-1',
                choices: [{
                    delta: { reasoning_details: [{ type: 'other', text: 'skip' }] },
                    finish_reason: null,
                }],
            }),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));
        expect(chunks).toEqual([]);
    });

    // ── Copilot reasoning_text / reasoning_opaque ───────────────

    it('streams Copilot reasoning_text as reasoning type', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({
                id: 'gen-1',
                choices: [{ delta: { content: null, role: 'assistant', reasoning_text: '**Analyzing the code**\n\n' }, finish_reason: null }],
            }),
            sseData({
                id: 'gen-1',
                choices: [{ delta: { content: 'Here is the answer.', role: 'assistant' }, finish_reason: 'stop' }],
            }),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        const result = await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: '**Analyzing the code**\n\n', type: 'reasoning' },
            { token: 'Here is the answer.', type: 'content' },
        ]);
        expect(result.finishReason).toBe('stop');
    });

    it('captures reasoning_opaque from Copilot delta', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({
                id: 'gen-1',
                choices: [{ delta: { content: null, reasoning_text: 'thinking...' }, finish_reason: null }],
            }),
            sseData({
                id: 'gen-1',
                choices: [{ delta: { content: 'answer', reasoning_opaque: 'opaque-token-abc' }, finish_reason: 'stop' }],
            }),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        const result = await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(result.reasoningOpaque).toBe('opaque-token-abc');
        expect(chunks).toEqual([
            { token: 'thinking...', type: 'reasoning' },
            { token: 'answer', type: 'content' },
        ]);
    });

    it('streams cot_summary (Azure OpenAI) as reasoning type', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({
                id: 'gen-1',
                choices: [{ delta: { cot_summary: 'Chain of thought reasoning' }, finish_reason: null }],
            }),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: 'Chain of thought reasoning', type: 'reasoning' },
        ]);
    });

    // ── Image tokens ────────────────────────────────────────────

    it('streams images from delta.images', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            imageChunk('data:image/png;base64,abc123'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: 'data:image/png;base64,abc123', type: 'image' },
        ]);
    });

    it('streams images from message.images (non-delta)', async () => {
        // This format appears in some OpenAI image gen responses
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({
                id: 'gen-1',
                choices: [{
                    delta: {},
                    message: { images: [{ image_url: { url: 'https://img.example.com/1.png' } }] },
                    finish_reason: null,
                }],
            }),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: 'https://img.example.com/1.png', type: 'image' },
        ]);
    });

    // ── Tool call accumulation ──────────────────────────────────

    it('accumulates tool calls across deltas', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            toolCallChunk({ index: 0, id: 'call-1', type: 'function', function: { name: 'search' } }),
            toolCallChunk({ index: 0, function: { name: '_vault', arguments: '{"q' } }),
            toolCallChunk({ index: 0, function: { arguments: 'uery":"test"}' } }),
            finishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const toolCallSnapshots: ToolCall[][] = [];
        await streamSSE('url', {}, {}, (token, type, toolCalls) => {
            if (type === 'tool_calls' && toolCalls) {
                toolCallSnapshots.push(JSON.parse(JSON.stringify(toolCalls)));
            }
        });

        // After all deltas, the final snapshot should have the full tool call
        const last = toolCallSnapshots[toolCallSnapshots.length - 1];
        expect(last).toHaveLength(1);
        expect(last[0].id).toBe('call-1');
        expect(last[0].type).toBe('function');
        expect(last[0].function.name).toBe('search_vault');
        expect(last[0].function.arguments).toBe('{"query":"test"}');
    });

    it('does not double function name when provider resends it', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            toolCallChunk({ index: 0, id: 'call-1', type: 'function', function: { name: 'search_vault' } }),
            // Some providers resend the full name alongside arguments
            toolCallChunk({ index: 0, function: { name: 'search_vault', arguments: '{"query":"test"}' } }),
            finishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => {});
        expect(result.toolCalls[0].function.name).toBe('search_vault');
        expect(result.toolCalls[0].function.arguments).toBe('{"query":"test"}');
    });

    it('accumulates multiple parallel tool calls', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            toolCallChunk({ index: 0, id: 'call-1', type: 'function', function: { name: 'search_vault' } }),
            toolCallChunk({ index: 1, id: 'call-2', type: 'function', function: { name: 'read_note' } }),
            toolCallChunk({ index: 0, function: { arguments: '{"query":"test"}' } }),
            toolCallChunk({ index: 1, function: { arguments: '{"path":"note.md"}' } }),
            finishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });

        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[0].function.name).toBe('search_vault');
        expect(result.toolCalls[0].function.arguments).toBe('{"query":"test"}');
        expect(result.toolCalls[1].function.name).toBe('read_note');
        expect(result.toolCalls[1].function.arguments).toBe('{"path":"note.md"}');
        expect(result.finishReason).toBe('tool_calls');
    });

    it('returns tool calls in result even without [DONE]', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            toolCallChunk({ index: 0, id: 'call-1', type: 'function', function: { name: 'create_note', arguments: '{}' } }),
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe('create_note');
    });

    // ── SSE parsing edge cases ──────────────────────────────────

    it('skips empty lines and non-data lines', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            '',
            ': comment line',
            'event: message',
            contentChunk('only this'),
            '',
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([{ token: 'only this', type: 'content' }]);
    });

    it('handles malformed JSON gracefully', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('before'),
            'data: {invalid json}',
            contentChunk('after'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([
            { token: 'before', type: 'content' },
            { token: 'after', type: 'content' },
        ]);
    });

    it('handles chunked delivery (split across reads)', async () => {
        // Simulate data arriving in multiple read() calls
        const encoder = new TextEncoder();
        const part1 = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'hel' }, finish_reason: null }] })}\n`;
        const part2 = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'lo' }, finish_reason: null }] })}\ndata: [DONE]\n`;

        let readCount = 0;
        const stream = new ReadableStream({
            pull(controller) {
                if (readCount === 0) {
                    controller.enqueue(encoder.encode(part1));
                    readCount++;
                } else if (readCount === 1) {
                    controller.enqueue(encoder.encode(part2));
                    readCount++;
                } else {
                    controller.close();
                }
            },
        });

        fetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            body: stream,
        } as unknown as Response);

        const chunks: string[] = [];
        const result = await streamSSE('url', {}, {}, (token) => {
            if (token) chunks.push(token);
        });

        expect(chunks).toEqual(['hel', 'lo']);
        expect(result.generationId).toBe('gen-1');
    });

    it('handles SSE data line without trailing space', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            'data:{"id": "gen-nospace", "choices": [{"delta": {"content": "test"}, "finish_reason": null}]}',
            'data:[DONE]',
        ]));

        const chunks: string[] = [];
        const result = await streamSSE('url', {}, {}, (token, type) => {
            if (type === 'content' && token) chunks.push(token);
        });

        expect(chunks).toEqual(['test']);
        expect(result.generationId).toBe('gen-nospace');
    });

    it('processes remaining buffer if stream ends without trailing newline', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"id": "gen-end", "choices": [{"delta": {"content": "buffer_test"}, "finish_reason": null}]}'));
                controller.close();
            },
        });
        fetchSpy.mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response);

        const chunks: string[] = [];
        const result = await streamSSE('url', {}, {}, (token, type) => {
            if (type === 'content' && token) chunks.push(token);
        });

        expect(chunks).toEqual(['buffer_test']);
        expect(result.generationId).toBe('gen-end');
    });

    // ── Abort signal ────────────────────────────────────────────

    it('passes abort signal to fetch', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse(['data: [DONE]']));
        const controller = new AbortController();

        await streamSSE('url', {}, {}, () => { }, controller.signal);

        expect(fetchSpy).toHaveBeenCalledWith(
            'url',
            expect.objectContaining({ signal: controller.signal }),
        );
    });

    // ── finish_reason tracking ──────────────────────────────────

    it('tracks finish_reason from choices', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('hi'),
            finishChunk('length'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.finishReason).toBe('length');
    });

    it('returns null finishReason when none provided', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('hi'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.finishReason).toBeNull();
    });

    // ── generationId extraction ─────────────────────────────────

    it('extracts generationId from first chunk only', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('a', 'first-id'),
            contentChunk('b', 'second-id'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.generationId).toBe('first-id');
    });

    it('returns null generationId when no id in chunks', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.generationId).toBeNull();
    });

    // ── Mixed content types ─────────────────────────────────────

    it('handles mixed reasoning + content + tool calls', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            reasoningChunk('let me think'),
            contentChunk('The answer is 42'),
            toolCallChunk({ index: 0, id: 'tc-1', type: 'function', function: { name: 'search_vault', arguments: '{}' } }),
            finishChunk('tool_calls'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        const result = await streamSSE('url', {}, {}, (token, type) => {
            chunks.push({ token, type });
        });

        expect(chunks).toContainEqual({ token: 'let me think', type: 'reasoning' });
        expect(chunks).toContainEqual({ token: 'The answer is 42', type: 'content' });
        expect(chunks).toContainEqual({ token: null, type: 'tool_calls' });
        expect(result.toolCalls).toHaveLength(1);
        expect(result.finishReason).toBe('tool_calls');
    });

    // ── Empty / no-content chunks ───────────────────────────────

    it('handles chunks with no delta content', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({ id: 'gen-1', choices: [{ delta: {}, finish_reason: null }] }),
            sseData({ id: 'gen-1', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
            contentChunk('actual content'),
            'data: [DONE]',
        ]));

        const chunks: { token: string | null; type?: ChunkType }[] = [];
        await streamSSE('url', {}, {}, (token, type) => chunks.push({ token, type }));

        expect(chunks).toEqual([{ token: 'actual content', type: 'content' }]);
    });

    // ── Tool call with default index ────────────────────────────

    it('defaults tool call index to 0 when not specified', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            toolCallChunk({ id: 'tc-1', type: 'function', function: { name: 'read_note', arguments: '{"path":"x"}' } }),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe('read_note');
    });

    // ── Usage extraction (Chat Completions) ─────────────────────

    it('extracts usage from final SSE chunk', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('Hello'),
            sseData({
                id: 'gen-1',
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 581, completion_tokens: 12, total_tokens: 593 },
            }),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.usage).toEqual({
            prompt_tokens: 581,
            completion_tokens: 12,
            total_tokens: 593,
        });
    });

    it('extracts usage from tool_calls finish with Copilot format', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            toolCallChunk({ index: 0, id: 'tc-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }),
            sseData({
                id: 'gen-1',
                choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                usage: {
                    prompt_tokens: 589,
                    completion_tokens: 54,
                    prompt_tokens_details: { cached_tokens: 0 },
                    total_tokens: 643,
                },
            }),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.usage).toBeDefined();
        expect(result.usage!.prompt_tokens).toBe(589);
        expect(result.usage!.completion_tokens).toBe(54);
        expect(result.usage!.total_tokens).toBe(643);
    });

    it('extracts usage with GPT completion_tokens_details format', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('Four'),
            sseData({
                id: 'gen-1',
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: 51,
                    completion_tokens: 9,
                    completion_tokens_details: { accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
                    prompt_tokens_details: { cached_tokens: 0 },
                    total_tokens: 60,
                    reasoning_tokens: 0,
                },
            }),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.usage).toBeDefined();
        expect(result.usage!.prompt_tokens).toBe(51);
        expect(result.usage!.completion_tokens).toBe(9);
        expect(result.usage!.total_tokens).toBe(60);
    });

    it('returns undefined usage when no usage in stream', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            contentChunk('Hello'),
            finishChunk('stop'),
            'data: [DONE]',
        ]));

        const result = await streamSSE('url', {}, {}, () => { });
        expect(result.usage).toBeUndefined();
    });
});

// ── Copilot thinking deltas (Anthropic format) ─────────────────────

describe('Copilot thinking deltas', () => {
    let fetchSpy: any;
    let chunkLog: Array<[string | null, string | undefined]>;
    const onChunk = (t: string | null, kind?: string) => chunkLog.push([t, kind]);

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, 'fetch');
        chunkLog = [];
    });

    it('handles delta.thinking (Anthropic-style via Copilot)', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({ choices: [{ delta: { thinking: 'Let me think about this...' } }] }),
            sseData({ choices: [{ delta: { content: 'Here is my answer.' } }] }),
            'data: [DONE]',
        ]));

        await streamSSE('url', {}, {}, onChunk);
        const reasoningChunks = chunkLog.filter(([, kind]) => kind === 'reasoning');
        const contentChunks = chunkLog.filter(([, kind]) => kind === 'content');
        expect(reasoningChunks.length).toBeGreaterThan(0);
        expect(reasoningChunks[0][0]).toBe('Let me think about this...');
        expect(contentChunks.length).toBeGreaterThan(0);
        expect(contentChunks[0][0]).toBe('Here is my answer.');
    });

    it('handles delta.content array with type thinking blocks', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({ choices: [{ delta: { content: [{ type: 'thinking', thinking: 'I need to consider...' }] } }] }),
            sseData({ choices: [{ delta: { content: 'The answer is 42.' } }] }),
            'data: [DONE]',
        ]));

        await streamSSE('url', {}, {}, onChunk);
        const reasoningChunks = chunkLog.filter(([, kind]) => kind === 'reasoning');
        const contentChunks = chunkLog.filter(([, kind]) => kind === 'content');
        expect(reasoningChunks.length).toBeGreaterThan(0);
        expect(reasoningChunks[0][0]).toBe('I need to consider...');
        expect(contentChunks.length).toBeGreaterThan(0);
    });

    it('handles mixed thinking formats in same stream', async () => {
        fetchSpy.mockResolvedValue(mockFetchResponse([
            sseData({ choices: [{ delta: { thinking: 'Thinking via delta.thinking' } }] }),
            sseData({ choices: [{ delta: { reasoning: 'Thinking via delta.reasoning' } }] }),
            sseData({ choices: [{ delta: { content: 'Final answer.' } }] }),
            'data: [DONE]',
        ]));

        await streamSSE('url', {}, {}, onChunk);
        const reasoningChunks = chunkLog.filter(([, kind]) => kind === 'reasoning');
        expect(reasoningChunks).toHaveLength(2);
        expect(reasoningChunks[0][0]).toBe('Thinking via delta.thinking');
        expect(reasoningChunks[1][0]).toBe('Thinking via delta.reasoning');
    });
});

// ── Responses API Tests ─────────────────────────────────────────────

/**
 * Create a mock Node.js IncomingMessage (readable stream) for Responses API SSE.
 * Uses named events (event: xxx\ndata: yyy).
 */
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

/**
 * Set up the https.request mock to return a mock response.
 */
function setupHttpsMock(events: Array<{ event: string; data: any }>, statusCode = 200) {
    const incoming = mockNodeIncoming(events, statusCode);
    mockHttpsRequest.mockImplementation((_options: any, callback: any) => {
        process.nextTick(() => callback(incoming));
        return {
            on: vi.fn(),
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
        };
    });
}

describe('streamResponsesAPI', () => {
    let chunkLog: Array<[string | null, ChunkType | undefined, ToolCall[] | undefined]>;
    let onChunk: (token: string | null, type?: ChunkType, toolCalls?: ToolCall[]) => void;

    beforeEach(() => {
        mockHttpsRequest.mockReset();
        chunkLog = [];
        onChunk = (token, type, tc) => chunkLog.push([token, type, tc]);
    });

    // ── Basic content streaming ─────────────────────────────────

    it('streams content from output_text.delta events', async () => {
        setupHttpsMock([
            { event: 'response.output_text.delta', data: { delta: 'Hello' } },
            { event: 'response.output_text.delta', data: { delta: ' world' } },
            { event: 'response.completed', data: { response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

        expect(result.generationId).toBe('resp-1');
        expect(result.finishReason).toBe('stop');
        expect(result.toolCalls).toEqual([]);
        expect(chunkLog).toEqual([
            ['Hello', 'content', undefined],
            [' world', 'content', undefined],
        ]);
    });

    // ── Reasoning streaming ─────────────────────────────────────

    it('streams reasoning from reasoning_summary_text.delta events', async () => {
        setupHttpsMock([
            { event: 'response.reasoning_summary_text.delta', data: { delta: 'Let me think...' } },
            { event: 'response.reasoning_summary_text.delta', data: { delta: ' step 1' } },
            { event: 'response.output_text.delta', data: { delta: 'Answer: 4' } },
            { event: 'response.completed', data: { response: { id: 'resp-2', status: 'completed', usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 } } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

        expect(result.generationId).toBe('resp-2');
        const reasoningChunks = chunkLog.filter(([, kind]) => kind === 'reasoning');
        const contentChunks = chunkLog.filter(([, kind]) => kind === 'content');
        expect(reasoningChunks).toHaveLength(2);
        expect(reasoningChunks[0][0]).toBe('Let me think...');
        expect(reasoningChunks[1][0]).toBe(' step 1');
        expect(contentChunks).toHaveLength(1);
        expect(contentChunks[0][0]).toBe('Answer: 4');
    });

    // ── Usage extraction ────────────────────────────────────────

    it('extracts usage from response.completed event', async () => {
        setupHttpsMock([
            { event: 'response.output_text.delta', data: { delta: 'hi' } },
            { event: 'response.completed', data: { response: { id: 'resp-3', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

        expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    });

    // ── Tool calls ──────────────────────────────────────────────

    it('handles function call tool calls', async () => {
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_vault', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_1', call_id: 'call_1', delta: '{"query":' } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_1', call_id: 'call_1', delta: ' "test"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_vault', arguments: '{"query": "test"}' } } },
            { event: 'response.completed', data: { response: { id: 'resp-4', status: 'completed', usage: { input_tokens: 10, output_tokens: 20 } } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toEqual({
            id: 'fc_1',
            callId: 'call_1',
            type: 'function',
            function: { name: 'search_vault', arguments: '{"query": "test"}' },
        });

        // onChunk is called with tool_calls
        const tcChunk = chunkLog.find(([, kind]) => kind === 'tool_calls');
        expect(tcChunk).toBeDefined();
        expect(tcChunk![2]).toHaveLength(1);
    });

    it('handles multiple function calls in one response', async () => {
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_vault', arguments: '' } } },
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_note', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_1', delta: '{"q":"a"}' } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_2', delta: '{"path":"b"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_vault', arguments: '{"q":"a"}' } } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_note', arguments: '{"path":"b"}' } } },
            { event: 'response.completed', data: { response: { id: 'resp-5', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[0].function.name).toBe('search_vault');
        expect(result.toolCalls[1].function.name).toBe('get_note');
    });

    // ── Error handling ──────────────────────────────────────────

    it('throws on non-OK response', async () => {
        setupHttpsMock([], 400);
        await expect(
            streamResponsesAPI('https://api.example.com/responses', {}, {}, () => { }),
        ).rejects.toThrow('API 400');
    });

    // ── Request format ──────────────────────────────────────────

    it('sends correct request parameters', async () => {
        setupHttpsMock([
            { event: 'response.completed', data: { response: { id: 'r1', status: 'completed' } } },
        ]);

        await streamResponsesAPI(
            'https://api.example.com/responses',
            { Authorization: 'Bearer test-key' },
            { model: 'gpt-5-mini', input: [], store: false },
            () => { },
        );

        expect(mockHttpsRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                hostname: 'api.example.com',
                path: '/responses',
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer test-key',
                }),
            }),
            expect.any(Function),
        );
    });

    // ── Generation ID from early events ─────────────────────────

    it('captures generation ID from early events', async () => {
        setupHttpsMock([
            { event: 'response.created', data: { response: { id: 'resp-early' } } },
            { event: 'response.output_text.delta', data: { delta: 'hi' } },
            { event: 'response.completed', data: { response: { id: 'resp-early', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.generationId).toBe('resp-early');
    });

    // ── Empty/malformed data handling ───────────────────────────

    it('skips malformed JSON data lines gracefully', async () => {
        const events: Array<{ event: string; data: any }> = [
            { event: 'response.output_text.delta', data: { delta: 'ok' } },
            { event: 'response.completed', data: { response: { id: 'r1', status: 'completed' } } },
        ];
        // Build SSE manually with a bad line injected
        const lines: string[] = [];
        lines.push('event: response.output_text.delta');
        lines.push('data: {bad json');
        lines.push('');
        for (const ev of events) {
            lines.push(`event: ${ev.event}`);
            lines.push(`data: ${JSON.stringify(ev.data)}`);
            lines.push('');
        }
        const body = lines.join('\n') + '\n';

        // Build a Node.js Readable with the malformed SSE body
        const incoming = new Readable({
            read() { this.push(Buffer.from(body)); this.push(null); },
        });
        (incoming as any).statusCode = 200;
        (incoming as any).statusMessage = 'OK';
        mockHttpsRequest.mockImplementation((_options: any, callback: any) => {
            process.nextTick(() => callback(incoming));
            return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
        });

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.generationId).toBe('r1');
        expect(chunkLog.some(([token]) => token === 'ok')).toBe(true);
    });

    // ── Ignores empty delta ────────────────────────────────────

    it('ignores empty delta strings', async () => {
        setupHttpsMock([
            { event: 'response.reasoning_summary_text.delta', data: { delta: '' } },
            { event: 'response.output_text.delta', data: { delta: '' } },
            { event: 'response.output_text.delta', data: { delta: 'actual' } },
            { event: 'response.completed', data: { response: { id: 'r2', status: 'completed' } } },
        ]);

        await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(chunkLog).toHaveLength(1);
        expect(chunkLog[0][0]).toBe('actual');
    });

    // ── Finish reason mapping ──────────────────────────────────

    it('maps incomplete status to finish_reason', async () => {
        setupHttpsMock([
            { event: 'response.completed', data: { response: { id: 'r3', status: 'incomplete' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, () => { });
        expect(result.finishReason).toBe('incomplete');
    });

    // ── Tool calls from response.completed output ───────────────

    it('extracts tool calls from response.completed output array', async () => {
        setupHttpsMock([
            { event: 'response.completed', data: { response: { id: 'r4', status: 'completed', output: [
                { type: 'function_call', id: 'fc_x', call_id: 'call_x', name: 'search_vault', arguments: '{"q":"test"}' },
            ] } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe('search_vault');
    });

    // ── response.completed must not overwrite delta-accumulated args ──

    it('response.completed with empty args does NOT erase delta-accumulated args', async () => {
        // Simulates the Copilot proxy bug: response.completed includes
        // function_call items with empty arguments, which previously
        // overwrote the carefully accumulated delta args.
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_bug', call_id: 'call_bug', name: 'search_vault', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_bug', call_id: 'call_bug', delta: '{"query":' } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_bug', call_id: 'call_bug', delta: ' "obsidian"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_bug', call_id: 'call_bug', name: 'search_vault', arguments: '{"query": "obsidian"}' } } },
            // response.completed with empty arguments — this is the bug trigger
            { event: 'response.completed', data: { response: { id: 'r-bug', status: 'completed', output: [
                { type: 'function_call', id: 'fc_bug', call_id: 'call_bug', name: 'search_vault', arguments: '' },
            ] } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.toolCalls).toHaveLength(1);
        // The delta-accumulated args must survive the response.completed overwrite
        expect(result.toolCalls[0].function.arguments).toBe('{"query": "obsidian"}');
    });

    it('response.completed with undefined args does NOT erase delta-accumulated args', async () => {
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_undef', call_id: 'call_undef', name: 'read_note', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_undef', delta: '{"path":"daily.md"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_undef', call_id: 'call_undef', name: 'read_note', arguments: '{"path":"daily.md"}' } } },
            // response.completed with NO arguments field at all
            { event: 'response.completed', data: { response: { id: 'r-undef', status: 'completed', output: [
                { type: 'function_call', id: 'fc_undef', call_id: 'call_undef', name: 'read_note' },
            ] } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.arguments).toBe('{"path":"daily.md"}');
    });

    it('response.completed with valid args updates entry correctly (non-regression)', async () => {
        // When response.completed has complete args, it should use them
        setupHttpsMock([
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_ok', call_id: 'call_ok', name: 'search_vault', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_ok', delta: '{"q":"test"}' } },
            { event: 'response.completed', data: { response: { id: 'r-ok', status: 'completed', output: [
                { type: 'function_call', id: 'fc_ok', call_id: 'call_ok', name: 'search_vault', arguments: '{"q":"test"}' },
            ] } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.arguments).toBe('{"q":"test"}');
    });

    // ── output_item.done without prior added event ──────────────

    it('output_item.done creates entry even if added event was missed', async () => {
        // Bug 3 regression: if output_item.added is missed, done should still work
        setupHttpsMock([
            // No output_item.added! Jump straight to done
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_missed', call_id: 'call_missed', name: 'fetch_url', arguments: '{"url":"https://x.com"}' } } },
            { event: 'response.completed', data: { response: { id: 'r-missed', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe('fetch_url');
        expect(result.toolCalls[0].function.arguments).toBe('{"url":"https://x.com"}');
        expect(result.toolCalls[0].callId).toBe('call_missed');
    });

    // ── Reasoning + tool call interleaving ──────────────────────

    it('reasoning deltas before function call do not interfere with arg accumulation', async () => {
        setupHttpsMock([
            // Reasoning first
            { event: 'response.reasoning_summary_text.delta', data: { delta: 'Let me search' } },
            { event: 'response.reasoning_summary_text.delta', data: { delta: ' for that.' } },
            // Then function call
            { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_think', call_id: 'call_think', name: 'search_vault', arguments: '' } } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_think', delta: '{"query":' } },
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_think', delta: '"notes"}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_think', call_id: 'call_think', name: 'search_vault', arguments: '{"query":"notes"}' } } },
            // response.completed with empty args — the original bug scenario
            { event: 'response.completed', data: { response: { id: 'r-think', status: 'completed', output: [
                { type: 'function_call', id: 'fc_think', call_id: 'call_think', name: 'search_vault', arguments: '' },
            ] } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.arguments).toBe('{"query":"notes"}');

        // Also verify reasoning was captured
        const reasoningChunks = chunkLog.filter(([, type]) => type === 'reasoning');
        expect(reasoningChunks).toHaveLength(2);
    });

    // ── Abort signal ────────────────────────────────────────────

    it('rejects with AbortError when signal is aborted', async () => {
        const controller = new AbortController();
        // Set up a mock that delays the callback, giving time to abort
        mockHttpsRequest.mockImplementation((_options: any, _callback: any) => {
            const req = {
                on: vi.fn(),
                write: vi.fn(),
                end: vi.fn(),
                destroy: vi.fn(),
            };
            // Don't call callback — simulate hanging request
            return req;
        });

        const promise = streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk, controller.signal);
        // Abort immediately
        controller.abort();

        await expect(promise).rejects.toThrow('aborted');
    });

    // ── Function call arguments without prior output_item.added ─

    it('accumulates function call args even without output_item.added', async () => {
        // When function_call_arguments.delta arrives before output_item.added,
        // the accumulator should still be created on-the-fly
        setupHttpsMock([
            { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_new', call_id: 'call_new', delta: '{"x":1}' } },
            { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_new', call_id: 'call_new', name: 'search_vault', arguments: '{"x":1}' } } },
            { event: 'response.completed', data: { response: { id: 'r5', status: 'completed' } } },
        ]);

        const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe('search_vault');
        expect(result.toolCalls[0].function.arguments).toBe('{"x":1}');
    });

    // ── HTTP (non-HTTPS) URL ────────────────────────────────────

    it('uses http module for http:// URLs', async () => {
        const incoming = mockNodeIncoming([
            { event: 'response.output_text.delta', data: { delta: 'hi' } },
            { event: 'response.completed', data: { response: { id: 'r6', status: 'completed' } } },
        ]);
        mockHttpsRequest.mockImplementation((_options: any, callback: any) => {
            process.nextTick(() => callback(incoming));
            return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
        });

        const result = await streamResponsesAPI('http://localhost:8080/responses', {}, {}, onChunk);
        expect(result.generationId).toBe('r6');
        // Verify the mock was called (both http and https use the same mock)
        expect(mockHttpsRequest).toHaveBeenCalled();
    });

    // ── output_index–based accumulation (obfuscated IDs) ────────

    describe('output_index keying (obfuscated ID support)', () => {
        it('matches deltas to function calls via output_index when ids are obfuscated', async () => {
            // Simulates Copilot's obfuscated IDs: each event has a different item_id/id
            // but output_index stays consistent
            setupHttpsMock([
                { event: 'response.output_item.added', data: { output_index: 1, item: { type: 'function_call', id: 'obf_aaa111', call_id: 'call_stable1', name: 'search_vault', arguments: '' } } },
                { event: 'response.function_call_arguments.delta', data: { output_index: 1, item_id: 'obf_bbb222', delta: '{"query":' } },
                { event: 'response.function_call_arguments.delta', data: { output_index: 1, item_id: 'obf_ccc333', delta: '"test"}' } },
                { event: 'response.output_item.done', data: { output_index: 1, item: { type: 'function_call', id: 'obf_ddd444', call_id: 'call_stable1', name: 'search_vault', arguments: '{"query":"test"}' } } },
                { event: 'response.completed', data: { response: { id: 'resp-obf', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

            expect(result.finishReason).toBe('tool_calls');
            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls[0].function.arguments).toBe('{"query":"test"}');
            expect(result.toolCalls[0].callId).toBe('call_stable1');
        });

        it('handles multiple obfuscated parallel tool calls via output_index', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { output_index: 1, item: { type: 'function_call', id: 'obf_x1', call_id: 'call_1', name: 'search_vault', arguments: '' } } },
                { event: 'response.output_item.added', data: { output_index: 2, item: { type: 'function_call', id: 'obf_x2', call_id: 'call_2', name: 'read_note', arguments: '' } } },
                // Deltas with different obfuscated item_ids
                { event: 'response.function_call_arguments.delta', data: { output_index: 1, item_id: 'obf_y1', delta: '{"q":"search"}' } },
                { event: 'response.function_call_arguments.delta', data: { output_index: 2, item_id: 'obf_y2', delta: '{"path":"note.md"}' } },
                { event: 'response.output_item.done', data: { output_index: 1, item: { type: 'function_call', id: 'obf_z1', call_id: 'call_1', name: 'search_vault', arguments: '{"q":"search"}' } } },
                { event: 'response.output_item.done', data: { output_index: 2, item: { type: 'function_call', id: 'obf_z2', call_id: 'call_2', name: 'read_note', arguments: '{"path":"note.md"}' } } },
                { event: 'response.completed', data: { response: { id: 'resp-multi-obf', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

            expect(result.toolCalls).toHaveLength(2);
            expect(result.toolCalls[0].function.name).toBe('search_vault');
            expect(result.toolCalls[0].function.arguments).toBe('{"q":"search"}');
            expect(result.toolCalls[1].function.name).toBe('read_note');
            expect(result.toolCalls[1].function.arguments).toBe('{"path":"note.md"}');
        });

        it('response.completed merges with output_index entries when ids differ', async () => {
            // output_item.added uses one obfuscated ID, response.completed output uses another
            setupHttpsMock([
                { event: 'response.output_item.added', data: { output_index: 1, item: { type: 'function_call', id: 'obf_added', call_id: 'call_merge', name: 'search_vault', arguments: '' } } },
                { event: 'response.function_call_arguments.delta', data: { output_index: 1, item_id: 'obf_delta', delta: '{"q":"merged"}' } },
                // response.completed has different id in output array index 1
                { event: 'response.completed', data: { response: { id: 'r-merge', status: 'completed', output: [
                    { type: 'reasoning', id: 'obf_reasoning', summary: [] },
                    { type: 'function_call', id: 'obf_completed', call_id: 'call_merge', name: 'search_vault', arguments: '{"q":"merged"}' },
                ] } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls[0].function.arguments).toBe('{"q":"merged"}');
            expect(result.toolCalls[0].callId).toBe('call_merge');
        });
    });

    // ── function_call_arguments.done event ──────────────────────

    describe('function_call_arguments.done event', () => {
        it('uses complete arguments from done event', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { output_index: 1, item: { type: 'function_call', id: 'fc_done', call_id: 'call_done', name: 'search_vault', arguments: '' } } },
                { event: 'response.function_call_arguments.delta', data: { output_index: 1, item_id: 'fc_done', delta: '{"query":' } },
                { event: 'response.function_call_arguments.delta', data: { output_index: 1, item_id: 'fc_done', delta: '"test"}' } },
                { event: 'response.function_call_arguments.done', data: { output_index: 1, item_id: 'fc_done', arguments: '{"query":"test"}' } },
                { event: 'response.output_item.done', data: { output_index: 1, item: { type: 'function_call', id: 'fc_done', call_id: 'call_done', name: 'search_vault', arguments: '{"query":"test"}' } } },
                { event: 'response.completed', data: { response: { id: 'r-done', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls[0].function.arguments).toBe('{"query":"test"}');
        });

        it('done event overrides accumulated deltas when args differ', async () => {
            setupHttpsMock([
                { event: 'response.output_item.added', data: { item: { type: 'function_call', id: 'fc_override', call_id: 'call_override', name: 'search_vault', arguments: '' } } },
                // Suppose delta accumulation produced partial/wrong args
                { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_override', delta: '{"q":' } },
                // done event has the correct complete args
                { event: 'response.function_call_arguments.done', data: { item_id: 'fc_override', arguments: '{"q":"corrected"}' } },
                { event: 'response.output_item.done', data: { item: { type: 'function_call', id: 'fc_override', call_id: 'call_override', name: 'search_vault', arguments: '{"q":"corrected"}' } } },
                { event: 'response.completed', data: { response: { id: 'r-override', status: 'completed' } } },
            ]);

            const result = await streamResponsesAPI('https://api.example.com/responses', {}, {}, onChunk);

            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls[0].function.arguments).toBe('{"q":"corrected"}');
        });
    });
});

// ── formatApiError ──────────────────────────────────────────────────

describe('formatApiError', () => {
    it('extracts message from JSON error body', () => {
        const raw = '{"error":{"message":"Request too large","code":413}}';
        const msg = formatApiError(413, raw);
        expect(msg).toContain('API 413');
        expect(msg).toContain('Request too large');
        expect(msg).not.toContain('"error"');
    });

    it('falls back to raw string for non-JSON', () => {
        const msg = formatApiError(500, 'Internal Server Error');
        expect(msg).toBe('API 500: Internal Server Error');
    });

    it('adds hint for 413 errors', () => {
        const msg = formatApiError(413, '{"error":{"message":"payload too large"}}');
        expect(msg).toContain('Hint');
        expect(msg).toContain('too large');
    });

    it('adds hint for 400 with token overflow message', () => {
        const msg = formatApiError(400, '{"error":{"message":"maximum context length exceeded"}}');
        expect(msg).toContain('Hint');
    });

    it('adds hint for 401 auth errors', () => {
        const msg = formatApiError(401, '{"error":{"message":"invalid api key"}}');
        expect(msg).toContain('API key');
    });

    it('adds hint for 429 rate limit', () => {
        const msg = formatApiError(429, '{"error":{"message":"rate limit exceeded"}}');
        expect(msg).toContain('Rate limit');
    });

    it('adds hint for 404 not found', () => {
        const msg = formatApiError(404, '{"error":{"message":"model not found"}}');
        expect(msg).toContain('model');
    });

    it('no hint for generic 500 errors', () => {
        const msg = formatApiError(500, '{"error":{"message":"server error"}}');
        expect(msg).not.toContain('Hint');
    });
});

// ── Messages API Tests ──────────────────────────────────────────────

/**
 * Create a mock Node.js IncomingMessage for Anthropic Messages API SSE.
 * Messages API uses only `data: {JSON}` lines (no `event:` prefix);
 * the event type lives in `parsed.type`.
 */
function mockMessagesIncoming(events: Array<Record<string, any>>, statusCode = 200) {
    const lines: string[] = [];
    for (const ev of events) {
        lines.push(`data: ${JSON.stringify(ev)}`);
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

function setupMessagesMock(events: Array<Record<string, any>>, statusCode = 200) {
    const incoming = mockMessagesIncoming(events, statusCode);
    mockHttpsRequest.mockImplementation((_options: any, callback: any) => {
        process.nextTick(() => callback(incoming));
        return {
            on: vi.fn(),
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
        };
    });
}

describe('streamMessagesAPI', () => {
    let chunkLog: Array<[string | null, ChunkType | undefined, ToolCall[] | undefined]>;
    let onChunk: (token: string | null, type?: ChunkType, toolCalls?: ToolCall[]) => void;

    beforeEach(() => {
        mockHttpsRequest.mockReset();
        chunkLog = [];
        onChunk = (token, type, tc) => chunkLog.push([token, type, tc]);
    });

    // ── Basic content streaming ─────────────────────────────────

    it('streams text content from text_delta events', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);

        const contentChunks = chunkLog.filter(([, kind]) => kind === 'content');
        expect(contentChunks).toHaveLength(2);
        expect(contentChunks[0][0]).toBe('Hello');
        expect(contentChunks[1][0]).toBe(' world');
        expect(result.generationId).toBe('msg-1');
        expect(result.finishReason).toBe('stop');
    });

    // ── Thinking/reasoning ──────────────────────────────────────

    it('streams thinking from thinking_delta events', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-2', usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think...' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' about this.' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'The answer is 42.' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);

        const reasoningChunks = chunkLog.filter(([, kind]) => kind === 'reasoning');
        expect(reasoningChunks).toHaveLength(2);
        expect(reasoningChunks[0][0]).toBe('Let me think...');
        expect(reasoningChunks[1][0]).toBe(' about this.');

        const contentChunks = chunkLog.filter(([, kind]) => kind === 'content');
        expect(contentChunks).toHaveLength(1);
        expect(contentChunks[0][0]).toBe('The answer is 42.');
        expect(result.finishReason).toBe('stop');
    });

    it('captures signature_delta as reasoningOpaque', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-sig', usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc-123' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);
        expect(result.reasoningOpaque).toBe('sig-abc-123');
    });

    it('concatenates multi-chunk signature_delta into reasoningOpaque', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-multisig', usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part1-' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part2-' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part3' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);
        expect(result.reasoningOpaque).toBe('part1-part2-part3');
    });

    // ── Tool calls ──────────────────────────────────────────────

    it('accumulates tool calls from tool_use blocks', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-tools', usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc-1', name: 'search' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'uery":"test"}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].id).toBe('tc-1');
        expect(result.toolCalls[0].function.name).toBe('search');
        expect(result.toolCalls[0].function.arguments).toBe('{"query":"test"}');
        expect(result.finishReason).toBe('tool_calls');

        // Should have emitted a tool_calls chunk
        const toolChunks = chunkLog.filter(([, kind]) => kind === 'tool_calls');
        expect(toolChunks.length).toBeGreaterThan(0);
    });

    it('handles multiple tool calls', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-mt', usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc-a', name: 'search' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tc-b', name: 'fetch' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":"b"}' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);

        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[0].function.name).toBe('search');
        expect(result.toolCalls[1].function.name).toBe('fetch');
    });

    // ── Usage tracking ──────────────────────────────────────────

    it('tracks usage from message_start and message_delta', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-u', usage: { input_tokens: 100, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);

        expect(result.usage).toEqual({
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
        });
    });

    // ── Error handling ──────────────────────────────────────────

    it('throws formatted error for non-2xx status', async () => {
        const errorBody = JSON.stringify({ error: { message: 'invalid_api_key' } });
        const readable = new Readable({
            read() {
                this.push(Buffer.from(errorBody));
                this.push(null);
            },
        });
        (readable as any).statusCode = 401;
        (readable as any).statusMessage = 'Unauthorized';

        mockHttpsRequest.mockImplementation((_options: any, callback: any) => {
            process.nextTick(() => callback(readable));
            return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
        });

        await expect(
            streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk),
        ).rejects.toThrow(/API 401.*invalid_api_key/);
    });

    // ── Stop reason mapping ─────────────────────────────────────

    it('maps end_turn stop_reason to "stop"', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-s1', usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);
        expect(result.finishReason).toBe('stop');
    });

    it('maps tool_use stop_reason to "tool_calls"', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-s2', usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc-x', name: 'fn' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);
        expect(result.finishReason).toBe('tool_calls');
    });

    it('passes through unknown stop_reason as-is', async () => {
        setupMessagesMock([
            { type: 'message_start', message: { id: 'msg-s3', usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ]);

        const result = await streamMessagesAPI('https://api.example.com/v1/messages', {}, {}, onChunk);
        expect(result.finishReason).toBe('max_tokens');
    });
});

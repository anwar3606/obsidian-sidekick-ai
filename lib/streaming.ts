/**
 * SSE streaming — zero Obsidian dependency.
 *
 * Parses Server-Sent Events from both the Chat Completions API and the
 * Responses API. Uses native fetch for Chat Completions and Node.js
 * https/http for the Responses API (to bypass CORS).
 */

import type { StreamResult, ToolCall, ToolCallAccumulator, ChunkType, ChunkCallback } from './types';
import https from 'https';
import http from 'http';

// ── Error formatting ────────────────────────────────────────────────

/**
 * Parse an API error response into a human-readable message.
 * Extracts the error message from JSON bodies and adds contextual hints.
 */
export function formatApiError(status: number, rawDetail: string): string {
    // Try to extract the message from JSON error response
    let message = rawDetail;
    try {
        const parsed = JSON.parse(rawDetail);
        message = parsed?.error?.message || parsed?.message || rawDetail;
    } catch { /* not JSON, use raw */ }

    // Status-specific hints
    let hint = '';
    if (status === 413 || (status === 400 && /too large|too many tokens|maximum context|payload/i.test(message))) {
        hint = '\n\nHint: The request payload was too large. This often happens when images are in the conversation. Try starting a new conversation or removing image attachments.';
    } else if (status === 401 || status === 403) {
        hint = '\n\nHint: Check your API key in Settings → Provider.';
    } else if (status === 429) {
        hint = '\n\nHint: Rate limit exceeded. Wait a moment and retry.';
    } else if (status === 404) {
        hint = '\n\nHint: The model or endpoint was not found. Check your model selection.';
    }

    return `API ${status}: ${message}${hint}`;
}

// ── Types ───────────────────────────────────────────────────────────

interface StreamState {
    generationId: string | null;
    finishReason: string | null;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    toolCallsAccum: ToolCallAccumulator;
    reasoningOpaque?: string;
}

// ── SSE line parsing ────────────────────────────────────────────────

function parseSSELine(line: string): { done: true } | { done: false; data: any } | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return null;

    let payload = trimmed.slice(5);
    if (payload.startsWith(' ')) payload = payload.slice(1);

    if (payload === '[DONE]') return { done: true };

    try {
        return { done: false, data: JSON.parse(payload) };
    } catch {
        return null;
    }
}

// ── Delta processors ────────────────────────────────────────────────

function processContentDelta(delta: any, onChunk: ChunkCallback): void {
    if (delta?.content) onChunk(delta.content, 'content');
}

function processReasoningDelta(delta: any, onChunk: ChunkCallback): void {
    if (delta?.reasoning_text) { onChunk(delta.reasoning_text, 'reasoning'); return; }
    if (delta?.cot_summary) { onChunk(delta.cot_summary, 'reasoning'); return; }
    if (delta?.reasoning) {
        onChunk(delta.reasoning, 'reasoning');
    } else if (Array.isArray(delta?.reasoning_details)) {
        for (const rd of delta.reasoning_details) {
            if (rd.type === 'reasoning.text' && rd.text) onChunk(rd.text, 'reasoning');
        }
    }
    if (delta?.thinking) onChunk(delta.thinking, 'reasoning');
    if (Array.isArray(delta?.content)) {
        for (const block of delta.content) {
            if (block.type === 'thinking' && block.thinking) onChunk(block.thinking, 'reasoning');
        }
    }
}

function processImageDelta(delta: any, parsed: any, onChunk: ChunkCallback): void {
    if (Array.isArray(delta?.images)) {
        for (const img of delta.images) {
            const imgUrl = img?.image_url?.url;
            if (imgUrl) onChunk(imgUrl, 'image');
        }
    }
    const message = parsed.choices?.[0]?.message;
    if (message && Array.isArray(message.images)) {
        for (const img of message.images) {
            const imgUrl = img?.image_url?.url;
            if (imgUrl) onChunk(imgUrl, 'image');
        }
    }
}

function processToolCallDelta(
    delta: any,
    accum: ToolCallAccumulator,
    onChunk: ChunkCallback,
): void {
    if (!Array.isArray(delta?.tool_calls)) return;
    for (const tc of delta.tool_calls) {
        let idx = tc.index ?? 0;

        // If a tool call arrives with an id that differs from the entry at this
        // index, it's either a continuation of an existing call at another slot
        // or a brand-new call (some providers send all with index 0).
        if (tc.id && accum[idx] && accum[idx].id && accum[idx].id !== tc.id) {
            // First check if this tc.id already exists in another slot
            const existing = Object.entries(accum).find(([, e]) => e.id === tc.id);
            if (existing) {
                idx = Number(existing[0]);
            } else {
                // New tool call — assign next available index
                const usedIndices = Object.keys(accum).map(Number);
                idx = Math.max(...usedIndices) + 1;
            }
        }

        if (!accum[idx]) {
            accum[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        const entry = accum[idx];
        if (tc.id) entry.id = tc.id;
        if (tc.type) entry.type = tc.type;
        if (tc.function?.name) {
            // Guard against providers that resend the full name in subsequent
            // deltas alongside arguments — prevents "search_vaultsearch_vault".
            // Still supports legitimate partial-name streaming across chunks.
            if (entry.function.name === '' || !entry.function.name.endsWith(tc.function.name)) {
                entry.function.name += tc.function.name;
            }
        }
        if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
    }
    onChunk(null, 'tool_calls', Object.values(accum));
}

// ── Process a single parsed SSE chunk ───────────────────────────────

function processChunk(parsed: any, state: StreamState, onChunk: ChunkCallback): void {
    if (!state.generationId && parsed.id) state.generationId = parsed.id;

    if (parsed.usage) {
        state.usage = {
            prompt_tokens: parsed.usage.prompt_tokens ?? 0,
            completion_tokens: parsed.usage.completion_tokens ?? 0,
            total_tokens: parsed.usage.total_tokens ?? 0,
        };
    }

    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    if (choice?.finish_reason) state.finishReason = choice.finish_reason;

    if (delta?.reasoning_opaque && !state.reasoningOpaque) {
        state.reasoningOpaque = delta.reasoning_opaque;
    }

    processContentDelta(delta, onChunk);
    processReasoningDelta(delta, onChunk);
    processImageDelta(delta, parsed, onChunk);
    processToolCallDelta(delta, state.toolCallsAccum, onChunk);
}

// ── Chat Completions SSE streaming ──────────────────────────────────

export async function streamChatCompletions(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onChunk: ChunkCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        let detail: string;
        try { detail = await res.text(); } catch { detail = res.statusText; }
        throw new Error(formatApiError(res.status, detail));
    }

    const state: StreamState = {
        generationId: null,
        finishReason: null,
        toolCallsAccum: {},
    };

    const buildResult = (): StreamResult => ({
        generationId: state.generationId,
        toolCalls: Object.values(state.toolCallsAccum),
        finishReason: state.finishReason,
        usage: state.usage,
        reasoningOpaque: state.reasoningOpaque,
    });

    if (!res.body) {
        throw new Error('Response body is null — streaming not supported');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                if (buffer) {
                    const parsed = parseSSELine(buffer);
                    if (parsed) {
                        if (parsed.done) return buildResult();
                        processChunk(parsed.data, state, onChunk);
                    }
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!;

            for (const line of lines) {
                const parsed = parseSSELine(line);
                if (!parsed) continue;
                if (parsed.done) return buildResult();
                processChunk(parsed.data, state, onChunk);
            }
        }

        return buildResult();
    } finally {
        reader.releaseLock();
    }
}

// ── Responses API streaming ─────────────────────────────────────────

/**
 * Stream from the OpenAI Responses API (Copilot thinking mode).
 *
 * Uses Node.js native https to bypass CORS. Named SSE events:
 * - response.reasoning_summary_text.delta — reasoning chunks
 * - response.output_text.delta — content chunks
 * - response.function_call_arguments.delta — tool call argument chunks
 * - response.output_item.added — function call name
 * - response.output_item.done — finalize function call
 * - response.completed — usage data
 */
export async function streamResponsesAPI(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onChunk: ChunkCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const requestBody = JSON.stringify(body);

    let onAbortStreaming: (() => void) | undefined;

    const res = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
        const req = transport.request(
            {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    ...headers,
                },
            },
            (response) => resolve(response),
        );

        req.on('error', reject);

        if (signal) {
            const onAbort = () => {
                req.destroy();
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            // Remove request-phase listener once response arrives to avoid
            // calling reject() on an already-resolved promise.
            req.on('response', () => signal.removeEventListener('abort', onAbort));
        }

        req.write(requestBody);
        req.end();
    });

    // Abort during streaming: destroy the response stream so the for-await loop breaks.
    if (signal) {
        onAbortStreaming = () => { res.destroy(); };
        signal.addEventListener('abort', onAbortStreaming, { once: true });
    }

    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        if (signal && onAbortStreaming) signal.removeEventListener('abort', onAbortStreaming);
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk as Buffer);
        const detail = Buffer.concat(chunks).toString('utf-8') || res.statusMessage || 'Unknown error';
        throw new Error(formatApiError(res.statusCode ?? 0, detail));
    }

    const state: StreamState = {
        generationId: null,
        finishReason: null,
        toolCallsAccum: {},
    };

    let buffer = '';
    let currentEventType: string | null = null;

    // Key by output_index (stable across obfuscated IDs) when available,
    // fall back to item id for backward compatibility with non-obfuscated responses.
    // Copilot obfuscates/rotates item_id on every SSE event, making id-based
    // matching impossible when output_index is present.
    const fnCallAccum: Record<string, { id: string; callId: string; name: string; args: string }> = {};

    /** Get a stable key: prefer output_index, fall back to id/item_id. */
    function fnKey(outputIndex: number | undefined, fallbackId: string): string {
        return outputIndex != null && outputIndex >= 0 ? `idx:${outputIndex}` : fallbackId;
    }

    for await (const chunk of res) {
        // Check abort before processing each chunk
        if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        buffer += (chunk as Buffer).toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('event:')) {
                currentEventType = trimmed.slice(6).trim();
                continue;
            }

            if (!trimmed.startsWith('data:')) continue;
            let payload = trimmed.slice(5);
            if (payload.startsWith(' ')) payload = payload.slice(1);
            if (payload === '[DONE]') continue;

            let parsed: any;
            try { parsed = JSON.parse(payload); } catch { continue; }

            const eventType = currentEventType || parsed.type || '';

            if (eventType === 'response.reasoning_summary_text.delta') {
                const text = parsed.delta || '';
                if (text) onChunk(text, 'reasoning');
            }

            if (eventType === 'response.output_text.delta') {
                const text = parsed.delta || '';
                if (text) onChunk(text, 'content');
            }

            if (eventType === 'response.function_call_arguments.delta') {
                const key = fnKey(parsed.output_index, parsed.item_id || '');
                if (key) {
                    if (!fnCallAccum[key]) {
                        fnCallAccum[key] = { id: parsed.item_id || '', callId: parsed.call_id || '', name: '', args: '' };
                    }
                    fnCallAccum[key].args += (parsed.delta || '');
                }
            }

            if (eventType === 'response.function_call_arguments.done') {
                const key = fnKey(parsed.output_index, parsed.item_id || '');
                if (key) {
                    if (!fnCallAccum[key]) {
                        fnCallAccum[key] = { id: '', callId: '', name: '', args: '' };
                    }
                    // Use the complete arguments from the done event
                    fnCallAccum[key].args = parsed.arguments || fnCallAccum[key].args;
                }
            }

            if (eventType === 'response.output_item.added') {
                const item = parsed.item;
                if (item?.type === 'function_call') {
                    const id = item.id || '';
                    const key = fnKey(parsed.output_index, id);
                    if (key) {
                        const existing = fnCallAccum[key];
                        fnCallAccum[key] = {
                            id,
                            callId: item.call_id || id,
                            name: item.name || '',
                            args: item.arguments || existing?.args || '',
                        };
                    }
                }
            }

            if (eventType === 'response.output_item.done') {
                const item = parsed.item;
                if (item?.type === 'function_call') {
                    const id = item.id || '';
                    const key = fnKey(parsed.output_index, id);
                    if (key) {
                        if (fnCallAccum[key]) {
                            fnCallAccum[key].id = id || fnCallAccum[key].id;
                            fnCallAccum[key].callId = item.call_id || fnCallAccum[key].callId || id;
                            fnCallAccum[key].name = item.name || fnCallAccum[key].name;
                            fnCallAccum[key].args = item.arguments || fnCallAccum[key].args;
                        } else {
                            fnCallAccum[key] = {
                                id,
                                callId: item.call_id || id,
                                name: item.name || '',
                                args: item.arguments || '',
                            };
                        }
                    }
                }
            }

            if (eventType === 'response.completed') {
                const resp = parsed.response || parsed;
                if (resp.id) state.generationId = resp.id;
                state.finishReason = resp.status === 'completed' ? 'stop' : (resp.status || 'stop');

                const usage = resp.usage;
                if (usage) {
                    state.usage = {
                        prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
                        completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
                        total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
                    };
                }

                // Merge final output array — array index corresponds to output_index
                const output = resp.output;
                if (Array.isArray(output)) {
                    for (let i = 0; i < output.length; i++) {
                        const item = output[i];
                        if (item.type === 'function_call') {
                            const id = item.id || '';
                            // Try output_index key first, then id key, then create new
                            const idxKey = `idx:${i}`;
                            const key = fnCallAccum[idxKey] ? idxKey : fnCallAccum[id] ? id : idxKey;
                            const existing = fnCallAccum[key];
                            if (existing) {
                                existing.id = id || existing.id;
                                existing.callId = item.call_id || existing.callId;
                                existing.name = item.name || existing.name;
                                existing.args = item.arguments || existing.args;
                            } else {
                                fnCallAccum[key] = {
                                    id,
                                    callId: item.call_id || id,
                                    name: item.name || '',
                                    args: item.arguments || '',
                                };
                            }
                        }
                    }
                }
            }

            if (parsed.response?.id && !state.generationId) {
                state.generationId = parsed.response.id;
            }
        }
    }

    // Clean up streaming abort listener
    if (signal && onAbortStreaming) signal.removeEventListener('abort', onAbortStreaming);

    const toolCalls: ToolCall[] = Object.values(fnCallAccum)
        .filter(fc => fc.name)
        .map(fc => ({
            id: fc.id,
            callId: fc.callId || fc.id,
            type: 'function' as const,
            function: { name: fc.name, arguments: fc.args },
        }));

    if (toolCalls.length > 0) {
        state.finishReason = 'tool_calls';
        onChunk(null, 'tool_calls', toolCalls);
    }

    return {
        generationId: state.generationId,
        toolCalls,
        finishReason: state.finishReason,
        usage: state.usage,
        reasoningOpaque: state.reasoningOpaque,
    };
}

// ── Anthropic Messages API streaming ────────────────────────────────

/**
 * Stream from the Anthropic Messages API (/v1/messages).
 *
 * Used for Claude models on Copilot when thinking is enabled, because
 * Chat Completions strips reasoning tokens for Claude.
 *
 * SSE events: message_start, content_block_start, content_block_delta,
 * content_block_stop, message_delta, message_stop.
 */
export async function streamMessagesAPI(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    onChunk: ChunkCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const requestBody = JSON.stringify(body);

    let onAbortStreaming: (() => void) | undefined;

    const res = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
        const req = transport.request(
            {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    ...headers,
                },
            },
            (response) => resolve(response),
        );

        req.on('error', reject);

        if (signal) {
            const onAbort = () => {
                req.destroy();
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            req.on('response', () => signal.removeEventListener('abort', onAbort));
        }

        req.write(requestBody);
        req.end();
    });

    if (signal) {
        onAbortStreaming = () => { res.destroy(); };
        signal.addEventListener('abort', onAbortStreaming, { once: true });
    }

    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        if (signal && onAbortStreaming) signal.removeEventListener('abort', onAbortStreaming);
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk as Buffer);
        const detail = Buffer.concat(chunks).toString('utf-8') || res.statusMessage || 'Unknown error';
        throw new Error(formatApiError(res.statusCode ?? 0, detail));
    }

    const state: StreamState = {
        generationId: null,
        finishReason: null,
        toolCallsAccum: {},
    };

    // Track content blocks by index for tool calls
    const blockTypes: Map<number, string> = new Map();
    const toolBlocks: Map<number, { id: string; name: string; args: string }> = new Map();

    let buffer = '';

    for await (const chunk of res) {
        if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        buffer += (chunk as Buffer).toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            let payload = trimmed.slice(5);
            if (payload.startsWith(' ')) payload = payload.slice(1);

            let parsed: any;
            try { parsed = JSON.parse(payload); } catch { continue; }

            switch (parsed.type) {
                case 'message_start': {
                    const msg = parsed.message;
                    if (msg?.id) state.generationId = msg.id;
                    if (msg?.usage) {
                        state.usage = {
                            prompt_tokens: msg.usage.input_tokens ?? 0,
                            completion_tokens: msg.usage.output_tokens ?? 0,
                            total_tokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
                        };
                    }
                    break;
                }

                case 'content_block_start': {
                    const idx = parsed.index;
                    const block = parsed.content_block;
                    if (block) {
                        blockTypes.set(idx, block.type);
                        if (block.type === 'tool_use') {
                            toolBlocks.set(idx, { id: block.id || '', name: block.name || '', args: '' });
                        }
                    }
                    break;
                }

                case 'content_block_delta': {
                    const idx = parsed.index;
                    const delta = parsed.delta;
                    if (!delta) break;

                    if (delta.type === 'thinking_delta' && delta.thinking) {
                        onChunk(delta.thinking, 'reasoning');
                    } else if (delta.type === 'text_delta' && delta.text) {
                        onChunk(delta.text, 'content');
                    } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
                        const tb = toolBlocks.get(idx);
                        if (tb) tb.args += delta.partial_json;
                    } else if (delta.type === 'signature_delta') {
                        if (delta.signature) {
                            state.reasoningOpaque = (state.reasoningOpaque || '') + delta.signature;
                        }
                    }
                    break;
                }

                case 'content_block_stop': {
                    const idx = parsed.index;
                    const tb = toolBlocks.get(idx);
                    if (tb && tb.name) {
                        const tcIdx = Object.keys(state.toolCallsAccum).length;
                        state.toolCallsAccum[tcIdx] = {
                            id: tb.id,
                            type: 'function',
                            function: { name: tb.name, arguments: tb.args },
                        };
                        onChunk(null, 'tool_calls', Object.values(state.toolCallsAccum));
                    }
                    blockTypes.delete(idx);
                    toolBlocks.delete(idx);
                    break;
                }

                case 'message_delta': {
                    if (parsed.delta?.stop_reason) {
                        state.finishReason = parsed.delta.stop_reason === 'tool_use'
                            ? 'tool_calls'
                            : parsed.delta.stop_reason === 'end_turn'
                                ? 'stop'
                                : parsed.delta.stop_reason;
                    }
                    if (parsed.usage?.output_tokens && state.usage) {
                        state.usage.completion_tokens = parsed.usage.output_tokens;
                        state.usage.total_tokens = state.usage.prompt_tokens + parsed.usage.output_tokens;
                    }
                    break;
                }

                case 'message_stop':
                    break;
            }
        }
    }

    // Clean up streaming abort listener
    if (signal && onAbortStreaming) signal.removeEventListener('abort', onAbortStreaming);

    return {
        generationId: state.generationId,
        toolCalls: Object.values(state.toolCallsAccum),
        finishReason: state.finishReason,
        usage: state.usage,
        reasoningOpaque: state.reasoningOpaque,
    };
}

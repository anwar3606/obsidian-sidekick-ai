/**
 * API request body builders — zero Obsidian dependency.
 *
 * Pure functions that build the request body for each API endpoint.
 * These know nothing about Obsidian, vault, or UI — they simply transform
 * settings + messages → request body.
 */

import type {
    ApiSettings,
    ApiMessage,
    ApiContentPart,
    ModelInfo,
    ChatCompletionRequest,
    ResponsesApiRequest,
    MessagesApiRequest,
    AnthropicTool,
    ToolCall,
    AnyRequestBody,
} from './types';
import { shouldSkipTemperature, isThinkingCapableOpenAIModel, getImageModalities } from './providers';
import { getEnabledTools, getEnabledToolsForResponses } from './tools';

// ── Constants (defaults — overridable via settings) ─────────────────

export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 2000;
export const MAX_TOOL_ROUNDS = 10;
export const MAX_TOOL_ROUNDS_ITERATE = 50;
export const MAX_CONTENT_LENGTH = 15_000;
export const THINKING_BUDGET = 16384;

// ── Chat Completions request body ───────────────────────────────────

/**
 * Build the request body for a Chat Completions API call.
 * Works for OpenAI, OpenRouter, and Copilot (non-thinking mode).
 */
export function buildChatCompletionBody(
    settings: ApiSettings,
    messages: ApiMessage[],
    cachedModels: ModelInfo[],
): ChatCompletionRequest {
    const currentModel = cachedModels.find(m => m.id === settings.selectedModel);

    // API compatibility aliases
    let apiModelId = settings.selectedModel;
    if (settings.selectedProvider === 'copilot' && settings.selectedModel === 'gemini-3-flash') {
        apiModelId = 'gemini-3-flash-preview';
    }

    const body: ChatCompletionRequest = {
        model: apiModelId,
        messages,
        stream: true,
    };

    // Temperature
    if (!shouldSkipTemperature(settings.selectedModel, settings.selectedProvider, settings.thinkingEnabled, currentModel)) {
        body.temperature = settings.temperature;
    }

    // Tools
    const tools = getEnabledTools(settings);
    if (tools) body.tools = tools;

    // Thinking/reasoning
    if (settings.thinkingEnabled) {
        if (settings.selectedProvider === 'openrouter') {
            body.reasoning = { effort: 'high' };
        } else if (settings.selectedProvider === 'copilot') {
            const budget = settings.thinkingBudget ?? THINKING_BUDGET;
            // All Copilot models (including Claude) use reasoning_effort + max_tokens.
            // Note: reasoning_summary must NOT be included for Claude (causes 400).
            body.reasoning_effort = 'high';
            body.max_tokens = Math.max(budget, THINKING_BUDGET);
            const modelId = settings.selectedModel.toLowerCase();
            if (!modelId.includes('claude')) {
                body.reasoning_summary = 'auto';
            }
        } else if (settings.selectedProvider === 'openai'
            && isThinkingCapableOpenAIModel(settings.selectedModel)) {
            body.reasoning_effort = 'high';
        }
    }

    // Inline image generation (OpenRouter)
    if (currentModel?.supportsImageGen && settings.selectedProvider === 'openrouter') {
        body.modalities = getImageModalities(settings.selectedModel);
    }

    // Usage tracking (OpenAI + Copilot + OpenRouter)
    if (settings.selectedProvider === 'openai' || settings.selectedProvider === 'copilot' || settings.selectedProvider === 'openrouter') {
        body.stream_options = { include_usage: true };
    }

    // Copilot: don't persist conversations server-side
    if (settings.selectedProvider === 'copilot') {
        body.store = false;
    }

    return body;
}

// ── Responses API request body ──────────────────────────────────────

/**
 * Convert Chat Completions content parts to Responses API format.
 *
 * Chat Completions uses `type: 'text'` / `type: 'image_url'`.
 * Responses API requires `type: 'input_text'` / `type: 'input_image'`.
 */
export function convertToResponsesContent(parts: ApiContentPart[]): ApiContentPart[] {
    return parts.map(part => {
        if (part.type === 'text') {
            return { type: 'input_text', text: part.text };
        }
        if (part.type === 'image_url') {
            return { type: 'input_image', image_url: part.image_url.url };
        }
        return part; // pass through unknown types
    });
}

/**
 * Convert an array of ApiMessages to Responses API input format.
 * Messages with array content get their parts remapped; string/null content is unchanged.
 */
export function convertMessagesForResponses(messages: ApiMessage[]): ApiMessage[] {
    return messages.map(msg => {
        if (Array.isArray(msg.content)) {
            return { ...msg, content: convertToResponsesContent(msg.content) };
        }
        return msg;
    });
}

/**
 * Build the request body for the Copilot Responses API (/responses endpoint).
 *
 * Key differences from Chat Completions:
 * - `input` instead of `messages`
 * - `reasoning: { effort, summary }` instead of flat `reasoning_effort`
 * - Tools in flat format (not nested)
 * - No `stream_options` — usage in `response.completed` event
 * - Content parts use `input_text`/`input_image` instead of `text`/`image_url`
 */
export function buildResponsesBody(
    settings: ApiSettings,
    messages: ApiMessage[],
    cachedModels: ModelInfo[],
): ResponsesApiRequest {
    const currentModel = cachedModels.find(m => m.id === settings.selectedModel);

    // API compatibility aliases
    let apiModelId = settings.selectedModel;
    if (settings.selectedProvider === 'copilot' && settings.selectedModel === 'gemini-3-flash') {
        apiModelId = 'gemini-3-flash-preview';
    }

    const body: ResponsesApiRequest = {
        model: apiModelId,
        input: convertMessagesForResponses(messages),
        stream: true,
        store: false,
    };

    // Reasoning — always high effort with detailed summary for thinking mode
    body.reasoning = { effort: 'high', summary: 'detailed' };

    // Tools — Responses API flat format
    const tools = getEnabledToolsForResponses(settings);
    if (tools) body.tools = tools;

    // Temperature — skip for reasoning models
    if (!shouldSkipTemperature(settings.selectedModel, settings.selectedProvider, settings.thinkingEnabled, currentModel)) {
        body.temperature = settings.temperature;
    }

    return body;
}

// ── Should use Responses API? ───────────────────────────────────────

/**
 * Whether this request should use the Copilot Responses API instead of Chat Completions.
 *
 * The Responses API (/responses) is needed for Copilot thinking mode because
 * Chat Completions strips reasoning tokens from the SSE stream.
 *
 * However, not all models support the Responses API — models with
 * `supportsThinking: false` must use Chat Completions even when thinking is enabled.
 * Claude models (4.6+) use Chat Completions with `thinking_budget` instead.
 */
export function shouldUseResponsesAPI(settings: ApiSettings, cachedModels?: ModelInfo[]): boolean {
    if (settings.selectedProvider !== 'copilot' || !settings.thinkingEnabled) return false;

    // Claude models do NOT support the Responses API at all —
    // they use Chat Completions with thinking_budget instead.
    const modelId = settings.selectedModel.toLowerCase();
    if (modelId.includes('claude')) return false;

    // If we have model metadata, check whether the specific model supports the Responses API.
    // Models like claude-haiku-4.5 have supportsThinking: false and don't support Responses API.
    if (cachedModels?.length) {
        const model = cachedModels.find(m => m.id === settings.selectedModel);
        if (model) {
            if (!model.supportsThinking) return false;
            if (model.responsesApiSupported === false) return false;
        }
    }

    return true;
}

// ── Anthropic Messages API (/v1/messages) ───────────────────────────

/**
 * Whether this request should use the Anthropic Messages API.
 *
 * The Messages API is used for Claude models on Copilot when thinking is enabled,
 * because Chat Completions strips reasoning tokens for Claude models like haiku.
 */
export function shouldUseMessagesAPI(settings: ApiSettings, cachedModels?: ModelInfo[]): boolean {
    if (settings.selectedProvider !== 'copilot' || !settings.thinkingEnabled) return false;
    const modelId = settings.selectedModel.toLowerCase();
    if (!modelId.includes('claude')) return false;

    // Check that the model actually supports thinking
    if (cachedModels?.length) {
        const model = cachedModels.find(m => m.id === settings.selectedModel);
        if (model && !model.supportsThinking) return false;
    }
    return true;
}

/**
 * Extra headers required for Anthropic Messages API calls.
 */
export function getMessagesApiHeaders(): Record<string, string> {
    return {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
    };
}

/**
 * Convert Chat Completions tools to Anthropic tool format.
 * Chat Completions: { type: 'function', function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function toAnthropicTools(settings: ApiSettings): AnthropicTool[] | undefined {
    const tools = getEnabledTools(settings);
    if (!tools) return undefined;
    return tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}

/** Convert an image_url part to Anthropic format (base64 or URL source). */
function convertImageForAnthropic(url: string): Record<string, unknown> | null {
    if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
        }
        return null;
    }
    return { type: 'image', source: { type: 'url', url } };
}

/** Convert an assistant ApiMessage to Anthropic content (handles tool_calls + thinking). */
function convertAssistantForAnthropic(msg: ApiMessage): { role: string; content: unknown } {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const blocks: unknown[] = [];
        if (msg._thinking && msg._thinkingSignature) {
            blocks.push({ type: 'thinking', thinking: msg._thinking, signature: msg._thinkingSignature });
        }
        const text = typeof msg.content === 'string' && msg.content ? msg.content : null;
        if (text) blocks.push({ type: 'text', text });
        for (const tc of msg.tool_calls) {
            let parsedInput: unknown = {};
            try { parsedInput = JSON.parse(tc.function.arguments); } catch { /* empty */ }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsedInput });
        }
        return { role: 'assistant', content: blocks };
    }
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (msg._thinking && msg._thinkingSignature) {
        return { role: 'assistant', content: [
            { type: 'thinking', thinking: msg._thinking, signature: msg._thinkingSignature },
            { type: 'text', text },
        ]};
    }
    return { role: 'assistant', content: text };
}

/** Convert a user ApiMessage to Anthropic content (handles multi-part text + images). */
function convertUserForAnthropic(msg: ApiMessage): { role: string; content: unknown } {
    if (Array.isArray(msg.content)) {
        const blocks: unknown[] = [];
        for (const part of msg.content) {
            if (part.type === 'text') {
                blocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_url') {
                const img = convertImageForAnthropic(part.image_url.url);
                if (img) blocks.push(img);
            }
        }
        return { role: 'user', content: blocks };
    }
    return { role: 'user', content: typeof msg.content === 'string' ? msg.content : '' };
}

/** Merge consecutive same-role messages (Anthropic requires alternating roles). */
function mergeConsecutiveRoles(
    converted: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
    const merged: Array<{ role: string; content: unknown }> = [];
    for (const msg of converted) {
        const last = merged[merged.length - 1];
        if (last && last.role === msg.role) {
            const prevContent = Array.isArray(last.content) ? last.content
                : typeof last.content === 'string' ? [{ type: 'text', text: last.content }]
                : [last.content];
            const curContent = Array.isArray(msg.content) ? msg.content
                : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }]
                : [msg.content];
            last.content = [...prevContent, ...curContent];
        } else {
            merged.push({ ...msg });
        }
    }
    return merged;
}

/**
 * Convert internal ApiMessage[] to Anthropic Messages API format.
 *
 * Key differences from Chat Completions:
 * - System message extracted as a separate `system` string (not in messages)
 * - Tool results go as user messages with `{ type: 'tool_result', ... }` blocks
 * - Assistant tool_calls become `{ type: 'tool_use', ... }` content blocks
 * - Image content uses `{ type: 'image', source: { type: 'base64', ... } }` or URL
 */
export function convertMessagesForAnthropic(
    messages: ApiMessage[],
): { system: string; messages: Array<{ role: string; content: unknown }> } {
    let system = '';
    const converted: Array<{ role: string; content: unknown }> = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            system += (system ? '\n\n' : '') + text;
            continue;
        }

        if (msg.role === 'assistant') {
            converted.push(convertAssistantForAnthropic(msg));
            continue;
        }

        if (msg.role === 'tool') {
            const toolResult = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string' ? msg.content : '',
            };
            const last = converted[converted.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content)
                && (last.content as { type: string }[]).every(b => b.type === 'tool_result')) {
                (last.content as { type: string }[]).push(toolResult);
            } else {
                converted.push({ role: 'user', content: [toolResult] });
            }
            continue;
        }

        if (msg.role === 'user') {
            converted.push(convertUserForAnthropic(msg));
            continue;
        }
    }

    return { system, messages: mergeConsecutiveRoles(converted) };
}

/**
 * Build the request body for the Anthropic Messages API (/v1/messages).
 * Used for Claude models on Copilot to enable extended thinking.
 */
export function buildMessagesApiBody(
    settings: ApiSettings,
    messages: ApiMessage[],
    _cachedModels: ModelInfo[],
): MessagesApiRequest {
    const { system, messages: anthropicMessages } = convertMessagesForAnthropic(messages);
    const budget = settings.thinkingBudget ?? THINKING_BUDGET;

    const body: MessagesApiRequest = {
        model: settings.selectedModel,
        max_tokens: Math.max(budget * 2, THINKING_BUDGET),
        stream: true,
        messages: anthropicMessages,
    };

    if (system) body.system = system;

    // Enable extended thinking
    body.thinking = { type: 'enabled', budget_tokens: budget };

    // Tools
    const tools = toAnthropicTools(settings);
    if (tools) body.tools = tools;

    return body;
}

/**
 * Format a tool call result for the Anthropic Messages API.
 * Tool results are sent as user messages with tool_result content blocks.
 */
export function formatToolResultForMessagesAPI(
    toolUseId: string,
    result: string,
): ApiMessage {
    // We store it as a regular tool message internally — it gets converted
    // to Anthropic format by convertMessagesForAnthropic() before sending.
    return {
        role: 'tool',
        tool_call_id: toolUseId,
        content: result,
    };
}

/**
 * Format assistant tool_calls for internal tracking when using Messages API.
 * Stores in the same format as Chat Completions for consistency.
 */
export function formatAssistantToolCallsForMessagesAPI(toolCalls: ToolCall[]): ApiMessage {
    return {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
    };
}

// ── Tool result message formatting ──────────────────────────────────

/**
 * Format a tool call result for the Chat Completions API (tool role message).
 */
export function formatToolResultForChatCompletions(
    toolCallId: string,
    result: string,
): ApiMessage {
    return {
        role: 'tool',
        tool_call_id: toolCallId,
        content: result,
    };
}

/**
 * Format a tool call result for the Responses API (function_call_output item).
 */
export function formatToolResultForResponses(
    callId: string,
    result: string,
): ApiMessage {
    return {
        type: 'function_call_output',
        call_id: callId,
        output: result,
    } as ApiMessage;
}

/**
 * Format assistant tool_calls for the Chat Completions API message history.
 */
export function formatAssistantToolCalls(toolCalls: ToolCall[]): ApiMessage {
    return {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
    };
}

/**
 * Format a function_call item for the Responses API message history.
 */
export function formatFunctionCallForResponses(tc: ToolCall): ApiMessage {
    return {
        type: 'function_call',
        id: tc.id,
        call_id: tc.callId || tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
    } as ApiMessage;
}

// ── Utility ─────────────────────────────────────────────────────────

/**
 * Format tool arguments into a human-readable preview string.
 * No backticks (break callout titles), long values truncated, newlines collapsed.
 */
export function formatToolArgsPreview(toolArgs: string): string {
    try {
        const parsed = JSON.parse(toolArgs);
        return Object.entries(parsed)
            .map(([k, v]) => {
                let display = typeof v === 'string' ? v : String(v);
                // Collapse newlines so the callout title stays single-line
                display = display.replace(/\n/g, ' ');
                // Truncate long values so callout titles stay readable
                if (display.length > 80) display = display.substring(0, 80) + '…';
                return `${k}: ${display}`;
            })
            .join(', ');
    } catch {
        // JSON parse failed — fall back to raw arg string
        return toolArgs || '';
    }
}

function trunc(s: string | undefined, max: number): string {
    if (!s) return '';
    return s.length > max ? s.substring(0, max) + '…' : s;
}

/**
 * Format a clean one-line tool header for display in callouts.
 * Produces concise summaries like "Read notes/file.md" instead of
 * "📖 Read Note · path: notes/file.md".
 */
export function formatCleanToolHeader(toolName: string, toolArgs: string): string {
    try {
        const args = JSON.parse(toolArgs);
        switch (toolName) {
            case 'read_note': {
                const range = args.start_line && args.end_line
                    ? `, lines ${args.start_line}–${args.end_line}`
                    : args.start_line ? `, from line ${args.start_line}` : '';
                return `Read ${args.path || 'note'}${range}`;
            }
            case 'read_note_section':
                return `Read ${args.path || 'note'}${args.heading ? ` → "${trunc(args.heading, 40)}"` : ''}`;
            case 'read_note_outline':
                return `Outline ${args.path || 'note'}`;
            case 'search_vault':
                return `Searched "${trunc(args.query, 50)}"`;
            case 'grep_search': {
                const grepFolder = args.folder ? ` in ${args.folder}` : '';
                return `Grep "${trunc(args.pattern, 50)}"${grepFolder}`;
            }
            case 'create_note':
                return `Create ${args.path || 'note'}`;
            case 'edit_note':
                return `Edit ${args.path || 'note'}`;
            case 'delete_note':
                return `Delete ${args.path || 'note'}`;
            case 'move_note':
                return `Move ${args.from || '?'} → ${args.to || '?'}`;
            case 'list_files':
                return `List ${args.path || '/'}`;
            case 'fetch_url':
                return `Fetch ${trunc(args.url, 60)}`;
            case 'open_note':
                return `Open ${args.path || 'note'}`;
            case 'generate_image':
                return `Generate image`;
            case 'view_image':
                return `View ${args.path || 'image'}`;
            case 'ask_user':
                return `Ask user`;
            case 'ask_user_choice':
                return `Ask user`;
            case 'get_backlinks':
                return `Backlinks ${args.path || 'note'}`;
            case 'get_note_metadata':
                return `Metadata ${args.path || 'note'}`;
            case 'search_by_tag':
                return `Tag #${(args.tag || '').replace(/^#/, '')}`;
            case 'get_recent_notes':
                return `Recent notes`;
            case 'get_open_notes':
                return `Open notes`;
            default: {
                const preview = formatToolArgsPreview(toolArgs);
                return `${toolName}${preview ? ` · ${preview}` : ''}`;
            }
        }
    } catch {
        // Arg parsing failed — fall back to bare tool name
        return toolName;
    }
}

// ── Pure message helpers ────────────────────────────────────────────

/** Strip inline base64 <img> tags from message content (to keep API payloads small). */
export function stripBase64(text: string): string {
    return text?.replace(/<img\s+src="data:[^"]*"[^>]*\/?>/gi, '[image]') ?? '';
}

/**
 * Build note context messages from attached notes.
 * Notes with images get multi-part content; plain notes get simple strings.
 */
export function buildNoteContextMessages(
    attachedNotes: Array<{
        path: string;
        content: string;
        images: string[];
    }>,
): ApiMessage[] {
    return attachedNotes.map((note): ApiMessage => {
        const header = `[Attached note: ${note.path} — full content provided below, no need to use read_note tool]`;
        if (note.images.length > 0) {
            const parts: ApiContentPart[] = [
                { type: 'text', text: `${header}\n\n${note.content}` },
                ...note.images.map((img): ApiContentPart => ({ type: 'image_url', image_url: { url: img } })),
            ];
            return { role: 'user', content: parts };
        }
        return { role: 'user', content: `${header}\n\n${note.content}` };
    });
}

// ── AnyRequestBody helpers ──────────────────────────────────────────

/** Get the message count from any request body shape. */
export function getRequestMessageCount(req: AnyRequestBody): number {
    switch (req.api) {
        case 'responses': return req.body.input.length;
        default: return req.body.messages.length;
    }
}

/** Get the temperature from any request body shape (undefined if not set). */
export function getRequestTemperature(req: AnyRequestBody): number | undefined {
    return req.body.temperature;
}

/** Get the tool count from any request body shape. */
export function getRequestToolCount(req: AnyRequestBody): number {
    return req.body.tools?.length ?? 0;
}

/** Check if the request has tools. */
export function requestHasTools(req: AnyRequestBody): boolean {
    return getRequestToolCount(req) > 0;
}

/** Update the messages/input on a request body for a new tool round. */
export function updateRequestMessages(
    req: AnyRequestBody,
    apiMessages: ApiMessage[],
    convertForResponses: (msgs: ApiMessage[]) => ApiMessage[],
    convertForAnthropic: (msgs: ApiMessage[]) => { system?: string; messages: Array<{ role: string; content: unknown }> },
): void {
    switch (req.api) {
        case 'messages': {
            const { system, messages: anthropicMsgs } = convertForAnthropic(apiMessages);
            req.body.messages = anthropicMsgs;
            if (system) req.body.system = system;
            break;
        }
        case 'responses':
            req.body.input = convertForResponses(apiMessages);
            break;
        case 'chat-completions':
            req.body.messages = apiMessages;
            break;
    }
}

/** Strip a parameter from the request body for 400-error recovery. */
export function stripRequestParam(req: AnyRequestBody, param: string): void {
    delete (req.body as Record<string, unknown>)[param];
}

/** Collect debug-friendly info from any request body shape. */
export function getRequestDebugInfo(req: AnyRequestBody): Record<string, unknown> {
    const body = req.body;
    const base: Record<string, unknown> = {
        api: req.api,
        model: body.model,
        messageCount: getRequestMessageCount(req),
        toolCount: getRequestToolCount(req),
    };
    if (body.temperature !== undefined) base.temperature = body.temperature;
    if (req.api === 'chat-completions') {
        const cc = req.body;
        if (cc.reasoning_effort) base.reasoning_effort = cc.reasoning_effort;
        if (cc.reasoning_summary) base.reasoning_summary = cc.reasoning_summary;
        if (cc.max_tokens) base.max_tokens = cc.max_tokens;
    } else if (req.api === 'messages') {
        const msg = req.body;
        if (msg.thinking) base.thinking = msg.thinking;
        if (msg.max_tokens) base.max_tokens = msg.max_tokens;
    } else if (req.api === 'responses') {
        const resp = req.body;
        if (resp.reasoning) base.reasoning = resp.reasoning;
    }
    return base;
}

// ── Context breakdown ───────────────────────────────────────────────

export interface ContextBreakdownItem {
    type: 'system' | 'notes' | 'history' | 'tool_result' | 'images';
    label: string;
    chars: number;
    /** Proportional share of the total (0–1). Use to distribute real API tokens. */
    proportion: number;
    count?: number;
}

export interface ContextBreakdown {
    items: ContextBreakdownItem[];
    totalChars: number;
    /** Character-proportional breakdown only — real tokens come from the API. */
    contextLimit: number;
}

/** Estimate character count for an API message content field. */
function measureContent(content: string | ApiContentPart[] | null | undefined): number {
    if (!content) return 0;
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
        return content.reduce((sum, part) => {
            if (part.type === 'text' || part.type === 'input_text') return sum + (part.text?.length || 0);
            // Images count as ~85 tokens ≈ 340 chars (low-detail estimate)
            if (part.type === 'image_url' || part.type === 'input_image') return sum + 340;
            return sum;
        }, 0);
    }
    return 0;
}

/** Walk API messages and compute a context breakdown by category (character proportions). */
export function computeContextBreakdown(
    messages: ApiMessage[],
    contextLimit: number,
): ContextBreakdown {
    let systemChars = 0;
    let notesChars = 0;
    let notesCount = 0;
    let historyChars = 0;
    let historyCount = 0;
    let toolChars = 0;
    let toolCount = 0;
    let imageChars = 0;
    let imageCount = 0;

    for (const msg of messages) {
        const chars = measureContent(msg.content);

        // Responses API function_call / function_call_output items
        if (msg.type === 'function_call') {
            toolChars += (msg.arguments?.length || 0);
            toolCount++;
            continue;
        }
        if (msg.type === 'function_call_output') {
            toolChars += (msg.output?.length || 0);
            toolCount++;
            continue;
        }

        if (msg.role === 'system') {
            systemChars += chars;
        } else if (msg.role === 'tool') {
            toolChars += chars;
            toolCount++;
        } else if (msg.role === 'user') {
            // Detect attached note context messages
            const textContent = typeof msg.content === 'string' ? msg.content : '';
            if (textContent.startsWith('[Attached note:')) {
                notesChars += chars;
                notesCount++;
            } else {
                historyChars += chars;
                historyCount++;
                // Count images in user messages
                if (Array.isArray(msg.content)) {
                    const imgParts = msg.content.filter(p => p.type === 'image_url' || p.type === 'input_image');
                    if (imgParts.length > 0) {
                        imageCount += imgParts.length;
                        imageChars += imgParts.length * 340;
                    }
                }
            }
        } else if (msg.role === 'assistant') {
            historyChars += chars;
            // Also measure tool_calls arguments — these are the main payload
            // for tool-calling assistant messages (which have content: null)
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const argLen = tc.function?.arguments?.length || 0;
                    const nameLen = tc.function?.name?.length || 0;
                    historyChars += argLen + nameLen;
                }
            }
            historyCount++;
        }
    }

    const totalChars = systemChars + notesChars + historyChars + toolChars + imageChars;

    const items: ContextBreakdownItem[] = [];
    const prop = (c: number) => totalChars > 0 ? c / totalChars : 0;
    if (systemChars > 0) items.push({ type: 'system', label: 'System Instructions', chars: systemChars, proportion: prop(systemChars) });
    if (notesCount > 0) items.push({ type: 'notes', label: `Attached Notes (${notesCount})`, chars: notesChars, proportion: prop(notesChars), count: notesCount });
    if (historyCount > 0) items.push({ type: 'history', label: `Messages (${historyCount})`, chars: historyChars, proportion: prop(historyChars), count: historyCount });
    if (toolCount > 0) items.push({ type: 'tool_result', label: `Tool Results (${toolCount})`, chars: toolChars, proportion: prop(toolChars), count: toolCount });
    if (imageCount > 0) items.push({ type: 'images', label: `Images (${imageCount})`, chars: imageChars, proportion: prop(imageChars), count: imageCount });

    const limit = contextLimit || 128_000; // fallback

    return { items, totalChars, contextLimit: limit };
}

// ── Thinking summary extraction ─────────────────────────────────────

/** Preamble phrases to strip from the start of reasoning text. */
const PREAMBLE_RE = /^(?:(?:OK|Okay|Alright|Right|Sure|Well|Hmm|So|Now)[,.]?\s*)?(?:(?:Let me|I'll|I need to|I should|I want to|I'm going to|Let's|I can|I will)\s+)/i;

/**
 * Extract a short, meaningful summary from reasoning text for the callout title.
 * Returns "Thinking" as fallback if no useful summary can be extracted.
 */
export function extractThinkingSummary(text: string): string {
    if (!text?.trim()) return 'Thinking';

    // Take the first ~200 chars to avoid scanning huge strings
    let first = text.slice(0, 200).trim();

    // Strip common preamble phrases
    first = first.replace(PREAMBLE_RE, '');
    if (!first) return 'Thinking';

    // Extract first sentence (split on sentence-ending punctuation or paragraph break)
    const sentenceMatch = first.match(/^(.+?)[.!?\n]{1}/);
    let summary = sentenceMatch ? sentenceMatch[1].trim() : first.split('\n')[0].trim();

    if (!summary || summary.length < 3) return 'Thinking';

    // Capitalize first letter
    summary = summary.charAt(0).toUpperCase() + summary.slice(1);

    // Truncate to ~80 chars
    if (summary.length > 80) {
        summary = summary.slice(0, 77) + '…';
    }

    return summary;
}

// ── Display accumulator ─────────────────────────────────────────────

/**
 * Manages the accumulated markdown content during streaming,
 * including reasoning blocks and tool call callouts.
 * Pure state management — zero Obsidian dependency.
 */
export class DisplayAccumulator {
    accumulated = '';
    /** Clean model output for API history — no callouts, no tool decorations. */
    cleanOutput = '';
    private reasoningChunks: string[] = [];
    private contentChunks: string[] = [];

    private get roundReasoning(): string {
        return this.reasoningChunks.join('');
    }

    private get roundContent(): string {
        return this.contentChunks.join('');
    }

    buildDisplay(): string {
        let display = this.accumulated;
        const reasoning = this.roundReasoning;
        if (reasoning) {
            const summary = extractThinkingSummary(reasoning);
            // Current/latest reasoning is expanded (+), previous ones are collapsed (-)
            display += `\n> [!abstract]+ 💭 ${summary}\n> ${reasoning.replace(/\n/g, '\n> ')}\n\n`;
        }
        display += this.roundContent;
        return display;
    }

    flushRound(): void {
        const reasoning = this.roundReasoning;
        const content = this.roundContent;
        if (reasoning) {
            const summary = extractThinkingSummary(reasoning);
            // Previous reasoning rounds are collapsed (-)
            this.accumulated += `\n> [!abstract]- 💭 ${summary}\n> ${reasoning.replace(/\n/g, '\n> ')}\n\n`;
        }
        this.accumulated += content;
        // Track clean content for API history (only model text, no callouts)
        this.cleanOutput += content;
        this.reasoningChunks = [];
        this.contentChunks = [];
    }

    addReasoning(text: string): void {
        this.reasoningChunks.push(text);
    }

    /** Get the current round's raw reasoning text (before flushRound clears it). */
    getRoundReasoning(): string {
        return this.roundReasoning;
    }

    addContent(text: string): void {
        this.contentChunks.push(text);
    }

    addImagePlaceholder(placeholder: string): void {
        this.contentChunks.push(placeholder);
    }

    replaceInContent(search: string, replace: string): void {
        // Materialize, replace, reset to single-element array
        const content = this.roundContent.replace(search, replace);
        this.contentChunks = [content];
    }

    replaceInAccumulated(search: string, replace: string): void {
        this.accumulated = this.accumulated.replace(search, replace);
    }

    /** Change the last reasoning callout from collapsed (-) to expanded (+). */
    expandLastReasoning(): void {
        const marker = '> [!abstract]- 💭 ';
        const lastIdx = this.accumulated.lastIndexOf(marker);
        if (lastIdx !== -1) {
            this.accumulated = this.accumulated.substring(0, lastIdx)
                + '> [!abstract]+ 💭 '
                + this.accumulated.substring(lastIdx + marker.length);
        }
    }

    resetForRetry(isFirstRound: boolean): void {
        if (isFirstRound) {
            this.accumulated = '';
            this.cleanOutput = '';
        }
        this.contentChunks = [];
        this.reasoningChunks = [];
    }
}

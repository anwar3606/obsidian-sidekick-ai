/**
 * Core types for the Sidekick API / protocol layer.
 *
 * These types have ZERO Obsidian dependency — they describe the shape of data
 * flowing between the plugin and external LLM APIs (OpenAI, OpenRouter, Copilot).
 */

// ── Tool call types ─────────────────────────────────────────────────

export interface ToolCall {
    /** Item ID — `fc_...` for Responses API, `call_...` for Chat Completions. */
    id: string;
    /** Function-call ID — `call_...` (Responses API only). Falls back to `id` when absent. */
    callId?: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolCallAccumulator {
    [index: number]: ToolCall;
}

// ── Tool schema types ───────────────────────────────────────────────

/** Chat Completions API tool schema — nested `function` key. */
export interface ChatCompletionTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/** Responses API tool schema — flat format (name, description at top level). */
export interface ResponsesApiTool {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

// ── Provider types ──────────────────────────────────────────────────

export interface HeaderOptions {
    isAgent?: boolean;
    /** When true, sets Openai-Intent to conversation-edits (needed for tool calling on Copilot). */
    hasTools?: boolean;
}

export interface ModelInfo {
    id: string;
    label: string;
    supportsVision: boolean;
    supportsThinking: boolean;
    supportsImageGen: boolean;
    supportsTools: boolean;
    /** Whether this model supports the Copilot Responses API. Defaults to `supportsThinking` when absent. */
    responsesApiSupported?: boolean;
    context_length?: number;
    pricing?: Record<string, unknown>;
    multiplier?: number;
    included?: boolean;
}

export interface ProviderConfig {
    label: string;
    url: string;
    responsesUrl?: string;
    messagesUrl?: string;
    modelsUrl: string;
    storageKey: string;
    authType?: 'key' | 'oauth';
    headers: (key: string, options?: HeaderOptions) => Record<string, string>;
    fallbackModels: ModelInfo[];
    defaultModel: string;
}

// ── API message types ───────────────────────────────────────────────

export type ApiContentPart =
    | { type: 'text'; text: string }
    | { type: 'input_text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'input_image'; image_url: string };

export interface ApiMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | ApiContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** Anthropic Messages API: thinking text from this assistant turn. */
    _thinking?: string;
    /** Anthropic Messages API: thinking signature for content verification. */
    _thinkingSignature?: string;
    /** Responses API: message type for function calls/outputs. */
    type?: string;
    /** Responses API: item ID (fc_...) for function_call items. */
    id?: string;
    /** Responses API: function call fields. */
    call_id?: string;
    name?: string;
    arguments?: string;
    /** Responses API: function call output. */
    output?: string;
}

// ── Request body types ──────────────────────────────────────────────

export interface ChatCompletionRequest {
    model: string;
    messages: ApiMessage[];
    stream: boolean;
    temperature?: number;
    max_tokens?: number;
    tools?: ChatCompletionTool[];
    reasoning?: { effort: string };
    reasoning_effort?: string;
    reasoning_summary?: string;
    thinking_budget?: number;
    modalities?: string[];
    stream_options?: { include_usage: boolean };
    store?: boolean;
}

export interface ResponsesApiRequest {
    model: string;
    input: ApiMessage[];
    stream: boolean;
    store?: boolean;
    reasoning?: { effort: string; summary?: string };
    tools?: ResponsesApiTool[];
    temperature?: number;
}

/** Anthropic Messages API tool schema. */
export interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

export interface MessagesApiRequest {
    model: string;
    max_tokens: number;
    stream: boolean;
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    thinking?: { type: string; budget_tokens: number };
    tools?: AnthropicTool[];
}

// ── Stream result ───────────────────────────────────────────────────

/** Discriminated union of all API request body shapes.
 *  Carrying the `api` tag lets consumer code narrow safely without `as any`. */
export type AnyRequestBody =
    | { api: 'chat-completions'; body: ChatCompletionRequest }
    | { api: 'responses'; body: ResponsesApiRequest }
    | { api: 'messages'; body: MessagesApiRequest };

// ── Stream result ───────────────────────────────────────────────────

export interface StreamResult {
    generationId: string | null;
    toolCalls: ToolCall[];
    finishReason: string | null;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    reasoningOpaque?: string;
}

export type ChunkType = 'content' | 'reasoning' | 'image' | 'tool_calls';

export type ChunkCallback = (token: string | null, type?: ChunkType, toolCalls?: ToolCall[]) => void;

// ── Settings subset (only what the lib needs) ───────────────────────

/** The minimal settings shape needed by lib/ functions.
 *  The full PluginSettings in src/ extends this. */
export interface ApiSettings {
    selectedProvider: string;
    selectedModel: string;
    temperature: number;
    thinkingEnabled: boolean;
    toolsEnabled: boolean;
    iterateMode: boolean;
    disabledTools: string[];
    thinkingBudget: number;
    webSearchEnabled?: boolean;
    redditClientId?: string;
    redditClientSecret?: string;
    jiraBaseUrl?: string;
    jiraEmail?: string;
    jiraApiToken?: string;
    /** Whether adaptive user profiling is enabled. */
    enableUserProfile?: boolean;
    /** Dynamically discovered MCP tools (already in Chat Completions format). */
    mcpTools?: ChatCompletionTool[];
}

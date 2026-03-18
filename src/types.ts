// ── Types for Sidekick Obsidian Plugin ─────────────────────────────

// Re-export all protocol types from lib/ (single source of truth)
export type {
    ToolCall,
    ToolCallAccumulator,
    HeaderOptions,
    ProviderConfig,
    ModelInfo,
    ApiContentPart,
    ApiMessage,
    ChatCompletionRequest,
    ResponsesApiRequest,
    MessagesApiRequest,
    StreamResult,
    ChunkType,
    ChunkCallback,
    ApiSettings,
    ChatCompletionTool,
    ResponsesApiTool,
} from '../lib/types';

// ── src-only types (UI, Obsidian, plugin settings) ──────────────────

import type { ToolCall, ApiMessage, ModelInfo as LibModelInfo } from '../lib/types';
import type { ConversationUsage, Collection } from '../lib/conversation';

// Re-export Collection for consumers
export type { Collection } from '../lib/conversation';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    /** Clean model output (no callouts/formatting) for API history on follow-up turns. */
    cleanContent?: string;
    images?: string[];
    cost?: GenerationCost;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    /** User feedback rating: 1 = thumbs up, -1 = thumbs down, undefined = not rated. */
    rating?: 1 | -1;
    /** Epoch ms when this message was created (optional, new messages only). */
    timestamp?: number;
}

export interface GenerationCost {
    total: number;
    tokensPrompt: number;
    tokensCompletion: number;
}

export interface Conversation {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
    pinned: boolean;
    provider: string;
    model: string;
    /** True when an iterate session was paused (switched away). */
    iterateSessionPaused?: boolean;
    /** Aggregated usage stats for this conversation. */
    usage?: ConversationUsage;
    /** Tools auto-approved via "Always Allow" — persisted per-chat. */
    alwaysAllowedTools?: string[];
    /** Collection this conversation belongs to (undefined = uncollected). */
    collectionId?: string;
}

/** Serializable snapshot of an in-flight iterate loop, saved when the user
 *  switches conversations so the session can be resumed without a new billing charge. */
export interface IterateState {
    apiMessages: ApiMessage[];
    displayAccumulated: string;
    toolRound: number;
    /** Whether the session was using the Responses API (vs Chat Completions).
     *  Ensures the restored messages are sent to the same API format they were built for. */
    useResponses?: boolean;
}

export interface CustomCommand {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
}

export interface AutocompleteSettings {
    enabled: boolean;
    provider: string;
    model: string;
    debounceMs: number;
    maxTokens: number;
    temperature: number;
    acceptKey: string;
    triggerMode: 'auto' | 'manual';
    /** Custom system prompt override (empty string = use default). */
    systemPrompt: string;
}

/** A stored GitHub Copilot account (OAuth token + user label). */
export interface CopilotAccount {
    id: string;
    label: string;
    oauthToken: string;
}

export interface PluginSettings {
    selectedProvider: string;
    selectedModel: string;
    openaiApiKey: string;
    openrouterApiKey: string;
    copilotToken: string;
    /** Multiple Copilot accounts for easy switching. */
    copilotAccounts: CopilotAccount[];
    /** ID of the currently active Copilot account. */
    activeCopilotAccountId: string;
    systemPrompt: string;
    temperature: number;
    customTypography: boolean;
    fontSize: number;
    lineHeight: number;
    compactMode: boolean;
    thinkingEnabled: boolean;
    toolsEnabled: boolean;
    iterateMode: boolean;
    disabledTools: string[];
    customCommands: CustomCommand[];
    customPromptsFolder: string;
    chatFolder: string;
    autocomplete: AutocompleteSettings;
    /** Image generation — provider, model, size, quality */
    imageGenProvider: 'same' | 'openai' | 'openrouter';
    imageGenModel: string;
    imageGenSize: string;
    imageGenQuality: string;
    /** OpenRouter image_config aspect ratio (e.g. "1:1", "16:9") */
    imageGenAspectRatio: string;
    /** Web search — provider and API key */
    webSearchEnabled: boolean;
    webSearchProvider: 'tavily' | 'brave' | 'google';
    /** Google Custom Search Engine ID (cx parameter) */
    googleSearchCxId: string;
    webSearchApiKey: string;
    /** MCP (Model Context Protocol) server connections. */
    mcpServers: Array<{ id: string; name: string; url: string; apiKey: string; enabled: boolean }>;
    mcpCacheTTL: number;
    /** Dynamically discovered MCP tools (runtime-only, not persisted). */
    mcpTools?: import('../lib/types').ChatCompletionTool[];
    /** Advanced — configurable limits (previously hardcoded) */
    maxToolRounds: number;
    maxToolRoundsIterate: number;
    maxRetries: number;
    retryDelayMs: number;
    maxContentLength: number;
    thinkingBudget: number;
    /** When enabled, verbose debug logs are written to copilot/debug-logs/ in the vault. */
    debugLogging: boolean;
    /** Embeddings / vector search settings. */
    embeddingsEnabled: boolean;
    embeddingDimensions: number;
    embeddingModel: string;
    /** Auto-generate conversation titles using AI after first exchange. */
    autoTitle: boolean;
    /** Recently used model IDs for quick access in model picker. */
    recentModels: string[];
    /** Named conversation collections for organizing chats. */
    collections: Collection[];
    /** Reddit API credentials (free, from https://www.reddit.com/prefs/apps) */
    redditClientId: string;
    redditClientSecret: string;
    /** Jira API credentials */
    jiraBaseUrl: string;
    jiraEmail: string;
    jiraApiToken: string;
    /** Show follow-up suggestion chips after assistant responses. */
    followUpSuggestions: boolean;
    /** Customizable prompts (empty = use built-in default). */
    iterateInstruction: string;
    iterateReprompt: string;
    autoTitlePrompt: string;
    followUpSuggestionsPrompt: string;
    /** Maps custom command names to their last-used conversation ID. */
    commandSessionMap: Record<string, string>;
    /** Adaptive User Profile — learn from chats to personalize responses. */
    enableUserProfile: boolean;
    /** Stored user profile (facts, traits). */
    userProfile: import('../lib/profile').UserProfile;
    /** Currently active agent preset ID. */
    activeAgentPreset: string;
    /** Auto-attach relevant vault notes as context (requires embeddings). */
    enableAutoRAG: boolean;
    /** S3 Auto-Update Settings */
    s3UpdateEnabled: boolean;
    s3Endpoint: string;
    s3Bucket: string;
    s3Prefix: string;
    s3AccessKeyId: string;
    s3SecretAccessKey: string;
}

export interface ToolExecutionResult {
    result: string;
    screenshotUrl?: string;
    generatedImageUrl?: string;
    /** Base64 data URL of an image read from vault (used by view_image tool). */
    viewedImageUrl?: string;
    /** User-attached images from iterate feedback (ask_user tool). */
    feedbackImages?: string[];
    /** Before/after content for file edits (used by edit_note tool). */
    editDiff?: { before: string; after: string; path: string };
}

export interface PendingToolApproval {
    toolName: string;
    toolLabel: string;
    args: string;
    argsPreview: string;
    toolCallId: string;
}

// Re-export ParsedCommand from lib/commands (single source of truth)
export type { ParsedCommand } from '../lib/commands';

import type { ChatControllerCallbacks } from './chat-controller';

/** Context needed for tool execution. */
export interface ToolContext {
    provider: string;
    apiKey: string;
    callbacks?: ChatControllerCallbacks;
    /** Image generation overrides */
    imageGenProvider?: string;
    imageGenApiKey?: string;
    imageGenModel?: string;
    imageGenSize?: string;
    imageGenQuality?: string;
    /** OpenRouter aspect ratio for image_config (e.g. "1:1", "16:9") */
    imageGenAspectRatio?: string;
    /** Max characters to read from notes/URLs (default 15000) */
    maxContentLength?: number;
    /** Web search overrides */
    webSearchProvider?: 'tavily' | 'brave' | 'google';
    webSearchApiKey?: string;
    /** Google Custom Search Engine ID */
    googleSearchCxId?: string;
    /** MCP servers for external tool execution */
    mcpServers?: Array<{ id: string; name: string; url: string; apiKey: string; enabled: boolean }>;
    /** Reddit API credentials */
    redditClientId?: string;
    redditClientSecret?: string;
    /** Jira API credentials */
    jiraBaseUrl?: string;
    jiraEmail?: string;
    jiraApiToken?: string;
    /** Full plugin settings (needed by sub-agent execution) */
    pluginSettings?: PluginSettings;
    /** Cached model list (needed by sub-agent execution) */
    cachedModels?: LibModelInfo[];
    /** Callback to save a user profile fact (remember_user_fact tool) */
    saveProfileFact?: (fact: string, category?: string) => Promise<void>;
}

/** Arguments for each tool (replacing parsed `any`). */
export interface SearchVaultArgs {
    query: string;
    max_results?: number;
}

export interface ReadNoteArgs {
    path: string;
    start_line?: number;
    end_line?: number;
}

export interface ReadNoteOutlineArgs {
    path: string;
}

export interface ReadNoteSectionArgs {
    path: string;
    heading: string;
    include_children?: boolean;
}

export interface CreateNoteArgs {
    path: string;
    content: string;
    append?: boolean;
    smart_enhance?: boolean;
}

export interface FetchUrlArgs {
    url: string;
}

export interface GenerateImageArgs {
    prompt: string;
    size?: string;
}

export interface WebSearchArgs {
    query: string;
    max_results?: number;
    topic?: 'general' | 'news';
}

export interface RedditSearchArgs {
    query: string;
    subreddit?: string;
    max_results?: number;
    sort?: 'relevance' | 'hot' | 'new' | 'top';
    time_filter?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
}

export interface RedditReadPostArgs {
    post_url: string;
    max_comments?: number;
}

export interface JiraSearchArgs {
    jql: string;
    max_results?: number;
}

export interface JiraGetIssueArgs {
    issue_key: string;
}

export interface JiraCreateIssueArgs {
    project_key: string;
    summary: string;
    description?: string;
    issue_type?: string;
    priority?: string;
    assignee_id?: string;
    labels?: string[];
}

export interface JiraAddCommentArgs {
    issue_key: string;
    comment: string;
}

export interface JiraUpdateIssueArgs {
    issue_key: string;
    summary?: string;
    description?: string;
    priority?: string;
    labels?: string[];
    status?: string;
    assignee_id?: string;
}

export interface RememberUserFactArgs {
    fact: string;
    category?: string;
}

export interface ViewImageArgs {
    path: string;
}

export interface ListFilesArgs {
    path: string;
}

export interface GrepSearchArgs {
    pattern: string;
    folder?: string;
    max_results?: number;
}

export interface AskUserArgs {
    question: string;
}

export interface AskUserChoiceArgs {
    question: string;
    choices: string[];
    allow_custom_answer?: boolean;
}

export interface OpenNoteArgs {
    path: string;
}

export interface EditNoteArgs {
    path: string;
    operation: 'replace' | 'insert';
    /** Text to search for (required for replace). */
    search?: string;
    /** Replacement text (required for replace). */
    replace?: string;
    /** Line number to insert at, 1-indexed (required for insert). */
    line_number?: number;
    /** Content to insert (required for insert). */
    content?: string;
}

export interface GetBacklinksArgs {
    path: string;
    max_results?: number;
}

export interface GetNoteMetadataArgs {
    path: string;
}

export interface SearchByTagArgs {
    tag: string;
    exact?: boolean;
    max_results?: number;
}

export interface GetRecentNotesArgs {
    max_results?: number;
    folder?: string;
}

export interface MoveNoteArgs {
    from: string;
    to: string;
}

export interface DeleteNoteArgs {
    path: string;
}

export interface SemanticSearchVaultArgs {
    query: string;
    max_results?: number;
    min_score?: number;
}

/** Note context attached to a conversation. */
export interface NoteContext {
    path: string;
    name: string;
    content: string;
    images: string[];
}

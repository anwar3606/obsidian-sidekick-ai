/**
 * Sidekick API Library — zero Obsidian dependency.
 *
 * This module exports all the protocol-layer functions needed to interact
 * with LLM APIs (OpenAI, OpenRouter, GitHub Copilot). It handles:
 *
 * - Provider configuration and headers
 * - Request body building (Chat Completions + Responses API)
 * - Tool schema definitions and format conversion
 * - SSE stream parsing
 *
 * Everything here is a pure function or constant — no Obsidian, no DOM, no vault.
 * This makes it independently testable, including integration tests against real APIs.
 */

// Types
export type {
    ToolCall,
    ToolCallAccumulator,
    ChatCompletionTool,
    ResponsesApiTool,
    AnthropicTool,
    HeaderOptions,
    ModelInfo,
    ProviderConfig,
    ApiContentPart,
    ApiMessage,
    ChatCompletionRequest,
    ResponsesApiRequest,
    MessagesApiRequest,
    StreamResult,
    ChunkType,
    ChunkCallback,
    ApiSettings,
    AnyRequestBody,
} from './types';

// Providers
export {
    PROVIDERS,
    PROVIDER_IDS,
    COPILOT_MODELS_URL,
    getProvider,
    getCopilotHeaders,
    resolveModelForProvider,
    isThinkingCapableOpenAIModel,
    shouldSkipTemperature,
    isVisionCapableOpenAIModel,
    isImageGenCapableOpenAIModel,
    isToolCapableOpenAIModel,
    isThinkingCapableOpenRouterModel,
    prettifyOpenAIModelId,
    openAIFamily,
    copilotModelFamily,
    prettifyProviderKey,
    categorizeModels,
    getImageModalities,
    parseCopilotModelsResponse,
    OPENAI_CHAT_PREFIXES,
    OPENAI_EXCLUDE,
    OPENROUTER_IMAGE_GEN_MODELS,
    OPENAI_IMAGE_GEN_MODELS,
} from './providers';

// API request builders
export {
    MAX_RETRIES,
    RETRY_DELAY_MS,
    MAX_TOOL_ROUNDS,
    MAX_TOOL_ROUNDS_ITERATE,
    MAX_CONTENT_LENGTH,
    THINKING_BUDGET,
    buildChatCompletionBody,
    buildResponsesBody,
    buildMessagesApiBody,
    shouldUseResponsesAPI,
    shouldUseMessagesAPI,
    getMessagesApiHeaders,
    convertToResponsesContent,
    convertMessagesForResponses,
    convertMessagesForAnthropic,
    formatToolResultForChatCompletions,
    formatToolResultForResponses,
    formatToolResultForMessagesAPI,
    formatAssistantToolCalls,
    formatAssistantToolCallsForMessagesAPI,
    formatFunctionCallForResponses,
    formatToolArgsPreview,
    formatCleanToolHeader,
    stripBase64,
    buildNoteContextMessages,
    DisplayAccumulator,
    computeContextBreakdown,
    extractThinkingSummary,
    getRequestMessageCount,
    getRequestTemperature,
    getRequestToolCount,
    requestHasTools,
    updateRequestMessages,
    stripRequestParam,
    getRequestDebugInfo,
} from './api';

// Tools
export {
    TOOL_SCHEMAS,
    RISKY_TOOLS,
    TOOL_LABELS,
    toResponsesFormat,
    getEnabledTools,
    getEnabledToolsForResponses,
} from './tools';

// Streaming
export {
    streamChatCompletions,
    streamResponsesAPI,
    streamMessagesAPI,
} from './streaming';

// Utils — pure helpers (no Obsidian)
export {
    retryWithBackoff,
    sleep,
    generateId,
    formatPrice,
    truncate,
    getErrorMessage,
} from './utils';
export type { RetryOptions } from './utils';

// Search — tokenisation, BM25, fuzzy scoring, web search builders/parsers
export {
    tokenize,
    bm25Score,
    fuzzyScore,
    BM25_K1,
    BM25_B,
    buildTavilySearchRequest,
    buildBraveSearchRequest,
    buildGoogleSearchRequest,
    parseTavilyResponse,
    parseBraveResponse,
    parseGoogleResponse,
    stripHtml,
} from './search';
export type { CorpusStats, WebSearchResult, WebSearchResponse } from './search';

// Commands — slash-command parsing
export {
    getBuiltInCommands,
    getAllCommands,
    getCommandSuggestions,
    parseSlashCommand,
    slashHelpText,
} from './commands';
export type { CommandDef, ParsedCommand } from './commands';

// Conversation — serialisation, grouping, export
export {
    formatTimeAgo,
    getPreviewSnippet,
    sortConversations,
    filterConversations,
    categorizeByTime,
    groupByCollection,
    conversationToMarkdown,
    markdownToConversation,
    buildExportMarkdown,
} from './conversation';
export type { ConversationData, Collection, GroupBy, SortBy, SortDir, ConversationGroup } from './conversation';

// Image utilities — base64, MIME
export {
    arrayBufferToBase64,
    extensionToMime,
} from './image-utils';

// Image generation — OpenRouter request building & response parsing (no HTTP calls)
export {
    normalizeOpenRouterModel,
    buildOpenRouterImageRequest,
    buildOpenRouterImageHeaders,
    parseOpenRouterImageResponse,
} from './image-gen';
export type { OpenRouterImageRequest, OpenRouterImageResult } from './image-gen';

// Autocomplete — completion context & prompt building
export {
    buildCompletionContext,
    buildCompletionPrompt,
    cleanCompletion,
} from './autocomplete';
export type { CompletionContext } from './autocomplete';

// Embeddings — vector math, chunking, search, serialisation
export {
    cosineSimilarity,
    chunkText,
    searchVectors,
    serializeEmbedding,
    deserializeEmbedding,
    estimateTokens,
    COPILOT_EMBEDDINGS_URL,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_BATCH_TOKENS,
} from './embeddings';
export type {
    VectorChunk,
    VectorSearchResult,
    TextChunk,
    ChunkingOptions,
} from './embeddings';

// Quick Actions — context-menu AI action definitions & prompt building
export {
    BUILT_IN_ACTIONS,
    buildQuickActionMessages,
    getActionById,
    getAllActions,
} from './quick-actions';
export type { QuickAction } from './quick-actions';

// MCP Client — JSON-RPC 2.0 protocol, schema conversion
export {
    buildInitializeRequest,
    buildToolsListRequest,
    buildToolsCallRequest,
    buildMCPHttpRequest,
    parseJsonRpcResponse,
    parseToolsList,
    parseToolCallResult,
    mcpToolsToChatCompletions,
    parseMCPToolName,
    mcpResultToText,
} from './mcp';
export type { MCPServerConfig, MCPToolSchema, MCPToolCallResult, DiscoveredMCPTool } from './mcp';

// Usage stats — cost computation
export {
    computeUsageReport,
    formatCost,
    formatTokens,
} from './usage-stats';
export type { ModelStats, UsageReport } from './usage-stats';

// Copilot usage — quota parsing
export {
    parseCopilotQuota,
    formatQuotaSummary,
} from './copilot-usage';
export type { CopilotQuotaInfo, CopilotQuotaSnapshot } from './copilot-usage';

// Follow-up suggestions — prompt building & response parsing
export {
    buildFollowUpPromptMessages,
    parseFollowUpResponse,
    shouldGenerateSuggestions,
    buildThinkingSummaryPromptMessages,
    parseThinkingSummaryResponse,
    extractThinkingCallouts,
    replaceThinkingSummary,
} from './suggestions';
export type { FollowUpSuggestion } from './suggestions';

// Debug log — formatting utilities
export {
    formatLogEntry,
    isoNow,
    logFileDateStamp,
} from './debug-log';
export type { DebugLogEntry } from './debug-log';

// Note suggestions — smart note creation helpers
export {
    displayNameFromPath,
    buildWikilinkSuggestions,
    appendRelatedNotesSection,
    suggestTags,
    addFrontmatterTags,
    generateConflictSummary,
    enhanceNoteContent,
} from './note-suggestions';
export type { RelatedNote, WikilinkSuggestion, SmartNoteEnhancements } from './note-suggestions';

// Sub-agent — role configs, tool filtering, token budgeting, validation
export {
    ROLE_CONFIGS,
    VALID_ROLES,
    MAX_PARALLEL_AGENTS,
    MAX_TOKENS_PER_AGENT,
    MAX_SUB_AGENT_TOOL_ROUNDS,
    getToolsForRole,
    calculateTokenBudget,
    buildSubAgentMessages,
    validateSubAgentArgs,
    validateParallelAgentsArgs,
    formatSubAgentResults,
} from './sub-agent';
export type { SubAgentRole, RoleConfig, TokenBudget, SubAgentResult } from './sub-agent';

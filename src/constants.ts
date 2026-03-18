import type { PluginSettings, AutocompleteSettings } from './types';

// ── Provider configurations (single source of truth in lib/) ────────
export { PROVIDERS, PROVIDER_IDS } from '../lib/providers';

// ── Default system prompt ───────────────────────────────────────────
export const DEFAULT_SYSTEM_PROMPT =
    'You are a helpful AI assistant integrated into Obsidian. Help the user with their notes, writing, and research. Use markdown formatting when appropriate.';

// ── Auto-completion defaults ────────────────────────────────────────
export const AUTOCOMPLETE_SYSTEM_PROMPT =
    'You are an inline text completion engine for a markdown note editor. ' +
    'The user\'s cursor position is marked with <|cursor|>. ' +
    'Predict and insert the most natural continuation at the cursor. ' +
    'Complete the current word first, then extend through the rest of the line. ' +
    'If the line is complete, you may continue to the next 1-3 lines.\n' +
    'Rules:\n' +
    '- Output ONLY the raw text to insert — no wrapping, no explanation.\n' +
    '- Do NOT repeat any text that already appears before <|cursor|>.\n' +
    '- Do NOT start with a newline unless the cursor is at a line ending.\n' +
    '- Respect existing markdown syntax (lists, checkboxes, headings, etc.) — continue the pattern, don\'t duplicate markers.\n' +
    '- Prefer completing the thought/sentence over starting new ones.\n' +
    '- Match the document\'s style, vocabulary, and formatting exactly.\n\n' +
    'Examples:\n' +
    'Input: "- [ ] <|cursor|>"\n' +
    'Output: "Buy groceries for dinner"\n\n' +
    'Input: "- [ ] discuss the fun<|cursor|>"\n' +
    'Output: "ding timeline with Sarah"\n\n' +
    'Input: "## Meeting Notes\\n\\nWe agreed to <|cursor|>"\n' +
    'Output: "move the deadline to next Friday."\n\n' +
    'Input: "The main advantage of <|cursor|> is"\n' +
    'Output: "this approach"';

export const DEFAULT_AUTOCOMPLETE_SETTINGS: AutocompleteSettings = {
    enabled: false,
    provider: 'openai',
    model: 'gpt-4o-mini',
    debounceMs: 300,
    maxTokens: 128,
    temperature: 0.3,
    acceptKey: 'Tab',
    triggerMode: 'auto',
    systemPrompt: AUTOCOMPLETE_SYSTEM_PROMPT,
};

// ── Iterate mode system instruction ─────────────────────────────────
export const ITERATE_FEEDBACK_INSTRUCTION =
    'You are in Iterate Mode. After EVERY response you give (whether it is an answer, code, explanation, or any other output), you MUST call the `ask_user` tool to ask the user if the task is complete, working as expected, or if they want any follow-up changes. NEVER end your turn without calling `ask_user`. Do NOT just output text asking for feedback — you MUST use the `ask_user` tool call. If you forget, the conversation will end prematurely.';

/** Re-prompt injected when the model finishes with 'stop' instead of calling ask_user in iterate mode. */
export const ITERATE_REPROMPT =
    'You forgot to call the `ask_user` tool. Please call it now to ask the user if they want to continue or if the task is complete.';

// ── Auto-title default prompt ───────────────────────────────────────
export const DEFAULT_AUTO_TITLE_PROMPT =
    'Generate a short, descriptive title (3-8 words) for this conversation. Reply with ONLY the title, no quotes, no punctuation, no explanation.';

// ── Follow-up suggestions default prompt ────────────────────────────
export const DEFAULT_FOLLOW_UP_PROMPT =
    `You generate 2-3 short follow-up questions that a user might want to ask next, based on an AI assistant's response. Each suggestion should be a natural continuation of the conversation.

Rules:
- Output ONLY a JSON array of strings, no explanation
- Each string is a complete question (5-15 words)
- Questions should be diverse (don't repeat the same angle)
- Questions should be actionable and specific
- Output example: ["How can I optimize this further?", "What are the trade-offs?", "Can you show an example?"]`;

// ── Default plugin settings ─────────────────────────────────────────
export const DEFAULT_SETTINGS: PluginSettings = {
    selectedProvider: 'openai',
    selectedModel: 'gpt-4.1-nano',
    openaiApiKey: '',
    openrouterApiKey: '',
    copilotToken: '',
    copilotAccounts: [],
    activeCopilotAccountId: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    temperature: 0.7,
    customTypography: false,
    fontSize: 1.0,
    lineHeight: 1.6,
    compactMode: false,
    thinkingEnabled: false,
    toolsEnabled: true,
    iterateMode: false,
    disabledTools: [],
    customCommands: [],
    customPromptsFolder: 'copilot/custom-prompts',
    chatFolder: 'copilot/conversations',
    autocomplete: DEFAULT_AUTOCOMPLETE_SETTINGS,
    imageGenProvider: 'same',
    imageGenModel: 'dall-e-3',
    imageGenSize: '1024x1024',
    imageGenQuality: 'standard',
    imageGenAspectRatio: '1:1',
    webSearchEnabled: false,
    webSearchProvider: 'tavily',
    webSearchApiKey: '',
    googleSearchCxId: '',
    mcpServers: [],
    mcpCacheTTL: 3600,
    maxToolRounds: 10,
    maxToolRoundsIterate: 50,
    maxRetries: 3,
    retryDelayMs: 2000,
    maxContentLength: 15000,
    thinkingBudget: 16384,
    debugLogging: false,
    embeddingsEnabled: false,
    embeddingDimensions: 256,
    embeddingModel: 'text-embedding-3-small',
    autoTitle: true,
    recentModels: [],
    collections: [],
    redditClientId: '',
    redditClientSecret: '',
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraApiToken: '',
    followUpSuggestions: true,
    iterateInstruction: ITERATE_FEEDBACK_INSTRUCTION,
    iterateReprompt: ITERATE_REPROMPT,
    autoTitlePrompt: DEFAULT_AUTO_TITLE_PROMPT,
    followUpSuggestionsPrompt: DEFAULT_FOLLOW_UP_PROMPT,
    commandSessionMap: {},
    enableUserProfile: false,
    userProfile: { version: 1, lastUpdated: 0, facts: [] },
    activeAgentPreset: 'default',
    enableAutoRAG: false,
    s3UpdateEnabled: false,
    s3Endpoint: '',
    s3Bucket: '',
    s3Prefix: 'obsidian-sidekick',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
};

// ── View type ───────────────────────────────────────────────────────
export const SIDEKICK_VIEW_TYPE = 'sidekick-view';

// ── OpenRouter provider labels ──────────────────────────────────────

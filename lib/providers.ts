/**
 * Provider configurations — zero Obsidian dependency.
 *
 * Defines each supported LLM provider's endpoints, headers, and fallback models.
 * This is the single source of truth for how to talk to each provider.
 */

import type { ProviderConfig, ModelInfo } from './types';

/** Copilot models listing endpoint (discovered June 2025). */
export const COPILOT_MODELS_URL = 'https://api.githubcopilot.com/models';

// ── Provider definitions ────────────────────────────────────────────

export const PROVIDERS: Record<string, ProviderConfig> = {
    openai: {
        label: 'OpenAI',
        url: 'https://api.openai.com/v1/chat/completions',
        modelsUrl: 'https://api.openai.com/v1/models',
        storageKey: 'openaiApiKey',
        headers: (key: string) => ({
            Authorization: `Bearer ${key}`,
        }),
        fallbackModels: [
            { id: 'gpt-4.1', label: 'GPT-4.1', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
            { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
            { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
            { id: 'gpt-4o', label: 'GPT-4o', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
            { id: 'gpt-4o-mini', label: 'GPT-4o Mini', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
            { id: 'o3-mini', label: 'o3-mini', supportsVision: false, supportsThinking: true, supportsImageGen: false, supportsTools: true },
        ],
        defaultModel: 'gpt-4.1-nano',
    },

    openrouter: {
        label: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        modelsUrl: 'https://openrouter.ai/api/v1/models',
        storageKey: 'openrouterApiKey',
        headers: (key: string) => ({
            Authorization: `Bearer ${key}`,
            'HTTP-Referer': 'https://obsidian.md',
            'X-Title': 'Obsidian Sidekick',
        }),
        fallbackModels: [
            { id: 'openai/gpt-4.1-nano', label: 'GPT-4.1 Nano', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
        ],
        defaultModel: 'openai/gpt-4.1-nano',
    },

    copilot: {
        label: 'GitHub Copilot',
        url: 'https://api.githubcopilot.com/chat/completions',
        responsesUrl: 'https://api.githubcopilot.com/responses',
        messagesUrl: 'https://api.githubcopilot.com/v1/messages',
        modelsUrl: COPILOT_MODELS_URL,
        storageKey: 'copilotToken',
        authType: 'oauth' as const,
        headers: (key: string, options?: { isAgent?: boolean; hasTools?: boolean }) => ({
            Authorization: `Bearer ${key}`,
            'Editor-Version': 'vscode/1.109.5',
            'Editor-Plugin-Version': 'copilot-chat/0.37.0',
            'Copilot-Integration-Id': 'vscode-chat',
            'User-Agent': 'GitHubCopilotChat/0.37.0',
            'X-Request-Id': crypto.randomUUID(),
            // Openai-Intent gates API capabilities (tool calling needs conversation-edits).
            // x-initiator controls billing (agent = free continuation, user = premium request).
            'Openai-Intent': (options?.isAgent || options?.hasTools) ? 'conversation-edits' : 'conversation-panel',
            'x-initiator': options?.isAgent ? 'agent' : 'user',
        }),
        fallbackModels: [
            // OpenAI models — context_length values from /models API (March 2026)
            { id: 'gpt-4.1', label: 'GPT-4.1', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 0, included: true },
            { id: 'gpt-5-mini', label: 'GPT-5 Mini', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 264_000, multiplier: 0, included: true },
            { id: 'gpt-5.1', label: 'GPT-5.1', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 264_000, multiplier: 1 },
            { id: 'gpt-5.1-codex', label: 'GPT-5.1-Codex', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 400_000, multiplier: 1 },
            { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-Mini', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 400_000, multiplier: 0.33 },
            { id: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 400_000, multiplier: 1 },
            { id: 'gpt-5.2', label: 'GPT-5.2', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 264_000, multiplier: 1 },
            { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 400_000, multiplier: 1 },
            { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 400_000, multiplier: 1 },
            { id: 'gpt-5.4', label: 'GPT-5.4', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 400_000, multiplier: 1 },
            // Anthropic models
            { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 200_000, multiplier: 0.33 },
            { id: 'claude-opus-4.5', label: 'Claude Opus 4.5', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 200_000, multiplier: 3 },
            { id: 'claude-opus-4.6', label: 'Claude Opus 4.6', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 200_000, responsesApiSupported: false, multiplier: 3 },
            { id: 'claude-opus-4.6-fast', label: 'Claude Opus 4.6 (fast mode)', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 200_000, responsesApiSupported: false, multiplier: 30 },
            { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 216_000, multiplier: 1 },
            { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 200_000, multiplier: 1 },
            { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 200_000, responsesApiSupported: false, multiplier: 1 },
            // Google models
            { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 1 },
            { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 0.33 },
            { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 1 },
            { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 1 },
            // xAI models
            { id: 'grok-code-fast-1', label: 'Grok Code Fast 1', supportsVision: false, supportsThinking: false, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 0.25 },
            // Fine-tuned models
            { id: 'oswe-vscode-prime', label: 'Raptor Mini', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, context_length: 264_000, multiplier: 0, included: true },
            { id: 'goldeneye', label: 'Goldeneye', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true, context_length: 128_000, multiplier: 1 },
        ],
        defaultModel: 'gpt-4.1',
    },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

// ── Copilot models API parsing ──────────────────────────────────────

/**
 * Billing multiplier lookup — not available from the /models API.
 * Maps model ID → { multiplier, included? }.
 * Models not in this map get a default derived from model_picker_category.
 */
const COPILOT_BILLING: Record<string, { multiplier: number; included?: boolean }> = {
    'gpt-4.1':              { multiplier: 0, included: true },
    'gpt-4o':               { multiplier: 0, included: true },
    'gpt-5-mini':           { multiplier: 0, included: true },
    'oswe-vscode-prime':    { multiplier: 0, included: true },
    'claude-haiku-4.5':     { multiplier: 0.33 },
    'gpt-5.1-codex-mini':  { multiplier: 0.33 },
    'grok-code-fast-1':     { multiplier: 0.25 },
    'claude-opus-4.5':      { multiplier: 3 },
    'claude-opus-4.6':      { multiplier: 3 },
    'claude-opus-4.6-fast': { multiplier: 30 },
};

/** Default multiplier for missing models based on model_picker_category. */
const CATEGORY_MULTIPLIER: Record<string, number> = {
    lightweight: 0.33,
    versatile: 1,
    powerful: 1,
};

/**
 * Parse the Copilot /models API response into our ModelInfo format.
 * Filters to model_picker_enabled models and maps capabilities.
 */
export function parseCopilotModelsResponse(data: { data: any[] }): ModelInfo[] {
    const models = data?.data;
    if (!Array.isArray(models)) return [];

    return models
        .filter((m: any) => m.model_picker_enabled && m.capabilities?.type === 'chat')
        .map((m: any): ModelInfo => {
            const caps = m.capabilities || {};
            const limits = caps.limits || {};
            const supports = caps.supports || {};
            const endpoints: string[] = m.supported_endpoints || [];

            const billing = COPILOT_BILLING[m.id];
            const categoryMultiplier = CATEGORY_MULTIPLIER[m.model_picker_category] ?? 1;

            // Derive responsesApiSupported from supported_endpoints
            const hasResponses = endpoints.includes('/responses');
            const hasChatCompletions = endpoints.includes('/chat/completions');
            // Only explicitly set to false if the model has endpoints listed but /responses isn't one
            const responsesApiSupported = endpoints.length > 0 && !hasResponses ? false : undefined;

            return {
                id: m.id,
                label: m.name || m.id,
                supportsVision: !!supports.vision,
                supportsThinking: !!supports.adaptive_thinking,
                supportsImageGen: false,
                supportsTools: !!supports.tool_calls,
                responsesApiSupported,
                context_length: limits.max_context_window_tokens,
                multiplier: billing?.multiplier ?? categoryMultiplier,
                included: billing?.included,
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Helper functions ────────────────────────────────────────────────

/** Get the provider config, throwing if the provider ID is unknown. */
export function getProvider(id: string): ProviderConfig {
    const p = PROVIDERS[id];
    if (!p) throw new Error(`Unknown provider: ${id}`);
    return p;
}

/** Get Copilot headers with the correct agent flag for tool calling. */
export function getCopilotHeaders(token: string, isAgent: boolean): Record<string, string> {
    return PROVIDERS.copilot.headers(token, { isAgent });
}

/** Return modelId if it exists in the provider's fallback list, otherwise the provider's default. */
export function resolveModelForProvider(providerId: string, modelId: string): string {
    const provider = PROVIDERS[providerId];
    if (!provider) return modelId;
    const exists = provider.fallbackModels.some(m => m.id === modelId);
    return exists ? modelId : provider.defaultModel;
}

/** Check if a model ID is a thinking-capable OpenAI model (o-series). */
export function isThinkingCapableOpenAIModel(modelId: string): boolean {
    return /\bo[1-9]/.test(modelId);
}

/** Check if a model ID should skip the temperature parameter. */
export function shouldSkipTemperature(
    modelId: string,
    provider: string,
    thinkingEnabled: boolean,
    model?: ModelInfo,
): boolean {
    const lower = modelId.toLowerCase();
    const isImageGenModel = model?.supportsImageGen && !model?.supportsVision;
    const isImageName = /gpt-image/i.test(lower) || /dall-e/i.test(lower);
    const isThinkingReasoning = thinkingEnabled && (
        /\bo[1-9]/.test(lower) || (provider === 'copilot' && model?.supportsThinking)
    );
    return !!(isImageGenModel || isImageName || isThinkingReasoning);
}

// ── OpenAI model classification helpers ─────────────────────────────

/** Prefixes that identify valid OpenAI chat models. */
export const OPENAI_CHAT_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-'];

/** Substrings to exclude from OpenAI model lists (non-chat or media models). */
export const OPENAI_EXCLUDE = ['realtime', 'audio', 'transcribe', 'search', 'tts', 'dall-e', 'whisper', 'embedding', 'babbage', 'davinci', 'moderation', 'gpt-image', 'gpt-5-image'];

const OPENAI_VISION_PATTERNS = [
    /^gpt-5/i, /^gpt-4o/i, /^gpt-4\.1/i, /^gpt-4\.5/i,
    /^gpt-4-turbo/i, /^gpt-4-vision/i, /^chatgpt-4o/i,
    /^o1/i, /^o3/i, /^o4/i,
];

const OPENAI_IMAGE_GEN_PATTERNS = [/^gpt-image/i, /^gpt-5-image/i, /^dall-e/i];

export function isVisionCapableOpenAIModel(id: string): boolean {
    return OPENAI_VISION_PATTERNS.some(p => p.test(id));
}

export function isImageGenCapableOpenAIModel(id: string): boolean {
    return OPENAI_IMAGE_GEN_PATTERNS.some(p => p.test(id));
}

/** Most GPT-4+, ChatGPT, and o-series models support function calling / tools. */
const OPENAI_TOOL_PATTERNS = [/^gpt-4/i, /^gpt-5/i, /^chatgpt/i, /^o[1-9]/i, /^gpt-3\.5-turbo/i];
export function isToolCapableOpenAIModel(id: string): boolean {
    if (isImageGenCapableOpenAIModel(id)) return false;
    return OPENAI_TOOL_PATTERNS.some(p => p.test(id));
}

export function isThinkingCapableOpenRouterModel(model: { id?: string; name?: string; label?: string }): boolean {
    const id = (model.id || '').toLowerCase();
    const name = (model.name || model.label || '').toLowerCase();
    if (/\bopenai\/o[134]/i.test(id)) return true;
    if (/deepseek.*r1/i.test(id)) return true;
    if (/qwq/i.test(id)) return true;
    if (/thinking/i.test(id) || /thinking/i.test(name)) return true;
    if (/reasoni/i.test(id) || /reasoni/i.test(name)) return true;
    return false;
}

export function prettifyOpenAIModelId(id: string): string {
    return id
        .replace(/-\d{4}-\d{2}-\d{2}$/, '')
        .replace(/^gpt-/i, 'GPT-')
        .replace(/^o(\d)/i, 'O$1')
        .replace(/^chatgpt-/i, 'ChatGPT-');
}

export function openAIFamily(id: string): string {
    if (/^gpt-5/i.test(id)) return 'GPT-5';
    if (/^gpt-4\.1/i.test(id) || /^gpt-4\.5/i.test(id)) return 'GPT-4.1 / 4.5';
    if (/^gpt-4o/i.test(id)) return 'GPT-4o';
    if (/^gpt-4/i.test(id)) return 'GPT-4';
    if (/^gpt-3/i.test(id)) return 'GPT-3.5';
    if (/^o1/i.test(id)) return 'O1 Reasoning';
    if (/^o3/i.test(id)) return 'O3 Reasoning';
    if (/^o4/i.test(id)) return 'O4 Reasoning';
    if (/^chatgpt/i.test(id)) return 'ChatGPT';
    return 'Other';
}

// ── Model categorisation ────────────────────────────────────────────

export function copilotModelFamily(id: string): string {
    if (/^gpt-/i.test(id) || /^o[1-9]/i.test(id) || /^chatgpt/i.test(id)) return 'OpenAI';
    if (/^claude/i.test(id)) return 'Anthropic';
    if (/^gemini/i.test(id)) return 'Google';
    if (/^grok/i.test(id)) return 'xAI';
    if (/^oswe-/i.test(id) || /^raptor/i.test(id) || /^goldeneye/i.test(id)) return 'Fine-tuned';
    return 'Other';
}

/** Well-known special casings for provider slugs. */
const PROVIDER_CASING: Record<string, string> = {
    'openai': 'OpenAI', 'ai21': 'AI21 Labs', 'x-ai': 'xAI',
};

/** Convert a slug like 'meta-llama' or 'mistralai' into a readable label. */
export function prettifyProviderKey(key: string): string {
    if (PROVIDER_CASING[key]) return PROVIDER_CASING[key];
    return key
        .split(/[-_]/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export function categorizeModels(providerId: string, models: ModelInfo[]): Record<string, ModelInfo[]> {
    const groups: Record<string, ModelInfo[]> = {};

    for (const m of models) {
        let category: string;
        if (providerId === 'openrouter') {
            const slash = m.id.indexOf('/');
            const key = slash > 0 ? m.id.substring(0, slash) : 'other';
            category = prettifyProviderKey(key);
        } else if (providerId === 'copilot') {
            category = copilotModelFamily(m.id);
        } else {
            category = openAIFamily(m.id);
        }
        if (!groups[category]) groups[category] = [];
        groups[category].push(m);
    }

    const sorted: Record<string, ModelInfo[]> = {};
    for (const key of Object.keys(groups).sort()) {
        sorted[key] = groups[key];
    }
    return sorted;
}

// ── OpenRouter image generation helpers ─────────────────────────────

/**
 * Known OpenRouter model prefixes that output BOTH text and images.
 * These models use `modalities: ["image", "text"]`.
 * All other image-gen models are assumed image-only (`modalities: ["image"]`).
 */
const MULTIMODAL_IMAGE_PATTERNS = [
    /^google\/gemini/i,
    /^openai\/gpt/i,
    /^gpt-/i,
    /pixtral/i,
];

/**
 * Returns the correct `modalities` array for a given OpenRouter image model.
 * Multimodal models (Gemini, GPT) → ["image", "text"]
 * Image-only models (Flux, Riverflow, etc.) → ["image"]
 */
export function getImageModalities(modelId: string): string[] {
    if (MULTIMODAL_IMAGE_PATTERNS.some(p => p.test(modelId))) {
        return ['image', 'text'];
    }
    return ['image'];
}

/**
 * Well-known OpenRouter image generation models for settings presets.
 * NOTE: These models are NOT in OpenRouter's /api/v1/models (chat endpoint).
 * They are image-generation-only models discoverable at https://openrouter.ai/models.
 * Grouped by provider/family.
 */
export const OPENROUTER_IMAGE_GEN_MODELS: { id: string; label: string }[] = [
    // Multimodal models (text+image output)
    { id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image' },
    { id: 'google/gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image' },
    { id: 'google/gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image' },
    { id: 'openai/gpt-5-image', label: 'GPT-5 Image' },
    { id: 'openai/gpt-5-image-mini', label: 'GPT-5 Image Mini' },
    // Image-only models (need modalities: ["image"])
    { id: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 Pro' },
    { id: 'black-forest-labs/flux.2-max', label: 'FLUX.2 Max' },
    { id: 'black-forest-labs/flux.2-flex', label: 'FLUX.2 Flex' },
    { id: 'black-forest-labs/flux.2-klein-4b', label: 'FLUX.2 Klein 4B' },
    { id: 'sourceful/riverflow-v2-pro', label: 'Riverflow v2 Pro' },
    { id: 'sourceful/riverflow-v2-fast', label: 'Riverflow v2 Fast' },
    { id: 'sourceful/riverflow-v2-max-preview', label: 'Riverflow v2 Max' },
    { id: 'sourceful/riverflow-v2-fast-preview', label: 'Riverflow v2 Fast (Preview)' },
    { id: 'sourceful/riverflow-v2-standard-preview', label: 'Riverflow v2 Standard' },
];

/** OpenAI image generation models for settings presets. */
export const OPENAI_IMAGE_GEN_MODELS: { id: string; label: string }[] = [
    { id: 'dall-e-3', label: 'DALL·E 3' },
    { id: 'gpt-image-1', label: 'GPT Image 1' },
];

import type { ModelInfo } from './types';
import { PROVIDERS } from './constants';
import { requestUrl } from 'obsidian';
import { retryWithBackoff, sleep } from './utils';
import {
    isThinkingCapableOpenAIModel,
    isVisionCapableOpenAIModel,
    isImageGenCapableOpenAIModel,
    isToolCapableOpenAIModel,
    isThinkingCapableOpenRouterModel,
    prettifyOpenAIModelId,
    categorizeModels,
    parseCopilotModelsResponse,
    COPILOT_MODELS_URL,
    OPENAI_CHAT_PREFIXES,
    OPENAI_EXCLUDE,
} from '../lib/providers';

// Re-export pure helpers for consumers that import from src/providers
export {
    isThinkingCapableOpenAIModel,
    isVisionCapableOpenAIModel,
    isImageGenCapableOpenAIModel,
    isToolCapableOpenAIModel,
    isThinkingCapableOpenRouterModel,
    prettifyOpenAIModelId,
    openAIFamily,
    copilotModelFamily,
    prettifyProviderKey,
    categorizeModels,
    resolveModelForProvider,
    getImageModalities,
    shouldSkipTemperature,
    OPENROUTER_IMAGE_GEN_MODELS,
    OPENAI_IMAGE_GEN_MODELS,
} from '../lib/providers';

// ── Fetch models from provider API ──────────────────────────────────

export async function fetchProviderModels(providerId: string, apiKey: string): Promise<ModelInfo[]> {
    if (providerId === 'openrouter') {
        const res = await requestUrl({ url: 'https://openrouter.ai/api/v1/models' });
        if (res.status !== 200) throw new Error(`Failed to fetch models: ${res.status}`);
        const data = res.json;
        return data.data
            .filter((m: any) => m.id)
            .map((m: any) => ({
                id: m.id,
                label: m.name || m.id,
                context_length: m.context_length,
                pricing: m.pricing,
                supportsVision: !!(m.architecture?.modality?.includes('image') ||
                    m.architecture?.input_modalities?.includes('image')),
                supportsThinking: isThinkingCapableOpenRouterModel(m),
                supportsImageGen: !!(m.architecture?.output_modalities?.includes('image')),
                supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
            }))
            .sort((a: ModelInfo, b: ModelInfo) => a.label.localeCompare(b.label));
    }

    if (providerId === 'openai') {
        if (!apiKey) return PROVIDERS.openai.fallbackModels;
        const res = await requestUrl({
            url: 'https://api.openai.com/v1/models',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.status !== 200) throw new Error(`Failed to fetch OpenAI models: ${res.status}`);
        const data = res.json;
        return data.data
            .filter((m: any) => OPENAI_CHAT_PREFIXES.some(p => m.id.startsWith(p)))
            .filter((m: any) => !OPENAI_EXCLUDE.some(p => m.id.includes(p)))
            // Exclude date-versioned snapshots (e.g. gpt-4.1-2025-04-14) — the canonical
            // alias (gpt-4.1) always points to the latest and avoids duplicate names.
            .filter((m: any) => !/-\d{4}-\d{2}-\d{2}$/.test(m.id))
            .map((m: any) => ({
                id: m.id,
                label: prettifyOpenAIModelId(m.id),
                supportsVision: isVisionCapableOpenAIModel(m.id),
                supportsThinking: isThinkingCapableOpenAIModel(m.id),
                supportsImageGen: isImageGenCapableOpenAIModel(m.id),
                supportsTools: isToolCapableOpenAIModel(m.id),
            }))
            .sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id));
    }

    if (providerId === 'copilot') {
        if (!apiKey) return PROVIDERS.copilot.fallbackModels;
        const res = await requestUrl({
            url: COPILOT_MODELS_URL,
            headers: PROVIDERS.copilot.headers(apiKey),
        });
        if (res.status !== 200) throw new Error(`Failed to fetch Copilot models: ${res.status}`);
        const models = parseCopilotModelsResponse(res.json);
        return models.length > 0 ? models : PROVIDERS.copilot.fallbackModels;
    }

    return [];
}

// ── OpenRouter generation cost lookup ───────────────────────────────

export interface GenerationCostData {
    total_cost: number;
    tokens_prompt: number;
    tokens_completion: number;
    [key: string]: unknown;
}

export async function fetchGenerationCost(generationId: string, apiKey: string): Promise<GenerationCostData | null> {
    // Initial delay before first attempt — the generation data needs time to appear
    await sleep(3000);

    try {
        return await retryWithBackoff(
            async () => {
                const res = await requestUrl({
                    url: `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
                const data = res.json;
                if (data?.data?.total_cost == null) throw new Error('Cost not yet available');
                return data.data as GenerationCostData;
            },
            { maxRetries: 5, baseDelayMs: 3000, exponential: true },
        );
    } catch {
        return null;
    }
}

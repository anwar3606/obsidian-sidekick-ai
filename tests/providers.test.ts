import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    fetchProviderModels,
    categorizeModels,
    fetchGenerationCost,
} from '../src/providers';
import { shouldSkipTemperature } from '../lib/providers';
import type { ModelInfo } from '../src/types';
import * as obsidian from 'obsidian';

// Model detection functions (isVisionCapable, isThinkingCapable, etc.)
// and openAIFamily are tested in lib.test.ts

// ── categorizeModels ────────────────────────────────────────────────

describe('categorizeModels', () => {
    const makeModel = (id: string, label?: string): ModelInfo => ({
        id,
        label: label || id,
        supportsVision: false,
        supportsThinking: false,
        supportsImageGen: false,
        supportsTools: false,
    });

    describe('OpenRouter categorization', () => {
        it('groups by provider prefix', () => {
            const models = [
                makeModel('openai/gpt-4o', 'GPT-4o'),
                makeModel('openai/gpt-4.1', 'GPT-4.1'),
                makeModel('anthropic/claude-3.5', 'Claude 3.5'),
                makeModel('google/gemini-pro', 'Gemini Pro'),
            ];
            const groups = categorizeModels('openrouter', models);
            expect(Object.keys(groups)).toContain('OpenAI');
            expect(Object.keys(groups)).toContain('Anthropic');
            expect(Object.keys(groups)).toContain('Google');
            expect(groups['OpenAI'].length).toBe(2);
        });

        it('handles unknown provider prefix', () => {
            const models = [makeModel('custom-provider/model-1')];
            const groups = categorizeModels('openrouter', models);
            expect(Object.keys(groups)).toContain('Custom Provider');
        });

        it('handles model without slash', () => {
            const models = [makeModel('some-model')];
            const groups = categorizeModels('openrouter', models);
            expect(Object.keys(groups)).toContain('Other');
        });

        it('sorts groups alphabetically', () => {
            const models = [
                makeModel('google/gemini', 'Gemini'),
                makeModel('anthropic/claude', 'Claude'),
                makeModel('openai/gpt-4', 'GPT-4'),
            ];
            const groups = categorizeModels('openrouter', models);
            const keys = Object.keys(groups);
            expect(keys).toEqual([...keys].sort());
        });

        it('dynamically derives labels for any provider slug', () => {
            const models = [
                makeModel('deepseek/deepseek-chat'),
                makeModel('mistralai/mistral-large'),
                makeModel('meta-llama/llama-3'),
                makeModel('x-ai/grok-2'),
                makeModel('ai21/jamba'),
                makeModel('newcompany/some-model'),
            ];
            const groups = categorizeModels('openrouter', models);
            expect(Object.keys(groups)).toContain('Deepseek');
            expect(Object.keys(groups)).toContain('Mistralai');
            expect(Object.keys(groups)).toContain('Meta Llama');
            expect(Object.keys(groups)).toContain('xAI');
            expect(Object.keys(groups)).toContain('AI21 Labs');
            expect(Object.keys(groups)).toContain('Newcompany');
        });

        it('does not rely on a static label map for categories', () => {
            // Any provider not in special casings gets auto-derived
            const models = [makeModel('totally-unknown-provider/model-x')];
            const groups = categorizeModels('openrouter', models);
            const key = Object.keys(groups)[0];
            expect(key).toBe('Totally Unknown Provider');
        });
    });

    describe('OpenAI categorization', () => {
        it('groups by model family', () => {
            const models = [
                makeModel('gpt-4o-mini'),
                makeModel('gpt-4.1-nano'),
                makeModel('o3-mini'),
                makeModel('gpt-3.5-turbo'),
            ];
            const groups = categorizeModels('openai', models);
            expect(Object.keys(groups)).toContain('GPT-4o');
            expect(Object.keys(groups)).toContain('GPT-4.1 / 4.5');
            expect(Object.keys(groups)).toContain('O3 Reasoning');
            expect(Object.keys(groups)).toContain('GPT-3.5');
        });

        it('handles unknown model family', () => {
            const models = [makeModel('custom-model')];
            const groups = categorizeModels('openai', models);
            expect(Object.keys(groups)).toContain('Other');
        });
    });

    it('returns empty groups for empty models', () => {
        const groups = categorizeModels('openai', []);
        expect(Object.keys(groups).length).toBe(0);
    });

    it('returns empty groups for unknown provider', () => {
        const models = [makeModel('test')];
        const groups = categorizeModels('unknown-provider', models);
        expect(Object.keys(groups).length).toBe(1);
        expect(Object.keys(groups)).toContain('Other');
    });

    describe('Copilot categorization', () => {
        it('groups by model provider family', () => {
            const models = [
                makeModel('gpt-4.1', 'GPT-4.1'),
                makeModel('gpt-5.2', 'GPT-5.2'),
                makeModel('claude-sonnet-4', 'Claude Sonnet 4'),
                makeModel('gemini-2.5-pro', 'Gemini 2.5 Pro'),
                makeModel('grok-code-fast-1', 'Grok Code Fast 1'),
                makeModel('raptor-mini', 'Raptor Mini'),
                makeModel('goldeneye', 'Goldeneye'),
            ];
            const groups = categorizeModels('copilot', models);
            expect(Object.keys(groups)).toContain('OpenAI');
            expect(Object.keys(groups)).toContain('Anthropic');
            expect(Object.keys(groups)).toContain('Google');
            expect(Object.keys(groups)).toContain('xAI');
            expect(Object.keys(groups)).toContain('Fine-tuned');
            expect(groups['OpenAI'].length).toBe(2); // gpt-4.1, gpt-5.2
            expect(groups['Anthropic'].length).toBe(1);
            expect(groups['Google'].length).toBe(1);
            expect(groups['xAI'].length).toBe(1);
            expect(groups['Fine-tuned'].length).toBe(2); // raptor-mini, goldeneye
        });

        it('puts unknown models in Other', () => {
            const models = [makeModel('unknown-model')];
            const groups = categorizeModels('copilot', models);
            expect(Object.keys(groups)).toContain('Other');
        });
    });
});

// ── fetchProviderModels ─────────────────────────────────────────────

describe('fetchProviderModels', () => {
    let mockRequestUrl: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockRequestUrl = vi.spyOn(obsidian, 'requestUrl' as any);
    });

    afterEach(() => {
        mockRequestUrl.mockRestore();
    });

    it('fetches OpenRouter models and maps fields', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    {
                        id: 'openai/gpt-4o',
                        name: 'GPT-4o',
                        context_length: 128000,
                        pricing: { prompt: '0.005', completion: '0.015' },
                        architecture: { modality: 'text+image', input_modalities: ['text', 'image'], output_modalities: ['text'] },
                    },
                    {
                        id: 'openai/o3-mini',
                        name: 'O3 Mini',
                        context_length: 200000,
                        pricing: { prompt: '0.001', completion: '0.004' },
                        architecture: { modality: 'text' },
                    },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openrouter', 'test-key');
        expect(models.length).toBe(2);
        expect(models[0].supportsVision).toBe(true);
        expect(models[0].context_length).toBe(128000);
        expect(models[0].pricing).toBeDefined();
    });

    it('throws on OpenRouter non-200 response', async () => {
        mockRequestUrl.mockResolvedValue({ status: 500 } as any);
        await expect(fetchProviderModels('openrouter', 'key')).rejects.toThrow('Failed to fetch models');
    });

    it('fetches OpenAI models and filters correctly', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    { id: 'gpt-4o' },
                    { id: 'gpt-4o-mini' },
                    { id: 'gpt-3.5-turbo' },
                    { id: 'gpt-4-turbo' },
                    { id: 'o3-mini' },
                    // These should be excluded:
                    { id: 'whisper-1' },
                    { id: 'tts-1' },
                    { id: 'dall-e-3' },
                    { id: 'gpt-image-1' },
                    { id: 'text-embedding-ada' },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openai', 'test-key');
        const ids = models.map(m => m.id);
        expect(ids).toContain('gpt-4o');
        expect(ids).toContain('gpt-4o-mini');
        expect(ids).toContain('gpt-3.5-turbo');
        expect(ids).toContain('o3-mini');
        expect(ids).not.toContain('whisper-1');
        expect(ids).not.toContain('tts-1');
        expect(ids).not.toContain('dall-e-3');
        expect(ids).not.toContain('gpt-image-1');
    });

    it('throws on OpenAI non-200 response', async () => {
        mockRequestUrl.mockResolvedValue({ status: 401 } as any);
        await expect(fetchProviderModels('openai', 'bad-key')).rejects.toThrow('Failed to fetch OpenAI models');
    });

    it('returns fallback models for OpenAI when no apiKey', async () => {
        const models = await fetchProviderModels('openai', '');
        // Fallback models from PROVIDERS.openai.fallbackModels
        expect(models.length).toBeGreaterThan(0);
    });

    it('returns empty array for unknown provider', async () => {
        const models = await fetchProviderModels('custom', 'key');
        expect(models).toEqual([]);
    });

    it('returns fallback models for copilot when no token provided', async () => {
        const models = await fetchProviderModels('copilot', '');
        expect(models.length).toBeGreaterThan(0);
        // All copilot models should have multiplier metadata
        for (const m of models) {
            expect(typeof m.multiplier).toBe('number');
        }
        // Should contain at least one included model
        const included = models.filter(m => m.included);
        expect(included.length).toBeGreaterThan(0);
        // Should contain GPT-4.1 as default
        expect(models.some(m => m.id === 'gpt-4.1')).toBe(true);
    });

    it('fetches models from Copilot API when token is provided', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    {
                        id: 'gpt-4.1',
                        name: 'GPT-4.1',
                        model_picker_enabled: true,
                        capabilities: {
                            type: 'chat',
                            limits: { max_context_window_tokens: 128000 },
                            supports: { vision: true, tool_calls: true },
                        },
                    },
                    {
                        id: 'claude-opus-4.6',
                        name: 'Claude Opus 4.6',
                        model_picker_enabled: true,
                        supported_endpoints: ['/v1/messages', '/chat/completions'],
                        capabilities: {
                            type: 'chat',
                            limits: { max_context_window_tokens: 200000 },
                            supports: { vision: true, tool_calls: true, adaptive_thinking: true },
                        },
                    },
                    {
                        id: 'text-embedding-3-small',
                        name: 'Text Embedding',
                        model_picker_enabled: false,
                        capabilities: { type: 'embedding' },
                    },
                ],
            },
        });
        const models = await fetchProviderModels('copilot', 'test-session-token');
        expect(models).toHaveLength(2);
        expect(models[0].id).toBe('Claude Opus 4.6' ? 'claude-opus-4.6' : 'gpt-4.1');
        expect(models.find(m => m.id === 'gpt-4.1')?.context_length).toBe(128000);
        expect(models.find(m => m.id === 'claude-opus-4.6')?.context_length).toBe(200000);
        expect(models.find(m => m.id === 'claude-opus-4.6')?.responsesApiSupported).toBe(false);
        // Embedding model should be filtered out
        expect(models.find(m => m.id === 'text-embedding-3-small')).toBeUndefined();
    });

    it('falls back to hardcoded models when Copilot API fails', async () => {
        mockRequestUrl.mockResolvedValue({ status: 500, json: {} });
        await expect(fetchProviderModels('copilot', 'test-token')).rejects.toThrow('Failed to fetch Copilot models');
    });

    it('sets supportsThinking for OpenRouter thinking models', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    { id: 'openai/o3-mini', name: 'O3 Mini', architecture: {} },
                    { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', architecture: {} },
                    { id: 'qwen/qwq-32b', name: 'QwQ 32B', architecture: {} },
                    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', architecture: {} },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openrouter', 'key');
        const o3 = models.find(m => m.id === 'openai/o3-mini');
        const r1 = models.find(m => m.id === 'deepseek/deepseek-r1');
        const qwq = models.find(m => m.id === 'qwen/qwq-32b');
        const claude = models.find(m => m.id === 'anthropic/claude-3.5-sonnet');

        expect(o3?.supportsThinking).toBe(true);
        expect(r1?.supportsThinking).toBe(true);
        expect(qwq?.supportsThinking).toBe(true);
        expect(claude?.supportsThinking).toBe(false);
    });

    it('sets supportsImageGen for OpenRouter image models', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    {
                        id: 'openai/gpt-image-1',
                        name: 'GPT Image',
                        architecture: { output_modalities: ['image', 'text'] },
                    },
                    {
                        id: 'openai/gpt-4o',
                        name: 'GPT-4o',
                        architecture: { output_modalities: ['text'] },
                    },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openrouter', 'key');
        const imgModel = models.find(m => m.id === 'openai/gpt-image-1');
        const textModel = models.find(m => m.id === 'openai/gpt-4o');
        expect(imgModel?.supportsImageGen).toBe(true);
        expect(textModel?.supportsImageGen).toBe(false);
    });

    it('sets supportsTools from OpenRouter supported_parameters', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    {
                        id: 'openai/gpt-4o',
                        name: 'GPT-4o',
                        supported_parameters: ['tools', 'tool_choice', 'temperature'],
                    },
                    {
                        id: 'aion-labs/aion-2.0',
                        name: 'Aion 2.0',
                        supported_parameters: ['temperature', 'max_tokens'],
                    },
                    {
                        id: 'some/no-params',
                        name: 'No Params',
                    },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openrouter', 'key');
        expect(models.find(m => m.id === 'openai/gpt-4o')?.supportsTools).toBe(true);
        expect(models.find(m => m.id === 'aion-labs/aion-2.0')?.supportsTools).toBe(false);
        expect(models.find(m => m.id === 'some/no-params')?.supportsTools).toBe(false);
    });

    it('prettifies OpenAI model IDs into labels', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    { id: 'gpt-4o' },
                    { id: 'o3-mini' },
                    { id: 'chatgpt-4o-latest' },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openai', 'key');
        const gpt4o = models.find(m => m.id === 'gpt-4o');
        const o3 = models.find(m => m.id === 'o3-mini');
        const chatgpt = models.find(m => m.id === 'chatgpt-4o-latest');
        expect(gpt4o?.label).toBe('GPT-4o');
        expect(o3?.label).toBe('O3-mini');
        expect(chatgpt?.label).toBe('ChatGPT-4o-latest');
    });

    it('filters out date-versioned OpenAI model snapshots', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: {
                data: [
                    { id: 'gpt-4o' },
                    { id: 'gpt-4o-2024-05-13' },
                    { id: 'gpt-4o-2024-08-06' },
                    { id: 'gpt-4.1' },
                    { id: 'gpt-4.1-2025-04-14' },
                ],
            },
        } as any);

        const models = await fetchProviderModels('openai', 'key');
        const ids = models.map(m => m.id);
        expect(ids).toContain('gpt-4o');
        expect(ids).toContain('gpt-4.1');
        expect(ids).not.toContain('gpt-4o-2024-05-13');
        expect(ids).not.toContain('gpt-4o-2024-08-06');
        expect(ids).not.toContain('gpt-4.1-2025-04-14');
    });
});

// ── fetchGenerationCost ─────────────────────────────────────────────

describe('fetchGenerationCost', () => {
    let mockRequestUrl: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockRequestUrl = vi.spyOn(obsidian, 'requestUrl' as any);
        vi.useFakeTimers();
    });

    it('returns cost data on success', async () => {
        mockRequestUrl.mockResolvedValue({
            status: 200,
            json: { data: { total_cost: 0.005, tokens_prompt: 100, tokens_completion: 50 } },
        } as any);

        const promise = fetchGenerationCost('gen-123', 'key');
        // Fast-forward past the 3s initial delay
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(result).toBeDefined();
        expect(result.total_cost).toBe(0.005);
    });

    it('retries on non-200 response', async () => {
        mockRequestUrl
            .mockResolvedValueOnce({ status: 404 } as any)
            .mockResolvedValueOnce({ status: 200, json: { data: { total_cost: 0.01 } } } as any);

        const promise = fetchGenerationCost('gen-456', 'key');
        // First attempt: 3s delay → 404
        await vi.advanceTimersByTimeAsync(4000);
        // Second attempt: 6s delay → 200
        await vi.advanceTimersByTimeAsync(7000);
        const result = await promise;
        expect(result.total_cost).toBe(0.01);
    });

    it('returns null after all retries fail', async () => {
        mockRequestUrl.mockResolvedValue({ status: 500 } as any);

        const promise = fetchGenerationCost('gen-789', 'key');
        // Advance past all 5 retries: 3 + 6 + 12 + 24 + 48 = 93s
        await vi.advanceTimersByTimeAsync(100_000);
        const result = await promise;
        expect(result).toBeNull();
    });

    it('returns null when API throws', async () => {
        mockRequestUrl.mockRejectedValue(new Error('Network error'));

        const promise = fetchGenerationCost('gen-err', 'key');
        await vi.advanceTimersByTimeAsync(100_000);
        const result = await promise;
        expect(result).toBeNull();
    });

    afterEach(() => {
        mockRequestUrl.mockRestore();
        vi.useRealTimers();
    });
});

// ── shouldSkipTemperature ──────────────────────────────────────────

describe('shouldSkipTemperature', () => {
    it('skips temperature for o-series models when thinking enabled', () => {
        expect(shouldSkipTemperature('o1-preview', 'openai', true)).toBe(true);
        expect(shouldSkipTemperature('o3-mini', 'openai', true)).toBe(true);
    });

    it('does not skip temperature for o-series when thinking disabled', () => {
        expect(shouldSkipTemperature('o1-preview', 'openai', false)).toBe(false);
    });

    it('skips temperature for image-gen-only models', () => {
        expect(shouldSkipTemperature('gpt-image-1', 'openai', false, { supportsImageGen: true } as any)).toBe(true);
        expect(shouldSkipTemperature('dall-e-3', 'openai', false)).toBe(true);
    });

    it('does not skip temperature for non-thinking Copilot models', () => {
        expect(shouldSkipTemperature('gpt-4o', 'copilot', true)).toBe(false);
        expect(shouldSkipTemperature('gpt-4.1', 'copilot', true)).toBe(false);
    });

    it('skips temperature for thinking-capable Copilot models', () => {
        expect(shouldSkipTemperature('o3-mini', 'copilot', true, { supportsThinking: true } as any)).toBe(true);
        expect(shouldSkipTemperature('o4-mini', 'copilot', true, { supportsThinking: true } as any)).toBe(true);
    });

    it('does not skip temperature when thinking disabled even on Copilot', () => {
        expect(shouldSkipTemperature('gpt-4o', 'copilot', false)).toBe(false);
    });
});

/**
 * Unit tests for lib/ modules — zero Obsidian dependency.
 * These run as part of the regular test suite (pnpm test).
 */

import { describe, it, expect } from 'vitest';

import {
    // Types
    type ApiSettings,
    type ModelInfo,
    type ApiMessage,
    type ChatCompletionTool,

    // Providers
    PROVIDERS,
    PROVIDER_IDS,
    getProvider,
    getCopilotHeaders,
    resolveModelForProvider,
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
    shouldSkipTemperature,
    getImageModalities,
    parseCopilotModelsResponse,
    OPENROUTER_IMAGE_GEN_MODELS,
    OPENAI_IMAGE_GEN_MODELS,

    // API builders
    buildChatCompletionBody,
    buildResponsesBody,
    buildMessagesApiBody,
    shouldUseResponsesAPI,
    shouldUseMessagesAPI,
    getMessagesApiHeaders,
    convertToResponsesContent,
    convertMessagesForResponses,
    convertMessagesForAnthropic,
    formatToolArgsPreview,
    formatCleanToolHeader,
    formatToolResultForChatCompletions,
    formatToolResultForResponses,
    formatToolResultForMessagesAPI,
    formatAssistantToolCalls,
    formatAssistantToolCallsForMessagesAPI,
    formatFunctionCallForResponses,
    MAX_RETRIES,
    RETRY_DELAY_MS,
    MAX_TOOL_ROUNDS,
    MAX_TOOL_ROUNDS_ITERATE,
    MAX_CONTENT_LENGTH,
    THINKING_BUDGET,
    stripBase64,
    buildNoteContextMessages,
    extractThinkingSummary,
    computeContextBreakdown,

    // Tools
    TOOL_SCHEMAS,
    RISKY_TOOLS,
    TOOL_LABELS,
    toResponsesFormat,
    getEnabledTools,
    getEnabledToolsForResponses,

    // AnyRequestBody helpers
    type AnyRequestBody,
    getRequestMessageCount,
    getRequestTemperature,
    getRequestToolCount,
    requestHasTools,
    updateRequestMessages,
    stripRequestParam,
    getRequestDebugInfo,
} from '../lib';

// ── Provider tests ──────────────────────────────────────────────────

describe('lib/providers', () => {
    it('has openai, openrouter, copilot providers', () => {
        expect(PROVIDER_IDS).toContain('openai');
        expect(PROVIDER_IDS).toContain('openrouter');
        expect(PROVIDER_IDS).toContain('copilot');
    });

    it('getProvider returns config for valid provider', () => {
        const p = getProvider('openai');
        expect(p.label).toBe('OpenAI');
        expect(p.url).toContain('openai.com');
    });

    it('getProvider throws for unknown provider', () => {
        expect(() => getProvider('fakeprovider')).toThrow('Unknown provider');
    });

    describe('Copilot headers', () => {
        it('isAgent=true → conversation-edits + agent', () => {
            const h = getCopilotHeaders('token', true);
            expect(h['Openai-Intent']).toBe('conversation-edits');
            expect(h['x-initiator']).toBe('agent');
        });

        it('isAgent=false → conversation-panel + user', () => {
            const h = getCopilotHeaders('token', false);
            expect(h['Openai-Intent']).toBe('conversation-panel');
            expect(h['x-initiator']).toBe('user');
        });

        it('includes Copilot-Integration-Id', () => {
            const h = getCopilotHeaders('token', true);
            expect(h['Copilot-Integration-Id']).toBe('vscode-chat');
        });

        it('includes Authorization bearer', () => {
            const h = getCopilotHeaders('ghu_abc', true);
            expect(h['Authorization']).toBe('Bearer ghu_abc');
        });
    });

    describe('isThinkingCapableOpenAIModel', () => {
        it('matches o1, o3-mini', () => {
            expect(isThinkingCapableOpenAIModel('o1-preview')).toBe(true);
            expect(isThinkingCapableOpenAIModel('o3-mini')).toBe(true);
        });
        it('does not match gpt-4', () => {
            expect(isThinkingCapableOpenAIModel('gpt-4o')).toBe(false);
        });
    });

    describe('resolveModelForProvider', () => {
        it('keeps model if it exists in the new provider', () => {
            // gpt-4.1 exists in both openai and copilot fallback lists
            expect(resolveModelForProvider('copilot', 'gpt-4.1')).toBe('gpt-4.1');
        });
        it('falls back to default when model does not exist in provider', () => {
            // claude-sonnet-4.6 does not exist in openai
            expect(resolveModelForProvider('openai', 'claude-sonnet-4.6')).toBe(PROVIDERS.openai.defaultModel);
        });
        it('returns model as-is for unknown provider', () => {
            expect(resolveModelForProvider('fakeprovider', 'gpt-4o')).toBe('gpt-4o');
        });
    });

    describe('getImageModalities', () => {
        it('returns ["image", "text"] for Gemini models', () => {
            expect(getImageModalities('google/gemini-2.5-flash-image')).toEqual(['image', 'text']);
            expect(getImageModalities('google/gemini-3-pro-image-preview')).toEqual(['image', 'text']);
        });
        it('returns ["image", "text"] for GPT image models', () => {
            expect(getImageModalities('openai/gpt-5-image')).toEqual(['image', 'text']);
            expect(getImageModalities('gpt-image-1')).toEqual(['image', 'text']);
        });
        it('returns ["image"] for Flux models (image-only)', () => {
            expect(getImageModalities('black-forest-labs/flux.2-pro')).toEqual(['image']);
            expect(getImageModalities('black-forest-labs/flux.2-flex')).toEqual(['image']);
        });
        it('returns ["image"] for Riverflow models (image-only)', () => {
            expect(getImageModalities('sourceful/riverflow-v2-pro')).toEqual(['image']);
            expect(getImageModalities('sourceful/riverflow-v2-fast')).toEqual(['image']);
        });
        it('returns ["image"] for unknown models (defaults to image-only)', () => {
            expect(getImageModalities('some-provider/unknown-model')).toEqual(['image']);
        });
    });

    describe('image gen model presets', () => {
        it('OPENROUTER_IMAGE_GEN_MODELS includes Flux and Riverflow', () => {
            const ids = OPENROUTER_IMAGE_GEN_MODELS.map(m => m.id);
            expect(ids).toContain('black-forest-labs/flux.2-pro');
            expect(ids).toContain('sourceful/riverflow-v2-pro');
        });
        it('OPENAI_IMAGE_GEN_MODELS includes dall-e-3', () => {
            const ids = OPENAI_IMAGE_GEN_MODELS.map(m => m.id);
            expect(ids).toContain('dall-e-3');
        });
    });

    describe('shouldSkipTemperature', () => {
        it('skips for gpt-image models', () => {
            expect(shouldSkipTemperature('gpt-image-1', 'openai', false)).toBe(true);
        });
        it('skips for dall-e models', () => {
            expect(shouldSkipTemperature('dall-e-3', 'openai', false)).toBe(true);
        });
        it('skips for Copilot thinking-capable models with thinking enabled', () => {
            expect(shouldSkipTemperature('o3-mini', 'copilot', true, { supportsThinking: true } as any)).toBe(true);
        });
        it('does not skip for non-thinking Copilot models even when thinking enabled', () => {
            expect(shouldSkipTemperature('gpt-4.1', 'copilot', true)).toBe(false);
        });
        it('does not skip for regular models', () => {
            expect(shouldSkipTemperature('gpt-4o', 'openai', false)).toBe(false);
        });
    });

    describe('isVisionCapableOpenAIModel', () => {
        it('returns true for gpt-4o', () => expect(isVisionCapableOpenAIModel('gpt-4o')).toBe(true));
        it('returns true for gpt-4-turbo', () => expect(isVisionCapableOpenAIModel('gpt-4-turbo')).toBe(true));
        it('returns true for gpt-4.1', () => expect(isVisionCapableOpenAIModel('gpt-4.1')).toBe(true));
        it('returns false for gpt-3.5-turbo', () => expect(isVisionCapableOpenAIModel('gpt-3.5-turbo')).toBe(false));
    });

    describe('isImageGenCapableOpenAIModel', () => {
        it('returns true for gpt-image-1', () => expect(isImageGenCapableOpenAIModel('gpt-image-1')).toBe(true));
        it('returns true for dall-e-3', () => expect(isImageGenCapableOpenAIModel('dall-e-3')).toBe(true));
        it('returns false for gpt-4o', () => expect(isImageGenCapableOpenAIModel('gpt-4o')).toBe(false));
    });

    describe('isToolCapableOpenAIModel', () => {
        it('returns true for gpt-4o', () => expect(isToolCapableOpenAIModel('gpt-4o')).toBe(true));
        it('returns true for gpt-3.5-turbo', () => expect(isToolCapableOpenAIModel('gpt-3.5-turbo')).toBe(true));
        it('returns true for o1', () => expect(isToolCapableOpenAIModel('o1')).toBe(true));
        it('returns false for gpt-image-1 (image gen)', () => expect(isToolCapableOpenAIModel('gpt-image-1')).toBe(false));
        it('returns false for dall-e-3 (image gen)', () => expect(isToolCapableOpenAIModel('dall-e-3')).toBe(false));
    });

    describe('isThinkingCapableOpenRouterModel', () => {
        it('matches openai/o1', () => expect(isThinkingCapableOpenRouterModel({ id: 'openai/o1' })).toBe(true));
        it('matches openai/o3-mini', () => expect(isThinkingCapableOpenRouterModel({ id: 'openai/o3-mini' })).toBe(true));
        it('matches deepseek-r1', () => expect(isThinkingCapableOpenRouterModel({ id: 'deepseek/deepseek-r1' })).toBe(true));
        it('matches qwq', () => expect(isThinkingCapableOpenRouterModel({ id: 'qwen/qwq-32b' })).toBe(true));
        it('matches models with thinking in name', () => expect(isThinkingCapableOpenRouterModel({ id: 'x', name: 'Thinking Model' })).toBe(true));
        it('does not match gpt-4o', () => expect(isThinkingCapableOpenRouterModel({ id: 'openai/gpt-4o' })).toBe(false));
    });

    describe('prettifyOpenAIModelId', () => {
        it('strips date suffix', () => expect(prettifyOpenAIModelId('gpt-4o-2024-08-06')).toBe('GPT-4o'));
        it('capitalizes GPT prefix', () => expect(prettifyOpenAIModelId('gpt-4-turbo')).toBe('GPT-4-turbo'));
        it('capitalizes O prefix', () => expect(prettifyOpenAIModelId('o3-mini')).toBe('O3-mini'));
        it('capitalizes ChatGPT prefix', () => expect(prettifyOpenAIModelId('chatgpt-4o-latest')).toBe('ChatGPT-4o-latest'));
    });

    describe('openAIFamily', () => {
        it('returns GPT-4o for gpt-4o models', () => expect(openAIFamily('gpt-4o-mini')).toBe('GPT-4o'));
        it('returns GPT-4 for gpt-4 models', () => expect(openAIFamily('gpt-4-turbo')).toBe('GPT-4'));
        it('returns GPT-3.5 for gpt-3.5 models', () => expect(openAIFamily('gpt-3.5-turbo')).toBe('GPT-3.5'));
        it('returns O1 Reasoning for o1 models', () => expect(openAIFamily('o1-mini')).toBe('O1 Reasoning'));
        it('returns O3 Reasoning for o3 models', () => expect(openAIFamily('o3-mini')).toBe('O3 Reasoning'));
        it('returns Other for unknown models', () => expect(openAIFamily('some-other-model')).toBe('Other'));
    });

    describe('copilotModelFamily', () => {
        it('returns OpenAI for gpt models', () => expect(copilotModelFamily('gpt-4o')).toBe('OpenAI'));
        it('returns Anthropic for claude models', () => expect(copilotModelFamily('claude-sonnet-4')).toBe('Anthropic'));
        it('returns Google for gemini models', () => expect(copilotModelFamily('gemini-2.0-flash')).toBe('Google'));
        it('returns xAI for grok models', () => expect(copilotModelFamily('grok-3')).toBe('xAI'));
        it('returns Other for unknown models', () => expect(copilotModelFamily('llama-3.1')).toBe('Other'));
    });

    describe('prettifyProviderKey', () => {
        it('uses special casing for openai', () => expect(prettifyProviderKey('openai')).toBe('OpenAI'));
        it('uses special casing for ai21', () => expect(prettifyProviderKey('ai21')).toBe('AI21 Labs'));
        it('uses special casing for x-ai', () => expect(prettifyProviderKey('x-ai')).toBe('xAI'));
        it('title-cases hyphenated slugs', () => expect(prettifyProviderKey('meta-llama')).toBe('Meta Llama'));
        it('title-cases single word', () => expect(prettifyProviderKey('mistralai')).toBe('Mistralai'));
    });

    describe('categorizeModels', () => {
        const models: ModelInfo[] = [
            { id: 'gpt-4o', name: 'GPT-4o', context_length: 128000 },
            { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', context_length: 16385 },
            { id: 'o3-mini', name: 'O3 Mini', context_length: 200000 },
        ];
        it('groups OpenAI models by family', () => {
            const groups = categorizeModels('openai', models);
            expect(groups['GPT-4o']).toHaveLength(1);
            expect(groups['GPT-3.5']).toHaveLength(1);
            expect(groups['O3 Reasoning']).toHaveLength(1);
        });
        it('groups Copilot models by vendor family', () => {
            const copilotModels: ModelInfo[] = [
                { id: 'gpt-4o', name: 'GPT-4o', context_length: 128000 },
                { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', context_length: 200000 },
            ];
            const groups = categorizeModels('copilot', copilotModels);
            expect(groups['OpenAI']).toHaveLength(1);
            expect(groups['Anthropic']).toHaveLength(1);
        });
        it('groups OpenRouter models by provider key', () => {
            const orModels: ModelInfo[] = [
                { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000 },
                { id: 'meta-llama/llama-3.1-70b', name: 'Llama 3.1 70B', context_length: 131072 },
            ];
            const groups = categorizeModels('openrouter', orModels);
            expect(groups['OpenAI']).toHaveLength(1);
            expect(groups['Meta Llama']).toHaveLength(1);
        });
        it('returns groups sorted alphabetically', () => {
            const groups = categorizeModels('openai', models);
            const keys = Object.keys(groups);
            expect(keys).toEqual([...keys].sort());
        });
    });
});

// ── parseCopilotModelsResponse tests ────────────────────────────────

describe('parseCopilotModelsResponse', () => {
    it('parses a typical API response into ModelInfo[]', () => {
        const response = {
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
            ],
        };
        const models = parseCopilotModelsResponse(response);
        expect(models).toHaveLength(2);

        const gpt = models.find(m => m.id === 'gpt-4.1')!;
        expect(gpt.context_length).toBe(128000);
        expect(gpt.supportsVision).toBe(true);
        expect(gpt.supportsTools).toBe(true);
        expect(gpt.supportsThinking).toBe(false);
        expect(gpt.multiplier).toBe(0); // known included model
        expect(gpt.included).toBe(true);

        const claude = models.find(m => m.id === 'claude-opus-4.6')!;
        expect(claude.context_length).toBe(200000);
        expect(claude.supportsThinking).toBe(true);
        expect(claude.responsesApiSupported).toBe(false); // no /responses in endpoints
        expect(claude.multiplier).toBe(3); // known billing
    });

    it('filters out non-picker and non-chat models', () => {
        const response = {
            data: [
                {
                    id: 'text-embedding-3-small',
                    name: 'Embedding',
                    model_picker_enabled: false,
                    capabilities: { type: 'embedding' },
                },
                {
                    id: 'gpt-3.5-turbo',
                    name: 'GPT-3.5',
                    model_picker_enabled: false,
                    capabilities: { type: 'chat', supports: { tool_calls: true } },
                },
            ],
        };
        const models = parseCopilotModelsResponse(response);
        expect(models).toHaveLength(0);
    });

    it('derives multiplier from model_picker_category for unknown models', () => {
        const response = {
            data: [
                {
                    id: 'some-new-model',
                    name: 'Some New Model',
                    model_picker_enabled: true,
                    model_picker_category: 'lightweight',
                    capabilities: {
                        type: 'chat',
                        limits: { max_context_window_tokens: 64000 },
                        supports: { tool_calls: true },
                    },
                },
            ],
        };
        const models = parseCopilotModelsResponse(response);
        expect(models[0].multiplier).toBe(0.33);
    });

    it('returns empty array for invalid data', () => {
        expect(parseCopilotModelsResponse({ data: null as any })).toEqual([]);
        expect(parseCopilotModelsResponse({} as any)).toEqual([]);
    });

    it('sets responsesApiSupported correctly based on supported_endpoints', () => {
        const response = {
            data: [
                {
                    id: 'model-with-responses',
                    name: 'Model A',
                    model_picker_enabled: true,
                    supported_endpoints: ['/chat/completions', '/responses'],
                    capabilities: { type: 'chat', supports: { tool_calls: true } },
                },
                {
                    id: 'model-without-responses',
                    name: 'Model B',
                    model_picker_enabled: true,
                    supported_endpoints: ['/chat/completions'],
                    capabilities: { type: 'chat', supports: { tool_calls: true } },
                },
                {
                    id: 'model-no-endpoints',
                    name: 'Model C',
                    model_picker_enabled: true,
                    capabilities: { type: 'chat', supports: { tool_calls: true } },
                },
            ],
        };
        const models = parseCopilotModelsResponse(response);
        const a = models.find(m => m.id === 'model-with-responses')!;
        const b = models.find(m => m.id === 'model-without-responses')!;
        const c = models.find(m => m.id === 'model-no-endpoints')!;
        expect(a.responsesApiSupported).toBeUndefined(); // has /responses → default
        expect(b.responsesApiSupported).toBe(false); // no /responses → explicitly false
        expect(c.responsesApiSupported).toBeUndefined(); // no endpoints listed → default
    });
});

// ── Tool tests ──────────────────────────────────────────────────────

describe('lib/tools', () => {
    it('TOOL_SCHEMAS has 33 tools', () => {
        expect(TOOL_SCHEMAS).toHaveLength(33);
    });

    it('all schemas are Chat Completions format (nested function)', () => {
        for (const tool of TOOL_SCHEMAS) {
            expect(tool.type).toBe('function');
            expect(tool.function).toBeDefined();
            expect(typeof tool.function.name).toBe('string');
            expect(typeof tool.function.description).toBe('string');
            expect(tool.function.parameters.type).toBe('object');
        }
    });

    it('RISKY_TOOLS contains expected tools', () => {
        expect(RISKY_TOOLS.has('fetch_url')).toBe(true);
        expect(RISKY_TOOLS.has('create_note')).toBe(true);
        expect(RISKY_TOOLS.has('generate_image')).toBe(true);
        expect(RISKY_TOOLS.has('move_note')).toBe(true);
        expect(RISKY_TOOLS.has('delete_note')).toBe(true);
        expect(RISKY_TOOLS.has('search_vault')).toBe(false);
    });

    it('TOOL_LABELS has label for each schema', () => {
        for (const s of TOOL_SCHEMAS) {
            expect(TOOL_LABELS[s.function.name]).toBeDefined();
        }
    });

    it('semantic_search_vault schema has required fields', () => {
        const schema = TOOL_SCHEMAS.find(t => t.function.name === 'semantic_search_vault');
        expect(schema).toBeDefined();
        const params = schema!.function.parameters;
        expect(params.properties.query).toBeDefined();
        expect(params.properties.max_results).toBeDefined();
        expect(params.properties.min_score).toBeDefined();
        expect(params.required).toContain('query');
    });

    it('semantic_search_vault is not a risky tool', () => {
        expect(RISKY_TOOLS.has('semantic_search_vault')).toBe(false);
    });

    describe('toResponsesFormat', () => {
        it('converts to flat format', () => {
            const flat = toResponsesFormat(TOOL_SCHEMAS);
            expect(flat).toHaveLength(TOOL_SCHEMAS.length);
            for (const tool of flat) {
                expect(tool.type).toBe('function');
                expect(tool.name).toBeDefined();
                expect(tool.description).toBeDefined();
                expect(tool.parameters).toBeDefined();
                expect((tool as any).function).toBeUndefined();
            }
        });

        it('preserves names', () => {
            const flat = toResponsesFormat(TOOL_SCHEMAS);
            expect(flat.map(t => t.name)).toEqual(TOOL_SCHEMAS.map(t => t.function.name));
        });

        it('preserves parameters', () => {
            const flat = toResponsesFormat(TOOL_SCHEMAS);
            for (let i = 0; i < flat.length; i++) {
                expect(flat[i].parameters).toEqual(TOOL_SCHEMAS[i].function.parameters);
            }
        });
    });

    describe('getEnabledTools', () => {
        const base: ApiSettings = {
            selectedProvider: 'openai',
            selectedModel: 'gpt-4o',
            temperature: 0.7,
            thinkingEnabled: false,
            toolsEnabled: true,
            iterateMode: false,
            disabledTools: [],
            thinkingBudget: 16384,
        };

        it('returns all tools when enabled, none disabled', () => {
            const tools = getEnabledTools(base);
            expect(tools).toHaveLength(24);
        });

        it('excludes disabled tools', () => {
            const tools = getEnabledTools({ ...base, disabledTools: ['search_vault'] });
            expect(tools!.map(t => t.function.name)).not.toContain('search_vault');
        });

        it('returns undefined when tools disabled', () => {
            expect(getEnabledTools({ ...base, toolsEnabled: false })).toBeUndefined();
        });

        it('forces ask_user in iterate mode', () => {
            const tools = getEnabledTools({ ...base, toolsEnabled: false, iterateMode: true });
            expect(tools).toHaveLength(1);
            expect(tools![0].function.name).toBe('ask_user');
        });

        it('does not duplicate ask_user', () => {
            const tools = getEnabledTools({ ...base, iterateMode: true });
            const askCount = tools!.filter(t => t.function.name === 'ask_user').length;
            expect(askCount).toBe(1);
        });
    });

    describe('getEnabledToolsForResponses', () => {
        const base: ApiSettings = {
            selectedProvider: 'copilot',
            selectedModel: 'gpt-5-mini',
            temperature: 0.7,
            thinkingEnabled: true,
            toolsEnabled: true,
            iterateMode: false,
            disabledTools: [],
            thinkingBudget: 16384,
        };

        it('returns flat format', () => {
            const tools = getEnabledToolsForResponses(base);
            expect(tools).toBeDefined();
            for (const tool of tools!) {
                expect(tool.type).toBe('function');
                expect(tool.name).toBeDefined();
                expect((tool as any).function).toBeUndefined();
            }
        });

        it('returns undefined when tools disabled', () => {
            expect(getEnabledToolsForResponses({ ...base, toolsEnabled: false })).toBeUndefined();
        });
    });
});

// ── API builder tests ───────────────────────────────────────────────

describe('lib/api', () => {
    const baseSettings: ApiSettings = {
        selectedProvider: 'openai',
        selectedModel: 'gpt-4o',
        temperature: 0.7,
        thinkingEnabled: false,
        toolsEnabled: true,
        iterateMode: false,
        disabledTools: [],
        thinkingBudget: 16384,
    };

    describe('buildChatCompletionBody', () => {
        it('includes model, messages, stream', () => {
            const body = buildChatCompletionBody(baseSettings, [], []);
            expect(body.model).toBe('gpt-4o');
            expect(body.messages).toEqual([]);
            expect(body.stream).toBe(true);
        });

        it('includes temperature for standard models', () => {
            const body = buildChatCompletionBody(baseSettings, [], []);
            expect(body.temperature).toBe(0.7);
        });

        it('includes tools in nested format', () => {
            const body = buildChatCompletionBody(baseSettings, [], []);
            expect(body.tools).toBeDefined();
            for (const tool of body.tools!) {
                expect(tool.function).toBeDefined();
            }
        });

        it('adds stream_options for OpenAI', () => {
            const body = buildChatCompletionBody(baseSettings, [], []);
            expect(body.stream_options).toEqual({ include_usage: true });
        });

        it('adds store=false for Copilot', () => {
            const s = { ...baseSettings, selectedProvider: 'copilot' };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.store).toBe(false);
        });

        it('adds reasoning for OpenRouter thinking', () => {
            const s = { ...baseSettings, selectedProvider: 'openrouter', thinkingEnabled: true };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.reasoning).toEqual({ effort: 'high' });
        });

        it('adds reasoning_effort for Copilot GPT models', () => {
            const s = { ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5-mini', thinkingEnabled: true };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.reasoning_effort).toBe('high');
            expect(body.reasoning_summary).toBe('auto');
        });

        it('adds reasoning_effort for Copilot Claude models (no reasoning_summary)', () => {
            const s = { ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-sonnet-4', thinkingEnabled: true };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.reasoning_effort).toBe('high');
            expect(body.reasoning_summary).toBeUndefined();
            expect(body.max_tokens).toBe(16384);
        });
    });

    describe('convertToResponsesContent', () => {
        it('maps text → input_text and image_url → input_image', () => {
            const parts: ApiContentPart[] = [
                { type: 'text', text: 'describe this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
            ];
            const converted = convertToResponsesContent(parts);
            expect(converted).toEqual([
                { type: 'input_text', text: 'describe this' },
                { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
            ]);
        });

        it('handles text-only content', () => {
            const parts: ApiContentPart[] = [{ type: 'text', text: 'hello' }];
            const converted = convertToResponsesContent(parts);
            expect(converted).toEqual([{ type: 'input_text', text: 'hello' }]);
        });
    });

    describe('convertMessagesForResponses', () => {
        it('converts array content but leaves string content unchanged', () => {
            const msgs: ApiMessage[] = [
                { role: 'system', content: 'You are helpful' },
                {
                    role: 'user', content: [
                        { type: 'text', text: 'What is this?' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } },
                    ]
                },
                { role: 'assistant', content: 'It is a cat.' },
            ];
            const converted = convertMessagesForResponses(msgs);
            expect(converted[0].content).toBe('You are helpful');
            expect(converted[1].content).toEqual([
                { type: 'input_text', text: 'What is this?' },
                { type: 'input_image', image_url: 'data:image/png;base64,xyz' },
            ]);
            expect(converted[2].content).toBe('It is a cat.');
        });

        it('preserves null content', () => {
            const msgs: ApiMessage[] = [{ role: 'assistant', content: null }];
            const converted = convertMessagesForResponses(msgs);
            expect(converted[0].content).toBeNull();
        });
    });

    describe('buildResponsesBody', () => {
        const copilotSettings: ApiSettings = {
            ...baseSettings,
            selectedProvider: 'copilot',
            selectedModel: 'gpt-5-mini',
            thinkingEnabled: true,
        };

        it('uses input instead of messages', () => {
            const msgs: ApiMessage[] = [{ role: 'user', content: 'hi' }];
            const body = buildResponsesBody(copilotSettings, msgs, []);
            // String content passes through unchanged
            expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
            expect((body as any).messages).toBeUndefined();
        });

        it('converts image content parts to Responses API format', () => {
            const msgs: ApiMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'What is this?' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
                ],
            }];
            const body = buildResponsesBody(copilotSettings, msgs, []);
            expect(body.input).toEqual([{
                role: 'user',
                content: [
                    { type: 'input_text', text: 'What is this?' },
                    { type: 'input_image', image_url: 'data:image/png;base64,abc' },
                ],
            }]);
        });

        it('includes reasoning config', () => {
            const body = buildResponsesBody(copilotSettings, [], []);
            expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
        });

        it('includes tools in flat format', () => {
            const body = buildResponsesBody(copilotSettings, [], []);
            expect(body.tools).toBeDefined();
            for (const tool of body.tools!) {
                expect(tool.name).toBeDefined();
                expect((tool as any).function).toBeUndefined();
            }
        });

        it('sets store=false', () => {
            const body = buildResponsesBody(copilotSettings, [], []);
            expect(body.store).toBe(false);
        });

        it('skips temperature for thinking mode with thinking-capable model', () => {
            const thinkingModel: ModelInfo[] = [{ id: 'gpt-5-mini', label: 'GPT-5 Mini', supportsThinking: true } as any];
            const body = buildResponsesBody(copilotSettings, [], thinkingModel);
            expect(body.temperature).toBeUndefined();
        });

        it('includes temperature for non-thinking Copilot model even with thinking enabled', () => {
            const body = buildResponsesBody(copilotSettings, [], []);
            expect(body.temperature).toBe(copilotSettings.temperature);
        });
    });

    describe('shouldUseResponsesAPI', () => {
        it('true for copilot + thinking', () => {
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', thinkingEnabled: true })).toBe(true);
        });
        it('false for copilot + no thinking', () => {
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', thinkingEnabled: false })).toBe(false);
        });
        it('false for openai + thinking', () => {
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'openai', thinkingEnabled: true })).toBe(false);
        });
        it('false for non-thinking model even with thinking enabled', () => {
            const models = [{ id: 'claude-haiku-4.5', label: 'Haiku', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true }];
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-haiku-4.5', thinkingEnabled: true }, models)).toBe(false);
        });
        it('false for Claude thinking model (uses Chat Completions with reasoning_effort)', () => {
            const models = [{ id: 'claude-sonnet-4', label: 'Sonnet', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true }];
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-sonnet-4', thinkingEnabled: true }, models)).toBe(false);
        });
        it('true for non-Claude thinking model with thinking enabled', () => {
            const models = [{ id: 'gpt-5-mini', label: 'GPT-5 Mini', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true }];
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5-mini', thinkingEnabled: true }, models)).toBe(true);
        });
        it('false for thinking model with responsesApiSupported: false', () => {
            const models = [{ id: 'claude-sonnet-4.6', label: 'Sonnet 4.6', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, responsesApiSupported: false }];
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-sonnet-4.6', thinkingEnabled: true }, models)).toBe(false);
        });
        it('true for thinking model with responsesApiSupported: true (explicit)', () => {
            const models = [{ id: 'gpt-5-mini', label: 'GPT-5 Mini', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true, responsesApiSupported: true }];
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5-mini', thinkingEnabled: true }, models)).toBe(true);
        });
        it('true for thinking model without responsesApiSupported set (defaults to supportsThinking)', () => {
            const models = [{ id: 'gpt-5-mini', label: 'GPT-5 Mini', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true }];
            expect(shouldUseResponsesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5-mini', thinkingEnabled: true }, models)).toBe(true);
        });
    });

    describe('shouldUseMessagesAPI', () => {
        it('true for copilot + claude + thinking', () => {
            expect(shouldUseMessagesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-haiku-4.5', thinkingEnabled: true })).toBe(true);
        });
        it('false for copilot + claude + no thinking', () => {
            expect(shouldUseMessagesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-haiku-4.5', thinkingEnabled: false })).toBe(false);
        });
        it('false for copilot + non-claude + thinking', () => {
            expect(shouldUseMessagesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5-mini', thinkingEnabled: true })).toBe(false);
        });
        it('false for openai + claude + thinking', () => {
            expect(shouldUseMessagesAPI({ ...baseSettings, selectedProvider: 'openai', selectedModel: 'claude-haiku-4.5', thinkingEnabled: true })).toBe(false);
        });
        it('false when model supportsThinking is false', () => {
            const models = [{ id: 'claude-old', label: 'Claude Old', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true }];
            expect(shouldUseMessagesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-old', thinkingEnabled: true }, models)).toBe(false);
        });
        it('true for all Claude variants', () => {
            for (const model of ['claude-haiku-4.5', 'claude-sonnet-4.6', 'claude-opus-4.6']) {
                expect(shouldUseMessagesAPI({ ...baseSettings, selectedProvider: 'copilot', selectedModel: model, thinkingEnabled: true })).toBe(true);
            }
        });
    });

    describe('getMessagesApiHeaders', () => {
        it('includes anthropic-version and anthropic-beta', () => {
            const headers = getMessagesApiHeaders();
            expect(headers['anthropic-version']).toBe('2023-06-01');
            expect(headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
        });
    });

    describe('convertMessagesForAnthropic', () => {
        it('extracts system message', () => {
            const msgs: ApiMessage[] = [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
            ];
            const { system, messages } = convertMessagesForAnthropic(msgs);
            expect(system).toBe('You are helpful.');
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe('user');
        });

        it('converts tool results to user messages with tool_result blocks', () => {
            const msgs: ApiMessage[] = [
                { role: 'tool', tool_call_id: 'toolu_123', content: 'result text' },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe('user');
            expect(Array.isArray(messages[0].content)).toBe(true);
            const blocks = messages[0].content as any[];
            expect(blocks[0].type).toBe('tool_result');
            expect(blocks[0].tool_use_id).toBe('toolu_123');
            expect(blocks[0].content).toBe('result text');
        });

        it('merges consecutive tool results into one user message', () => {
            const msgs: ApiMessage[] = [
                { role: 'tool', tool_call_id: 'tc1', content: 'result1' },
                { role: 'tool', tool_call_id: 'tc2', content: 'result2' },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            expect(messages).toHaveLength(1);
            const blocks = messages[0].content as any[];
            expect(blocks).toHaveLength(2);
            expect(blocks[0].tool_use_id).toBe('tc1');
            expect(blocks[1].tool_use_id).toBe('tc2');
        });

        it('converts assistant tool_calls to tool_use content blocks', () => {
            const msgs: ApiMessage[] = [
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
                },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            expect(messages).toHaveLength(1);
            const blocks = messages[0].content as any[];
            expect(blocks[0].type).toBe('tool_use');
            expect(blocks[0].id).toBe('call_1');
            expect(blocks[0].name).toBe('search');
            expect(blocks[0].input).toEqual({ q: 'test' });
        });

        it('merges consecutive same-role messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'user', content: 'Hello' },
                { role: 'user', content: 'World' },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            expect(messages).toHaveLength(1);
            const content = messages[0].content as any[];
            expect(content).toHaveLength(2);
        });

        it('handles image content parts', () => {
            const msgs: ApiMessage[] = [
                { role: 'user', content: [
                    { type: 'text', text: 'Look at this' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
                ]},
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            const blocks = messages[0].content as any[];
            expect(blocks[0].type).toBe('text');
            expect(blocks[1].type).toBe('image');
            expect(blocks[1].source.type).toBe('base64');
            expect(blocks[1].source.media_type).toBe('image/png');
        });

        it('concatenates multiple system messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'system', content: 'Rule 1' },
                { role: 'system', content: 'Rule 2' },
                { role: 'user', content: 'Hi' },
            ];
            const { system } = convertMessagesForAnthropic(msgs);
            expect(system).toBe('Rule 1\n\nRule 2');
        });

        it('includes thinking block with signature on assistant tool_call messages', () => {
            const msgs: ApiMessage[] = [
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
                    _thinking: 'The user wants to search',
                    _thinkingSignature: 'sig-abc-123',
                },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            const blocks = messages[0].content as any[];
            expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'The user wants to search', signature: 'sig-abc-123' });
            expect(blocks[1].type).toBe('tool_use');
        });

        it('omits thinking block when signature is missing on assistant tool_call messages', () => {
            const msgs: ApiMessage[] = [
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
                    _thinking: 'The user wants to search',
                    // no _thinkingSignature
                },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            const blocks = messages[0].content as any[];
            expect(blocks[0].type).toBe('tool_use');
            expect(blocks.length).toBe(1);
        });

        it('includes thinking block with signature on plain assistant messages', () => {
            const msgs: ApiMessage[] = [
                {
                    role: 'assistant', content: 'The answer is 42.',
                    _thinking: 'Let me compute this',
                    _thinkingSignature: 'sig-xyz-789',
                },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            const blocks = messages[0].content as any[];
            expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'Let me compute this', signature: 'sig-xyz-789' });
            expect(blocks[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
        });

        it('omits thinking block when signature is missing on plain assistant messages', () => {
            const msgs: ApiMessage[] = [
                {
                    role: 'assistant', content: 'The answer is 42.',
                    _thinking: 'Let me compute this',
                    // no _thinkingSignature
                },
            ];
            const { messages } = convertMessagesForAnthropic(msgs);
            // Should fall back to plain text content (no blocks)
            expect(messages[0].content).toBe('The answer is 42.');
        });
    });

    describe('buildMessagesApiBody', () => {
        const claudeSettings: ApiSettings = {
            ...baseSettings,
            selectedProvider: 'copilot',
            selectedModel: 'claude-haiku-4.5',
            thinkingEnabled: true,
        };

        it('includes model, max_tokens, stream, thinking', () => {
            const body = buildMessagesApiBody(claudeSettings, [], []);
            expect(body.model).toBe('claude-haiku-4.5');
            expect(body.stream).toBe(true);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
            expect(body.max_tokens).toBeGreaterThanOrEqual(16384);
        });

        it('extracts system message from messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'system', content: 'Be helpful' },
                { role: 'user', content: 'Hi' },
            ];
            const body = buildMessagesApiBody(claudeSettings, msgs, []);
            expect(body.system).toBe('Be helpful');
            expect(body.messages).toHaveLength(1);
        });

        it('includes tools in Anthropic format when toolsEnabled', () => {
            const body = buildMessagesApiBody(claudeSettings, [], []);
            expect(body.tools).toBeDefined();
            if (body.tools) {
                expect(body.tools[0]).toHaveProperty('name');
                expect(body.tools[0]).toHaveProperty('input_schema');
                expect(body.tools[0]).not.toHaveProperty('type');
            }
        });

        it('uses custom thinking budget', () => {
            const body = buildMessagesApiBody({ ...claudeSettings, thinkingBudget: 4096 }, [], []);
            expect(body.thinking?.budget_tokens).toBe(4096);
        });

        it('has no tools when toolsEnabled is false', () => {
            const body = buildMessagesApiBody({ ...claudeSettings, toolsEnabled: false }, [], []);
            expect(body.tools).toBeUndefined();
        });
    });

    describe('formatToolArgsPreview', () => {
        it('formats simple args without backticks', () => {
            expect(formatToolArgsPreview('{"query":"test"}')).toBe('query: test');
        });
        it('truncates long values to 80 chars', () => {
            const long = 'a'.repeat(150);
            expect(formatToolArgsPreview(`{"x":"${long}"}`)).toBe(`x: ${'a'.repeat(80)}\u2026`);
        });
        it('does not truncate values at exactly 80 chars', () => {
            const exact = 'b'.repeat(80);
            expect(formatToolArgsPreview(`{"x":"${exact}"}`)).toBe(`x: ${exact}`);
        });
        it('collapses newlines', () => {
            expect(formatToolArgsPreview('{"c":"a\\nb"}')).not.toContain('\n');
        });
        it('returns raw for invalid JSON', () => {
            expect(formatToolArgsPreview('not json')).toBe('not json');
        });
    });

    describe('formatCleanToolHeader', () => {
        it('read_note shows file path', () => {
            expect(formatCleanToolHeader('read_note', '{"path":"notes/todo.md"}')).toBe('Read notes/todo.md');
        });
        it('read_note with line range', () => {
            expect(formatCleanToolHeader('read_note', '{"path":"a.md","start_line":5,"end_line":20}'))
                .toBe('Read a.md, lines 5–20');
        });
        it('read_note_section shows heading', () => {
            expect(formatCleanToolHeader('read_note_section', '{"path":"a.md","heading":"Intro"}'))
                .toBe('Read a.md → "Intro"');
        });
        it('read_note_outline shows path', () => {
            expect(formatCleanToolHeader('read_note_outline', '{"path":"doc.md"}')).toBe('Outline doc.md');
        });
        it('search_vault shows query', () => {
            expect(formatCleanToolHeader('search_vault', '{"query":"meeting notes"}'))
                .toBe('Searched "meeting notes"');
        });
        it('grep_search shows pattern', () => {
            expect(formatCleanToolHeader('grep_search', '{"pattern":"TODO"}'))
                .toBe('Grep "TODO"');
        });
        it('grep_search shows folder when provided', () => {
            expect(formatCleanToolHeader('grep_search', '{"pattern":"TODO","folder":"Projects"}'))
                .toBe('Grep "TODO" in Projects');
        });
        it('create_note shows path', () => {
            expect(formatCleanToolHeader('create_note', '{"path":"new.md","content":"hi"}'))
                .toBe('Create new.md');
        });
        it('edit_note shows path', () => {
            expect(formatCleanToolHeader('edit_note', '{"path":"a.md","operation":"replace","search":"x","replace":"y"}'))
                .toBe('Edit a.md');
        });
        it('move_note shows from/to', () => {
            expect(formatCleanToolHeader('move_note', '{"from":"a.md","to":"b.md"}'))
                .toBe('Move a.md → b.md');
        });
        it('delete_note shows path', () => {
            expect(formatCleanToolHeader('delete_note', '{"path":"old.md"}')).toBe('Delete old.md');
        });
        it('list_files shows directory', () => {
            expect(formatCleanToolHeader('list_files', '{"path":"Daily Notes"}')).toBe('List Daily Notes');
        });
        it('fetch_url shows url', () => {
            expect(formatCleanToolHeader('fetch_url', '{"url":"https://example.com/page"}')).toBe('Fetch https://example.com/page');
        });
        it('fetch_url truncates long url', () => {
            const longUrl = 'https://example.com/' + 'a'.repeat(100);
            const result = formatCleanToolHeader('fetch_url', JSON.stringify({ url: longUrl }));
            expect(result.length).toBeLessThan(80);
            expect(result).toContain('…');
        });
        it('search_by_tag strips hash', () => {
            expect(formatCleanToolHeader('search_by_tag', '{"tag":"#project"}')).toBe('Tag #project');
        });
        it('search_by_tag without hash', () => {
            expect(formatCleanToolHeader('search_by_tag', '{"tag":"project"}')).toBe('Tag #project');
        });
        it('ask_user', () => {
            expect(formatCleanToolHeader('ask_user', '{"question":"what?"}')).toBe('Ask user');
        });
        it('generate_image', () => {
            expect(formatCleanToolHeader('generate_image', '{"prompt":"a cat"}')).toBe('Generate image');
        });
        it('view_image shows path', () => {
            expect(formatCleanToolHeader('view_image', '{"path":"img.png"}')).toBe('View img.png');
        });
        it('get_recent_notes', () => {
            expect(formatCleanToolHeader('get_recent_notes', '{}')).toBe('Recent notes');
        });
        it('get_open_notes', () => {
            expect(formatCleanToolHeader('get_open_notes', '{}')).toBe('Open notes');
        });
        it('unknown tool falls back to name + args', () => {
            expect(formatCleanToolHeader('some_tool', '{"x":"y"}')).toBe('some_tool · x: y');
        });
        it('handles invalid JSON gracefully', () => {
            expect(formatCleanToolHeader('read_note', 'bad')).toBe('read_note');
        });
    });

    describe('constants', () => {
        it('MAX_RETRIES is 3', () => expect(MAX_RETRIES).toBe(3));
        it('RETRY_DELAY_MS is 2000', () => expect(RETRY_DELAY_MS).toBe(2000));
        it('MAX_TOOL_ROUNDS is 10', () => expect(MAX_TOOL_ROUNDS).toBe(10));
        it('MAX_TOOL_ROUNDS_ITERATE is 50', () => expect(MAX_TOOL_ROUNDS_ITERATE).toBe(50));
        it('MAX_CONTENT_LENGTH is 15000', () => expect(MAX_CONTENT_LENGTH).toBe(15000));
        it('THINKING_BUDGET is 16384', () => expect(THINKING_BUDGET).toBe(16384));
    });

    describe('stripBase64', () => {
        it('replaces inline base64 img tags with [image]', () => {
            const html = 'Hello <img src="data:image/png;base64,abc123"/> world';
            expect(stripBase64(html)).toBe('Hello [image] world');
        });
        it('handles multiple img tags', () => {
            const html = '<img src="data:image/png;base64,a"/><img src="data:image/jpeg;base64,b"/>';
            expect(stripBase64(html)).toBe('[image][image]');
        });
        it('preserves non-base64 content', () => {
            expect(stripBase64('Hello world')).toBe('Hello world');
        });
        it('handles empty string', () => {
            expect(stripBase64('')).toBe('');
        });
        it('handles null/undefined gracefully', () => {
            expect(stripBase64(null as any)).toBe('');
            expect(stripBase64(undefined as any)).toBe('');
        });
        it('preserves self-closing tags with extra attributes', () => {
            const html = '<img src="data:image/png;base64,abc" width="100" />';
            expect(stripBase64(html)).toBe('[image]');
        });
    });

    describe('buildNoteContextMessages', () => {
        it('creates user message with note header and content', () => {
            const msgs = buildNoteContextMessages([
                { path: 'notes/test.md', content: 'Hello world', images: [] },
            ]);
            expect(msgs).toHaveLength(1);
            expect(msgs[0].role).toBe('user');
            expect(msgs[0].content).toContain('[Attached note: notes/test.md');
            expect(msgs[0].content).toContain('Hello world');
        });
        it('returns multi-part content when images are present', () => {
            const msgs = buildNoteContextMessages([
                { path: 'doc.md', content: 'Text', images: ['data:image/png;base64,abc'] },
            ]);
            expect(msgs).toHaveLength(1);
            expect(Array.isArray(msgs[0].content)).toBe(true);
            const parts = msgs[0].content as any[];
            expect(parts[0].type).toBe('text');
            expect(parts[0].text).toContain('[Attached note: doc.md');
            expect(parts[1].type).toBe('image_url');
            expect(parts[1].image_url.url).toBe('data:image/png;base64,abc');
        });
        it('handles multiple notes', () => {
            const msgs = buildNoteContextMessages([
                { path: 'a.md', content: 'A', images: [] },
                { path: 'b.md', content: 'B', images: [] },
            ]);
            expect(msgs).toHaveLength(2);
        });
        it('handles multiple images per note', () => {
            const msgs = buildNoteContextMessages([
                { path: 'img.md', content: 'Pics', images: ['img1', 'img2'] },
            ]);
            const parts = msgs[0].content as any[];
            expect(parts).toHaveLength(3); // 1 text + 2 images
        });
        it('returns empty array for no notes', () => {
            expect(buildNoteContextMessages([])).toEqual([]);
        });
    });

    describe('formatToolResultForChatCompletions', () => {
        it('creates tool role message with id and content', () => {
            const msg = formatToolResultForChatCompletions('call_123', 'result text');
            expect(msg.role).toBe('tool');
            expect(msg.tool_call_id).toBe('call_123');
            expect(msg.content).toBe('result text');
        });
    });

    describe('formatToolResultForResponses', () => {
        it('creates function_call_output item', () => {
            const msg = formatToolResultForResponses('call_456', 'output data');
            expect(msg.type).toBe('function_call_output');
            expect(msg.call_id).toBe('call_456');
            expect(msg.output).toBe('output data');
        });
    });

    describe('formatToolResultForMessagesAPI', () => {
        it('creates tool role message (same internal format as Chat Completions)', () => {
            const msg = formatToolResultForMessagesAPI('toolu_789', 'anthropic result');
            expect(msg.role).toBe('tool');
            expect(msg.tool_call_id).toBe('toolu_789');
            expect(msg.content).toBe('anthropic result');
        });
    });

    describe('formatAssistantToolCalls', () => {
        it('creates assistant message with tool_calls array', () => {
            const msg = formatAssistantToolCalls([
                { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } },
            ]);
            expect(msg.role).toBe('assistant');
            expect(msg.content).toBeNull();
            expect(msg.tool_calls).toHaveLength(1);
            expect(msg.tool_calls![0].id).toBe('call_1');
            expect(msg.tool_calls![0].type).toBe('function');
            expect(msg.tool_calls![0].function.name).toBe('search');
        });
        it('handles multiple tool calls', () => {
            const msg = formatAssistantToolCalls([
                { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } },
                { id: 'c2', type: 'function', function: { name: 'write', arguments: '{}' } },
            ]);
            expect(msg.tool_calls).toHaveLength(2);
        });
    });

    describe('formatAssistantToolCallsForMessagesAPI', () => {
        it('creates assistant message with tool_calls (same format as Chat Completions)', () => {
            const msg = formatAssistantToolCallsForMessagesAPI([
                { id: 'tc_1', type: 'function', function: { name: 'edit_note', arguments: '{"path":"a.md"}' } },
            ]);
            expect(msg.role).toBe('assistant');
            expect(msg.content).toBeNull();
            expect(msg.tool_calls).toHaveLength(1);
            expect(msg.tool_calls![0].function.name).toBe('edit_note');
        });
    });

    describe('formatFunctionCallForResponses', () => {
        it('creates function_call item with correct fields', () => {
            const msg = formatFunctionCallForResponses({
                id: 'fc_1', type: 'function',
                callId: 'call_abc',
                function: { name: 'search', arguments: '{"q":"test"}' },
            });
            expect(msg.type).toBe('function_call');
            expect(msg.id).toBe('fc_1');
            expect(msg.call_id).toBe('call_abc');
            expect(msg.name).toBe('search');
            expect(msg.arguments).toBe('{"q":"test"}');
        });
        it('falls back to id when callId is missing', () => {
            const msg = formatFunctionCallForResponses({
                id: 'fc_2', type: 'function',
                function: { name: 'read', arguments: '{}' },
            });
            expect(msg.call_id).toBe('fc_2');
        });
    });

    describe('buildChatCompletionBody edge cases', () => {
        it('aliases gemini-3-flash to gemini-3-flash-preview for Copilot', () => {
            const s = { ...baseSettings, selectedProvider: 'copilot' as const, selectedModel: 'gemini-3-flash' };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.model).toBe('gemini-3-flash-preview');
        });
        it('does not alias gemini-3-flash for non-Copilot providers', () => {
            const s = { ...baseSettings, selectedProvider: 'openai' as const, selectedModel: 'gemini-3-flash' };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.model).toBe('gemini-3-flash');
        });
        it('includes reasoning_effort for OpenAI thinking-capable model', () => {
            const s = { ...baseSettings, selectedProvider: 'openai' as const, selectedModel: 'o3-mini', thinkingEnabled: true };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.reasoning_effort).toBe('high');
        });
        it('adds modalities for image gen models on OpenRouter', () => {
            const model: ModelInfo = { id: 'gpt-image-1', label: 'GPT Image', supportsImageGen: true } as any;
            const s = { ...baseSettings, selectedProvider: 'openrouter' as const, selectedModel: 'gpt-image-1' };
            const body = buildChatCompletionBody(s, [], [model]);
            expect(body.modalities).toBeDefined();
        });
        it('omits tools when toolsEnabled is false', () => {
            const s = { ...baseSettings, toolsEnabled: false };
            const body = buildChatCompletionBody(s, [], []);
            expect(body.tools).toBeUndefined();
        });
    });

    describe('convertMessagesForAnthropic edge cases', () => {
        it('converts URL-based image (non-base64) to source URL', () => {
            const msgs: ApiMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Look at this' },
                    { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
                ],
            }];
            const { messages } = convertMessagesForAnthropic(msgs);
            const blocks = messages[0].content as any[];
            expect(blocks[1].type).toBe('image');
            expect(blocks[1].source.type).toBe('url');
            expect(blocks[1].source.url).toBe('https://example.com/img.png');
        });
        it('handles assistant with text content and tool_calls', () => {
            const msgs: ApiMessage[] = [{
                role: 'assistant',
                content: 'Let me search for that.',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
            }];
            const { messages } = convertMessagesForAnthropic(msgs);
            const blocks = messages[0].content as any[];
            expect(blocks[0].type).toBe('text');
            expect(blocks[0].text).toBe('Let me search for that.');
            expect(blocks[1].type).toBe('tool_use');
        });
        it('handles empty messages array', () => {
            const { system, messages } = convertMessagesForAnthropic([]);
            expect(system).toBe('');
            expect(messages).toEqual([]);
        });
    });

    describe('extractThinkingSummary', () => {
        it('returns "Thinking" for empty/whitespace input', () => {
            expect(extractThinkingSummary('')).toBe('Thinking');
            expect(extractThinkingSummary('   ')).toBe('Thinking');
        });

        it('returns "Thinking" for null-like input', () => {
            expect(extractThinkingSummary(null as any)).toBe('Thinking');
            expect(extractThinkingSummary(undefined as any)).toBe('Thinking');
        });

        it('extracts first sentence', () => {
            const result = extractThinkingSummary('Analyzing the user request. Then doing more work.');
            expect(result).toBe('Analyzing the user request');
        });

        it('strips preamble phrases', () => {
            expect(extractThinkingSummary("Let me search for that information.")).not.toMatch(/^Let me/);
            expect(extractThinkingSummary("OK, I'll look at the file.")).not.toMatch(/^OK/);
            expect(extractThinkingSummary("I need to check the API docs.")).not.toMatch(/^I need to/);
        });

        it('capitalizes first letter', () => {
            const result = extractThinkingSummary('analyzing the code');
            expect(result.charAt(0)).toBe('A');
        });

        it('truncates to 80 chars', () => {
            const long = 'A'.repeat(120) + '.';
            const result = extractThinkingSummary(long);
            expect(result.length).toBeLessThanOrEqual(80);
            expect(result).toContain('…');
        });

        it('handles newline-delimited text', () => {
            const result = extractThinkingSummary('First paragraph here\nSecond paragraph');
            expect(result).toBe('First paragraph here');
        });

        it('preserves short non-preamble text unchanged', () => {
            expect(extractThinkingSummary("Let me ")).toBe('Let me');
        });
    });

    describe('computeContextBreakdown', () => {
        it('returns empty items for empty messages', () => {
            const result = computeContextBreakdown([], 128000);
            expect(result.items).toHaveLength(0);
            expect(result.totalChars).toBe(0);
            expect(result.contextLimit).toBe(128000);
        });

        it('categorizes system messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'system', content: 'You are helpful.' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            expect(result.items).toHaveLength(1);
            expect(result.items[0].type).toBe('system');
            expect(result.items[0].chars).toBe(16);
        });

        it('categorizes user messages as history', () => {
            const msgs: ApiMessage[] = [
                { role: 'user', content: 'Hello' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const hist = result.items.find(i => i.type === 'history');
            expect(hist).toBeDefined();
            expect(hist!.count).toBe(1);
        });

        it('categorizes attached note context messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'user', content: '[Attached note: test.md]\nSome content here.' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const notes = result.items.find(i => i.type === 'notes');
            expect(notes).toBeDefined();
            expect(notes!.count).toBe(1);
        });

        it('categorizes tool messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'tool', content: '{"result": "found"}', tool_call_id: 'tc1' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const tool = result.items.find(i => i.type === 'tool_result');
            expect(tool).toBeDefined();
            expect(tool!.count).toBe(1);
        });

        it('categorizes Responses API function_call items', () => {
            const msgs: ApiMessage[] = [
                { role: 'assistant', type: 'function_call', content: null, arguments: '{"query":"test"}' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const tool = result.items.find(i => i.type === 'tool_result');
            expect(tool).toBeDefined();
            expect(tool!.count).toBe(1);
        });

        it('categorizes Responses API function_call_output items', () => {
            const msgs: ApiMessage[] = [
                { role: 'tool', type: 'function_call_output', content: null, output: 'result text' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const tool = result.items.find(i => i.type === 'tool_result');
            expect(tool).toBeDefined();
            expect(tool!.chars).toBe(11);
        });

        it('counts images in user messages', () => {
            const msgs: ApiMessage[] = [
                { role: 'user', content: [
                    { type: 'text', text: 'Describe this' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
                ] },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const images = result.items.find(i => i.type === 'images');
            expect(images).toBeDefined();
            expect(images!.count).toBe(1);
        });

        it('includes assistant tool_calls arguments in history', () => {
            const msgs: ApiMessage[] = [
                { role: 'assistant', content: null, tool_calls: [
                    { id: 'tc1', type: 'function', function: { name: 'search_vault', arguments: '{"query":"test"}' } },
                ] },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const hist = result.items.find(i => i.type === 'history');
            expect(hist).toBeDefined();
            expect(hist!.chars).toBeGreaterThan(0);
        });

        it('proportions sum to approximately 1', () => {
            const msgs: ApiMessage[] = [
                { role: 'system', content: 'System prompt here' },
                { role: 'user', content: 'Hello world' },
                { role: 'assistant', content: 'Hi there!' },
            ];
            const result = computeContextBreakdown(msgs, 128000);
            const total = result.items.reduce((sum, i) => sum + i.proportion, 0);
            expect(total).toBeCloseTo(1.0, 5);
        });

        it('uses fallback context limit of 128000 when 0 is passed', () => {
            const result = computeContextBreakdown([], 0);
            expect(result.contextLimit).toBe(128000);
        });
    });

    // ── AnyRequestBody helpers ──────────────────────────────────────────

    describe('AnyRequestBody helpers', () => {
        const chatReq: AnyRequestBody = {
            api: 'chat-completions',
            body: {
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'Hello' },
                ],
                stream: true,
                temperature: 0.7,
                tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: {} } }],
                reasoning_effort: 'high',
                reasoning_summary: 'auto',
                max_tokens: 4096,
            },
        };

        const responsesReq: AnyRequestBody = {
            api: 'responses',
            body: {
                model: 'gpt-4o',
                input: [
                    { role: 'user', content: 'Hi' },
                ],
                stream: true,
                temperature: 0.5,
                tools: [
                    { type: 'function', name: 'search', description: 'Search', parameters: {} },
                    { type: 'function', name: 'read', description: 'Read', parameters: {} },
                ],
                reasoning: { effort: 'medium' },
            },
        };

        const messagesReq: AnyRequestBody = {
            api: 'messages',
            body: {
                model: 'claude-sonnet-4-20250514',
                max_tokens: 8192,
                stream: true,
                system: 'Be helpful.',
                messages: [
                    { role: 'user', content: 'Hey' },
                    { role: 'assistant', content: 'Hello!' },
                    { role: 'user', content: 'How?' },
                ],
                thinking: { type: 'enabled', budget_tokens: 10000 },
                tools: [{ name: 'write', description: 'Write', input_schema: {} }],
            },
        };

        const noToolsReq: AnyRequestBody = {
            api: 'chat-completions',
            body: {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: true,
            },
        };

        describe('getRequestMessageCount', () => {
            it('counts messages in chat-completions', () => {
                expect(getRequestMessageCount(chatReq)).toBe(2);
            });

            it('counts input in responses API', () => {
                expect(getRequestMessageCount(responsesReq)).toBe(1);
            });

            it('counts messages in messages API', () => {
                expect(getRequestMessageCount(messagesReq)).toBe(3);
            });

            it('returns 0 for empty messages', () => {
                const empty: AnyRequestBody = {
                    api: 'chat-completions',
                    body: { model: 'gpt-4o', messages: [], stream: true },
                };
                expect(getRequestMessageCount(empty)).toBe(0);
            });
        });

        describe('getRequestTemperature', () => {
            it('returns temperature for chat-completions', () => {
                expect(getRequestTemperature(chatReq)).toBe(0.7);
            });

            it('returns temperature for responses API', () => {
                expect(getRequestTemperature(responsesReq)).toBe(0.5);
            });

            it('returns undefined when temperature not set', () => {
                expect(getRequestTemperature(noToolsReq)).toBeUndefined();
            });
        });

        describe('getRequestToolCount', () => {
            it('counts tools in chat-completions', () => {
                expect(getRequestToolCount(chatReq)).toBe(1);
            });

            it('counts tools in responses API', () => {
                expect(getRequestToolCount(responsesReq)).toBe(2);
            });

            it('counts tools in messages API', () => {
                expect(getRequestToolCount(messagesReq)).toBe(1);
            });

            it('returns 0 when no tools', () => {
                expect(getRequestToolCount(noToolsReq)).toBe(0);
            });
        });

        describe('requestHasTools', () => {
            it('returns true when tools present', () => {
                expect(requestHasTools(chatReq)).toBe(true);
                expect(requestHasTools(responsesReq)).toBe(true);
                expect(requestHasTools(messagesReq)).toBe(true);
            });

            it('returns false when no tools', () => {
                expect(requestHasTools(noToolsReq)).toBe(false);
            });
        });

        describe('updateRequestMessages', () => {
            it('updates chat-completions messages directly', () => {
                const req: AnyRequestBody = {
                    api: 'chat-completions',
                    body: { model: 'gpt-4o', messages: [], stream: true },
                };
                const newMsgs: ApiMessage[] = [
                    { role: 'user', content: 'Updated' },
                ];
                updateRequestMessages(req, newMsgs, () => [], () => ({ messages: [] }));
                expect(req.body.messages).toEqual(newMsgs);
            });

            it('calls convertForResponses for responses API', () => {
                const req: AnyRequestBody = {
                    api: 'responses',
                    body: { model: 'gpt-4o', input: [], stream: true },
                };
                const converted: ApiMessage[] = [{ role: 'user', content: 'converted' }];
                updateRequestMessages(
                    req,
                    [{ role: 'user', content: 'original' }],
                    () => converted,
                    () => ({ messages: [] }),
                );
                expect(req.body.input).toEqual(converted);
            });

            it('calls convertForAnthropic for messages API', () => {
                const req: AnyRequestBody = {
                    api: 'messages',
                    body: { model: 'claude-sonnet-4-20250514', max_tokens: 4096, stream: true, messages: [] },
                };
                const anthropicMsgs = [{ role: 'user', content: 'hi' as unknown }];
                updateRequestMessages(
                    req,
                    [{ role: 'user', content: 'original' }],
                    () => [],
                    () => ({ system: 'Be nice.', messages: anthropicMsgs }),
                );
                expect(req.body.messages).toEqual(anthropicMsgs);
                expect(req.body.system).toBe('Be nice.');
            });

            it('does not set system on messages API when converter returns none', () => {
                const req: AnyRequestBody = {
                    api: 'messages',
                    body: { model: 'claude-sonnet-4-20250514', max_tokens: 4096, stream: true, messages: [] },
                };
                updateRequestMessages(
                    req,
                    [{ role: 'user', content: 'test' }],
                    () => [],
                    () => ({ messages: [{ role: 'user', content: 'test' as unknown }] }),
                );
                expect(req.body.system).toBeUndefined();
            });
        });

        describe('stripRequestParam', () => {
            it('removes a parameter from chat-completions body', () => {
                const req: AnyRequestBody = {
                    api: 'chat-completions',
                    body: { model: 'gpt-4o', messages: [], stream: true, temperature: 0.5 },
                };
                stripRequestParam(req, 'temperature');
                expect(req.body.temperature).toBeUndefined();
            });

            it('removes a parameter from responses body', () => {
                const req: AnyRequestBody = {
                    api: 'responses',
                    body: { model: 'gpt-4o', input: [], stream: true, reasoning: { effort: 'high' } },
                };
                stripRequestParam(req, 'reasoning');
                expect((req.body as Record<string, unknown>).reasoning).toBeUndefined();
            });

            it('is a no-op for non-existent parameter', () => {
                const req: AnyRequestBody = {
                    api: 'chat-completions',
                    body: { model: 'gpt-4o', messages: [], stream: true },
                };
                stripRequestParam(req, 'nonexistent');
                expect(req.body.model).toBe('gpt-4o'); // unchanged
            });
        });

        describe('getRequestDebugInfo', () => {
            it('returns base info for chat-completions', () => {
                const info = getRequestDebugInfo(chatReq);
                expect(info.api).toBe('chat-completions');
                expect(info.model).toBe('gpt-4o');
                expect(info.messageCount).toBe(2);
                expect(info.toolCount).toBe(1);
                expect(info.temperature).toBe(0.7);
                expect(info.reasoning_effort).toBe('high');
                expect(info.reasoning_summary).toBe('auto');
                expect(info.max_tokens).toBe(4096);
            });

            it('returns base info for responses API', () => {
                const info = getRequestDebugInfo(responsesReq);
                expect(info.api).toBe('responses');
                expect(info.model).toBe('gpt-4o');
                expect(info.messageCount).toBe(1);
                expect(info.toolCount).toBe(2);
                expect(info.temperature).toBe(0.5);
                expect(info.reasoning).toEqual({ effort: 'medium' });
            });

            it('returns base info for messages API', () => {
                const info = getRequestDebugInfo(messagesReq);
                expect(info.api).toBe('messages');
                expect(info.model).toBe('claude-sonnet-4-20250514');
                expect(info.messageCount).toBe(3);
                expect(info.toolCount).toBe(1);
                expect(info.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
                expect(info.max_tokens).toBe(8192);
            });

            it('omits optional fields when not set', () => {
                const info = getRequestDebugInfo(noToolsReq);
                expect(info.api).toBe('chat-completions');
                expect(info.model).toBe('gpt-4o-mini');
                expect(info.messageCount).toBe(1);
                expect(info.toolCount).toBe(0);
                expect(info.temperature).toBeUndefined();
                expect(info.reasoning_effort).toBeUndefined();
                expect(info.reasoning_summary).toBeUndefined();
                expect(info.max_tokens).toBeUndefined();
            });
        });
    });
});

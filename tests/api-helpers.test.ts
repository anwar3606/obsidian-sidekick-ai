import { describe, it, expect, vi } from 'vitest';
import { createMockApp } from './mocks/obsidian';
import {
    resolveHistoryForApi,
    buildApiMessages,
    buildRequestBody,
    buildResponsesRequestBody,
    shouldUseResponsesAPI,
    getApiKeyForProvider,
} from '../src/api-helpers';
import { getActiveCopilotOAuthToken } from '../src/copilot-auth';
import { TOOL_SCHEMAS } from '../src/tools';
import { PROVIDERS } from '../src/constants';
import type { PluginSettings, ModelInfo, ChatMessage } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/constants';

// ── resolveHistoryForApi ────────────────────────────────────────────

describe('resolveHistoryForApi', () => {
    it('passes through simple text messages', async () => {
        const app = createMockApp();
        const history: ChatMessage[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ];
        const result = await resolveHistoryForApi(app, history);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('Hello');
        expect(result[1].content).toBe('Hi there');
    });

    it('strips base64 img tags from text content', async () => {
        const app = createMockApp();
        const history: ChatMessage[] = [
            { role: 'user', content: 'Look <img src="data:image/png;base64,abc" /> here' },
        ];
        const result = await resolveHistoryForApi(app, history);
        expect(result[0].content).toBe('Look [image] here');
    });

    it('resolves vault image paths to multi-part content', async () => {
        const app = createMockApp({ 'photo.png': 'imgdata' });
        const history: ChatMessage[] = [
            { role: 'user', content: 'Check this', images: ['photo.png'] },
        ];
        const result = await resolveHistoryForApi(app, history);
        expect(result[0].content).toBeInstanceOf(Array);
        expect(result[0].content[0].type).toBe('text');
        expect(result[0].content[1].type).toBe('image_url');
    });
});

// ── buildApiMessages ────────────────────────────────────────────────

describe('buildApiMessages', () => {
    it('includes system prompt as first message', async () => {
        const app = createMockApp();
        const result = await buildApiMessages(app, 'Be helpful', [], []);
        expect(result[0]).toEqual({ role: 'system', content: 'Be helpful' });
    });

    it('combines system + notes + history in correct order', async () => {
        const app = createMockApp();
        const notes = [{ path: 'N.md', name: 'N', content: 'c', images: [] }];
        const history: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
        const result = await buildApiMessages(app, 'sys', notes, history);
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe('system');
        expect(result[1].content).toContain('[Attached note');
        expect(result[2].content).toBe('Hi');
    });
});

// ── buildRequestBody ────────────────────────────────────────────────

describe('buildRequestBody', () => {
    const baseSettings: PluginSettings = {
        ...DEFAULT_SETTINGS,
        selectedModel: 'gpt-4o',
        temperature: 0.7,
    };

    it('includes model, messages, stream=true', () => {
        const body = buildRequestBody(baseSettings, [], []);
        expect(body.model).toBe('gpt-4o');
        expect(body.messages).toEqual([]);
        expect(body.stream).toBe(true);
    });

    it('includes temperature for standard models', () => {
        const body = buildRequestBody(baseSettings, [], []);
        expect(body.temperature).toBe(0.7);
    });

    it('skips temperature for gpt-image models', () => {
        const s = { ...baseSettings, selectedModel: 'gpt-image-1' };
        const body = buildRequestBody(s, [], []);
        expect(body.temperature).toBeUndefined();
    });

    it('skips temperature for reasoning models when thinking enabled', () => {
        const s = { ...baseSettings, selectedModel: 'o1-preview', thinkingEnabled: true };
        const body = buildRequestBody(s, [], []);
        expect(body.temperature).toBeUndefined();
    });

    it('includes temperature for reasoning models when thinking disabled', () => {
        const s = { ...baseSettings, selectedModel: 'o1-preview', thinkingEnabled: false };
        const body = buildRequestBody(s, [], []);
        expect(body.temperature).toBe(0.7);
    });

    it('includes tools when enabled', () => {
        const s = { ...baseSettings, toolsEnabled: true, disabledTools: [] };
        const body = buildRequestBody(s, [], []);
        expect(body.tools).toBeDefined();
        expect(body.tools.length).toBeGreaterThan(0);
    });

    it('excludes disabled tools', () => {
        const s = { ...baseSettings, toolsEnabled: true, disabledTools: ['search_vault'] };
        const body = buildRequestBody(s, [], []);
        const toolNames = body.tools.map((t: any) => t.function.name);
        expect(toolNames).not.toContain('search_vault');
    });

    it('omits tools when toolsEnabled is false', () => {
        const s = { ...baseSettings, toolsEnabled: false };
        const body = buildRequestBody(s, [], []);
        expect(body.tools).toBeUndefined();
    });

    it('adds reasoning for openrouter when thinking enabled', () => {
        const s = { ...baseSettings, selectedProvider: 'openrouter', thinkingEnabled: true };
        const body = buildRequestBody(s, [], []);
        expect(body.reasoning).toEqual({ effort: 'high' });
    });

    it('adds reasoning_effort for openai thinking models', () => {
        const s = { ...baseSettings, selectedProvider: 'openai', selectedModel: 'o3-mini', thinkingEnabled: true };
        const body = buildRequestBody(s, [], []);
        expect(body.reasoning_effort).toBe('high');
    });

    it('adds reasoning_effort for copilot thinking models via supportsThinking flag', () => {
        const models: ModelInfo[] = [
            { id: 'gpt-5.2', label: 'GPT-5.2', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true },
        ];
        const s = { ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5.2', thinkingEnabled: true };
        const body = buildRequestBody(s, [], models);
        expect(body.reasoning_effort).toBe('high');
        expect(body.reasoning_summary).toBe('auto');
        expect(body.max_tokens).toBe(16384);
        expect(body.temperature).toBeUndefined();
    });

    it('adds reasoning_effort for copilot Claude models', () => {
        const models: ModelInfo[] = [
            { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', supportsVision: true, supportsThinking: false, supportsImageGen: false, supportsTools: true },
        ];
        const s = { ...baseSettings, selectedProvider: 'copilot', selectedModel: 'claude-sonnet-4', thinkingEnabled: true };
        const body = buildRequestBody(s, [], models);
        expect(body.reasoning_effort).toBe('high');
        expect(body.reasoning_summary).toBeUndefined();
        expect(body.max_tokens).toBe(16384);
    });

    it('uses custom thinkingBudget from settings', () => {
        const models: ModelInfo[] = [
            { id: 'gpt-5', label: 'GPT-5', supportsVision: true, supportsThinking: true, supportsImageGen: false, supportsTools: true },
        ];
        const s = { ...baseSettings, selectedProvider: 'copilot', selectedModel: 'gpt-5', thinkingEnabled: true, thinkingBudget: 32768 };
        const body = buildRequestBody(s, [], models);
        expect(body.max_tokens).toBe(32768);
    });

    it('does not add reasoning when thinking disabled', () => {
        const s = { ...baseSettings, thinkingEnabled: false };
        const body = buildRequestBody(s, [], []);
        expect(body.reasoning).toBeUndefined();
        expect(body.reasoning_effort).toBeUndefined();
    });

    it('adds stream_options for OpenAI provider', () => {
        const s = { ...baseSettings, selectedProvider: 'openai' };
        const body = buildRequestBody(s, [], []);
        expect(body.stream_options).toEqual({ include_usage: true });
    });
});

// ── buildRequestBody iterate mode ───────────────────────────────────

describe('buildRequestBody iterate mode', () => {
    const baseSettings: PluginSettings = {
        ...DEFAULT_SETTINGS,
        selectedModel: 'gpt-4o',
        temperature: 0.7,
    };

    it('includes ask_user in tools when iterateMode is enabled and tools are enabled', () => {
        const s = { ...baseSettings, toolsEnabled: true, iterateMode: true };
        const body = buildRequestBody(s, [], []);
        const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
        expect(toolNames).toContain('ask_user');
    });

    it('includes ask_user even when tools are disabled but iterateMode is on', () => {
        const s = { ...baseSettings, toolsEnabled: false, iterateMode: true };
        const body = buildRequestBody(s, [], []);
        const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
        expect(toolNames).toContain('ask_user');
    });

    it('does not duplicate ask_user when already in enabled tools', () => {
        const s = { ...baseSettings, toolsEnabled: true, iterateMode: true, disabledTools: [] };
        const body = buildRequestBody(s, [], []);
        const askUserCount = body.tools?.filter((t: any) => t.function.name === 'ask_user').length ?? 0;
        expect(askUserCount).toBe(1);
    });

    it('does not include ask_user when iterateMode is off', () => {
        const s = { ...baseSettings, toolsEnabled: false, iterateMode: false };
        const body = buildRequestBody(s, [], []);
        expect(body.tools).toBeUndefined();
    });
});

// ── buildResponsesRequestBody ───────────────────────────────────────

describe('buildResponsesRequestBody', () => {
    const baseSettings: PluginSettings = {
        ...DEFAULT_SETTINGS,
        selectedProvider: 'copilot',
        selectedModel: 'gpt-5-mini',
        thinkingEnabled: true,
        toolsEnabled: false,
    };

    it('includes model and input fields', () => {
        const msgs = [{ role: 'user' as const, content: 'hello' }];
        const body = buildResponsesRequestBody(baseSettings, msgs, []);
        expect(body.model).toBe('gpt-5-mini');
        expect(body.input).toEqual(msgs);
    });

    it('sets stream and store correctly', () => {
        const body = buildResponsesRequestBody(baseSettings, [], []);
        expect(body.stream).toBe(true);
        expect(body.store).toBe(false);
    });

    it('includes reasoning config with effort high and summary detailed', () => {
        const body = buildResponsesRequestBody(baseSettings, [], []);
        expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    });

    it('does not include messages field (uses input instead)', () => {
        const body = buildResponsesRequestBody(baseSettings, [{ role: 'user', content: 'hi' }], []);
        expect((body as any).messages).toBeUndefined();
        expect(body.input).toBeDefined();
    });

    it('includes tools when toolsEnabled', () => {
        const s = { ...baseSettings, toolsEnabled: true };
        const body = buildResponsesRequestBody(s, [], []);
        expect(body.tools).toBeDefined();
        expect(body.tools!.length).toBeGreaterThan(0);
    });

    it('skips temperature for thinking-capable Copilot model', () => {
        const models: ModelInfo[] = [{ id: 'gpt-5-mini', name: 'gpt-5-mini', provider: 'copilot', supportsThinking: true }];
        const s = { ...baseSettings, thinkingEnabled: true, temperature: 0.7 };
        const body = buildResponsesRequestBody(s, [], models);
        expect(body.temperature).toBeUndefined();
    });
});

// ── Copilot tool schema format tests ────────────────────────────────

describe('Copilot tool calling', () => {
    const copilotSettings: PluginSettings = {
        ...DEFAULT_SETTINGS,
        selectedProvider: 'copilot',
        selectedModel: 'gpt-4.1',
        toolsEnabled: true,
        disabledTools: [],
    };

    describe('Chat Completions tool format', () => {
        it('uses nested {type, function: {name, ...}} format', () => {
            const body = buildRequestBody(copilotSettings, [], []);
            expect(body.tools).toBeDefined();
            for (const tool of body.tools) {
                expect(tool.type).toBe('function');
                expect(tool.function).toBeDefined();
                expect(tool.function.name).toBeDefined();
            }
        });
    });

    describe('Responses API tool format', () => {
        const responsesSettings: PluginSettings = {
            ...copilotSettings,
            thinkingEnabled: true,
        };

        it('uses flat {type, name, description, parameters} format', () => {
            const body = buildResponsesRequestBody(responsesSettings, [], []);
            expect(body.tools).toBeDefined();
            for (const tool of body.tools!) {
                expect(tool.type).toBe('function');
                expect((tool as any).name).toBeDefined();
                expect((tool as any).parameters).toBeDefined();
                // Must NOT have nested function key
                expect((tool as any).function).toBeUndefined();
            }
        });

        it('excludes disabled tools in flat format too', () => {
            const s = { ...responsesSettings, disabledTools: ['search_vault', 'fetch_url'] };
            const body = buildResponsesRequestBody(s, [], []);
            const toolNames = body.tools!.map((t: any) => t.name);
            expect(toolNames).not.toContain('search_vault');
            expect(toolNames).not.toContain('fetch_url');
            expect(toolNames).toContain('read_note');
        });
    });
});

// ── getActiveCopilotOAuthToken ──────────────────────────────────────

describe('getActiveCopilotOAuthToken', () => {
    it('returns active account token when found', () => {
        const settings = {
            copilotAccounts: [
                { id: 'acct-1', oauthToken: 'token-1' },
                { id: 'acct-2', oauthToken: 'token-2' },
            ],
            activeCopilotAccountId: 'acct-2',
            copilotToken: 'legacy-token',
        };
        expect(getActiveCopilotOAuthToken(settings)).toBe('token-2');
    });

    it('falls back to copilotToken when no accounts', () => {
        const settings = {
            copilotAccounts: [],
            activeCopilotAccountId: '',
            copilotToken: 'legacy-token',
        };
        expect(getActiveCopilotOAuthToken(settings)).toBe('legacy-token');
    });

    it('falls back to copilotToken when activeCopilotAccountId does not match', () => {
        const settings = {
            copilotAccounts: [
                { id: 'acct-1', oauthToken: 'token-1' },
            ],
            activeCopilotAccountId: 'nonexistent',
            copilotToken: 'legacy-token',
        };
        expect(getActiveCopilotOAuthToken(settings)).toBe('legacy-token');
    });

    it('returns empty string when no token anywhere', () => {
        const settings = {
            copilotAccounts: [],
            activeCopilotAccountId: '',
            copilotToken: '',
        };
        expect(getActiveCopilotOAuthToken(settings)).toBe('');
    });
});

// ── getApiKeyForProvider (multi-account copilot) ────────────────────

describe('getApiKeyForProvider', () => {
    it('returns openai key for openai provider', () => {
        const settings = { ...DEFAULT_SETTINGS, openaiApiKey: 'sk-openai' };
        expect(getApiKeyForProvider('openai', settings)).toBe('sk-openai');
    });

    it('returns openrouter key for openrouter provider', () => {
        const settings = { ...DEFAULT_SETTINGS, openrouterApiKey: 'sk-or' };
        expect(getApiKeyForProvider('openrouter', settings)).toBe('sk-or');
    });

    it('returns active copilot account token when matched', () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            copilotAccounts: [
                { id: 'acct-1', oauthToken: 'oauth-1', label: 'Work' },
            ],
            activeCopilotAccountId: 'acct-1',
            copilotToken: 'legacy',
        };
        expect(getApiKeyForProvider('copilot', settings)).toBe('oauth-1');
    });

    it('falls back to copilotToken when no copilot accounts', () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            copilotAccounts: [],
            activeCopilotAccountId: '',
            copilotToken: 'legacy-fallback',
        };
        expect(getApiKeyForProvider('copilot', settings)).toBe('legacy-fallback');
    });

    it('returns empty string for unknown provider', () => {
        expect(getApiKeyForProvider('unknown', DEFAULT_SETTINGS)).toBe('');
    });
});

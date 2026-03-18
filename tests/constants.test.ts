import { describe, it, expect } from 'vitest';
import { PROVIDERS, PROVIDER_IDS, DEFAULT_SETTINGS } from '../src/constants';

// ── PROVIDERS ───────────────────────────────────────────────────────

describe('PROVIDERS', () => {
    it('has openai, openrouter, and copilot', () => {
        expect(PROVIDERS.openai).toBeDefined();
        expect(PROVIDERS.openrouter).toBeDefined();
        expect(PROVIDERS.copilot).toBeDefined();
    });

    it('each provider has required properties', () => {
        for (const [id, config] of Object.entries(PROVIDERS)) {
            expect(config.label).toBeTruthy();
            expect(config.url).toBeTruthy();
            // modelsUrl can be empty (Copilot has no models endpoint)
            expect(typeof config.modelsUrl).toBe('string');
            expect(config.storageKey).toBeTruthy();
            expect(typeof config.headers).toBe('function');
            expect(config.fallbackModels).toBeInstanceOf(Array);
            expect(config.fallbackModels.length).toBeGreaterThan(0);
            expect(config.defaultModel).toBeTruthy();
        }
    });

    it('openai headers contain Authorization', () => {
        const headers = PROVIDERS.openai.headers('test-key');
        expect(headers['Authorization']).toBe('Bearer test-key');
    });

    it('openrouter headers contain Authorization and Referer', () => {
        const headers = PROVIDERS.openrouter.headers('test-key');
        expect(headers['Authorization']).toBe('Bearer test-key');
        expect(headers['HTTP-Referer']).toBeTruthy();
        expect(headers['X-Title']).toBeTruthy();
    });

    it('copilot headers contain Authorization and Copilot-specific headers', () => {
        const headers = PROVIDERS.copilot.headers('test-token');
        expect(headers['Authorization']).toBe('Bearer test-token');
        expect(headers['Editor-Version']).toBe('vscode/1.109.5');
        expect(headers['Editor-Plugin-Version']).toBe('copilot-chat/0.37.0');
        expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
        expect(headers['Openai-Intent']).toBe('conversation-panel');
        expect(headers['x-initiator']).toBe('user');
    });

    it('copilot headers set x-initiator to agent when isAgent is true', () => {
        const headers = PROVIDERS.copilot.headers('test-token', { isAgent: true });
        expect(headers['x-initiator']).toBe('agent');
        expect(headers['Openai-Intent']).toBe('conversation-edits');
    });

    it('copilot has OAuth authType', () => {
        expect(PROVIDERS.copilot.authType).toBe('oauth');
    });

    it('copilot fallback models have multiplier metadata', () => {
        for (const model of PROVIDERS.copilot.fallbackModels) {
            expect(typeof model.multiplier).toBe('number');
        }
    });

    it('fallback models conform to ModelInfo interface', () => {
        for (const provider of Object.values(PROVIDERS)) {
            for (const model of provider.fallbackModels) {
                expect(model.id).toBeTruthy();
                expect(model.label).toBeTruthy();
                expect(typeof model.supportsVision).toBe('boolean');
                expect(typeof model.supportsThinking).toBe('boolean');
                expect(typeof model.supportsImageGen).toBe('boolean');
                expect(typeof model.supportsTools).toBe('boolean');
            }
        }
    });

    it('default model exists in fallback models', () => {
        for (const provider of Object.values(PROVIDERS)) {
            const ids = provider.fallbackModels.map(m => m.id);
            expect(ids).toContain(provider.defaultModel);
        }
    });
});

// ── PROVIDER_IDS ────────────────────────────────────────────────────

describe('PROVIDER_IDS', () => {
    it('matches PROVIDERS keys', () => {
        expect(PROVIDER_IDS.sort()).toEqual(Object.keys(PROVIDERS).sort());
    });
});

// ── DEFAULT_SETTINGS ────────────────────────────────────────────────

describe('DEFAULT_SETTINGS', () => {
    it('has valid default provider', () => {
        expect(PROVIDER_IDS).toContain(DEFAULT_SETTINGS.selectedProvider);
    });

    it('temperature is in valid range', () => {
        expect(DEFAULT_SETTINGS.temperature).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_SETTINGS.temperature).toBeLessThanOrEqual(2);
    });
});

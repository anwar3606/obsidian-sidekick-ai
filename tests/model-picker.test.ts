import { describe, it, expect, beforeEach } from 'vitest';
import { ModelPicker, fuzzyScore, fuzzyFilterModels } from '../src/model-picker';
import type { ModelInfo } from '../src/types';

/**
 * ModelPicker behavioral tests.
 *
 * Since ModelPicker is heavily DOM-dependent, these tests focus on
 * the cache behavior and public API rather than full rendering.
 */

function createMockOverlay(): any {
    return {
        style: {},
        empty() {},
        createDiv() { return createMockOverlay(); },
        createEl() { return createMockOverlay(); },
        createSpan() { return createMockOverlay(); },
        addEventListener() {},
        children: [],
        textContent: '',
    };
}

describe('ModelPicker', () => {
    let picker: ModelPicker;

    beforeEach(() => {
        picker = new ModelPicker(createMockOverlay());
    });

    it('starts with empty cached models', () => {
        expect(picker.getCachedModels()).toEqual([]);
    });

    it('close hides overlay', () => {
        const overlay = createMockOverlay();
        const p = new ModelPicker(overlay);
        p.close();
        expect(overlay.style.display).toBe('none');
    });

    it('getCachedModels returns a reference to the internal cache', () => {
        const models = picker.getCachedModels();
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBe(0);
    });

    describe('cache invalidation behavior', () => {
        it('cache is empty by default — forces fresh fetch on first open', () => {
            expect(picker.getCachedModels().length).toBe(0);
        });

        it('clearing cachedModels simulates provider switch behavior', () => {
            // The fix: provider tab click now does `this.cachedModels = []` before re-opening
            // This ensures models are re-fetched for the new provider
            const fakeModels: ModelInfo[] = [
                { id: 'model-1', label: 'Model 1', supportsVision: false, supportsThinking: false, supportsImageGen: false, supportsTools: false },
            ];

            // Simulate cached state
            (picker as any).cachedModels = fakeModels;
            expect(picker.getCachedModels().length).toBe(1);

            // Simulate what provider switch does
            (picker as any).cachedModels = [];
            expect(picker.getCachedModels().length).toBe(0);
        });

        it('close+reopen without clearing cache reuses stale models', () => {
            const fakeModels: ModelInfo[] = [
                { id: 'old-model', label: 'Old', supportsVision: false, supportsThinking: false, supportsImageGen: false, supportsTools: false },
            ];
            (picker as any).cachedModels = fakeModels;
            picker.close();

            // Without clearing, cache persists — this was the bug
            expect(picker.getCachedModels().length).toBe(1);
            expect(picker.getCachedModels()[0].id).toBe('old-model');
        });
    });
});

// ── Fuzzy search tests ──────────────────────────────────────────────

function makeModel(overrides: Partial<ModelInfo> & { id: string; label: string }): ModelInfo {
    return {
        supportsVision: false,
        supportsThinking: false,
        supportsImageGen: false,
        supportsTools: false,
        ...overrides,
    };
}

describe('fuzzyScore', () => {
    it('returns 0 for empty pattern', () => {
        expect(fuzzyScore('', 'anything')).toBe(0);
    });

    it('returns 0 for exact match at start', () => {
        expect(fuzzyScore('gpt', 'gpt-4o')).toBe(0);
    });

    it('returns positive score for substring match later in text', () => {
        const s = fuzzyScore('4o', 'gpt-4o');
        expect(s).toBeGreaterThan(0);
    });

    it('returns -1 when no match', () => {
        expect(fuzzyScore('xyz', 'gpt-4o')).toBe(-1);
    });

    it('is case-insensitive', () => {
        expect(fuzzyScore('GPT', 'gpt-4o')).toBe(0);
    });

    it('matches non-contiguous characters', () => {
        const s = fuzzyScore('g4', 'gpt-4o');
        expect(s).toBeGreaterThanOrEqual(0);
    });

    it('scores contiguous matches better than scattered', () => {
        const contiguous = fuzzyScore('gpt4', 'gpt-4o-mini');
        const scattered = fuzzyScore('gpt4', 'g---p---t---4');
        expect(contiguous).toBeLessThan(scattered);
    });

    it('scores start-of-string matches best', () => {
        const startMatch = fuzzyScore('gpt', 'gpt-4o-mini');
        const midMatch = fuzzyScore('gpt', 'openai/gpt-4o-mini');
        expect(startMatch).toBeLessThan(midMatch);
    });
});

describe('fuzzyFilterModels', () => {
    const models: ModelInfo[] = [
        makeModel({ id: 'gpt-4o', label: 'GPT-4o', supportsVision: true, supportsTools: true, context_length: 128000 }),
        makeModel({ id: 'gpt-4o-mini', label: 'GPT-4o Mini', supportsVision: true, supportsTools: true }),
        makeModel({ id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', supportsThinking: true, supportsTools: true }),
        makeModel({ id: 'dall-e-3', label: 'DALL-E 3', supportsImageGen: true }),
        makeModel({ id: 'o3', label: 'o3', supportsThinking: true, included: true }),
    ];

    it('returns all models for empty query', () => {
        expect(fuzzyFilterModels(models, '')).toHaveLength(models.length);
    });

    it('finds models by exact name', () => {
        const results = fuzzyFilterModels(models, 'GPT-4o');
        expect(results[0].id).toBe('gpt-4o');
    });

    it('finds models by partial fuzzy query', () => {
        const results = fuzzyFilterModels(models, 'sonnet');
        expect(results.some(m => m.id.includes('claude'))).toBe(true);
    });

    it('finds models by capability keyword "vision"', () => {
        const results = fuzzyFilterModels(models, 'vision');
        expect(results.every(m => m.supportsVision)).toBe(true);
        expect(results.length).toBe(2);
    });

    it('finds models by capability keyword "thinking"', () => {
        const results = fuzzyFilterModels(models, 'thinking');
        expect(results.every(m => m.supportsThinking)).toBe(true);
    });

    it('finds models by "image" keyword', () => {
        const results = fuzzyFilterModels(models, 'image');
        expect(results.some(m => m.id === 'dall-e-3')).toBe(true);
    });

    it('finds models by context length', () => {
        const results = fuzzyFilterModels(models, '128000');
        expect(results.some(m => m.id === 'gpt-4o')).toBe(true);
    });

    it('finds included/free models', () => {
        const results = fuzzyFilterModels(models, 'included');
        expect(results.some(m => m.id === 'o3')).toBe(true);
    });

    it('returns empty array when nothing matches', () => {
        expect(fuzzyFilterModels(models, 'zzzznotexist')).toHaveLength(0);
    });

    it('ranks exact start-match higher', () => {
        const results = fuzzyFilterModels(models, 'gpt');
        // GPT-4o should be first (start match)
        expect(results[0].id).toBe('gpt-4o');
    });

    it('handles whitespace-only query as empty', () => {
        expect(fuzzyFilterModels(models, '   ')).toHaveLength(models.length);
    });
});

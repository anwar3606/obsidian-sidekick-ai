import { describe, it, expect } from 'vitest';
import {
    BUILT_IN_PRESETS,
    getPreset,
    getDefaultPreset,
    getEffectivePrompt,
    formatPresetList,
} from '../lib/agents';

describe('BUILT_IN_PRESETS', () => {
    it('has at least 5 presets', () => {
        expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(5);
    });

    it('each preset has required fields', () => {
        for (const p of BUILT_IN_PRESETS) {
            expect(p.id).toBeTruthy();
            expect(p.name).toBeTruthy();
            expect(p.icon).toBeTruthy();
            expect(p.description).toBeTruthy();
            expect(typeof p.systemPrompt).toBe('string');
        }
    });

    it('has unique IDs', () => {
        const ids = BUILT_IN_PRESETS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('first preset is default', () => {
        expect(BUILT_IN_PRESETS[0].id).toBe('default');
    });

    it('default preset has empty systemPrompt', () => {
        expect(BUILT_IN_PRESETS[0].systemPrompt).toBe('');
    });

    it('each preset has starters with 4 items', () => {
        for (const p of BUILT_IN_PRESETS) {
            expect(p.starters).toBeDefined();
            expect(p.starters!.length).toBe(4);
            for (const s of p.starters!) {
                expect(s.icon).toBeTruthy();
                expect(s.text).toBeTruthy();
            }
        }
    });
});

describe('getPreset', () => {
    it('returns preset by ID', () => {
        const preset = getPreset('code-expert');
        expect(preset).toBeDefined();
        expect(preset!.name).toBe('Code Expert');
    });

    it('returns undefined for unknown ID', () => {
        expect(getPreset('nonexistent')).toBeUndefined();
    });
});

describe('getDefaultPreset', () => {
    it('returns the default preset', () => {
        const d = getDefaultPreset();
        expect(d.id).toBe('default');
    });
});

describe('getEffectivePrompt', () => {
    it('returns preset prompt for non-default presets', () => {
        const prompt = getEffectivePrompt('code-expert', 'fallback');
        expect(prompt).toContain('software engineer');
        expect(prompt).not.toBe('fallback');
    });

    it('returns fallback for default preset', () => {
        const prompt = getEffectivePrompt('default', 'my custom prompt');
        expect(prompt).toBe('my custom prompt');
    });

    it('returns fallback for unknown preset', () => {
        const prompt = getEffectivePrompt('unknown', 'fallback');
        expect(prompt).toBe('fallback');
    });
});

describe('formatPresetList', () => {
    it('includes all preset names', () => {
        const list = formatPresetList();
        for (const p of BUILT_IN_PRESETS) {
            expect(list).toContain(p.name);
        }
    });

    it('includes icons', () => {
        const list = formatPresetList();
        expect(list).toContain('🤖');
        expect(list).toContain('💻');
    });
});

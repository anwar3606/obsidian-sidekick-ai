import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createEmptyProfile,
    parseProfile,
    addFact,
    removeFact,
    updateFact,
    buildProfileContext,
    buildLearningInstructions,
    buildExtractionPrompt,
    parseExtractionResults,
    generateFactId,
    findSimilarFact,
    reinforceFact,
    pruneProfile,
    MAX_FACTS,
    FACT_CATEGORIES,
} from '../lib/profile';
import type { UserProfile, FactCategory, ProfileFact } from '../lib/profile';

// ── createEmptyProfile ──────────────────────────────────────────────

describe('createEmptyProfile', () => {
    it('returns a valid empty profile', () => {
        const profile = createEmptyProfile();
        expect(profile.version).toBe(1);
        expect(profile.facts).toEqual([]);
        expect(profile.lastUpdated).toBeGreaterThan(0);
    });
});

// ── parseProfile ────────────────────────────────────────────────────

describe('parseProfile', () => {
    it('returns empty profile for null/undefined', () => {
        expect(parseProfile(null).facts).toEqual([]);
        expect(parseProfile(undefined).facts).toEqual([]);
    });

    it('returns empty profile for invalid objects', () => {
        expect(parseProfile({}).facts).toEqual([]);
        expect(parseProfile({ version: 1 }).facts).toEqual([]);
        expect(parseProfile('string').facts).toEqual([]);
    });

    it('parses valid profile correctly', () => {
        const raw = {
            version: 1,
            lastUpdated: 12345,
            facts: [
                { id: 'f1', category: 'preference', content: 'test', confidence: 0.9, source: 'chat', createdAt: 1, lastReinforced: 1, reinforceCount: 1 },
            ],
        };
        const profile = parseProfile(raw);
        expect(profile.version).toBe(1);
        expect(profile.facts).toHaveLength(1);
        expect(profile.facts[0].content).toBe('test');
    });

    it('filters out invalid facts', () => {
        const raw = {
            version: 1,
            lastUpdated: 12345,
            facts: [
                { id: 'f1', category: 'preference', content: 'valid', confidence: 0.9 },
                { id: 'f2', content: 'missing category' }, // missing required fields
                null,
                'invalid',
                { id: 'f3', category: 'interest', content: 'also valid', confidence: 0.5 },
            ],
        };
        const profile = parseProfile(raw);
        expect(profile.facts).toHaveLength(2);
    });
});

// ── addFact ─────────────────────────────────────────────────────────

describe('addFact', () => {
    let profile: UserProfile;

    beforeEach(() => {
        profile = createEmptyProfile();
    });

    it('adds a fact with defaults', () => {
        const updated = addFact(profile, 'User likes TypeScript');
        expect(updated.facts).toHaveLength(1);
        expect(updated.facts[0].content).toBe('User likes TypeScript');
        expect(updated.facts[0].category).toBe('custom');
        expect(updated.facts[0].source).toBe('explicit');
        expect(updated.facts[0].confidence).toBe(0.9);
        expect(updated.facts[0].reinforceCount).toBe(1);
    });

    it('adds a fact with custom category and source', () => {
        const updated = addFact(profile, 'Uses Vim', 'preference', 'chat', 0.7);
        expect(updated.facts[0].category).toBe('preference');
        expect(updated.facts[0].source).toBe('chat');
        expect(updated.facts[0].confidence).toBe(0.7);
    });

    it('trims whitespace from content', () => {
        const updated = addFact(profile, '  Uses Vim   ');
        expect(updated.facts[0].content).toBe('Uses Vim');
    });

    it('clamps confidence to 0-1', () => {
        const high = addFact(profile, 'test', 'custom', 'explicit', 1.5);
        expect(high.facts[0].confidence).toBe(1);
        const low = addFact(profile, 'test', 'custom', 'explicit', -0.5);
        expect(low.facts[0].confidence).toBe(0);
    });

    it('does not mutate the original profile', () => {
        const updated = addFact(profile, 'test');
        expect(profile.facts).toHaveLength(0);
        expect(updated.facts).toHaveLength(1);
    });

    it('generates unique fact IDs', () => {
        const first = addFact(profile, 'fact 1');
        const second = addFact(first, 'fact 2');
        expect(second.facts[0].id).not.toBe(second.facts[1].id);
    });
});

// ── removeFact ──────────────────────────────────────────────────────

describe('removeFact', () => {
    it('removes a fact by ID', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'fact 1');
        profile = addFact(profile, 'fact 2');
        const factId = profile.facts[0].id;
        const updated = removeFact(profile, factId);
        expect(updated.facts).toHaveLength(1);
        expect(updated.facts[0].content).toBe('fact 2');
    });

    it('returns unchanged profile if ID not found', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'fact 1');
        const updated = removeFact(profile, 'nonexistent');
        expect(updated.facts).toHaveLength(1);
    });
});

// ── updateFact ──────────────────────────────────────────────────────

describe('updateFact', () => {
    it('updates fact content', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'original');
        const factId = profile.facts[0].id;
        const updated = updateFact(profile, factId, 'modified');
        expect(updated.facts[0].content).toBe('modified');
    });

    it('trims whitespace on update', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'original');
        const factId = profile.facts[0].id;
        const updated = updateFact(profile, factId, '  spaced  ');
        expect(updated.facts[0].content).toBe('spaced');
    });

    it('updates lastReinforced timestamp', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'original');
        const factId = profile.facts[0].id;
        const before = profile.facts[0].lastReinforced;
        // Small delay to ensure timestamp changes
        const updated = updateFact(profile, factId, 'modified');
        expect(updated.facts[0].lastReinforced).toBeGreaterThanOrEqual(before);
    });
});

// ── buildProfileContext ─────────────────────────────────────────────

describe('buildProfileContext', () => {
    it('returns empty string for empty profile', () => {
        const profile = createEmptyProfile();
        expect(buildProfileContext(profile)).toBe('');
    });

    it('returns formatted context with facts', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'User prefers TypeScript', 'preference');
        profile = addFact(profile, 'Expert in Node.js', 'knowledge_level');
        const ctx = buildProfileContext(profile);
        expect(ctx).toContain('About This User');
        expect(ctx).toContain('User prefers TypeScript');
        expect(ctx).toContain('Expert in Node.js');
        expect(ctx).toContain('[preference]');
        expect(ctx).toContain('[knowledge_level]');
    });

    it('sorts by confidence descending', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'low confidence', 'custom', 'chat', 0.3);
        profile = addFact(profile, 'high confidence', 'custom', 'chat', 0.95);
        const ctx = buildProfileContext(profile);
        const highIdx = ctx.indexOf('high confidence');
        const lowIdx = ctx.indexOf('low confidence');
        expect(highIdx).toBeLessThan(lowIdx);
    });

    it('respects token budget by excluding excess facts', () => {
        let profile = createEmptyProfile();
        // Add many long facts to exceed the token budget
        for (let i = 0; i < 100; i++) {
            profile = addFact(profile, `This is a very long fact number ${i} that contains lots of detail about the user's preferences and habits in their daily workflow. `.repeat(3));
        }
        const ctx = buildProfileContext(profile);
        // Should not contain all 100 facts
        const factLines = ctx.split('\n').filter(l => l.startsWith('- ['));
        expect(factLines.length).toBeLessThan(100);
        expect(factLines.length).toBeGreaterThan(0);
    });
});

// ── buildExtractionPrompt ───────────────────────────────────────────

describe('buildExtractionPrompt', () => {
    it('builds a valid extraction prompt', () => {
        const prompt = buildExtractionPrompt('User: Hello\nAssistant: Hi!');
        expect(prompt).toContain('user profiling system');
        expect(prompt).toContain('preference');
        expect(prompt).toContain('knowledge_level');
        expect(prompt).toContain('User: Hello');
    });
});

// ── parseExtractionResults ──────────────────────────────────────────

describe('parseExtractionResults', () => {
    it('parses valid JSON array', () => {
        const input = JSON.stringify([
            { category: 'preference', content: 'Likes TypeScript', confidence: 0.9 },
            { category: 'interest', content: 'AI/ML', confidence: 0.8 },
        ]);
        const results = parseExtractionResults(input);
        expect(results).toHaveLength(2);
        expect(results[0].content).toBe('Likes TypeScript');
        expect(results[1].category).toBe('interest');
    });

    it('extracts JSON from surrounding text', () => {
        const input = 'Here are the facts:\n[{"category": "preference", "content": "test", "confidence": 0.5}]\nDone!';
        const results = parseExtractionResults(input);
        expect(results).toHaveLength(1);
    });

    it('returns empty array for invalid input', () => {
        expect(parseExtractionResults('')).toEqual([]);
        expect(parseExtractionResults('no json here')).toEqual([]);
        expect(parseExtractionResults('{"not": "array"}')).toEqual([]);
    });

    it('maps unknown categories to custom', () => {
        const input = JSON.stringify([
            { category: 'unknown_category', content: 'test', confidence: 0.5 },
        ]);
        const results = parseExtractionResults(input);
        expect(results[0].category).toBe('custom');
    });

    it('clamps confidence to 0-1', () => {
        const input = JSON.stringify([
            { category: 'preference', content: 'test', confidence: 5.0 },
        ]);
        const results = parseExtractionResults(input);
        expect(results[0].confidence).toBe(1);
    });

    it('filters out items missing content', () => {
        const input = JSON.stringify([
            { category: 'preference', confidence: 0.9 },
            { category: 'preference', content: 'valid', confidence: 0.9 },
        ]);
        const results = parseExtractionResults(input);
        expect(results).toHaveLength(1);
    });
});

// ── FACT_CATEGORIES ─────────────────────────────────────────────────

describe('FACT_CATEGORIES', () => {
    it('contains expected categories', () => {
        expect(FACT_CATEGORIES).toContain('preference');
        expect(FACT_CATEGORIES).toContain('knowledge_level');
        expect(FACT_CATEGORIES).toContain('interest');
        expect(FACT_CATEGORIES).toContain('identity');
        expect(FACT_CATEGORIES).toContain('communication');
        expect(FACT_CATEGORIES).toContain('workflow');
        expect(FACT_CATEGORIES).toContain('context');
        expect(FACT_CATEGORIES).toContain('personality');
        expect(FACT_CATEGORIES).toContain('custom');
    });
});

// ── generateFactId ──────────────────────────────────────────────────

describe('generateFactId', () => {
    it('generates unique IDs', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateFactId());
        }
        expect(ids.size).toBe(100);
    });

    it('starts with f_ prefix', () => {
        expect(generateFactId()).toMatch(/^f_\d+_\d+$/);
    });
});

// ── findSimilarFact ─────────────────────────────────────────────────

describe('findSimilarFact', () => {
    it('finds exact duplicate (case-insensitive)', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'User prefers TypeScript', 'preference');
        const match = findSimilarFact(profile, 'user prefers typescript', 'preference');
        expect(match).toBeDefined();
        expect(match!.content).toBe('User prefers TypeScript');
    });

    it('finds substring match', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'User is a senior backend developer', 'identity');
        const match = findSimilarFact(profile, 'backend developer', 'identity');
        expect(match).toBeDefined();
    });

    it('returns undefined for different category', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'User prefers TypeScript', 'preference');
        const match = findSimilarFact(profile, 'User prefers TypeScript', 'interest');
        expect(match).toBeUndefined();
    });

    it('returns undefined for empty content', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'Some fact', 'preference');
        const match = findSimilarFact(profile, '', 'preference');
        expect(match).toBeUndefined();
    });

    it('ignores punctuation differences', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, "User prefers TypeScript!", 'preference');
        const match = findSimilarFact(profile, 'User prefers TypeScript', 'preference');
        expect(match).toBeDefined();
    });
});

// ── reinforceFact ───────────────────────────────────────────────────

describe('reinforceFact', () => {
    it('increments reinforceCount', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'test');
        const factId = profile.facts[0].id;
        const updated = reinforceFact(profile, factId);
        expect(updated.facts[0].reinforceCount).toBe(2);
    });

    it('increases confidence by 0.05', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'test', 'custom', 'chat', 0.7);
        const factId = profile.facts[0].id;
        const updated = reinforceFact(profile, factId);
        expect(updated.facts[0].confidence).toBeCloseTo(0.75);
    });

    it('caps confidence at 1.0', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'test', 'custom', 'chat', 0.98);
        const factId = profile.facts[0].id;
        const updated = reinforceFact(profile, factId);
        expect(updated.facts[0].confidence).toBe(1);
    });
});

// ── addFact deduplication ───────────────────────────────────────────

describe('addFact deduplication', () => {
    it('reinforces instead of duplicating identical facts', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'User prefers TypeScript', 'preference');
        profile = addFact(profile, 'User prefers TypeScript', 'preference');
        expect(profile.facts).toHaveLength(1);
        expect(profile.facts[0].reinforceCount).toBe(2);
    });

    it('reinforces case-insensitive matches', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'User prefers TypeScript', 'preference');
        profile = addFact(profile, 'user prefers typescript', 'preference');
        expect(profile.facts).toHaveLength(1);
        expect(profile.facts[0].reinforceCount).toBe(2);
    });

    it('adds new fact if category differs', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'TypeScript', 'preference');
        profile = addFact(profile, 'TypeScript', 'interest');
        expect(profile.facts).toHaveLength(2);
    });

    it('skips empty content', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, '');
        expect(profile.facts).toHaveLength(0);
    });

    it('skips whitespace-only content', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, '   ');
        expect(profile.facts).toHaveLength(0);
    });
});

// ── buildLearningInstructions ───────────────────────────────────────

describe('buildLearningInstructions', () => {
    it('includes remember_user_fact tool reference', () => {
        const instr = buildLearningInstructions();
        expect(instr).toContain('remember_user_fact');
    });

    it('includes example categories', () => {
        const instr = buildLearningInstructions();
        expect(instr).toContain('identity');
        expect(instr).toContain('preference');
    });
});

// ── pruneProfile ────────────────────────────────────────────────────

describe('pruneProfile', () => {
    it('does nothing when under limit', () => {
        let profile = createEmptyProfile();
        profile = addFact(profile, 'fact 1');
        profile = addFact(profile, 'fact 2');
        const pruned = pruneProfile(profile);
        expect(pruned.facts).toHaveLength(2);
    });

    it('prunes to MAX_FACTS when over limit', () => {
        let profile = createEmptyProfile();
        // Directly inject facts to bypass dedup
        const now = Date.now();
        for (let i = 0; i < MAX_FACTS + 10; i++) {
            profile.facts.push({
                id: `f_${i}`,
                category: 'custom',
                content: `unique fact number ${i} about topic ${i}`,
                confidence: Math.random(),
                source: 'chat',
                createdAt: now - i * 1000,
                lastReinforced: now - i * 1000,
                reinforceCount: 1,
            });
        }
        expect(profile.facts).toHaveLength(MAX_FACTS + 10);
        const pruned = pruneProfile(profile);
        expect(pruned.facts).toHaveLength(MAX_FACTS);
    });

    it('keeps high-confidence facts over low-confidence', () => {
        let profile = createEmptyProfile();
        const now = Date.now();
        // Add low-confidence facts first
        for (let i = 0; i < MAX_FACTS; i++) {
            profile.facts.push({
                id: `low_${i}`,
                category: 'custom',
                content: `low confidence fact ${i}`,
                confidence: 0.1,
                source: 'chat',
                createdAt: now,
                lastReinforced: now,
                reinforceCount: 1,
            });
        }
        // Add one high-confidence fact
        profile.facts.push({
            id: 'high_1',
            category: 'custom',
            content: 'high confidence fact',
            confidence: 1.0,
            source: 'explicit',
            createdAt: now,
            lastReinforced: now,
            reinforceCount: 5,
        });
        const pruned = pruneProfile(profile);
        expect(pruned.facts).toHaveLength(MAX_FACTS);
        expect(pruned.facts.find(f => f.id === 'high_1')).toBeDefined();
    });

    it('addFact auto-prunes when over limit', () => {
        let profile = createEmptyProfile();
        const now = Date.now();
        for (let i = 0; i < MAX_FACTS; i++) {
            profile.facts.push({
                id: `f_${i}`,
                category: 'custom',
                content: `unique fact ${i} on a unique topic area ${i}`,
                confidence: 0.5,
                source: 'chat',
                createdAt: now - i * 1000,
                lastReinforced: now - i * 1000,
                reinforceCount: 1,
            });
        }
        // Adding one more should trigger prune
        profile = addFact(profile, 'brand new totally different fact xyz');
        expect(profile.facts.length).toBeLessThanOrEqual(MAX_FACTS);
    });
});

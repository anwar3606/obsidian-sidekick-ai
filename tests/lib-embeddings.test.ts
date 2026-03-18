/**
 * Tests for lib/embeddings.ts — vector math, chunking, search, serialisation.
 */
import { describe, it, expect } from 'vitest';
import {
    cosineSimilarity,
    chunkText,
    searchVectors,
    serializeEmbedding,
    deserializeEmbedding,
    estimateTokens,
    COPILOT_EMBEDDINGS_URL,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_BATCH_TOKENS,
} from '../lib/embeddings';
import type { VectorChunk } from '../lib/embeddings';

// ── Helpers ─────────────────────────────────────────────────────────

function makeChunk(
    path: string,
    chunkIndex: number,
    embedding: number[],
    text = 'test',
    heading?: string,
): VectorChunk {
    return {
        path,
        chunkIndex,
        text,
        heading,
        embedding: new Float32Array(embedding),
        mtime: Date.now(),
    };
}

/** Create a unit vector along a given axis in N dimensions. */
function unitVec(dim: number, axis: number): Float32Array {
    const v = new Float32Array(dim);
    v[axis] = 1;
    return v;
}

// ── cosineSimilarity ────────────────────────────────────────────────

describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
        const a = new Float32Array([1, 2, 3]);
        expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
        const a = unitVec(3, 0);
        const b = unitVec(3, 1);
        expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('returns -1 for opposite vectors', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([-1, 0, 0]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
    });

    it('returns 0 for zero vector', () => {
        const a = new Float32Array([1, 2, 3]);
        const b = new Float32Array([0, 0, 0]);
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('returns 0 for different-length vectors', () => {
        const a = new Float32Array([1, 2]);
        const b = new Float32Array([1, 2, 3]);
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('computes correct value for non-trivial vectors', () => {
        const a = new Float32Array([1, 2, 3]);
        const b = new Float32Array([4, 5, 6]);
        // dot = 32, |a| = sqrt(14), |b| = sqrt(77)
        const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
        expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
    });

    it('handles high-dimensional vectors (256 dims)', () => {
        const a = new Float32Array(256).fill(1);
        const b = new Float32Array(256).fill(1);
        expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    });

    it('is symmetric', () => {
        const a = new Float32Array([1, -3, 5, 7]);
        const b = new Float32Array([2, 4, -6, 8]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
    });
});

// ── chunkText ───────────────────────────────────────────────────────

describe('chunkText', () => {
    it('returns empty array for empty text', () => {
        expect(chunkText('')).toEqual([]);
        expect(chunkText('   ')).toEqual([]);
    });

    it('returns single chunk for short text', () => {
        const text = 'Hello world, this is a test.';
        const chunks = chunkText(text);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toBe(text);
        expect(chunks[0].heading).toBeUndefined();
    });

    it('splits by headings', () => {
        const text = `# Introduction
Some intro text.

## Methods
Method details here.

## Results
Result data.`;
        const chunks = chunkText(text);
        expect(chunks).toHaveLength(3);
        expect(chunks[0].heading).toBe('Introduction');
        expect(chunks[0].text).toContain('intro text');
        expect(chunks[1].heading).toBe('Methods');
        expect(chunks[1].text).toContain('Method details');
        expect(chunks[2].heading).toBe('Results');
        expect(chunks[2].text).toContain('Result data');
    });

    it('includes content before first heading as a headingless chunk', () => {
        const text = `Some frontmatter stuff.

# Heading
Content.`;
        const chunks = chunkText(text);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].heading).toBeUndefined();
        expect(chunks[0].text).toContain('frontmatter');
        expect(chunks[1].heading).toBe('Heading');
    });

    it('handles deeply nested headings (h1-h6)', () => {
        const text = `# H1
h1 content
## H2
h2 content
### H3
h3 content
#### H4
h4 content
##### H5
h5 content
###### H6
h6 content`;
        const chunks = chunkText(text);
        expect(chunks).toHaveLength(6);
        expect(chunks[0].heading).toBe('H1');
        expect(chunks[5].heading).toBe('H6');
    });

    it('splits large sections by token window', () => {
        // Each line is ~8 tokens (32 chars). With maxTokens=40, expect splits.
        const lines = Array.from({ length: 30 }, (_, i) => `This is line number ${i} of text.`);
        const text = lines.join('\n');
        const chunks = chunkText(text, { maxTokens: 40, overlap: 5 });
        expect(chunks.length).toBeGreaterThan(1);
        // All original text should be covered
        const combined = chunks.map(c => c.text).join('\n');
        for (const line of lines) {
            expect(combined).toContain(line);
        }
    });

    it('respects overlap between chunks', () => {
        const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: some padding text here.`);
        const text = lines.join('\n');
        const chunks = chunkText(text, { maxTokens: 30, overlap: 10 });
        // Adjacent chunks should share some text
        if (chunks.length >= 2) {
            const chunk0Lines = chunks[0].text.split('\n');
            const chunk1Lines = chunks[1].text.split('\n');
            const lastOfFirst = chunk0Lines[chunk0Lines.length - 1];
            expect(chunk1Lines.some(l => l === lastOfFirst)).toBe(true);
        }
    });

    it('handles heading with large section underneath', () => {
        const bigContent = Array.from({ length: 50 }, (_, i) => `Sentence ${i} of the big section.`).join('\n');
        const text = `# Big Section\n${bigContent}`;
        const chunks = chunkText(text, { maxTokens: 50 });
        expect(chunks.length).toBeGreaterThan(1);
        // All chunks should inherit the heading
        for (const chunk of chunks) {
            expect(chunk.heading).toBe('Big Section');
        }
    });

    it('does not treat # inside text as heading', () => {
        const text = 'Use C# for development.\nAlso try F#.';
        const chunks = chunkText(text);
        expect(chunks).toHaveLength(1);
    });

    it('handles frontmatter block', () => {
        const text = `---
title: My Note
tags: [test]
---

# Content
Actual content here.`;
        const chunks = chunkText(text);
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks[0].text).toContain('title: My Note');
    });

    it('returns default options when none specified', () => {
        // Just ensure it doesn't crash with no options
        const text = 'Simple text.';
        const chunks = chunkText(text);
        expect(chunks).toHaveLength(1);
    });
});

// ── searchVectors ───────────────────────────────────────────────────

describe('searchVectors', () => {
    it('returns empty array when no chunks', () => {
        const query = new Float32Array([1, 0, 0]);
        expect(searchVectors(query, [])).toEqual([]);
    });

    it('returns results sorted by descending score', () => {
        const query = unitVec(3, 0); // [1, 0, 0]
        const chunks = [
            makeChunk('low.md', 0, [0.1, 0.9, 0]),    // low similarity to [1,0,0]
            makeChunk('high.md', 0, [0.9, 0.1, 0]),   // high similarity
            makeChunk('mid.md', 0, [0.5, 0.5, 0]),    // medium
        ];
        const results = searchVectors(query, chunks, 10, 0);
        expect(results[0].path).toBe('high.md');
        expect(results[1].path).toBe('mid.md');
        expect(results[2].path).toBe('low.md');
    });

    it('respects topK limit', () => {
        const query = unitVec(3, 0);
        const chunks = Array.from({ length: 20 }, (_, i) =>
            makeChunk(`file${i}.md`, 0, [1, 0, 0], `text ${i}`),
        );
        const results = searchVectors(query, chunks, 5, 0);
        expect(results).toHaveLength(5);
    });

    it('filters by minScore', () => {
        const query = unitVec(3, 0);
        const chunks = [
            makeChunk('good.md', 0, [1, 0, 0]),     // score ≈ 1
            makeChunk('bad.md', 0, [0, 1, 0]),      // score ≈ 0
            makeChunk('ok.md', 0, [0.7, 0.7, 0]),   // score ≈ 0.707
        ];
        const results = searchVectors(query, chunks, 10, 0.5);
        expect(results.every(r => r.score >= 0.5)).toBe(true);
        expect(results.find(r => r.path === 'bad.md')).toBeUndefined();
    });

    it('includes heading and text in results', () => {
        const query = unitVec(3, 0);
        const chunk = makeChunk('file.md', 2, [1, 0, 0], 'My chunk text', 'Section A');
        const results = searchVectors(query, [chunk], 10, 0);
        expect(results[0].heading).toBe('Section A');
        expect(results[0].text).toBe('My chunk text');
        expect(results[0].chunkIndex).toBe(2);
    });

    it('handles negative cosine scores (should be filtered by minScore > 0)', () => {
        const query = new Float32Array([1, 0, 0]);
        const chunk = makeChunk('opp.md', 0, [-1, 0, 0]); // opposite direction
        const results = searchVectors(query, [chunk], 10, 0.3);
        expect(results).toHaveLength(0);
    });

    it('handles large number of chunks efficiently', () => {
        const query = new Float32Array(256).fill(0.1);
        const chunks = Array.from({ length: 10000 }, (_, i) => {
            const emb = new Float32Array(256);
            emb[i % 256] = 1;
            return {
                path: `file${i}.md`,
                chunkIndex: 0,
                text: `chunk ${i}`,
                embedding: emb,
                mtime: Date.now(),
            } as VectorChunk;
        });
        const start = performance.now();
        const results = searchVectors(query, chunks, 10, 0);
        const elapsed = performance.now() - start;
        expect(results).toHaveLength(10);
        // Should be fast — under 200ms for 10K chunks × 256 dims
        expect(elapsed).toBeLessThan(200);
    });
});

// ── serializeEmbedding / deserializeEmbedding ───────────────────────

describe('serializeEmbedding / deserializeEmbedding', () => {
    it('round-trips a Float32Array', () => {
        const original = new Float32Array([1.5, -2.3, 0, 42.42, -0.001]);
        const serialized = serializeEmbedding(original);
        const deserialized = deserializeEmbedding(serialized);
        expect(deserialized.length).toBe(original.length);
        for (let i = 0; i < original.length; i++) {
            expect(deserialized[i]).toBeCloseTo(original[i], 5);
        }
    });

    it('round-trips empty Float32Array', () => {
        const original = new Float32Array(0);
        const serialized = serializeEmbedding(original);
        const deserialized = deserializeEmbedding(serialized);
        expect(deserialized.length).toBe(0);
    });

    it('round-trips 256-dim vector', () => {
        const original = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            original[i] = Math.sin(i) * 0.1;
        }
        const serialized = serializeEmbedding(original);
        const deserialized = deserializeEmbedding(serialized);
        expect(deserialized.length).toBe(256);
        for (let i = 0; i < 256; i++) {
            expect(deserialized[i]).toBeCloseTo(original[i], 5);
        }
    });

    it('produces base64 output (no non-base64 chars)', () => {
        const original = new Float32Array([1, 2, 3]);
        const serialized = serializeEmbedding(original);
        expect(serialized).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('serialized size is ~4/3 of raw bytes', () => {
        const original = new Float32Array(256); // 1024 bytes raw
        const serialized = serializeEmbedding(original);
        // Base64 is ~4/3 of raw bytes, plus padding
        expect(serialized.length).toBeLessThanOrEqual(Math.ceil(1024 * 4 / 3) + 4);
    });

    it('handles special float values', () => {
        const original = new Float32Array([Infinity, -Infinity, 0, -0]);
        const serialized = serializeEmbedding(original);
        const deserialized = deserializeEmbedding(serialized);
        expect(deserialized[0]).toBe(Infinity);
        expect(deserialized[1]).toBe(-Infinity);
        expect(deserialized[2]).toBe(0);
    });
});

// ── Constants ───────────────────────────────────────────────────────

describe('embedding constants', () => {
    it('COPILOT_EMBEDDINGS_URL is correct', () => {
        expect(COPILOT_EMBEDDINGS_URL).toBe('https://api.githubcopilot.com/embeddings');
    });

    it('DEFAULT_EMBEDDING_MODEL is text-embedding-3-small', () => {
        expect(DEFAULT_EMBEDDING_MODEL).toBe('text-embedding-3-small');
    });

    it('DEFAULT_EMBEDDING_DIMENSIONS is 256', () => {
        expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(256);
    });

    it('MAX_EMBEDDING_BATCH_SIZE is 20', () => {
        expect(MAX_EMBEDDING_BATCH_SIZE).toBe(20);
    });

    it('MAX_BATCH_TOKENS is 7000', () => {
        expect(MAX_BATCH_TOKENS).toBe(7000);
    });
});

// ── estimateTokens ──────────────────────────────────────────────────

describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('returns 1 for single character', () => {
        expect(estimateTokens('a')).toBe(1);
    });

    it('returns 1 for exactly 3 chars', () => {
        expect(estimateTokens('abc')).toBe(1);
    });

    it('uses Math.ceil(chars/3)', () => {
        expect(estimateTokens('abcd')).toBe(2);    // ceil(4/3) = 2
        expect(estimateTokens('abcdef')).toBe(2);  // ceil(6/3) = 2
        expect(estimateTokens('abcdefg')).toBe(3); // ceil(7/3) = 3
    });

    it('handles long strings', () => {
        const text = 'a'.repeat(30000);
        expect(estimateTokens(text)).toBe(10000);
    });

    it('counts emoji as characters', () => {
        // Emoji are 1-2 JS chars but may tokenize as multiple tokens
        expect(estimateTokens('🎉')).toBeGreaterThan(0);
    });
});

// ── chunkText edge cases: long lines & token boundaries ─────────────

describe('chunkText — long line pre-splitting', () => {
    it('splits a single long line into multiple chunks', () => {
        // maxTokens=100, maxChars=300. A 900-char line should become 3 pre-split segments.
        const longLine = 'x'.repeat(900);
        const chunks = chunkText(longLine, { maxTokens: 100 });
        expect(chunks.length).toBeGreaterThan(1);
        // Combined text should cover the full line
        const combined = chunks.map(c => c.text).join('');
        expect(combined.length).toBe(900);
    });

    it('does not split a line at exactly maxChars', () => {
        // maxTokens=100, maxChars=300. Line of exactly 300 chars should NOT pre-split.
        const line = 'y'.repeat(300);
        const chunks = chunkText(line, { maxTokens: 100 });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toBe(line);
    });

    it('splits a line one char over maxChars', () => {
        // maxTokens=100, maxChars=300. Line of 301 chars SHOULD pre-split.
        const line = 'z'.repeat(301);
        const chunks = chunkText(line, { maxTokens: 100 });
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('handles base64-like content (no newlines, thousands of chars)', () => {
        const base64 = 'A'.repeat(10000);
        const chunks = chunkText(base64, { maxTokens: 500, overlap: 50 });
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(510); // small margin for rounding
        }
    });

    it('preserves heading through long-line pre-split', () => {
        const longContent = 'B'.repeat(5000);
        const text = `# My Heading\n${longContent}`;
        const chunks = chunkText(text, { maxTokens: 200 });
        expect(chunks.length).toBeGreaterThan(1);
        // All chunks from the same heading section keep the heading
        for (const chunk of chunks) {
            if (chunk.text !== '# My Heading') {
                expect(chunk.heading).toBe('My Heading');
            }
        }
    });
});

describe('chunkText — token window boundaries', () => {
    it('no chunk exceeds maxTokens (except single oversized lines)', () => {
        // Create text with many lines of varying sizes
        const lines: string[] = [];
        for (let i = 0; i < 100; i++) {
            lines.push('word '.repeat(10 + (i % 20))); // 10-30 words each
        }
        const text = lines.join('\n');
        const chunks = chunkText(text, { maxTokens: 50, overlap: 5 });

        for (const chunk of chunks) {
            const tokens = estimateTokens(chunk.text);
            const chunkLines = chunk.text.split('\n');
            const maxSingleLine = Math.max(...chunkLines.map(l => estimateTokens(l)));
            if (maxSingleLine > 50) {
                // If a single line exceeds maxTokens, chunk can be larger (unavoidable)
                expect(chunkLines.length).toBe(1);
            } else {
                // Multi-line chunks must not exceed maxTokens
                expect(tokens).toBeLessThanOrEqual(51); // +1 for newline rounding
            }
        }
    });

    it('does not create empty chunks', () => {
        const text = 'hello\n\n\n\nworld';
        const chunks = chunkText(text, { maxTokens: 10 });
        for (const chunk of chunks) {
            expect(chunk.text.trim().length).toBeGreaterThan(0);
        }
    });

    it('handles file with no headings', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: some text content.`);
        const text = lines.join('\n');
        const chunks = chunkText(text, { maxTokens: 30 });
        expect(chunks.length).toBeGreaterThan(1);
        // No heading on any chunk
        for (const chunk of chunks) {
            expect(chunk.heading).toBeUndefined();
        }
    });

    it('handles single-char-per-line file', () => {
        const text = Array.from({ length: 500 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('\n');
        const chunks = chunkText(text, { maxTokens: 50 });
        expect(chunks.length).toBeGreaterThan(1);
        // No crash, no infinite loop
    });
});

// ── Token-aware batching simulation ─────────────────────────────────

describe('token-aware batching simulation', () => {
    it('batches never exceed MAX_BATCH_TOKENS', () => {
        // Simulate the batching logic from src/embeddings.ts
        // Use realistic chunk sizes from chunkText output
        const bigText = Array.from({ length: 500 }, (_, i) =>
            `# Section ${i}\n${'word '.repeat(100 + (i % 100))}`
        ).join('\n');
        const chunks = chunkText(bigText, { maxTokens: 500, overlap: 50 });
        const texts = chunks.map(c => c.text);

        const batches: { tokens: number; items: number }[] = [];
        let currentBatch: string[] = [];
        let currentTokens = 0;
        for (const text of texts) {
            const itemTokens = estimateTokens(text);
            if (currentBatch.length > 0 && currentTokens + itemTokens > MAX_BATCH_TOKENS) {
                batches.push({ tokens: currentTokens, items: currentBatch.length });
                currentBatch = [];
                currentTokens = 0;
            }
            if (currentBatch.length >= MAX_EMBEDDING_BATCH_SIZE) {
                batches.push({ tokens: currentTokens, items: currentBatch.length });
                currentBatch = [];
                currentTokens = 0;
            }
            currentBatch.push(text);
            currentTokens += itemTokens;
        }
        if (currentBatch.length > 0) {
            batches.push({ tokens: currentTokens, items: currentBatch.length });
        }

        for (const batch of batches) {
            expect(batch.tokens).toBeLessThanOrEqual(MAX_BATCH_TOKENS + 500); // one item overshoot max
            expect(batch.items).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_SIZE);
        }
    });

    it('chunks from base64-heavy content batch safely', () => {
        // Simulate a file with embedded base64 images
        const base64 = 'A'.repeat(50000);
        const text = `# Title\nSome text\n${base64}\nMore text after`;
        const chunks = chunkText(text, { maxTokens: 500, overlap: 50 });

        // Each chunk, when batched individually, should be under 8192
        for (const chunk of chunks) {
            const tokens = estimateTokens(chunk.text);
            expect(tokens).toBeLessThan(8192);
        }
    });
});

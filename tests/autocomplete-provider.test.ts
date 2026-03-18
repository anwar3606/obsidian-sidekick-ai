import { describe, it, expect } from 'vitest';
import {
    buildCompletionContext,
    buildCompletionPrompt,
    cleanCompletion,
} from '../src/autocomplete-provider';

// ── buildCompletionContext ──────────────────────────────────────────

describe('buildCompletionContext', () => {
    it('extracts prefix and suffix around cursor', () => {
        const doc = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7';
        // Cursor at end of "line 4"
        const cursor = doc.indexOf('line 4') + 6;
        const ctx = buildCompletionContext(doc, cursor, 'Test Note');

        expect(ctx.noteTitle).toBe('Test Note');
        expect(ctx.prefix).toContain('line 4');
        expect(ctx.suffix).toContain('line 5');
    });

    it('handles cursor at start of document', () => {
        const doc = 'Hello world\nSecond line';
        const ctx = buildCompletionContext(doc, 0, 'Note');

        expect(ctx.prefix).toBe('');
        expect(ctx.suffix).toContain('Hello world');
    });

    it('handles cursor at end of document', () => {
        const doc = 'First line\nSecond line\nThird line';
        const ctx = buildCompletionContext(doc, doc.length, 'Note');

        expect(ctx.prefix).toContain('Third line');
        expect(ctx.suffix).toBe('');
    });

    it('handles empty document', () => {
        const ctx = buildCompletionContext('', 0, 'Empty');
        expect(ctx.prefix).toBe('');
        expect(ctx.suffix).toBe('');
    });

    it('limits prefix to 25 lines', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
        const doc = lines.join('\n');
        // Cursor at end
        const ctx = buildCompletionContext(doc, doc.length, 'Note');

        const prefixLines = ctx.prefix.split('\n');
        expect(prefixLines.length).toBeLessThanOrEqual(25);
        expect(prefixLines[prefixLines.length - 1]).toBe('line 40');
    });

    it('limits suffix to 10 lines', () => {
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
        const doc = lines.join('\n');
        // Cursor at start
        const ctx = buildCompletionContext(doc, 0, 'Note');

        const suffixLines = ctx.suffix.split('\n');
        expect(suffixLines.length).toBeLessThanOrEqual(10);
    });

    it('handles single line document', () => {
        const doc = 'Hello world';
        const cursor = 5; // middle of "Hello"
        const ctx = buildCompletionContext(doc, cursor, 'Note');

        expect(ctx.prefix).toBe('Hello');
        expect(ctx.suffix).toBe(' world');
    });

    it('handles empty note title', () => {
        const ctx = buildCompletionContext('Some text', 4, '');
        expect(ctx.noteTitle).toBe('');
    });
});

// ── buildCompletionPrompt ───────────────────────────────────────────

describe('buildCompletionPrompt', () => {
    it('includes note title when present', () => {
        const prompt = buildCompletionPrompt({
            noteTitle: 'My Note',
            prefix: 'Hello world',
            suffix: '',
        });
        expect(prompt).toContain('[Note: My Note]');
    });

    it('omits note title section when empty', () => {
        const prompt = buildCompletionPrompt({
            noteTitle: '',
            prefix: 'Hello world',
            suffix: '',
        });
        expect(prompt).not.toContain('[Note:');
    });

    it('includes prefix text', () => {
        const prompt = buildCompletionPrompt({
            noteTitle: 'Test',
            prefix: 'The quick brown fox',
            suffix: '',
        });
        expect(prompt).toContain('The quick brown fox');
    });

    it('includes suffix inline after cursor marker', () => {
        const prompt = buildCompletionPrompt({
            noteTitle: '',
            prefix: 'Before cursor',
            suffix: 'After cursor',
        });
        expect(prompt).toContain('Before cursor<|cursor|>After cursor');
    });

    it('omits suffix when suffix is whitespace-only', () => {
        const prompt = buildCompletionPrompt({
            noteTitle: '',
            prefix: 'Before cursor',
            suffix: '   \n  ',
        });
        expect(prompt).toContain('Before cursor<|cursor|>');
        expect(prompt).not.toContain('   \n  ');
    });

    it('always ends with FIM insertion instruction', () => {
        const prompt = buildCompletionPrompt({
            noteTitle: '',
            prefix: 'Hello',
            suffix: '',
        });
        expect(prompt).toContain('[Insert the most likely continuation at <|cursor|>.');
    });
});

// ── cleanCompletion ─────────────────────────────────────────────────

describe('cleanCompletion', () => {
    it('returns trimmed text', () => {
        expect(cleanCompletion('  hello world  ')).toBe(' hello world');
    });

    it('removes markdown code fences', () => {
        expect(cleanCompletion('```\nhello world\n```')).toBe('hello world');
    });

    it('removes code fences with language tag', () => {
        expect(cleanCompletion('```markdown\nhello world\n```')).toBe('hello world');
    });

    it('preserves leading space for word boundary', () => {
        expect(cleanCompletion(' jumps over the lazy dog')).toBe(' jumps over the lazy dog');
    });

    it('caps at paragraph boundary', () => {
        const text = 'First paragraph.\n\nSecond paragraph.';
        const result = cleanCompletion(text);
        expect(result).toBe('First paragraph.');
        expect(result).not.toContain('Second paragraph');
    });

    it('caps at ~300 characters', () => {
        const longText = 'word '.repeat(100); // 500 chars
        const result = cleanCompletion(longText);
        expect(result.length).toBeLessThanOrEqual(301);
    });

    it('handles empty string', () => {
        expect(cleanCompletion('')).toBe('');
    });

    it('handles whitespace-only string', () => {
        expect(cleanCompletion('   \n  ')).toBe('');
    });

    it('does not strip leading space on empty content after trim', () => {
        expect(cleanCompletion('   ')).toBe('');
    });

    it('preserves single sentence correctly', () => {
        const text = 'The quick brown fox jumps over the lazy dog.';
        expect(cleanCompletion(text)).toBe(text);
    });

    it('handles text with no word boundary near 300 chars', () => {
        const longWord = 'a'.repeat(350);
        const result = cleanCompletion(longWord);
        expect(result.length).toBe(300);
    });
});

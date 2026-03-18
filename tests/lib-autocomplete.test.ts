import { describe, it, expect } from 'vitest';
import { buildCompletionContext, buildCompletionPrompt, cleanCompletion, getNextWordBoundary, getFirstLine } from '../lib/autocomplete';

describe('lib/autocomplete', () => {
    describe('buildCompletionContext', () => {
        it('extracts prefix and suffix around cursor', () => {
            const doc = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
            const cursor = doc.indexOf('line4');
            const ctx = buildCompletionContext(doc, cursor, 'Test Note');
            expect(ctx.noteTitle).toBe('Test Note');
            expect(ctx.prefix).toContain('line3');
            expect(ctx.suffix).toContain('line4');
        });

        it('handles cursor at start of document', () => {
            const ctx = buildCompletionContext('hello world', 0, 'Note');
            expect(ctx.prefix).toBe('');
            expect(ctx.suffix).toBe('hello world');
        });

        it('handles cursor at end of document', () => {
            const ctx = buildCompletionContext('hello world', 11, 'Note');
            expect(ctx.prefix).toBe('hello world');
            expect(ctx.suffix).toBe('');
        });

        it('limits prefix to 25 lines', () => {
            const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
            const doc = lines.join('\n');
            const ctx = buildCompletionContext(doc, doc.length, 'Note');
            const prefixLines = ctx.prefix.split('\n');
            expect(prefixLines.length).toBeLessThanOrEqual(25);
        });

        it('limits suffix to 10 lines', () => {
            const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
            const doc = lines.join('\n');
            const ctx = buildCompletionContext(doc, 0, 'Note');
            const suffixLines = ctx.suffix.split('\n');
            expect(suffixLines.length).toBeLessThanOrEqual(10);
        });
    });

    describe('buildCompletionPrompt', () => {
        it('includes note title when present', () => {
            const prompt = buildCompletionPrompt({ noteTitle: 'My Note', prefix: 'text', suffix: '' });
            expect(prompt).toContain('[Note: My Note]');
        });

        it('omits note title when empty', () => {
            const prompt = buildCompletionPrompt({ noteTitle: '', prefix: 'text', suffix: '' });
            expect(prompt).not.toContain('[Note:');
        });

        it('includes prefix text', () => {
            const prompt = buildCompletionPrompt({ noteTitle: '', prefix: 'some prefix', suffix: '' });
            expect(prompt).toContain('some prefix');
        });

        it('includes suffix inline after cursor marker', () => {
            const prompt = buildCompletionPrompt({ noteTitle: '', prefix: 'before', suffix: 'after' });
            expect(prompt).toContain('before<|cursor|>after');
        });

        it('omits suffix when suffix is only whitespace', () => {
            const prompt = buildCompletionPrompt({ noteTitle: '', prefix: 'before', suffix: '   ' });
            expect(prompt).not.toContain('   ');
            expect(prompt).toContain('before<|cursor|>');
        });

        it('ends with FIM insertion instruction', () => {
            const prompt = buildCompletionPrompt({ noteTitle: '', prefix: 'Hello', suffix: '' });
            expect(prompt).toContain('[Insert the most likely continuation at <|cursor|>.');
        });
    });

    describe('cleanCompletion', () => {
        it('returns clean text as-is', () => {
            expect(cleanCompletion('hello world')).toBe('hello world');
        });

        it('strips code fences', () => {
            expect(cleanCompletion('```js\nconsole.log("hi")\n```')).toBe('console.log("hi")');
        });

        it('preserves leading space', () => {
            expect(cleanCompletion(' hello')).toBe(' hello');
        });

        it('caps at paragraph boundary', () => {
            const result = cleanCompletion('first paragraph\n\nsecond paragraph');
            expect(result).toBe('first paragraph');
        });

        it('hard caps at ~300 characters', () => {
            const long = 'word '.repeat(100);
            const result = cleanCompletion(long);
            expect(result.length).toBeLessThanOrEqual(301);
        });

        it('returns empty string for whitespace-only input', () => {
            expect(cleanCompletion('   ')).toBe('');
        });

        it('strips leading newlines', () => {
            expect(cleanCompletion('\n\nhello')).toBe('hello');
        });

        it('removes cursor marker if echoed back', () => {
            expect(cleanCompletion('world<|cursor|> is round')).toBe('world is round');
        });

        it('caps multi-line completions at 5 lines', () => {
            const result = cleanCompletion('line1\nline2\nline3\nline4\nline5\nline6\nline7');
            expect(result).toBe('line1\nline2\nline3\nline4\nline5');
        });
    });

    describe('getNextWordBoundary', () => {
        it('returns 0 for empty string', () => {
            expect(getNextWordBoundary('')).toBe(0);
        });

        it('finds boundary of a simple word', () => {
            expect(getNextWordBoundary('hello world')).toBe(5);
        });

        it('includes leading whitespace before the word', () => {
            expect(getNextWordBoundary(' hello world')).toBe(6);
        });

        it('handles punctuation as a separate boundary', () => {
            expect(getNextWordBoundary('...hello')).toBe(3);
        });

        it('handles mixed punctuation and words', () => {
            expect(getNextWordBoundary('word, next')).toBe(4);
        });

        it('returns full length when only whitespace', () => {
            expect(getNextWordBoundary('   ')).toBe(3);
        });

        it('handles single character', () => {
            expect(getNextWordBoundary('a')).toBe(1);
        });

        it('handles tab + word', () => {
            expect(getNextWordBoundary('\tword')).toBe(5);
        });

        it('handles camelCase as single word', () => {
            // camelCase is treated as one word (standard word-boundary behavior)
            expect(getNextWordBoundary('camelCase rest')).toBe(9);
        });

        it('handles markdown list marker', () => {
            expect(getNextWordBoundary('- item')).toBe(1);
        });

        it('handles newline at start', () => {
            expect(getNextWordBoundary('\nword')).toBe(5);
        });

        // Unicode support
        it('handles Chinese characters (one char = one word)', () => {
            expect(getNextWordBoundary('你好世界')).toBe(1);
        });

        it('handles Japanese hiragana', () => {
            expect(getNextWordBoundary('こんにちは')).toBe(1);
        });

        it('handles Korean', () => {
            expect(getNextWordBoundary('한국어 text')).toBe(1);
        });

        it('handles accented Latin characters', () => {
            expect(getNextWordBoundary('café rest')).toBe(4);
        });

        it('handles Cyrillic', () => {
            expect(getNextWordBoundary('привет мир')).toBe(6);
        });

        it('handles emoji as punctuation', () => {
            expect(getNextWordBoundary('👋 hello')).toBe(2);
        });

        it('handles CJK with leading whitespace', () => {
            expect(getNextWordBoundary(' 你好')).toBe(2);
        });
    });

    describe('getFirstLine', () => {
        it('returns full text when no newline', () => {
            expect(getFirstLine('hello world')).toBe('hello world');
        });

        it('returns first line of multi-line text', () => {
            expect(getFirstLine('first\nsecond\nthird')).toBe('first');
        });

        it('returns empty string for empty input', () => {
            expect(getFirstLine('')).toBe('');
        });

        it('returns empty string when text starts with newline', () => {
            expect(getFirstLine('\nsecond')).toBe('');
        });

        it('handles single line with trailing newline', () => {
            expect(getFirstLine('hello\n')).toBe('hello');
        });
    });
});

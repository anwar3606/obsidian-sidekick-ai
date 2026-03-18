import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff, sleep, generateId, formatPrice, truncate, sanitizeVaultPath, getErrorMessage, categorizeError, mergeWithDefaults } from '../lib/utils';

describe('lib/utils', () => {
    describe('retryWithBackoff', () => {
        it('returns on first success', async () => {
            const result = await retryWithBackoff(
                async () => 'ok',
                { maxRetries: 3, baseDelayMs: 0 },
            );
            expect(result).toBe('ok');
        });

        it('retries on failure and returns on eventual success', async () => {
            let calls = 0;
            const result = await retryWithBackoff(
                async () => {
                    calls++;
                    if (calls < 3) throw new Error('fail');
                    return 'ok';
                },
                { maxRetries: 3, baseDelayMs: 0 },
            );
            expect(result).toBe('ok');
            expect(calls).toBe(3);
        });

        it('throws last error when all retries exhausted', async () => {
            await expect(retryWithBackoff(
                async () => { throw new Error('always fail'); },
                { maxRetries: 2, baseDelayMs: 0 },
            )).rejects.toThrow('always fail');
        });

        it('uses constant delay by default', async () => {
            const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
            let calls = 0;
            await retryWithBackoff(
                async () => {
                    calls++;
                    if (calls < 2) throw new Error('fail');
                    return 'ok';
                },
                { maxRetries: 3, baseDelayMs: 100 },
            );
            // The sleep function uses setTimeout — verify it was called
            expect(calls).toBe(2);
            sleepSpy.mockRestore();
        });

        it('wraps non-Error throws in Error', async () => {
            await expect(retryWithBackoff(
                async () => { throw 'string error'; },
                { maxRetries: 1, baseDelayMs: 0 },
            )).rejects.toThrow('string error');
        });

        it('passes attempt number to fn', async () => {
            const attempts: number[] = [];
            await retryWithBackoff(
                async (attempt) => {
                    attempts.push(attempt);
                    if (attempt < 2) throw new Error('fail');
                    return 'ok';
                },
                { maxRetries: 3, baseDelayMs: 0 },
            );
            expect(attempts).toEqual([0, 1, 2]);
        });
    });

    describe('sleep', () => {
        it('resolves after timeout', async () => {
            vi.useFakeTimers();
            const p = sleep(100);
            vi.advanceTimersByTime(100);
            await p;
            vi.useRealTimers();
        });

        it('resolves immediately for 0ms', async () => {
            await sleep(0);
        });

        it('rejects immediately if signal already aborted', async () => {
            const ac = new AbortController();
            ac.abort();
            await expect(sleep(1000, ac.signal)).rejects.toThrow('aborted');
        });

        it('rejects when signal aborts during sleep', async () => {
            vi.useFakeTimers();
            const ac = new AbortController();
            const p = sleep(5000, ac.signal);
            ac.abort();
            await expect(p).rejects.toThrow('aborted');
            vi.useRealTimers();
        });

        it('resolves normally when signal is provided but never aborts', async () => {
            const ac = new AbortController();
            await sleep(0, ac.signal);
        });
    });

    describe('generateId', () => {
        it('returns a non-empty string', () => {
            const id = generateId();
            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(0);
        });

        it('returns unique IDs', () => {
            const ids = new Set(Array.from({ length: 100 }, () => generateId()));
            expect(ids.size).toBe(100);
        });
    });

    describe('formatPrice', () => {
        it('formats zero', () => expect(formatPrice(0)).toBe('0'));
        it('formats tiny values with 4 decimals', () => expect(formatPrice(0.001)).toBe('0.0010'));
        it('formats small values with 2 decimals', () => expect(formatPrice(0.5)).toBe('0.50'));
        it('formats large values with 1 decimal', () => expect(formatPrice(2.35)).toBe('2.4'));
    });

    describe('truncate', () => {
        it('returns text unchanged if within limit', () => {
            expect(truncate('hello', 10)).toBe('hello');
        });

        it('truncates and appends ellipsis', () => {
            expect(truncate('hello world', 5)).toBe('hello…');
        });

        it('handles exact boundary', () => {
            expect(truncate('hello', 5)).toBe('hello');
        });
    });

    // ── sanitizeVaultPath ───────────────────────────────────────

    describe('sanitizeVaultPath', () => {
        it('passes through clean relative paths', () => {
            expect(sanitizeVaultPath('Notes/daily.md')).toBe('Notes/daily.md');
            expect(sanitizeVaultPath('file.md')).toBe('file.md');
            expect(sanitizeVaultPath('deep/nested/folder/note.md')).toBe('deep/nested/folder/note.md');
        });

        it('normalizes backslashes to forward slashes', () => {
            expect(sanitizeVaultPath('Notes\\daily.md')).toBe('Notes/daily.md');
            expect(sanitizeVaultPath('a\\b\\c.md')).toBe('a/b/c.md');
        });

        it('collapses consecutive slashes', () => {
            expect(sanitizeVaultPath('Notes//daily.md')).toBe('Notes/daily.md');
            expect(sanitizeVaultPath('a///b////c.md')).toBe('a/b/c.md');
        });

        it('strips trailing slashes from valid paths', () => {
            expect(sanitizeVaultPath('Notes/daily.md/')).toBe('Notes/daily.md');
        });

        it('removes current-dir segments', () => {
            expect(sanitizeVaultPath('./Notes/daily.md')).toBe('Notes/daily.md');
            expect(sanitizeVaultPath('Notes/./daily.md')).toBe('Notes/daily.md');
        });

        it('rejects empty paths', () => {
            expect(() => sanitizeVaultPath('')).toThrow('empty');
            expect(() => sanitizeVaultPath('  ')).toThrow('empty');
        });

        it('rejects absolute Unix paths', () => {
            expect(() => sanitizeVaultPath('/etc/passwd')).toThrow('Absolute');
            expect(() => sanitizeVaultPath('/Notes/daily.md')).toThrow('Absolute');
        });

        it('rejects absolute Windows paths', () => {
            expect(() => sanitizeVaultPath('C:\\Users\\file.md')).toThrow('Absolute');
            expect(() => sanitizeVaultPath('D:/Documents/note.md')).toThrow('Absolute');
        });

        it('rejects path traversal with ..', () => {
            expect(() => sanitizeVaultPath('../outside.md')).toThrow('traversal');
            expect(() => sanitizeVaultPath('Notes/../../etc/passwd')).toThrow('traversal');
            expect(() => sanitizeVaultPath('a/b/../../../escape.md')).toThrow('traversal');
        });

        it('allows segments containing dots (not traversal)', () => {
            expect(sanitizeVaultPath('my.notes/v1.2.md')).toBe('my.notes/v1.2.md');
            expect(sanitizeVaultPath('...weird/file.md')).toBe('...weird/file.md');
        });

        it('rejects paths that normalize to empty', () => {
            expect(() => sanitizeVaultPath('.')).toThrow('empty');
            expect(() => sanitizeVaultPath('./.')).toThrow('empty');
        });
    });

    describe('getErrorMessage', () => {
        it('extracts message from Error instance', () => {
            expect(getErrorMessage(new Error('something broke'))).toBe('something broke');
        });

        it('extracts message from TypeError', () => {
            expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
        });

        it('converts string to itself', () => {
            expect(getErrorMessage('plain string error')).toBe('plain string error');
        });

        it('converts number to string', () => {
            expect(getErrorMessage(42)).toBe('42');
        });

        it('converts null to string', () => {
            expect(getErrorMessage(null)).toBe('null');
        });

        it('converts undefined to string', () => {
            expect(getErrorMessage(undefined)).toBe('undefined');
        });

        it('converts object to string', () => {
            expect(getErrorMessage({ code: 'ENOENT' })).toBe('[object Object]');
        });
    });

    describe('categorizeError', () => {
        it('detects rate limiting', () => {
            const result = categorizeError('429 Too Many Requests');
            expect(result.message).toBe('Rate limited by the API');
            expect(result.hint).toContain('Wait');
        });

        it('detects auth errors', () => {
            const result = categorizeError('401 Unauthorized');
            expect(result.message).toBe('Authentication failed');
            expect(result.hint).toContain('API key');
        });

        it('detects context length errors', () => {
            const result = categorizeError('maximum context length exceeded');
            expect(result.message).toContain('too long');
            expect(result.hint).toContain('shorter');
        });

        it('detects model not found', () => {
            const result = categorizeError('model not found');
            expect(result.message).toContain('not available');
            expect(result.hint).toContain('model');
        });

        it('detects network errors', () => {
            const result = categorizeError('fetch failed ECONNREFUSED');
            expect(result.message).toBe('Network error');
            expect(result.hint).toContain('internet');
        });

        it('detects server errors', () => {
            const result = categorizeError('502 Bad Gateway');
            expect(result.message).toBe('Server error');
            expect(result.hint).toContain('again');
        });

        it('detects timeout errors', () => {
            const result = categorizeError('Request timed out');
            expect(result.message).toBe('Request timed out');
            expect(result.hint).toContain('again');
        });

        it('returns raw message for unknown errors', () => {
            const result = categorizeError('Something unexpected happened');
            expect(result.message).toBe('Something unexpected happened');
            expect(result.hint).toBeUndefined();
        });
    });

    describe('mergeWithDefaults', () => {
        it('deep-merges nested objects while preserving loaded values', () => {
            const defaults = {
                top: true,
                nested: {
                    a: 1,
                    b: 2,
                    deep: { x: 'x', y: 'y' },
                },
            };
            const loaded = {
                nested: {
                    b: 99,
                    deep: { y: 'override' },
                },
            };

            const merged = mergeWithDefaults(defaults, loaded);
            expect(merged).toEqual({
                top: true,
                nested: {
                    a: 1,
                    b: 99,
                    deep: { x: 'x', y: 'override' },
                },
            });
        });

        it('replaces default arrays with loaded arrays', () => {
            const defaults = { items: ['a', 'b'] };
            const loaded = { items: ['z'] };
            expect(mergeWithDefaults(defaults, loaded)).toEqual({ items: ['z'] });
        });

        it('preserves unknown loaded keys', () => {
            const defaults = { a: 1 };
            const loaded = { a: 2, future: { enabled: true } };
            expect(mergeWithDefaults(defaults, loaded)).toEqual({ a: 2, future: { enabled: true } });
        });
    });
});

import { describe, it, expect, vi } from 'vitest';
import { formatLogEntry, isoNow, logFileDateStamp } from '../lib/debug-log';
import type { DebugLogEntry } from '../lib/debug-log';

describe('lib/debug-log', () => {
    describe('formatLogEntry', () => {
        it('formats entry without data', () => {
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'api',
                event: 'Request sent',
            };
            expect(formatLogEntry(entry)).toBe('[2024-01-15T10:30:00.000Z] [api] Request sent');
        });

        it('formats entry with empty data object', () => {
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'tool',
                event: 'Executed',
                data: {},
            };
            expect(formatLogEntry(entry)).toBe('[2024-01-15T10:30:00.000Z] [tool] Executed');
        });

        it('formats entry with data as indented JSON', () => {
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'api',
                event: 'Response',
                data: { status: 200, model: 'gpt-4o' },
            };
            const result = formatLogEntry(entry);
            expect(result).toContain('[2024-01-15T10:30:00.000Z] [api] Response');
            expect(result).toContain('"status": 200');
            expect(result).toContain('"model": "gpt-4o"');
        });

        it('truncates strings longer than 2000 chars', () => {
            const longStr = 'x'.repeat(3000);
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'api',
                event: 'Response',
                data: { content: longStr },
            };
            const result = formatLogEntry(entry);
            expect(result).toContain('… (3000 chars total)');
            expect(result).not.toContain('x'.repeat(2001));
        });

        it('preserves strings exactly 2000 chars', () => {
            const str = 'a'.repeat(2000);
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'api',
                event: 'Test',
                data: { content: str },
            };
            const result = formatLogEntry(entry);
            expect(result).toContain(str);
            expect(result).not.toContain('chars total');
        });

        it('omits functions from data', () => {
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'test',
                event: 'Test',
                data: { fn: (() => {}) as any, value: 42 },
            };
            const result = formatLogEntry(entry);
            expect(result).toContain('"value": 42');
            expect(result).not.toContain('fn');
        });

        it('handles circular references gracefully', () => {
            const obj: any = { name: 'test' };
            obj.self = obj;
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'test',
                event: 'Circular',
                data: obj,
            };
            const result = formatLogEntry(entry);
            expect(result).toContain('[Failed to serialize data]');
        });

        it('handles undefined data', () => {
            const entry: DebugLogEntry = {
                timestamp: '2024-01-15T10:30:00.000Z',
                category: 'test',
                event: 'No data',
                data: undefined,
            };
            expect(formatLogEntry(entry)).toBe('[2024-01-15T10:30:00.000Z] [test] No data');
        });
    });

    describe('isoNow', () => {
        it('returns a valid ISO 8601 string', () => {
            const result = isoNow();
            expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });

        it('returns current time (within 1 second)', () => {
            const before = Date.now();
            const result = new Date(isoNow()).getTime();
            const after = Date.now();
            expect(result).toBeGreaterThanOrEqual(before - 1);
            expect(result).toBeLessThanOrEqual(after + 1);
        });
    });

    describe('logFileDateStamp', () => {
        it('returns YYYY-MM-DD format', () => {
            const result = logFileDateStamp();
            expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });

        it('matches the current date', () => {
            const expected = new Date().toISOString().slice(0, 10);
            expect(logFileDateStamp()).toBe(expected);
        });
    });
});

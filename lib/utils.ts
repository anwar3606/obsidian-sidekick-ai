/**
 * Pure utility functions — zero Obsidian dependency.
 * Used by both lib/ and src/ layers.
 */

// ── Error message extraction ────────────────────────────────────────

/** Extract a human-readable message from an unknown caught value. */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge loaded data over defaults.
 *
 * - Objects are deep-merged key-by-key
 * - Arrays from loaded data replace default arrays
 * - Primitive values use loaded when defined, otherwise default
 * - Unknown keys from loaded data are preserved
 */
export function mergeWithDefaults<T>(defaults: T, loaded: unknown): T {
    if (Array.isArray(defaults)) {
        return (Array.isArray(loaded) ? loaded : [...defaults]) as T;
    }

    if (isPlainObject(defaults)) {
        const loadedObj = isPlainObject(loaded) ? loaded : {};
        const result: Record<string, unknown> = {};

        const keys = new Set([...Object.keys(defaults), ...Object.keys(loadedObj)]);
        for (const key of keys) {
            const defaultVal = (defaults as Record<string, unknown>)[key];
            const loadedVal = loadedObj[key];
            if (defaultVal === undefined) {
                result[key] = loadedVal;
                continue;
            }
            result[key] = mergeWithDefaults(defaultVal, loadedVal);
        }

        return result as T;
    }

    return (loaded !== undefined ? loaded : defaults) as T;
}

/**
 * Categorize an error message and return a user-friendly version with a hint.
 * Returns { message, hint } where hint is an optional suggestion.
 * Zero Obsidian dependency.
 */
export function categorizeError(rawMessage: string): { message: string; hint?: string } {
    const lower = rawMessage.toLowerCase();

    if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
        return { message: 'Rate limited by the API', hint: 'Wait a moment and try again' };
    }
    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
        return { message: 'Authentication failed', hint: 'Check your API key in Settings' };
    }
    if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission')) {
        return { message: 'Access denied', hint: 'Your API key may not have access to this model' };
    }
    if (lower.includes('context length') || lower.includes('maximum context') || lower.includes('too long') || lower.includes('token limit')) {
        return { message: 'Message too long for this model', hint: 'Try a shorter message or start a new conversation' };
    }
    if (lower.includes('model not found') || lower.includes('404') || lower.includes('does not exist')) {
        return { message: 'Model not available', hint: 'Switch to a different model in the picker' };
    }
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
        return { message: 'Request timed out', hint: 'Try again — the server may be under load' };
    }
    if (lower.includes('network') || lower.includes('fetch') || lower.includes('econnrefused') || lower.includes('dns') || lower.includes('socket')) {
        return { message: 'Network error', hint: 'Check your internet connection' };
    }
    if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('server error') || lower.includes('internal error')) {
        return { message: 'Server error', hint: 'The API is having issues — try again shortly' };
    }

    return { message: rawMessage };
}

// ── Retry with exponential backoff ──────────────────────────────────

export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    /** If true, uses exponential backoff (delay * 2^attempt). Default: false (constant delay). */
    exponential?: boolean;
}

/**
 * Retry an async operation with configurable backoff.
 * Returns the result of the first successful attempt, or throws the last error.
 */
export async function retryWithBackoff<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions,
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < options.maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = options.exponential
                ? options.baseDelayMs * Math.pow(2, attempt)
                : options.baseDelayMs;
            await sleep(delay);
        }
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
        }
    }

    throw lastError ?? new Error('All retry attempts failed');
}

// ── Sleep ───────────────────────────────────────────────────────────

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
        }
    });
}

// ── ID generation ───────────────────────────────────────────────────

/** Generate a short, unique ID suitable for conversation/command IDs. */
export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Price formatting ────────────────────────────────────────────────

/** Format a price value for display (used in model picker). */
export function formatPrice(value: number): string {
    if (value === 0) return '0';
    if (value < 0.01) return value.toFixed(4);
    if (value < 1) return value.toFixed(2);
    return value.toFixed(1);
}

// ── String truncation ───────────────────────────────────────────────

/** Truncate a string to maxLen, appending '…' if truncated. */
export function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '…';
}

// ── Vault path sanitization ─────────────────────────────────────────

/**
 * Sanitize a vault-relative file path to prevent directory traversal attacks.
 *
 * - Rejects absolute paths (leading `/` or drive letters like `C:\`)
 * - Rejects `..` segments (path traversal)
 * - Normalizes backslashes to forward slashes
 * - Collapses consecutive slashes and strips leading/trailing slashes
 * - Returns the cleaned path, or throws if the path is unsafe.
 */
export function sanitizeVaultPath(raw: string): string {
    if (!raw || !raw.trim()) {
        throw new Error('Path must not be empty');
    }

    // Normalize backslashes → forward slashes
    let p = raw.replace(/\\/g, '/');

    // Reject absolute paths: /foo, C:/foo, C:\foo
    if (/^\//.test(p) || /^[a-zA-Z]:/.test(p)) {
        throw new Error(`Absolute paths are not allowed: ${raw}`);
    }

    // Collapse consecutive slashes, strip leading/trailing slashes
    p = p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');

    // Reject '..' segments (traversal attack)
    const segments = p.split('/');
    if (segments.some(s => s === '..')) {
        throw new Error(`Path traversal ("..") is not allowed: ${raw}`);
    }

    // Remove '.' segments (current dir — harmless but noisy)
    const cleaned = segments.filter(s => s !== '.' && s !== '').join('/');

    if (!cleaned) {
        throw new Error('Path must not be empty after normalization');
    }

    return cleaned;
}

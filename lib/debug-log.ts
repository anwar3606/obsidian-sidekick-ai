// Zero Obsidian dependency — pure debug log formatting logic.

export interface DebugLogEntry {
    timestamp: string;
    category: string;
    event: string;
    data?: Record<string, unknown>;
}

/** Format a log entry as a human-readable line for the debug log file. */
export function formatLogEntry(entry: DebugLogEntry): string {
    const ts = entry.timestamp;
    const prefix = `[${ts}] [${entry.category}] ${entry.event}`;
    if (!entry.data || Object.keys(entry.data).length === 0) return prefix;
    try {
        const dataStr = JSON.stringify(entry.data, (_key, value) => {
            // Truncate long strings (e.g. base64 images, large content)
            if (typeof value === 'string' && value.length > 2000) {
                return value.substring(0, 2000) + `… (${value.length} chars total)`;
            }
            // Skip functions and symbols
            if (typeof value === 'function' || typeof value === 'symbol') return undefined;
            return value;
        }, 2);
        return `${prefix}\n${dataStr}`;
    } catch {
        return `${prefix}\n[Failed to serialize data]`;
    }
}

/** Create ISO timestamp string. */
export function isoNow(): string {
    return new Date().toISOString();
}

/** Create a datestamp string for log file names (YYYY-MM-DD). */
export function logFileDateStamp(): string {
    return new Date().toISOString().slice(0, 10);
}

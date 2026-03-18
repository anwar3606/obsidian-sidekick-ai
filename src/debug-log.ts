// Obsidian-dependent debug logger — writes verbose logs to a vault file.

import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { formatLogEntry, isoNow, logFileDateStamp } from '../lib/debug-log';
import type { DebugLogEntry } from '../lib/debug-log';

/** Re-export pure formatting utilities for consumers */
export { formatLogEntry, isoNow, logFileDateStamp } from '../lib/debug-log';
export type { DebugLogEntry } from '../lib/debug-log';

const LOG_FOLDER = 'copilot/debug-logs';

/** Singleton debug logger. Enabled/disabled via settings toggle. */
class DebugLogger {
    private enabled = false;
    private app: App | null = null;
    private buffer: string[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushInterval = 2000; // ms
    private flushing: Promise<void> | null = null; // serialize writes

    /** Call once at plugin load to wire up the Obsidian App reference. */
    init(app: App, enabled: boolean): void {
        this.app = app;
        this.enabled = enabled;
        if (enabled) {
            this.log('system', 'Debug logging enabled');
        }
    }

    /** Update enabled state (called when settings change). */
    setEnabled(enabled: boolean): void {
        if (this.enabled !== enabled) {
            this.enabled = enabled;
            if (enabled) {
                this.log('system', 'Debug logging enabled');
            } else {
                // Flush remaining buffer before disabling
                this.flush();
            }
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Log a debug entry. No-op when disabled. */
    log(category: string, event: string, data?: Record<string, unknown>): void {
        if (!this.enabled) return;
        const entry: DebugLogEntry = {
            timestamp: isoNow(),
            category,
            event,
            data,
        };
        const formatted = formatLogEntry(entry);
        this.buffer.push(formatted);
        // Also write errors to console for immediate visibility
        if (event.includes('error') || event.includes('Error')) {
            console.error(`[Sidekick Debug] ${formatted}`);
        }
        // Flush immediately on errors to avoid losing data on crashes
        if (category === 'api' && (event.includes('error') || event.includes('Error'))) {
            this.flush();
        } else {
            this.scheduleFlush();
        }
    }

    /** Schedule a batched flush to avoid writing on every single log call. */
    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, this.flushInterval);
    }

    /** Flush all buffered entries to the vault log file. Serialized to prevent concurrent writes. */
    async flush(): Promise<void> {
        // Wait for any in-progress flush to complete first
        if (this.flushing) {
            await this.flushing;
        }
        if (this.buffer.length === 0 || !this.app) return;
        this.flushing = this.doFlush();
        await this.flushing;
        this.flushing = null;
    }

    private async doFlush(): Promise<void> {
        if (!this.app) return;
        const lines = this.buffer.splice(0);
        if (lines.length === 0) return;
        const content = lines.join('\n\n') + '\n\n';

        try {
            const fileName = `${LOG_FOLDER}/sidekick-${logFileDateStamp()}.log`;
            const existing = this.app.vault.getAbstractFileByPath(fileName);
            if (existing && existing instanceof TFile) {
                const prev = await this.app.vault.read(existing);
                await this.app.vault.modify(existing, prev + content);
            } else {
                // Ensure folder exists
                await this.ensureFolder(LOG_FOLDER);
                await this.app.vault.create(fileName, content);
            }
        } catch {
            // If writing fails, push content back to buffer for next attempt
            this.buffer.unshift(...lines);
        }
    }

    private async ensureFolder(path: string): Promise<void> {
        if (!this.app) return;
        const parts = path.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                try { await this.app.vault.createFolder(current); } catch { /* already exists */ }
            }
        }
    }
}

/** Global debug logger singleton. */
export const debugLog = new DebugLogger();

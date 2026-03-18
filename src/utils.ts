import type { App } from 'obsidian';

// ── Re-export pure utilities from lib/ (single source of truth) ─────
export { retryWithBackoff, sleep, generateId, formatPrice, truncate, getErrorMessage, sanitizeVaultPath } from '../lib/utils';
export type { RetryOptions } from '../lib/utils';

// ── Obsidian-dependent helpers (src-only) ───────────────────────────

/**
 * Ensure a folder path exists in the vault, creating it if necessary.
 * Handles nested paths by creating parent directories.
 */
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
    if (app.vault.getAbstractFileByPath(folderPath)) return;
    await app.vault.createFolder(folderPath);
}

/**
 * Ensure the parent directory of a file path exists.
 */
export async function ensureParentFolder(app: App, filePath: string): Promise<void> {
    const parts = filePath.split('/');
    if (parts.length <= 1) return;
    const folder = parts.slice(0, -1).join('/');
    await ensureFolder(app, folder);
}

// ── Toggle button helper ────────────────────────────────────────────

/**
 * Update a toggle button's visual state (active class + aria-pressed).
 */
export function updateToggleButton(btn: HTMLElement, active: boolean): void {
    btn.classList.toggle('sidekick-tool-btn-active', active);
    btn.setAttribute('aria-pressed', String(active));
}

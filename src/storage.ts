import type { App, TFile } from 'obsidian';
import type { Conversation, ChatMessage, IterateState } from './types';
import { conversationToMarkdown, markdownToConversation } from '../lib/conversation';
import { generateId } from '../lib/utils';

/**
 * Chat storage — persists conversations as markdown files in the vault.
 *
 * Each conversation is stored as a .md file in the configured chat folder.
 * The file format:
 *   - YAML frontmatter with metadata (id, provider, model, pinned, dates)
 *   - Messages as markdown sections (### User / ### Assistant)
 */

export class ChatStorage {
    /** Cache of conversation ID → actual file path (handles externally renamed files). */
    private idToPath = new Map<string, string>();

    constructor(
        private app: App,
        private chatFolder: string,
    ) { }

    setChatFolder(folder: string) {
        this.chatFolder = folder;
        this.idToPath.clear();
    }

    private async ensureFolder(): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(this.chatFolder);
        if (!folder) {
            try {
                await this.app.vault.createFolder(this.chatFolder);
            } catch { /* folder created concurrently — ignore */ }
        }
    }

    private conversationPath(id: string): string {
        return `${this.chatFolder}/${id}.md`;
    }

    /** Roles that are persisted to markdown (system/tool messages are ephemeral). */
    private static readonly PERSISTED_ROLES: ReadonlySet<string> = new Set(['user', 'assistant']);

    private toMarkdown(conv: Conversation): string {
        return conversationToMarkdown(conv);
    }

    private fromMarkdown(content: string, _filePath: string): Conversation | null {
        return markdownToConversation(content) as Conversation | null;
    }

    async saveConversation(conv: Conversation): Promise<void> {
        await this.ensureFolder();
        // Try the expected ID-based path first, then fall back to the cached path
        const idPath = this.conversationPath(conv.id);
        let existing = this.app.vault.getAbstractFileByPath(idPath);
        if (!existing) {
            const cachedPath = this.idToPath.get(conv.id);
            if (cachedPath && cachedPath !== idPath) {
                existing = this.app.vault.getAbstractFileByPath(cachedPath);
            }
        }
        const content = this.toMarkdown(conv);
        if (existing) {
            await this.app.vault.modify(existing as TFile, content);
            this.idToPath.set(conv.id, existing.path);
        } else {
            await this.app.vault.create(idPath, content);
            this.idToPath.set(conv.id, idPath);
        }
    }

    async loadConversation(id: string): Promise<Conversation | null> {
        // Fast path: file at the expected ID-based path
        const path = this.conversationPath(id);
        let file = this.app.vault.getAbstractFileByPath(path);

        // Fallback: file was externally renamed — check the cached path
        if (!file) {
            const cachedPath = this.idToPath.get(id);
            if (cachedPath && cachedPath !== path) {
                file = this.app.vault.getAbstractFileByPath(cachedPath);
            }
        }

        // Last resort: scan all files in the folder for one with matching frontmatter ID
        if (!file) {
            file = await this.findFileById(id);
        }

        if (!file) return null;
        try {
            const content = await this.app.vault.read(file as TFile);
            const conv = this.fromMarkdown(content, file.path);
            if (conv) this.idToPath.set(id, file.path);
            return conv;
        } catch (err: unknown) {
            console.warn(`[Sidekick] Failed to load conversation ${id}:`, err);
            return null;
        }
    }

    /** Scan chat folder for a file with matching frontmatter ID (handles renamed files). */
    private async findFileById(id: string): Promise<TFile | null> {
        await this.ensureFolder();
        const prefix = this.chatFolder + '/';
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'));
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const conv = this.fromMarkdown(content, file.path);
                if (conv?.id === id) {
                    this.idToPath.set(id, file.path);
                    return file;
                }
            } catch { /* skip unreadable files */ }
        }
        return null;
    }

    async loadAllConversations(): Promise<Conversation[]> {
        await this.ensureFolder();
        const folder = this.app.vault.getAbstractFileByPath(this.chatFolder);
        if (!folder) return [];

        const conversations: Conversation[] = [];
        const prefix = this.chatFolder + '/';
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => {
                // Must be directly inside the chat folder (not in subfolders like exports/)
                if (!f.path.startsWith(prefix)) return false;
                const relative = f.path.slice(prefix.length);
                return !relative.includes('/');
            });

        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const conv = this.fromMarkdown(content, file.path);
                // Only include files with valid conversation frontmatter (must have id field)
                if (conv && conv.id && conv.messages.length > 0) {
                    conversations.push(conv);
                    // Cache the actual path — handles externally renamed files
                    this.idToPath.set(conv.id, file.path);
                }
            } catch (err: unknown) {
                console.warn(`[Sidekick] Skipping bad conversation file ${file.path}:`, err);
            }
        }

        return conversations.sort((a, b) => {
            // Pinned items sink to the bottom (most accessible when list scrolls to bottom)
            if (a.pinned !== b.pinned) return a.pinned ? 1 : -1;
            // Within each group, sort ascending (oldest first = top, newest = bottom)
            return a.updatedAt - b.updatedAt;
        });
    }

    async deleteConversation(id: string): Promise<void> {
        const path = this.conversationPath(id);
        let file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
            const cachedPath = this.idToPath.get(id);
            if (cachedPath && cachedPath !== path) {
                file = this.app.vault.getAbstractFileByPath(cachedPath);
            }
        }
        if (file) {
            await this.app.vault.delete(file as TFile);
        }
        this.idToPath.delete(id);
        // Clean up any iterate state sidecar
        await this.deleteIterateState(id);
    }

    // ── Iterate state sidecar (JSON) ────────────────────────────────

    private iterateStatePath(convId: string): string {
        return `${this.chatFolder}/iterate-state/${convId}.json`;
    }

    async saveIterateState(convId: string, state: IterateState): Promise<void> {
        const folder = `${this.chatFolder}/iterate-state`;
        const folderRef = this.app.vault.getAbstractFileByPath(folder);
        if (!folderRef) {
            try { await this.app.vault.createFolder(folder); } catch { /* concurrent */ }
        }
        const path = this.iterateStatePath(convId);
        const json = JSON.stringify(state);
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing) {
            await this.app.vault.modify(existing as TFile, json);
        } else {
            await this.app.vault.create(path, json);
        }
    }

    async loadIterateState(convId: string): Promise<IterateState | null> {
        const path = this.iterateStatePath(convId);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) return null;
        try {
            const content = await this.app.vault.read(file as TFile);
            return JSON.parse(content) as IterateState;
        } catch {
            return null;
        }
    }

    async deleteIterateState(convId: string): Promise<void> {
        const path = this.iterateStatePath(convId);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) {
            await this.app.vault.delete(file as TFile);
        }
    }

    generateId(): string {
        return generateId();
    }

    /** Update the ID-to-path cache when a chat file is renamed externally. */
    handleFileRename(oldPath: string, newPath: string): void {
        for (const [id, cachedPath] of this.idToPath) {
            if (cachedPath === oldPath) {
                this.idToPath.set(id, newPath);
                return;
            }
        }
    }
}

import { TFile, TAbstractFile, App, TFolder, EventRef } from 'obsidian';
import type { CustomCommand } from './types';

/**
 * Note-based custom prompt system.
 *
 * Each .md file in the customPromptsFolder becomes a slash command.
 * Filename (sans .md) = command name.
 *
 * Frontmatter:
 *   - description: string  — shown in autocomplete
 *   - enabled: boolean     — whether the command is active (default: true)
 *
 * Body (after frontmatter) = system prompt template.
 *
 * Template variables:
 *   - {}              — replaced with user's message text
 *   - {activeNote}    — content of the currently active note
 *   - {[[Note Title]]}— content of a specific note by wikilink
 */

export class CustomPromptManager {
    private app: App;
    private folder: string;
    private commands: CustomCommand[] = [];
    private onChangeCallbacks: (() => void)[] = [];
    private eventRefs: EventRef[] = [];
    private loadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(app: App, folder: string) {
        this.app = app;
        this.folder = folder;
    }

    /** Start watching the vault for prompt file changes */
    initialize(): void {
        this.loadAll();

        this.eventRefs.push(
            this.app.vault.on('create', (file) => {
                if (this.isPromptFile(file)) this.scheduleLoadAll();
            }),
            this.app.vault.on('delete', (file) => {
                if (this.isPromptFile(file)) this.scheduleLoadAll();
            }),
            this.app.vault.on('rename', (file, oldPath) => {
                if (this.isPromptFile(file) || oldPath.startsWith(this.folder + '/')) this.scheduleLoadAll();
            }),
            this.app.vault.on('modify', (file) => {
                if (this.isPromptFile(file)) this.scheduleLoadAll();
            }),
        );
    }

    /** Debounce rapid vault events into a single loadAll */
    private scheduleLoadAll(): void {
        if (this.loadDebounceTimer) clearTimeout(this.loadDebounceTimer);
        this.loadDebounceTimer = setTimeout(() => {
            this.loadDebounceTimer = null;
            this.loadAll();
        }, 200);
    }

    /** Unregister all vault event listeners. Call on plugin unload. */
    destroy(): void {
        if (this.loadDebounceTimer) { clearTimeout(this.loadDebounceTimer); this.loadDebounceTimer = null; }
        for (const ref of this.eventRefs) {
            this.app.vault.offref(ref);
        }
        this.eventRefs = [];
        this.onChangeCallbacks = [];
    }

    /** Get all loaded custom commands from prompt files */
    getCommands(): CustomCommand[] {
        return this.commands;
    }

    /** Register a callback for when commands change */
    onChange(callback: () => void): void {
        this.onChangeCallbacks.push(callback);
    }

    /** Update the folder path (if settings change) */
    setFolder(folder: string): void {
        this.folder = folder;
        this.loadAll();
    }

    /** Create a new prompt file with default template */
    async createPrompt(name: string, description: string, systemPrompt: string): Promise<void> {
        await this.ensureFolder();
        const path = `${this.folder}/${name}.md`;
        const content = `---\ndescription: "${description}"\nenabled: true\n---\n${systemPrompt}`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing && existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
        } else {
            await this.app.vault.create(path, content);
        }
    }

    /** Delete a prompt file */
    async deletePrompt(name: string): Promise<void> {
        const path = `${this.folder}/${name}.md`;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file && file instanceof TFile) {
            await this.app.vault.trash(file, false);
        }
    }

    /**
     * Process template variables in a prompt.
     * @param template - The system prompt template
     * @param userMessage - The user's input text (replaces {})
     * @param activeNoteContent - Content of the active note (replaces {activeNote})
     */
    async processTemplate(template: string, userMessage: string, activeNoteContent?: string): Promise<string> {
        const noteReplacement = activeNoteContent ?? '[No active note]';

        // Collect wikilink matches from the ORIGINAL template (before any substitution)
        // to prevent template injection via user message content.
        const wikiPattern = /\{\[\[([^\]]+)\]\]\}/g;
        const wikiMatches: { full: string; title: string }[] = [];
        let match: RegExpExecArray | null;
        while ((match = wikiPattern.exec(template)) !== null) {
            wikiMatches.push({ full: match[0], title: match[1] });
        }

        // Resolve all wikilink note contents
        const resolvedWikilinks = new Map<string, string>();
        for (const { full, title } of wikiMatches) {
            if (!resolvedWikilinks.has(full)) {
                resolvedWikilinks.set(full, await this.resolveNoteContent(title));
            }
        }

        // Single-pass replacement prevents user content from being re-processed
        // as template variables (e.g. user typing "{activeNote}" won't expand).
        return template.replace(/\{\}|\{activeNote\}|\{\[\[[^\]]+\]\]\}/g, (matched) => {
            if (matched === '{}') return userMessage;
            if (matched === '{activeNote}') return noteReplacement;
            return resolvedWikilinks.get(matched) ?? matched;
        });
    }

    // ── Private helpers ──────────────────────────────────────────────

    private isPromptFile(file: TAbstractFile): boolean {
        if (!(file instanceof TFile)) return false;
        if (file.extension !== 'md') return false;
        if (!file.path.startsWith(this.folder + '/')) return false;
        // Only direct children (no subdirectories)
        const relative = file.path.slice(this.folder.length + 1);
        return !relative.includes('/');
    }

    private async loadAll(): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(this.folder);
        if (!folder || !(folder instanceof TFolder)) {
            this.commands = [];
            this.notifyChange();
            return;
        }

        const files = folder.children.filter(
            (f): f is TFile => f instanceof TFile && f.extension === 'md',
        );

        const commands: CustomCommand[] = [];
        for (const file of files) {
            try {
                const cmd = await this.parsePromptFile(file);
                if (cmd) commands.push(cmd);
            } catch {
                // Skip invalid files
            }
        }

        // Sort alphabetically
        commands.sort((a, b) => a.name.localeCompare(b.name));
        this.commands = commands;
        this.notifyChange();
    }

    private async parsePromptFile(file: TFile): Promise<CustomCommand | null> {
        const raw = await this.app.vault.read(file);
        const { frontmatter, body } = this.parseFrontmatter(raw);

        // Skip disabled commands
        if (frontmatter.enabled === false) return null;

        const name = file.basename.toLowerCase().replace(/\s+/g, '-');
        return {
            id: file.path, // Use file path as unique ID
            name,
            description: frontmatter.description || '',
            systemPrompt: body.trim(),
        };
    }

    private parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!fmMatch) return { frontmatter: {}, body: content };

        const fmBlock = fmMatch[1];
        const body = fmMatch[2];
        const frontmatter: Record<string, any> = {};

        for (const line of fmBlock.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx < 0) continue;
            const key = line.slice(0, colonIdx).trim();
            let value: any = line.slice(colonIdx + 1).trim();

            // Parse value types
            if (value === 'true') value = true;
            else if (value === 'false') value = false;
            else if (/^\d+$/.test(value)) value = parseInt(value, 10);
            else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
            else value = value.replace(/^["']|["']$/g, ''); // strip quotes

            frontmatter[key] = value;
        }

        return { frontmatter, body };
    }

    private async resolveNoteContent(title: string): Promise<string> {
        // Try exact path match first
        let file = this.app.vault.getAbstractFileByPath(title);
        if (!file) file = this.app.vault.getAbstractFileByPath(title + '.md');

        // Try searching by basename
        if (!file) {
            const allFiles = this.app.vault.getMarkdownFiles();
            file = allFiles.find(f => f.basename === title) ?? null;
        }

        if (file && file instanceof TFile) {
            return await this.app.vault.read(file);
        }
        return `[Note "${title}" not found]`;
    }

    private async ensureFolder(): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(this.folder);
        if (!existing) {
            try {
                await this.app.vault.createFolder(this.folder);
            } catch { /* folder created concurrently — ignore */ }
        }
    }

    private notifyChange(): void {
        for (const cb of this.onChangeCallbacks) {
            try { cb(); } catch { /* ignore */ }
        }
    }
}

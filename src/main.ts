import { Plugin, TFile } from 'obsidian';
import type { PluginSettings, ModelInfo } from './types';
import { DEFAULT_SETTINGS, SIDEKICK_VIEW_TYPE } from './constants';
import { ChatView } from './chat-view';
import { SidekickSettingTab } from './settings';
import { ChatStorage } from './storage';
import { CustomPromptManager } from './custom-prompts';
import { createAutocompleteExtension, triggerAutocomplete } from './autocomplete';
import { copilotTokenManager } from './copilot-auth';
import { debugLog } from './debug-log';
import { UsageReportModal } from './usage-report';
import { VaultIndexer, DEFAULT_EMBEDDING_SETTINGS } from './embeddings';
import { setVaultIndexer } from './tools';
import { registerQuickActionsMenu } from './quick-actions';
import { mergeWithDefaults } from '../lib/utils';
import { checkForUpdates } from './auto-update';

export default class SidekickPlugin extends Plugin {
    settings!: PluginSettings;
    storage!: ChatStorage;
    promptManager!: CustomPromptManager;
    vaultIndexer!: VaultIndexer;
    /** Cached model list from last model picker fetch (survives view rebuilds). */
    cachedModels: ModelInfo[] = [];

    async onload(): Promise<void> {
        await this.loadSettings();
        console.log(`Sidekick plugin loaded v${this.manifest.version}`);

        // Initialize debug logger
        debugLog.init(this.app, this.settings.debugLogging ?? false);

        // Initialize token manager with active Copilot account
        const activeAccount = this.settings.copilotAccounts.find(
            a => a.id === this.settings.activeCopilotAccountId
        );
        if (activeAccount) {
            copilotTokenManager.setOAuthToken(activeAccount.oauthToken);
        }

        this.storage = new ChatStorage(this.app, this.settings.chatFolder);

        // Track chat file renames so externally renamed conversations remain accessible
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file.path.endsWith('.md') && oldPath.startsWith(this.settings.chatFolder + '/')) {
                    this.storage.handleFileRename(oldPath, file.path);
                }
            }),
        );

        this.promptManager = new CustomPromptManager(this.app, this.settings.customPromptsFolder);
        this.promptManager.initialize();

        // Register the chat view
        this.registerView(SIDEKICK_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

        // Register the auto-completion CodeMirror extension
        this.registerEditorExtension(
            createAutocompleteExtension({
                getSettings: () => this.settings,
                getActiveNoteTitle: () => {
                    const file = this.app.workspace.getActiveFile();
                    return file?.basename ?? '';
                },
            }),
        );

        // Add ribbon icon to open chat
        this.addRibbonIcon('message-circle', 'Sidekick', () => {
            this.activateView();
        });

        // Add command to open chat panel
        this.addCommand({
            id: 'open-chat',
            name: 'Open Sidekick',
            callback: () => this.activateView(),
        });

        // Add command to start new conversation
        this.addCommand({
            id: 'new-chat',
            name: 'New Sidekick conversation',
            callback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) await view.newConversation();
            },
        });

        // Add command to add active note as context
        this.addCommand({
            id: 'add-note-context',
            name: 'Add active note to Sidekick',
            editorCallback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) view.addNoteContext();
            },
        });

        // Add command to add selection as context
        this.addCommand({
            id: 'add-selection-context',
            name: 'Add selection to Sidekick',
            editorCallback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) view.addSelectionContext();
            },
        });

        // Add command to open model picker
        this.addCommand({
            id: 'switch-model',
            name: 'Switch model',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'm' }],
            callback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) await view.openModelPicker();
            },
        });

        // Add command to view usage report
        this.addCommand({
            id: 'usage-report',
            name: 'Usage report',
            callback: async () => {
                const conversations = await this.storage.loadAllConversations();
                new UsageReportModal(this.app, conversations).open();
            },
        });

        // Add command to manually trigger inline suggestion
        this.addCommand({
            id: 'trigger-inline-suggestion',
            name: 'Trigger inline suggestion',
            hotkeys: [{ modifiers: ['Alt'], key: '\\' }],
            editorCallback: (_editor, view) => {
                if (!this.settings.autocomplete.enabled) return;
                // CM6 EditorView accessible via view.editor.cm
                const cmView = (view as unknown as { editor: { cm: import('@codemirror/view').EditorView } }).editor?.cm;
                if (cmView) triggerAutocomplete(cmView, this.settings);
            },
        });

        // Focus chat input (like VS Code Copilot Chat Ctrl+L)
        this.addCommand({
            id: 'focus-chat',
            name: 'Focus Sidekick chat input',
            hotkeys: [{ modifiers: ['Ctrl'], key: 'l' }],
            callback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) view.focusChatInput();
            },
        });

        // Toggle iterate mode
        this.addCommand({
            id: 'toggle-iterate',
            name: 'Toggle iterate mode',
            callback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) view.toggleIterateMode();
            },
        });

        // Summarize active note in one step
        this.addCommand({
            id: 'summarize-note',
            name: 'Summarize active note in Sidekick',
            editorCallback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) {
                    await view.addNoteContext();
                    view.sendMessageFromCommand('Summarize this note. Include key points, main ideas, and any action items.');
                }
            },
        });

        // Ask about active note in one step
        this.addCommand({
            id: 'ask-about-note',
            name: 'Ask Sidekick about active note',
            editorCallback: async () => {
                await this.activateView();
                const view = this.getView();
                if (view) {
                    await view.addNoteContext();
                    view.focusChatInput();
                }
            },
        });

        // Check for updates via S3
        this.addCommand({
            id: 'check-for-updates',
            name: 'Check for Updates',
            callback: () => checkForUpdates(this.app, this, true),
        });

        // Register settings tab
        this.addSettingTab(new SidekickSettingTab(this.app, this));

        // Register Quick Actions context menu (right-click on selected text)
        this.registerEvent(
            this.app.workspace.on('editor-menu', registerQuickActionsMenu(this.app, this.settings)),
        );

        // Initialize embeddings/vector search (non-blocking)
        this.vaultIndexer = new VaultIndexer({
            ...DEFAULT_EMBEDDING_SETTINGS,
            enabled: this.settings.embeddingsEnabled,
            dimensions: this.settings.embeddingDimensions ?? DEFAULT_EMBEDDING_SETTINGS.dimensions,
            model: this.settings.embeddingModel ?? DEFAULT_EMBEDDING_SETTINGS.model,
        });
        setVaultIndexer(this.vaultIndexer);

        // Defer indexing to after Obsidian layout is ready (non-blocking startup)
        this.app.workspace.onLayoutReady(() => {
            this.initEmbeddings();
            // Silently check for S3 updates a few seconds after startup
            setTimeout(() => {
                checkForUpdates(this.app, this, false);
            }, 5000);
        });
    }

    /**
     * Initialize embeddings: open IndexedDB, register file watchers,
     * and start background indexing if enabled.
     */
    private async initEmbeddings(): Promise<void> {
        try {
            // Use vault adapter basePath as unique vault identifier
            const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? this.app.vault.getName();
            await this.vaultIndexer.initialize(vaultPath);

            // Register file watchers for incremental updates
            if (this.settings.embeddingsEnabled) {
                this.registerEvent(
                    this.app.vault.on('modify', (file) => {
                        if (file.path.endsWith('.md')) {
                            // Debounce: wait 5s after last edit before re-indexing
                            this.debouncedIndexFile(file as TFile);
                        }
                    }),
                );
                this.registerEvent(
                    this.app.vault.on('delete', (file) => {
                        if (file.path.endsWith('.md')) {
                            this.vaultIndexer.removeFile(file.path);
                        }
                    }),
                );
                this.registerEvent(
                    this.app.vault.on('rename', (file, oldPath) => {
                        if (file.path.endsWith('.md')) {
                            this.vaultIndexer.renameFile(oldPath, file.path);
                        }
                    }),
                );

                // Start background indexing
                this.vaultIndexer.indexVault(this.app);
            }
        } catch (err) {
            debugLog.log('embeddings', 'Failed to initialize embeddings', { error: String(err) });
        }
    }

    /** Debounced file re-index — waits 5s after last edit. */
    private _indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private debouncedIndexFile(file: import('obsidian').TFile): void {
        const existing = this._indexTimers.get(file.path);
        if (existing) clearTimeout(existing);
        this._indexTimers.set(file.path, setTimeout(() => {
            this._indexTimers.delete(file.path);
            this.vaultIndexer.indexFile(this.app, file);
        }, 5000));
    }

    onunload(): void {
        this.promptManager?.destroy();
        this.vaultIndexer?.destroy();
        setVaultIndexer(null);
        this.app.workspace.detachLeavesOfType(SIDEKICK_VIEW_TYPE);
    }

    private getView(): ChatView | null {
        const leaves = this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
        if (leaves.length > 0) {
            return leaves[0].view as ChatView;
        }
        return null;
    }

    async activateView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }

        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: SIDEKICK_VIEW_TYPE, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    async loadSettings(): Promise<void> {
        this.settings = mergeWithDefaults(DEFAULT_SETTINGS, await this.loadData());
        // Ensure collections array exists for pre-collections users
        if (!Array.isArray(this.settings.collections)) {
            this.settings.collections = [];
        }
        // NOTE: We intentionally do NOT call resolveModelForProvider() here.
        // The saved model was previously valid — resolving against the small
        // fallbackModels list would incorrectly reset dynamically-fetched models
        // (e.g. OpenRouter models not in the hardcoded list).
        // resolveModelForProvider() is only called when the provider changes
        // (settings.ts, chat-view.ts).

        // Migrate single copilotToken → copilotAccounts
        if (this.settings.copilotToken && this.settings.copilotAccounts.length === 0) {
            const id = crypto.randomUUID();
            this.settings.copilotAccounts = [{
                id,
                label: 'Default',
                oauthToken: this.settings.copilotToken,
            }];
            this.settings.activeCopilotAccountId = id;
            this.settings.copilotToken = '';
            await this.saveSettings();
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        // Update storage folder if changed
        if (this.storage) {
            this.storage.setChatFolder(this.settings.chatFolder);
        }
        if (this.promptManager) {
            this.promptManager.setFolder(this.settings.customPromptsFolder);
        }
    }
}


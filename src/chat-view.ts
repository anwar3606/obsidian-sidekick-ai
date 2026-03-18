import { ItemView, WorkspaceLeaf, setIcon, Notice, TFile, Component, MarkdownRenderer, Menu } from 'obsidian';
import type SidekickPlugin from './main';
import type { ChatMessage, Conversation, PendingToolApproval, NoteContext, CustomCommand } from './types';
import type { ContextBreakdown } from './api-helpers';
import { SIDEKICK_VIEW_TYPE, PROVIDERS } from './constants';
import { resolveModelForProvider } from '../lib/providers';
import { fetchCopilotQuotaInfo, copilotTokenManager } from './copilot-auth';
import { resolveToolApproval, clearPendingApprovals } from './tools';
import { parseSlashCommand, slashHelpText, getCommandSuggestions } from './commands';
import { getResourceUrl, saveImageToVault, extractNoteImages } from './image-utils';
import { ModelPicker } from './model-picker';
import { renderMessage, updateLastAssistantContent, buildExportMarkdown } from './message-renderer';
import { renderConversationList, type ConversationListState } from './conversation-list';
import { orchestrateSendMessage } from './chat-controller';
import { buildApiMessages, computeContextBreakdown } from './api-helpers';
import { updateToggleButton, ensureFolder } from './utils';
import { searchFiles } from './search';
import { PROVIDER_ICONS } from './icons';
import { getErrorMessage, categorizeError } from '../lib/utils';
import { buildFollowUpPromptMessages, parseFollowUpResponse, shouldGenerateSuggestions } from '../lib/suggestions';
import type { FollowUpSuggestion } from '../lib/suggestions';

/**
 * ChatView — the main sidebar view for the Sidekick plugin.
 *
 * Responsibilities are limited to:
 *   - UI construction and event handling
 *   - Conversation state management (new/switch/delete)
 *   - Delegating message sending to the ChatController
 */
export class ChatView extends ItemView {
    plugin: SidekickPlugin;
    private conversation: Conversation | null = null;
    private abortController: AbortController | null = null;
    private activeSend: Promise<void> | null = null;
    private isLoading = false;
    private pendingApproval: PendingToolApproval | null = null;

    // DOM refs
    private messagesContainer!: HTMLElement;

    // Disposable component for MarkdownRenderer — prevents memory leaks on re-render
    private renderComponent: Component | null = null;
    private inputEl!: HTMLTextAreaElement;
    private stopBtn!: HTMLElement;
    private headerModelLabel!: HTMLElement;
    private errorBanner!: HTMLElement;
    private suggestionEl!: HTMLElement;
    private approvalContainer!: HTMLElement;
    private conversationListEl!: HTMLElement;
    private showConversations = false;

    // Attached notes
    private attachedNotes: NoteContext[] = [];
    private attachedNotesEl!: HTMLElement;
    private modelPickerBtn!: HTMLElement;
    private modelPickerOverlay!: HTMLElement;
    private modelPicker!: ModelPicker;
    private thinkBtn!: HTMLElement;
    private toolsBtn!: HTMLElement;
    private iterateBtn!: HTMLElement;
    private submitBtn!: HTMLElement;
    private loadingIndicator!: HTMLElement;
    private loadingTextEl!: HTMLElement;
    private contextBarEl!: HTMLElement;
    private contextFillEl!: HTMLElement;
    private contextLabelEl!: HTMLElement;
    private contextTooltipEl!: HTMLElement;

    // Copilot quota bar
    private quotaBarEl!: HTMLElement;
    private quotaFillEl!: HTMLElement;
    private quotaLabelEl!: HTMLElement;
    private quotaTooltipEl!: HTMLElement;

    // Embedding index progress
    private embeddingBarEl!: HTMLElement;
    private embeddingFillEl!: HTMLElement;
    private embeddingLabelEl!: HTMLElement;

    // Iterate mode feedback
    private iterateFeedbackBanner!: HTMLElement;
    private iterateResumeBanner!: HTMLElement;
    private iterateFeedbackResolve: ((value: { text: string; images?: string[] } | null) => void) | null = null;
    private isWaitingForFeedback = false;
    private isWaitingForResume = false;
    private savedPlaceholder = '';

    // Slash-command suggestion navigation
    private suggestionIndex = -1;
    private suggestionMode: 'slash' | 'mention' | null = null;
    private convListState: ConversationListState = { groupBy: 'time', sortBy: 'date', sortDir: 'asc', searchQuery: '', collections: [] };

    // Input history
    private sentHistory: string[] = [];
    private historyIndex = -1;
    private draftInput = '';
    private drafts = new Map<string, string>();

    // Pasted images
    private pendingImages: string[] = [];
    private pendingImagesEl!: HTMLElement;

    // Follow-up suggestion chips
    private followUpChipsEl!: HTMLElement;
    private suggestionAbortController: AbortController | null = null;

    // Message queuing (type while generating)
    private queuedMessage: { text: string; images: string[] } | null = null;
    private queuedBannerEl!: HTMLElement;
    private scrollToBottomBtn!: HTMLElement;

    // In-conversation search
    private searchBarEl!: HTMLElement;
    private searchInputEl!: HTMLInputElement;
    private searchCountEl!: HTMLElement;
    private searchMatches: HTMLElement[] = [];
    private searchMatchIndex = -1;

    // Input token counter
    private tokenCountEl!: HTMLElement;
    // Clear input button
    private clearInputBtn!: HTMLElement;

    // Session cost tracking
    private sessionCost = 0;
    private sessionTokensPrompt = 0;
    private sessionTokensCompletion = 0;

    private lastBreakdown: ContextBreakdown | null = null;
    private lastApiTokens?: number;

    constructor(leaf: WorkspaceLeaf, plugin: SidekickPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return SIDEKICK_VIEW_TYPE; }
    getDisplayText(): string { return 'Sidekick'; }
    getIcon(): string { return 'message-circle'; }

    // ── Lifecycle ───────────────────────────────────────────────────

    async onOpen(): Promise<void> {
        const container = this.contentEl;
        container.empty();
        container.addClass('sidekick-container');

        this.buildMessagesArea(container);
        this.buildConversationList(container);
        this.buildControlsBar(container);
        this.buildSuggestionsDropdown(container);
        this.buildInputArea(container);
        this.bindInputEvents();

        await this.loadInitialConversation();
        this.applyTypography();
    }

    async onClose(): Promise<void> {
        this.stopGeneration();
        clearPendingApprovals();
        if (this.activeSend) {
            try { await this.activeSend; } catch { /* ignore */ }
        }
        // Clean up markdown render component to prevent memory leaks
        if (this.renderComponent) {
            this.removeChild(this.renderComponent);
            this.renderComponent = null;
        }
    }

    /** Focus the chat input textarea (for Ctrl+L shortcut). */
    focusChatInput(): void {
        this.inputEl?.focus();
    }

    /** Send a message programmatically (from a command). */
    sendMessageFromCommand(content: string): void {
        this.inputEl.value = content;
        this.handleSend();
    }

    // ── UI construction (broken out of onOpen) ──────────────────────

    private buildErrorBanner(container: HTMLElement): void {
        this.errorBanner = container.createDiv({ cls: 'sidekick-error-banner' });
        this.errorBanner.style.display = 'none';
        this.errorBanner.setAttribute('role', 'alert');
    }

    private buildConversationList(container: HTMLElement): void {
        this.conversationListEl = container.createDiv({ cls: 'sidekick-conversation-list' });
        this.conversationListEl.style.display = 'none';
    }

    private buildApprovalBanner(container: HTMLElement): void {
        this.approvalContainer = container.createDiv({ cls: 'sidekick-approval' });
        this.approvalContainer.style.display = 'none';
        this.approvalContainer.setAttribute('role', 'alertdialog');
        this.approvalContainer.setAttribute('aria-label', 'Tool approval request');
    }

    private buildMessagesArea(container: HTMLElement): void {
        const messagesWrapper = container.createDiv({ cls: 'sidekick-messages-wrapper' });

        // Search bar (hidden by default)
        this.searchBarEl = messagesWrapper.createDiv({ cls: 'sidekick-search-bar' });
        this.searchBarEl.style.display = 'none';
        this.searchInputEl = this.searchBarEl.createEl('input', {
            cls: 'sidekick-search-input',
            attr: { placeholder: 'Search in conversation…', type: 'text' },
        });
        this.searchCountEl = this.searchBarEl.createSpan({ cls: 'sidekick-search-count' });
        const searchPrev = this.searchBarEl.createEl('button', { cls: 'sidekick-search-nav', attr: { title: 'Previous' } });
        setIcon(searchPrev, 'chevron-up');
        const searchNext = this.searchBarEl.createEl('button', { cls: 'sidekick-search-nav', attr: { title: 'Next' } });
        setIcon(searchNext, 'chevron-down');
        const searchClose = this.searchBarEl.createEl('button', { cls: 'sidekick-search-nav', attr: { title: 'Close' } });
        setIcon(searchClose, 'x');

        this.searchInputEl.addEventListener('input', () => this.performSearch());
        searchPrev.addEventListener('click', () => this.navigateSearch(-1));
        searchNext.addEventListener('click', () => this.navigateSearch(1));
        searchClose.addEventListener('click', () => this.closeSearch());
        this.searchInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.navigateSearch(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
        });

        this.messagesContainer = messagesWrapper.createDiv({ cls: 'sidekick-messages' });
        this.messagesContainer.setAttribute('role', 'log');
        this.messagesContainer.setAttribute('aria-label', 'Chat messages');

        // Scroll-to-bottom FAB
        this.scrollToBottomBtn = messagesWrapper.createEl('button', {
            cls: 'sidekick-scroll-to-bottom',
            attr: { title: 'Scroll to bottom' },
        });
        setIcon(this.scrollToBottomBtn, 'arrow-down');
        this.scrollToBottomBtn.style.display = 'none';
        this.scrollToBottomBtn.addEventListener('click', () => this.scrollToBottom(true));

        let scrollRaf = 0;
        this.messagesContainer.addEventListener('scroll', () => {
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => {
                scrollRaf = 0;
                this.scrollToBottomBtn.style.display = this.isNearBottom() ? 'none' : 'flex';
            });
        });
    }

    private buildControlsBar(container: HTMLElement): void {
        const controlsBar = container.createDiv({ cls: 'sidekick-controls' });
        this.headerModelLabel = controlsBar.createSpan({ cls: 'sidekick-controls-title' });
        this.headerModelLabel.setAttribute('title', 'Double-click to rename');
        this.headerModelLabel.addEventListener('dblclick', () => this.renameConversationInline());
        const controlsRight = controlsBar.createDiv({ cls: 'sidekick-controls-actions' });

        const buttons: Array<{ icon: string; title: string; handler: () => void }> = [
            { icon: 'message-circle-plus', title: 'New chat', handler: () => this.newConversation() },
            { icon: 'external-link', title: 'Open chat note', handler: () => this.openConversationNote() },
            { icon: 'history', title: 'History', handler: () => this.toggleConversationList() },
            { icon: 'search', title: 'Search (Ctrl+F)', handler: () => this.openSearch() },
            { icon: 'download', title: 'Save as note', handler: () => this.exportChat() },
            { icon: 'clipboard-copy', title: 'Copy chat', handler: () => this.copyChat() },
            { icon: 'gauge', title: 'Copilot usage', handler: () => this.toggleCopilotUsage() },
            { icon: 'keyboard', title: 'Shortcuts (Ctrl+/)', handler: () => this.showShortcutsOverlay() },
            { icon: 'settings', title: 'Settings', handler: () => this.openSettings() },
        ];

        for (const { icon, title, handler } of buttons) {
            const btn = controlsRight.createEl('button', { cls: 'sidekick-ctrl-btn', attr: { title } });
            setIcon(btn, icon);
            btn.addEventListener('click', handler);
        }
    }

    private buildSuggestionsDropdown(container: HTMLElement): void {
        this.suggestionEl = container.createDiv({ cls: 'sidekick-suggestions' });
        this.suggestionEl.style.display = 'none';
        this.suggestionEl.setAttribute('role', 'listbox');
        this.suggestionEl.setAttribute('aria-label', 'Suggestions');
    }

    private buildInputArea(container: HTMLElement): void {
        const inputWrapper = container.createDiv({ cls: 'sidekick-input-wrapper' });

        // Error/retry banner (above input, hidden by default)
        this.buildErrorBanner(inputWrapper);

        // Tool approval banner (above input, hidden by default)
        this.buildApprovalBanner(inputWrapper);

        // Iterate feedback banner (above input, hidden by default)
        this.iterateFeedbackBanner = inputWrapper.createDiv({ cls: 'sidekick-iterate-banner' });
        this.iterateFeedbackBanner.style.display = 'none';

        // Iterate resume banner (above input, hidden by default)
        this.iterateResumeBanner = inputWrapper.createDiv({ cls: 'sidekick-iterate-resume-banner' });
        this.iterateResumeBanner.style.display = 'none';

        // Attached notes chips
        this.attachedNotesEl = inputWrapper.createDiv({ cls: 'sidekick-attached-notes' });
        this.attachedNotesEl.style.display = 'none';

        // Pending images
        this.pendingImagesEl = inputWrapper.createDiv({ cls: 'sidekick-pending-images' });
        this.pendingImagesEl.style.display = 'none';

        // Follow-up suggestion chips (above textarea, hidden by default)
        this.followUpChipsEl = inputWrapper.createDiv({ cls: 'sidekick-followup-chips' });
        this.followUpChipsEl.style.display = 'none';

        // Queued message banner (above textarea, hidden by default)
        this.queuedBannerEl = inputWrapper.createDiv({ cls: 'sidekick-queued-banner' });
        this.queuedBannerEl.style.display = 'none';

        // Textarea + clear button wrapper
        const textareaWrapper = inputWrapper.createDiv({ cls: 'sidekick-textarea-wrapper' });
        this.inputEl = textareaWrapper.createEl('textarea', {
            cls: 'sidekick-input',
            attr: {
                placeholder: 'Ask anything... • /help for commands',
                rows: '1',
                'aria-label': 'Chat message input',
                'aria-describedby': 'sidekick-input-hint',
            },
        });
        // Rotate placeholder tips
        const placeholders = [
            'Ask anything... • /help for commands',
            'Try @filename to attach a note',
            'Drag & drop files here',
            '/search to find across all chats',
            'Shift+Enter for new line',
            'Ctrl+N to start a new chat',
            '↑↓ to navigate message history',
        ];
        let placeholderIdx = 0;
        const placeholderInterval = window.setInterval(() => {
            if (this.inputEl.value) return; // don't change while typing
            placeholderIdx = (placeholderIdx + 1) % placeholders.length;
            this.inputEl.placeholder = placeholders[placeholderIdx];
        }, 8000);
        this.register(() => window.clearInterval(placeholderInterval));
        this.clearInputBtn = textareaWrapper.createEl('button', {
            cls: 'sidekick-clear-input-btn',
            attr: { title: 'Clear input', 'aria-label': 'Clear input' },
        });
        setIcon(this.clearInputBtn, 'x');
        this.clearInputBtn.style.display = 'none';
        this.clearInputBtn.addEventListener('click', () => {
            this.inputEl.value = '';
            this.autoResizeInput();
            this.updateTokenCount();
            this.updateClearButton();
            this.inputEl.focus();
        });

        // Footer toolbar
        const inputFooter = inputWrapper.createDiv({ cls: 'sidekick-input-footer' });
        this.buildFooterLeft(inputFooter, container);
        this.buildFooterRight(inputFooter);
    }

    private buildFooterLeft(footer: HTMLElement, container: HTMLElement): void {
        const footerLeft = footer.createDiv({ cls: 'sidekick-footer-left' });

        // Model picker button
        this.modelPickerBtn = footerLeft.createEl('button', { cls: 'sidekick-model-picker-btn' });
        this.updateModelLabel();
        this.modelPickerBtn.addEventListener('click', () => this.openModelPickerUI());

        // Input token counter (hidden when empty)
        this.tokenCountEl = footerLeft.createSpan({ cls: 'sidekick-token-count' });
        this.tokenCountEl.style.display = 'none';

        // Model picker overlay (hidden)
        this.modelPickerOverlay = container.createDiv({ cls: 'sidekick-model-picker-overlay' });
        this.modelPickerOverlay.style.display = 'none';
        this.modelPicker = new ModelPicker(this.modelPickerOverlay);
        // Restore previously fetched models so capability badges survive view rebuilds
        this.modelPicker.initModels(this.plugin.settings.selectedProvider, this.plugin.cachedModels);

        // Loading indicator
        this.loadingIndicator = footerLeft.createDiv({ cls: 'sidekick-loading-indicator' });
        const spinnerIcon = this.loadingIndicator.createSpan({ cls: 'sidekick-spinner' });
        setIcon(spinnerIcon, 'loader-2');
        this.loadingTextEl = this.loadingIndicator.createSpan({ text: 'Generating...', cls: 'sidekick-loading-text' });
        this.loadingIndicator.style.display = 'none';

        // Context breakdown bar (also shows session cost)
        this.contextBarEl = footerLeft.createDiv({ cls: 'sidekick-context-bar' });
        this.contextBarEl.style.display = 'none';
        const ctxBar = this.buildProgressBar(this.contextBarEl);
        this.contextFillEl = ctxBar.fillEl;
        this.contextLabelEl = ctxBar.labelEl;
        this.contextTooltipEl = ctxBar.tooltipEl!;

        // Copilot quota bar (same pattern as context bar)
        this.quotaBarEl = footerLeft.createDiv({ cls: 'sidekick-quota-bar' });
        this.quotaBarEl.style.display = 'none';
        const quotaBar = this.buildProgressBar(this.quotaBarEl);
        this.quotaFillEl = quotaBar.fillEl;
        this.quotaLabelEl = quotaBar.labelEl;
        this.quotaTooltipEl = quotaBar.tooltipEl!;

        // Embedding index progress bar
        this.embeddingBarEl = footerLeft.createDiv({ cls: 'sidekick-embedding-bar' });
        this.embeddingBarEl.style.display = 'none';
        const embBar = this.buildProgressBar(this.embeddingBarEl, { tooltip: false, fillCls: 'sidekick-embedding-fill' });
        this.embeddingFillEl = embBar.fillEl;
        this.embeddingLabelEl = embBar.labelEl;

        // Wire up indexer progress
        this.setupEmbeddingProgress();
    }

    /** Create a progress bar with track, fill, label, and optional tooltip. */
    private buildProgressBar(
        parent: HTMLElement,
        opts: { tooltip?: boolean; fillCls?: string } = {},
    ): { fillEl: HTMLElement; labelEl: HTMLElement; tooltipEl?: HTMLElement } {
        const trackEl = parent.createDiv({ cls: 'sidekick-context-track' });
        const fillCls = opts.fillCls ? `sidekick-context-fill ${opts.fillCls}` : 'sidekick-context-fill';
        const fillEl = trackEl.createDiv({ cls: fillCls });
        const labelEl = parent.createSpan({ cls: 'sidekick-context-label' });

        if (opts.tooltip !== false) {
            const tooltipEl = parent.createDiv({ cls: 'sidekick-context-tooltip' });
            tooltipEl.style.display = 'none';
            parent.addEventListener('mouseenter', () => { tooltipEl.style.display = 'block'; });
            parent.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
            return { fillEl, labelEl, tooltipEl };
        }
        return { fillEl, labelEl };
    }

    /** Wire up embedding indexer progress to the progress bar. */
    private setupEmbeddingProgress(): void {
        const indexer = this.plugin.vaultIndexer;
        if (!indexer) return;

        indexer.onProgress = (progress) => {
            if (progress.phase === 'done' || progress.phase === 'error') {
                this.embeddingBarEl.style.display = 'none';
                return;
            }

            this.embeddingBarEl.style.display = '';
            const pct = progress.total > 0 ? Math.round((progress.indexed / progress.total) * 100) : 0;
            this.embeddingFillEl.style.width = `${pct}%`;
            this.embeddingLabelEl.textContent = `🧠 Indexing ${progress.indexed}/${progress.total} files (${pct}%)`;
        };
    }

    private buildFooterRight(footer: HTMLElement): void {
        const footerRight = footer.createDiv({ cls: 'sidekick-footer-right' });

        // Thinking toggle
        this.thinkBtn = footerRight.createEl('button', { cls: 'sidekick-tool-btn', attr: { title: 'Toggle thinking' } });
        setIcon(this.thinkBtn, 'brain');
        updateToggleButton(this.thinkBtn, this.plugin.settings.thinkingEnabled);
        this.thinkBtn.addEventListener('click', async () => {
            this.plugin.settings.thinkingEnabled = !this.plugin.settings.thinkingEnabled;
            await this.plugin.saveSettings();
            updateToggleButton(this.thinkBtn, this.plugin.settings.thinkingEnabled);
        });

        // Tools toggle
        this.toolsBtn = footerRight.createEl('button', { cls: 'sidekick-tool-btn', attr: { title: 'Toggle tools' } });
        setIcon(this.toolsBtn, 'wrench');
        updateToggleButton(this.toolsBtn, this.plugin.settings.toolsEnabled);
        this.toolsBtn.addEventListener('click', async () => {
            this.plugin.settings.toolsEnabled = !this.plugin.settings.toolsEnabled;
            await this.plugin.saveSettings();
            updateToggleButton(this.toolsBtn, this.plugin.settings.toolsEnabled);
        });

        // Iterate mode toggle
        this.iterateBtn = footerRight.createEl('button', { cls: 'sidekick-tool-btn', attr: { title: 'Toggle iterate mode (ask for feedback after each response)' } });
        setIcon(this.iterateBtn, 'repeat');
        updateToggleButton(this.iterateBtn, this.plugin.settings.iterateMode);
        this.iterateBtn.addEventListener('click', async () => {
            this.plugin.settings.iterateMode = !this.plugin.settings.iterateMode;
            await this.plugin.saveSettings();
            updateToggleButton(this.iterateBtn, this.plugin.settings.iterateMode);
        });

        // Agent preset picker button
        const agentBtn = footerRight.createEl('button', { cls: 'sidekick-tool-btn', attr: { title: 'Switch agent preset' } });
        setIcon(agentBtn, 'user');
        agentBtn.addEventListener('click', async (e) => {
            const { BUILT_IN_PRESETS } = await import('../lib/agents');
            const menu = new Menu();
            for (const p of BUILT_IN_PRESETS) {
                const isActive = p.id === this.plugin.settings.activeAgentPreset;
                menu.addItem(item => {
                    item.setTitle(`${p.icon} ${p.name}${isActive ? ' ✓' : ''}`)
                        .setChecked(isActive)
                        .onClick(async () => {
                            this.plugin.settings.activeAgentPreset = p.id;
                            await this.plugin.saveSettings();
                            this.addSystemMessage(`${p.icon} Switched to **${p.name}** — ${p.description}`);
                            await this.renderMessages();
                        });
                });
            }
            menu.showAtMouseEvent(e);
        });

        // Add context button
        const addContextBtn = footerRight.createEl('button', { cls: 'sidekick-tool-btn', attr: { title: 'Add active note as context' } });
        setIcon(addContextBtn, 'file-text');
        addContextBtn.addEventListener('click', () => this.addNoteContext());

        // Submit button
        this.submitBtn = footerRight.createEl('button', { cls: 'sidekick-submit-btn', attr: { title: 'Send (Enter)' } });
        setIcon(this.submitBtn, 'corner-down-left');
        this.submitBtn.addEventListener('click', () => this.handleSend());

        // Stop button
        this.stopBtn = footerRight.createEl('button', { cls: 'sidekick-stop-btn', attr: { title: 'Stop generation' } });
        setIcon(this.stopBtn, 'stop-circle');
        this.stopBtn.style.display = 'none';
        this.stopBtn.addEventListener('click', () => this.stopGeneration());
    }

    private bindInputEvents(): void {
        // Use capture phase on the container so we intercept Ctrl+Enter and Ctrl+F
        // before Obsidian's app-level handlers can consume it
        this.contentEl.addEventListener('keydown', (e) => {
            // Escape → stop generation when active
            if (e.key === 'Escape' && this.abortController) {
                e.preventDefault();
                e.stopPropagation();
                this.stopGeneration();
                return;
            }
            // Ctrl+F / Cmd+F → open in-conversation search
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                e.stopPropagation();
                this.openSearch();
                return;
            }
            // Ctrl+/ → show keyboard shortcuts overlay
            if ((e.ctrlKey || e.metaKey) && e.key === '/') {
                e.preventDefault();
                e.stopPropagation();
                this.showShortcutsOverlay();
                return;
            }
            // Ctrl+N → new conversation
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                e.stopPropagation();
                this.newConversation();
                return;
            }
            // Ctrl+Shift+E → export chat
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
                e.preventDefault();
                e.stopPropagation();
                this.exportChat();
                return;
            }
            // Ctrl+Shift+Z → undo last exchange
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') {
                e.preventDefault();
                e.stopPropagation();
                this.undoLastExchange();
                return;
            }
            // Ctrl+Shift+R → regenerate last response
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
                e.preventDefault();
                e.stopPropagation();
                this.regenerate();
                return;
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Main chat input → send message
                if (e.target === this.inputEl) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleSend();
                    return;
                }
                // Edit textarea → handled by the textarea's own keydown listener
                // (registered in editMessage). We just need to stop propagation
                // so Obsidian doesn't intercept it.
                if ((e.target as HTMLElement)?.classList?.contains('sidekick-edit-textarea')) {
                    e.preventDefault();
                    // Don't stopPropagation — let the event reach the textarea's handler
                }
            }
        }, true);

        this.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
        this.inputEl.addEventListener('paste', (e) => this.handlePaste(e));
        this.inputEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.inputEl.classList.add('sidekick-drag-over');
        });
        this.inputEl.addEventListener('dragleave', () => {
            this.inputEl.classList.remove('sidekick-drag-over');
        });
        this.inputEl.addEventListener('drop', (e) => {
            this.inputEl.classList.remove('sidekick-drag-over');
            this.handleDrop(e);
        });
        this.inputEl.addEventListener('input', () => {
            this.autoResizeInput();
            this.updateSuggestions();
            this.updateTokenCount();
            this.updateClearButton();
            // Hide follow-up chips when user starts typing
            if (this.inputEl.value.length > 0) this.clearFollowUpChips();
        });
    }

    private async loadInitialConversation(): Promise<void> {
        const conversations = await this.plugin.storage.loadAllConversations();
        if (conversations.length > 0) {
            // Pick the most recently updated conversation (last in ascending-sorted list)
            this.conversation = conversations[conversations.length - 1];
        } else {
            await this.newConversation();
        }
        this.renderMessages();
        this.checkAndShowResumeBanner();
    }

    // ── Input event handlers ────────────────────────────────────────

    private handleKeyDown(e: KeyboardEvent): void {
        const suggestionsVisible = this.suggestionEl.style.display !== 'none';

        // ── Slash-command suggestion navigation ─────────────────────
        if (suggestionsVisible) {
            const items = this.suggestionEl.querySelectorAll('.sidekick-suggestion-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.suggestionIndex = Math.min(this.suggestionIndex + 1, items.length - 1);
                this.highlightSuggestion(items);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.suggestionIndex = Math.max(this.suggestionIndex - 1, 0);
                this.highlightSuggestion(items);
                return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && this.suggestionIndex >= 0 && this.suggestionIndex < items.length) {
                e.preventDefault();
                (items[this.suggestionIndex] as HTMLElement).click();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.hideSuggestions();
                return;
            }
        }

        // ── Send on Enter (without Shift) OR Ctrl+Enter / Cmd+Enter
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSend();
            return;
        }

        // ── Input history navigation ────────────────────────────────
        if (e.key === 'ArrowUp' && this.inputEl.selectionStart === 0 && this.inputEl.selectionEnd === 0) {
            if (this.sentHistory.length === 0) return;
            if (this.historyIndex === -1) {
                this.draftInput = this.inputEl.value;
                this.historyIndex = this.sentHistory.length - 1;
            } else if (this.historyIndex > 0) {
                this.historyIndex--;
            }
            this.inputEl.value = this.sentHistory[this.historyIndex];
            this.autoResizeInput();
            e.preventDefault();
            return;
        }
        if (e.key === 'ArrowDown' && this.historyIndex !== -1) {
            if (this.historyIndex < this.sentHistory.length - 1) {
                this.historyIndex++;
                this.inputEl.value = this.sentHistory[this.historyIndex];
            } else {
                this.historyIndex = -1;
                this.inputEl.value = this.draftInput;
            }
            this.autoResizeInput();
            e.preventDefault();
        }

        // ── Ctrl+L: New conversation ────────────────────────────────
        if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
            e.preventDefault();
            this.newConversation();
            return;
        }
    }

    private highlightSuggestion(items: NodeListOf<Element>): void {
        items.forEach((item, i) => {
            (item as HTMLElement).classList.toggle('is-selected', i === this.suggestionIndex);
        });
    }

    private handlePaste(e: ClipboardEvent): void {
        const items = e.clipboardData?.items;
        if (!items) return;
        let hasImage = false;
        for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                this.readImageFile(item.getAsFile());
                hasImage = true;
            }
        }
        // Detect URL paste and suggest action
        if (!hasImage) {
            const text = e.clipboardData?.getData('text/plain') || '';
            const urlMatch = text.trim().match(/^https?:\/\/\S+$/);
            if (urlMatch) {
                // Show a brief hint after the paste completes
                setTimeout(() => {
                    this.showUrlPasteHint(text.trim());
                }, 50);
            }
        }
    }

    private showUrlPasteHint(url: string): void {
        // Show suggestion chips for URL actions
        this.followUpChipsEl.empty();
        const chips = [
            { text: '📖 Summarize this URL', action: `Summarize this URL: ${url}` },
            { text: '❓ Ask about this page', action: `What is this page about? ${url}` },
        ];
        for (const chip of chips) {
            const el = this.followUpChipsEl.createEl('button', { cls: 'sidekick-followup-chip', text: chip.text });
            el.addEventListener('click', () => {
                this.inputEl.value = chip.action;
                this.handleSend();
            });
        }
        this.followUpChipsEl.style.display = 'flex';
    }

    private handleDrop(e: DragEvent): void {
        const files = e.dataTransfer?.files;

        // Handle Obsidian internal file drag (from file explorer)
        const textData = e.dataTransfer?.getData('text/plain');
        if (textData && !files?.length) {
            // Obsidian internal links look like [[filename]] or paths like folder/file.md
            const path = textData.replace(/^\[\[|\]\]$/g, '');
            const tfile = this.app.vault.getAbstractFileByPath(path);
            if (tfile && 'extension' in tfile) {
                e.preventDefault();
                this.attachNoteByFile(tfile as import('obsidian').TFile);
                return;
            }
        }

        if (!files) return;
        for (const file of Array.from(files)) {
            if (file.type.startsWith('image/')) {
                e.preventDefault();
                this.readImageFile(file);
            }
        }
    }

    private readImageFile(file: File | null): void {
        if (!file || this.pendingImages.length >= 10) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const { compressImageDataUrl } = await import('./image-utils');
            const compressed = await compressImageDataUrl(reader.result as string);
            this.pendingImages.push(compressed);
            this.renderPendingImages();
        };
        reader.readAsDataURL(file);
    }

    // ── Typography ──────────────────────────────────────────────────

    private applyTypography(): void {
        const s = this.plugin.settings;
        if (s.customTypography) {
            this.messagesContainer.style.fontSize = `${s.fontSize}rem`;
            this.messagesContainer.style.lineHeight = `${s.lineHeight}`;
        } else {
            // Respect Obsidian's global typography
            this.messagesContainer.style.fontSize = '';
            this.messagesContainer.style.lineHeight = '';
        }
        // Compact mode — reduced spacing
        this.contentEl.classList.toggle('sidekick-compact', !!s.compactMode);
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private openSettings(): void {
        // Obsidian's settings API is not in the public types
        const app = this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } };
        app.setting?.open();
        app.setting?.openTabById(this.plugin.manifest.id);
    }

    private togglePin(): void {
        if (!this.conversation) { this.addSystemMessage('No active conversation.'); return; }
        this.conversation.pinned = !this.conversation.pinned;
        this.plugin.storage.saveConversation(this.conversation);
        this.renderConversationListUI();
        this.addSystemMessage(this.conversation.pinned ? '📌 Conversation **pinned**' : '📌 Conversation **unpinned**');
    }

    private showConversationInfo(): void {
        if (!this.conversation) { this.addSystemMessage('No active conversation.'); return; }
        const c = this.conversation;
        const userCount = c.messages.filter(m => m.role === 'user').length;
        const assistantCount = c.messages.filter(m => m.role === 'assistant').length;
        const totalWords = c.messages.reduce((sum, m) => sum + (m.content || '').split(/\s+/).filter(Boolean).length, 0);
        const totalCost = c.usage?.totalCost ?? c.messages.reduce((sum, m) => sum + (m.cost?.total ?? 0), 0);
        const duration = c.updatedAt - c.createdAt;
        const durationStr = duration < 60000 ? `${Math.round(duration / 1000)}s`
            : duration < 3600000 ? `${Math.round(duration / 60000)}m`
            : `${(duration / 3600000).toFixed(1)}h`;
        const s = this.plugin.settings;
        const lines = [
            `**${c.title}**`,
            `Model: ${s.selectedModel}`,
            `Provider: ${PROVIDERS[s.selectedProvider]?.label ?? s.selectedProvider}`,
            `Messages: ${c.messages.length} (${userCount} user, ${assistantCount} assistant)`,
            `Words: ~${totalWords.toLocaleString()}`,
            `Duration: ${durationStr}`,
            totalCost > 0 ? `Cost: $${totalCost.toFixed(4)}` : '',
            `Pinned: ${c.pinned ? 'Yes' : 'No'}`,
            `Created: ${new Date(c.createdAt).toLocaleString()}`,
            `Updated: ${new Date(c.updatedAt).toLocaleString()}`,
        ].filter(Boolean);
        this.addSystemMessage(lines.join('\n'));
    }

    private async showVaultStats(): Promise<void> {
        const allConvs = await this.plugin.storage.loadAllConversations();
        const totalMsgs = allConvs.reduce((sum, c) => sum + c.messages.length, 0);
        const totalWords = allConvs.reduce((sum, c) =>
            sum + c.messages.reduce((ws, m) => ws + (m.content || '').split(/\s+/).filter(Boolean).length, 0), 0);
        const totalCost = allConvs.reduce((sum, c) => {
            const convCost = c.usage?.totalCost ?? c.messages.reduce((cs, m) => cs + (m.cost?.total ?? 0), 0);
            return sum + convCost;
        }, 0);
        const pinnedCount = allConvs.filter(c => c.pinned).length;
        const oldestDate = allConvs.length > 0 ? new Date(Math.min(...allConvs.map(c => c.createdAt))).toLocaleDateString() : 'N/A';
        const lines = [
            '**Vault Chat Statistics**',
            `Conversations: ${allConvs.length} (${pinnedCount} pinned)`,
            `Total messages: ${totalMsgs.toLocaleString()}`,
            `Total words: ~${totalWords.toLocaleString()}`,
            totalCost > 0 ? `Total cost: $${totalCost.toFixed(4)}` : '',
            `Oldest conversation: ${oldestDate}`,
            `Provider: ${PROVIDERS[this.plugin.settings.selectedProvider]?.label ?? this.plugin.settings.selectedProvider}`,
            `Model: ${this.plugin.settings.selectedModel}`,
        ].filter(Boolean);
        this.addSystemMessage(lines.join('\n'));
    }

    private async showFavorites(): Promise<void> {
        const allConvs = await this.plugin.storage.loadAllConversations();
        const favorites: { convTitle: string; content: string }[] = [];
        for (const conv of allConvs) {
            for (const msg of conv.messages) {
                if (msg.rating === 1 && msg.role === 'assistant') {
                    const preview = (msg.content || '').slice(0, 120).replace(/\n/g, ' ');
                    favorites.push({ convTitle: conv.title, content: preview });
                }
            }
        }
        if (favorites.length === 0) {
            this.addSystemMessage('No favorited messages yet. Use 👍 on assistant messages to favorite them.');
            return;
        }
        const lines = [`**⭐ Favorited Messages (${favorites.length})**`, ''];
        for (const fav of favorites.slice(0, 20)) {
            lines.push(`• **${fav.convTitle}**: ${fav.content}…`);
        }
        if (favorites.length > 20) {
            lines.push(`\n…and ${favorites.length - 20} more`);
        }
        this.addSystemMessage(lines.join('\n'));
    }

    private async searchAllConversations(query: string): Promise<void> {
        if (!query.trim()) {
            this.addSystemMessage('Usage: `/search <query>` — search across all conversations');
            return;
        }
        const allConvs = await this.plugin.storage.loadAllConversations();
        const needle = query.toLowerCase();
        const results: { convId: string; convTitle: string; preview: string; role: string }[] = [];

        for (const conv of allConvs) {
            for (const msg of conv.messages) {
                if (!msg.content) continue;
                const idx = msg.content.toLowerCase().indexOf(needle);
                if (idx === -1) continue;
                // Extract context around match
                const start = Math.max(0, idx - 40);
                const end = Math.min(msg.content.length, idx + needle.length + 60);
                const preview = (start > 0 ? '…' : '') + msg.content.slice(start, end).replace(/\n/g, ' ') + (end < msg.content.length ? '…' : '');
                results.push({ convId: conv.id, convTitle: conv.title, preview, role: msg.role });
                if (results.length >= 30) break;
            }
            if (results.length >= 30) break;
        }

        if (results.length === 0) {
            this.addSystemMessage(`No results found for "${query}".`);
            return;
        }

        const lines = [`**🔍 Search: "${query}"** (${results.length} matches)`, ''];
        for (const r of results) {
            const roleIcon = r.role === 'user' ? '👤' : '🤖';
            lines.push(`${roleIcon} **${r.convTitle}**: ${r.preview}`);
        }
        if (results.length >= 30) {
            lines.push('\n…showing first 30 matches');
        }
        this.addSystemMessage(lines.join('\n'));
    }

    private updateModelLabel(): void {
        const s = this.plugin.settings;
        const cfg = PROVIDERS[s.selectedProvider];
        if (!cfg) return;

        const modelName = s.selectedModel.replace(/^[^/]+\//, '');
        this.modelPickerBtn.empty();

        const providerIconStr = PROVIDER_ICONS[s.selectedProvider as keyof typeof PROVIDER_ICONS];
        if (providerIconStr) {
            const iconSpan = this.modelPickerBtn.createSpan({ cls: 'sidekick-model-picker-provider-icon' });
            iconSpan.innerHTML = providerIconStr;
        }

        this.modelPickerBtn.createSpan({ text: modelName, cls: 'sidekick-model-picker-label' });

        const cachedModels = this.modelPicker?.getCachedModels() ?? [];
        const currentModel = cachedModels.find(m => m.id === s.selectedModel);
        if (currentModel) {
            const caps: string[] = [];
            if (currentModel.supportsVision) caps.push('📷');
            if (currentModel.supportsThinking) caps.push('🧠');
            if (currentModel.supportsTools) caps.push('🔧');
            if (currentModel.supportsImageGen) caps.push('🎨');
            if (caps.length > 0) {
                this.modelPickerBtn.createSpan({ text: caps.join(''), cls: 'sidekick-model-picker-caps' });
            }
            // Tooltip with full capabilities
            const tipParts = [modelName];
            if (currentModel.supportsVision) tipParts.push('Vision');
            if (currentModel.supportsThinking) tipParts.push('Thinking');
            if (currentModel.supportsTools) tipParts.push('Tools');
            if (currentModel.supportsImageGen) tipParts.push('Image Gen');
            this.modelPickerBtn.setAttribute('title', tipParts.join(' · '));
        } else {
            this.modelPickerBtn.setAttribute('title', `${modelName} (${cfg.label})`);
        }

        const chevron = this.modelPickerBtn.createSpan({ cls: 'sidekick-model-picker-chevron' });
        setIcon(chevron, 'chevron-down');
    }

    private getAllCustomCommands(): CustomCommand[] {
        const settingsCmds = this.plugin.settings.customCommands || [];
        const noteCmds = this.plugin.promptManager?.getCommands() || [];
        const seen = new Set(noteCmds.map(c => c.name.toLowerCase()));
        return [...noteCmds, ...settingsCmds.filter(c => !seen.has(c.name.toLowerCase()))];
    }

    private getMarkdownLeaf(): { editor: unknown; file: TFile } | null {
        // getMostRecentLeaf is not in Obsidian's public types
        const workspace = this.app.workspace as unknown as { getMostRecentLeaf?(): { view?: Record<string, unknown> } | null };
        const recent = workspace.getMostRecentLeaf?.();
        if (recent?.view?.getViewType?.() === 'markdown' && recent.view.editor && recent.view.file) {
            return { editor: recent.view.editor, file: recent.view.file as TFile };
        }
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view as Record<string, unknown>;
            if (view?.editor && view?.file) return { editor: view.editor, file: view.file as TFile };
        }
        return null;
    }

    private errorTimer: ReturnType<typeof setTimeout> | null = null;

    private showError(msg: string): void {
        if (this.errorTimer) { clearTimeout(this.errorTimer); this.errorTimer = null; }
        this.errorBanner.textContent = msg;
        this.errorBanner.style.display = 'block';
        this.errorTimer = setTimeout(() => { this.errorBanner.style.display = 'none'; }, 8000);
    }

    private showErrorWithRetry(msg: string, content: string, systemPrompt?: string, images?: string[]): void {
        if (this.errorTimer) { clearTimeout(this.errorTimer); this.errorTimer = null; }
        this.errorBanner.empty();
        const cat = categorizeError(msg);
        const msgSpan = this.errorBanner.createSpan({ text: cat.message, cls: 'sidekick-error-msg' });
        if (cat.hint) {
            this.errorBanner.createSpan({ text: ` · ${cat.hint}`, cls: 'sidekick-error-hint' });
        }
        const retryBtn = this.errorBanner.createEl('button', { text: '↻ Retry', cls: 'sidekick-retry-btn' });
        retryBtn.addEventListener('click', () => {
            this.errorBanner.style.display = 'none';
            if (this.conversation) {
                const msgs = this.conversation.messages;
                if (msgs[msgs.length - 1]?.role === 'assistant') {
                    msgs.pop();
                    // Remove the stale assistant DOM element so it doesn't persist
                    const lastAssistant = this.messagesContainer.querySelector('.sidekick-message-assistant:last-child');
                    lastAssistant?.remove();
                }
            }
            this.sendMessage(content, systemPrompt, true, images);
        });
        this.errorBanner.style.display = 'block';
    }

    private showCostDisplay(total: number, promptTokens: number, completionTokens: number): void {
        this.sessionCost += total;
        this.sessionTokensPrompt += promptTokens;
        this.sessionTokensCompletion += completionTokens;
        if (this.lastBreakdown) {
            // Use prompt tokens from cost data as the token count if we don't have
            // real streaming tokens yet (e.g. OpenRouter async cost fetch)
            const apiTokens = this.lastApiTokens ?? (promptTokens > 0 ? promptTokens : undefined);
            this.updateContextBreakdown(this.lastBreakdown, apiTokens);
        }
    }

    private resetSessionCost(): void {
        this.sessionCost = 0;
        this.sessionTokensPrompt = 0;
        this.sessionTokensCompletion = 0;
        this.lastBreakdown = null;
        this.lastApiTokens = undefined;
        this.contextBarEl.style.display = 'none';
    }

    private updateContextBreakdown(breakdown: ContextBreakdown, apiTokens?: number): void {
        this.lastBreakdown = breakdown;
        this.lastApiTokens = apiTokens;
        this.contextBarEl.style.display = 'flex';

        // Only show real API tokens — no char-based estimation
        const hasRealTokens = apiTokens != null && apiTokens > 0;
        const tokensToDisplay = hasRealTokens ? apiTokens : 0;
        let pct = hasRealTokens ? (tokensToDisplay / breakdown.contextLimit) * 100 : 0;
        pct = Math.max(0, Math.min(100, pct)); // clamp 0-100

        // Update fill bar width and color
        this.contextFillEl.style.width = `${pct.toFixed(2)}%`;
        this.contextFillEl.classList.remove('sidekick-ctx-green', 'sidekick-ctx-yellow', 'sidekick-ctx-red');
        if (pct < 50) this.contextFillEl.classList.add('sidekick-ctx-green');
        else if (pct < 80) this.contextFillEl.classList.add('sidekick-ctx-yellow');
        else this.contextFillEl.classList.add('sidekick-ctx-red');

        // Label
        const limStr = breakdown.contextLimit >= 1_000_000
            ? `${(breakdown.contextLimit / 1_000_000).toFixed(1)}M`
            : `${Math.round(breakdown.contextLimit / 1000)}k`;
        if (hasRealTokens) {
            const tokStr = tokensToDisplay >= 1000
                ? `${(tokensToDisplay / 1000).toFixed(1)}k`
                : `${tokensToDisplay}`;
            this.contextLabelEl.textContent = `${tokStr} / ${limStr} tokens (${Math.round(pct)}%)`;
        } else {
            this.contextLabelEl.textContent = `– / ${limStr} tokens`;
        }

        // Tooltip content
        this.contextTooltipEl.empty();
        this.contextTooltipEl.createEl('div', { text: 'Context Window (current round)', cls: 'sidekick-ctx-tooltip-title' });

        if (hasRealTokens) {
            const tokStr = tokensToDisplay >= 1000
                ? `${(tokensToDisplay / 1000).toFixed(1)}k`
                : `${tokensToDisplay}`;
            const summaryStr = `${tokStr} / ${limStr} tokens • ${Math.round(pct)}%`;
            this.contextTooltipEl.createDiv({ text: summaryStr, cls: 'sidekick-ctx-tooltip-summary' });

            const barContainer = this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-bar-container' });
            const tooltipBarEl = barContainer.createDiv({ cls: 'sidekick-ctx-tooltip-bar' });
            tooltipBarEl.style.width = `${pct.toFixed(2)}%`;

            // Per-item breakdown — distribute real tokens proportionally by char ratio
            if (breakdown.items.length > 0) {
                this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-section', text: 'Breakdown' });
                for (const item of breakdown.items) {
                    const row = this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
                    row.createSpan({ text: item.label });
                    const itemTokens = Math.round(item.proportion * tokensToDisplay);
                    const itemPct = (item.proportion * pct).toFixed(1) + '%';
                    const tokLabel = itemTokens >= 1000 ? `${(itemTokens / 1000).toFixed(1)}k` : `${itemTokens}`;
                    row.createSpan({ text: `${tokLabel} (${itemPct})`, cls: 'sidekick-ctx-tooltip-val' });
                }
            }
        } else {
            this.contextTooltipEl.createDiv({ text: 'Send a message to see token usage', cls: 'sidekick-ctx-tooltip-summary' });
        }

        // Append session usage if any
        if (this.sessionTokensPrompt > 0 || this.sessionTokensCompletion > 0) {
            this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-section', text: 'Session Total (cumulative)' });

            const promptRow = this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
            promptRow.createSpan({ text: 'Prompt' });
            promptRow.createSpan({ text: this.sessionTokensPrompt.toLocaleString(), cls: 'sidekick-ctx-tooltip-val' });

            const compRow = this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
            compRow.createSpan({ text: 'Completion' });
            compRow.createSpan({ text: this.sessionTokensCompletion.toLocaleString(), cls: 'sidekick-ctx-tooltip-val' });

            if (this.sessionCost > 0) {
                const costRow = this.contextTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row', attr: { title: 'Estimated Session Cost' } });
                costRow.createSpan({ text: 'Cost' });
                const totalStr = this.sessionCost < 0.001 ? this.sessionCost.toFixed(6) : this.sessionCost.toFixed(4);
                costRow.createSpan({ text: `$${totalStr}`, cls: 'sidekick-ctx-tooltip-val' });
            }
        }
    }

    private async refreshContextBreakdown(): Promise<void> {
        const s = this.plugin.settings;
        const currentModel = this.modelPicker.getCachedModels().find(m => m.id === s.selectedModel);
        const ctxLimit = currentModel?.context_length || 128_000;

        const history = this.conversation ? this.conversation.messages : [];
        const apiMessages = await buildApiMessages(
            this.app,
            s.systemPrompt,
            this.attachedNotes,
            history
        );

        this.updateContextBreakdown(computeContextBreakdown(apiMessages, ctxLimit));
    }

    private renderPendingImages(): void {
        this.pendingImagesEl.empty();
        if (this.pendingImages.length === 0) {
            this.pendingImagesEl.style.display = 'none';
            return;
        }
        this.pendingImagesEl.style.display = 'flex';
        for (let i = 0; i < this.pendingImages.length; i++) {
            const thumb = this.pendingImagesEl.createDiv({ cls: 'sidekick-pending-img' });
            thumb.createEl('img', { attr: { src: this.pendingImages[i] } });
            const removeBtn = thumb.createEl('button', { cls: 'sidekick-pending-img-remove' });
            setIcon(removeBtn, 'x');
            const idx = i;
            removeBtn.addEventListener('click', () => {
                this.pendingImages.splice(idx, 1);
                this.renderPendingImages();
            });
        }
    }

    private autoResizeInput(): void {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
    }

    private updateTokenCount(): void {
        const text = this.inputEl.value;
        if (!text) {
            this.tokenCountEl.style.display = 'none';
            return;
        }
        const tokens = Math.ceil(text.length / 3);
        if (tokens > 10000) {
            this.tokenCountEl.textContent = `~${tokens.toLocaleString()} tokens ⚠️ very long`;
            this.tokenCountEl.classList.add('sidekick-token-warning');
        } else {
            this.tokenCountEl.textContent = `~${tokens.toLocaleString()} tokens`;
            this.tokenCountEl.classList.remove('sidekick-token-warning');
        }
        this.tokenCountEl.style.display = '';
    }

    private updateClearButton(): void {
        this.clearInputBtn.style.display = this.inputEl.value.length > 0 ? '' : 'none';
    }

    // ── Conversation management ─────────────────────────────────────

    async newConversation(): Promise<void> {
        // Save draft for current conversation
        if (this.conversation && this.inputEl.value.trim()) {
            this.drafts.set(this.conversation.id, this.inputEl.value);
        }
        // Stop any in-flight generation / iterate loop before creating new chat
        this.stopGeneration();
        this.conversation = null;
        this.resetSessionCost();
        this.refreshContextBreakdown();
        this.hideResumeBanner();
        this.clearFollowUpChips();
        this.clearQueuedMessage();
        this.suggestionAbortController?.abort();
        const id = this.plugin.storage.generateId();
        this.conversation = {
            id,
            title: 'New Chat',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pinned: false,
            provider: this.plugin.settings.selectedProvider,
            model: this.plugin.settings.selectedModel,
        };
        this.renderMessages();
        this.inputEl.focus();
        // Close the conversation list if it was open
        if (this.showConversations) {
            this.showConversations = false;
            this.conversationListEl.style.display = 'none';
        }
    }

    private async switchConversation(id: string): Promise<void> {
        const conv = await this.plugin.storage.loadConversation(id);
        if (conv) {
            // Save draft for current conversation
            if (this.conversation && this.inputEl.value.trim()) {
                this.drafts.set(this.conversation.id, this.inputEl.value);
            } else if (this.conversation) {
                this.drafts.delete(this.conversation.id);
            }
            // Stop any in-flight generation / iterate loop before switching
            this.stopGeneration();
            this.resetSessionCost();
            this.clearFollowUpChips();
            this.clearQueuedMessage();
            this.suggestionAbortController?.abort();
            this.conversation = conv;
            // Restore conversation's model/provider if set
            if (conv.provider && conv.model) {
                const s = this.plugin.settings;
                if (s.selectedProvider !== conv.provider || s.selectedModel !== conv.model) {
                    s.selectedProvider = conv.provider;
                    s.selectedModel = conv.model;
                    await this.plugin.saveSettings();
                    this.updateModelLabel();
                }
            }
            this.refreshContextBreakdown();
            await this.renderMessages();
            // Restore draft for the conversation we're switching to
            const savedDraft = this.drafts.get(id) || '';
            this.inputEl.value = savedDraft;
            this.autoResizeInput();
            this.updateTokenCount();
            this.showConversations = false;
            this.conversationListEl.style.display = 'none';
            this.messagesContainer.style.display = 'flex';
            this.checkAndShowResumeBanner();
            this.inputEl.focus();
        }
    }

    private async toggleConversationList(): Promise<void> {
        this.showConversations = !this.showConversations;
        if (this.showConversations) {
            await this.renderConversationListUI();
            this.conversationListEl.style.display = 'flex';
            this.messagesContainer.style.display = 'none';
        } else {
            this.conversationListEl.style.display = 'none';
            this.messagesContainer.style.display = 'flex';
        }
    }

    private async renderConversationListUI(): Promise<void> {
        const conversations = await this.plugin.storage.loadAllConversations();
        // Sync collections from settings into list state
        this.convListState.collections = this.plugin.settings.collections ?? [];
        renderConversationList(
            this.conversationListEl,
            conversations,
            this.conversation?.id ?? null,
            {
                onSwitch: (id) => this.switchConversation(id),
                onPin: async (conv) => {
                    conv.pinned = !conv.pinned;
                    await this.plugin.storage.saveConversation(conv);
                    if (this.conversation?.id === conv.id) this.conversation.pinned = conv.pinned;
                    await this.renderConversationListUI();
                },
                onDelete: async (conv) => {
                    // Save a snapshot for undo before deleting
                    const snapshot = JSON.parse(JSON.stringify(conv));
                    await this.plugin.storage.deleteConversation(conv.id);
                    // Clean up stale command session mappings
                    let mappingChanged = false;
                    const removedMappings: Record<string, string> = {};
                    for (const [cmd, convId] of Object.entries(this.plugin.settings.commandSessionMap)) {
                        if (convId === conv.id) {
                            removedMappings[cmd] = convId;
                            delete this.plugin.settings.commandSessionMap[cmd];
                            mappingChanged = true;
                        }
                    }
                    if (mappingChanged) await this.plugin.saveSettings();
                    const wasActive = this.conversation?.id === conv.id;
                    if (wasActive) await this.newConversation();
                    await this.renderConversationListUI();

                    // Show undo toast
                    this.showUndoDeleteToast(snapshot, removedMappings, wasActive);
                },
                onRename: async (conv, newTitle) => {
                    conv.title = newTitle;
                    await this.plugin.storage.saveConversation(conv);
                    if (this.conversation?.id === conv.id) this.conversation.title = newTitle;
                    await this.renderConversationListUI();
                },
                onGenerateTitle: (conv) => this.generateTitleForConversation(conv),
            },
            this.convListState,
            (state) => { this.convListState = state; },
        );
    }

    // ── Message rendering ───────────────────────────────────────────

    private messageActions = {
        getResourceUrl: (img: string) => getResourceUrl(this.app, img),
        onEdit: (msg: ChatMessage) => this.editMessage(msg),
        onInsertAtCursor: (content: string) => {
            const mdView = this.getMarkdownLeaf();
            if (mdView?.editor) {
                mdView.editor.replaceSelection(content);
                new Notice('Inserted into note.');
            } else {
                new Notice('No active editor. Open a note first.');
            }
        },
        onRegenerate: () => this.regenerate(),
        onDelete: async (msg: ChatMessage) => {
            if (!this.conversation) return;
            const realIndex = this.conversation.messages.indexOf(msg);
            if (realIndex >= 0) {
                this.conversation.messages.splice(realIndex, 1);
                this.conversation.updatedAt = Date.now();
                this.renderMessages();
                await this.plugin.storage.saveConversation(this.conversation);
            }
        },
        onFork: (visibleIndex: number) => this.forkConversation(visibleIndex),
        onRate: async (msg: ChatMessage, rating: 1 | -1 | undefined) => {
            msg.rating = rating;
            if (this.conversation) {
                this.conversation.updatedAt = Date.now();
                await this.plugin.storage.saveConversation(this.conversation);
            }
        },
        onSaveToNote: async (content: string) => {
            try {
                const folder = this.plugin.settings.chatFolder || 'Sidekick';
                await ensureFolder(this.app, folder);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const path = `${folder}/Sidekick Response ${timestamp}.md`;
                await this.app.vault.create(path, content);
                new Notice(`Saved to ${path}`);
            } catch (err) {
                new Notice(`Failed to save: ${getErrorMessage(err)}`);
            }
        },
    };

    private async renderMessages(): Promise<void> {
        // Update header title with message count badge and agent indicator
        const title = this.conversation?.title ?? 'New Chat';
        const msgCount = this.conversation?.messages.length ?? 0;
        const agentId = this.plugin.settings.activeAgentPreset;
        let headerText = msgCount > 0 ? `${title} (${msgCount})` : title;
        if (agentId && agentId !== 'default') {
            const { getPreset } = await import('../lib/agents');
            const preset = getPreset(agentId);
            if (preset) headerText = `${preset.icon} ${headerText}`;
        }
        this.headerModelLabel.textContent = headerText;
        // Rich tooltip with conversation metadata
        if (this.conversation) {
            const c = this.conversation;
            const parts = [c.title];
            if (c.model) parts.push(`Model: ${c.model}`);
            parts.push(`Messages: ${c.messages.length}`);
            parts.push(`Created: ${new Date(c.createdAt).toLocaleString()}`);
            if (c.usage?.totalCost) parts.push(`Cost: $${c.usage.totalCost.toFixed(4)}`);
            this.headerModelLabel.setAttribute('title', parts.join('\n'));
        } else {
            this.headerModelLabel.setAttribute('title', 'New Chat');
        }

        // Unload previous render component to clean up MarkdownRenderer children
        if (this.renderComponent) {
            this.removeChild(this.renderComponent);
            this.renderComponent = null;
        }
        this.renderComponent = new Component();
        this.addChild(this.renderComponent);

        this.messagesContainer.empty();

        if (!this.conversation || this.conversation.messages.length === 0) {
            const empty = this.messagesContainer.createDiv({ cls: 'sidekick-empty-state' });

            // Time-based greeting
            const hour = new Date().getHours();
            const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
            empty.createEl('p', { text: `✨ ${greeting}`, cls: 'sidekick-empty-greeting' });

            // Resolve active preset before using it in subtitle/starters.
            const { getPreset } = await import('../lib/agents');
            const currentPreset = getPreset(this.plugin.settings.activeAgentPreset);
            const hasAgentStarters = currentPreset && currentPreset.starters && currentPreset.starters.length > 0;

            const subtitle = hasAgentStarters && currentPreset!.id !== 'default'
                ? `${currentPreset!.icon} ${currentPreset!.name} — ${currentPreset!.description}`
                : 'Your AI assistant for Obsidian. Ask anything or try:';
            empty.createEl('p', { text: subtitle, cls: 'sidekick-empty-sub' });

            const allStarters = hasAgentStarters
                ? [...currentPreset!.starters!]
                : (() => {
                    // Context-aware starters: reference the active note if one is open
                    const activeFile = this.app.workspace.getActiveFile();
                    const noteName = activeFile?.basename;
                    if (noteName) {
                        return [
                            { icon: '📝', text: `Summarize "${noteName}"` },
                            { icon: '💡', text: `Give me ideas based on "${noteName}"` },
                            { icon: '🔍', text: `Find notes related to "${noteName}"` },
                            { icon: '✏️', text: `Help me improve "${noteName}"` },
                            { icon: '🧠', text: `Explain the key concepts in "${noteName}"` },
                            { icon: '📋', text: `Create action items from "${noteName}"` },
                            { icon: '🔗', text: `Find connections between "${noteName}" and other notes` },
                            { icon: '📊', text: 'Analyze the structure of my vault' },
                        ];
                    }
                    return [
                        { icon: '📝', text: 'Summarize my current note' },
                        { icon: '💡', text: 'Give me ideas for my project' },
                        { icon: '🔍', text: 'Search my vault for recent topics' },
                        { icon: '✏️', text: 'Help me write a blog post' },
                        { icon: '🧠', text: 'Explain a concept in my notes' },
                        { icon: '📋', text: 'Create a checklist from my note' },
                        { icon: '🔗', text: 'Find connections between my notes' },
                        { icon: '📊', text: 'Analyze the structure of my vault' },
                    ];
                })();
            // Shuffle and pick 4
            const starters = this.sampleRandom(allStarters, 4);

            const starterGrid = empty.createDiv({ cls: 'sidekick-starter-grid' });
            for (const s of starters) {
                const card = starterGrid.createDiv({ cls: 'sidekick-starter-card' });
                card.createSpan({ text: s.icon, cls: 'sidekick-starter-icon' });
                card.createSpan({ text: s.text, cls: 'sidekick-starter-text' });
                card.addEventListener('click', () => {
                    const hadDraft = this.inputEl.value.trim().length > 0;
                    if (hadDraft) {
                        this.inputEl.value = s.text;
                        this.inputEl.focus();
                        this.inputEl.setSelectionRange(s.text.length, s.text.length);
                        this.updateSuggestions();
                        new Notice('Draft preserved: press Enter to send this starter.');
                        return;
                    }
                    this.inputEl.value = s.text;
                    this.handleSend();
                });
            }

            // Keyboard shortcut hints
            const hints = empty.createDiv({ cls: 'sidekick-shortcut-hints' });
            hints.innerHTML =
                '<span><kbd>@</kbd> mention a note</span>' +
                '<span><kbd>/</kbd> commands</span>' +
                '<span><kbd>Ctrl+L</kbd> focus chat</span>';

            // Show pinned conversations as quick-access cards
            const allConvs = await this.plugin.storage.loadAllConversations();
            const pinned = allConvs.filter(c => c.pinned);
            if (pinned.length > 0) {
                empty.createEl('p', { text: '📌 Pinned', cls: 'sidekick-empty-sub sidekick-pinned-label' });
                const pinnedGrid = empty.createDiv({ cls: 'sidekick-starter-grid' });
                for (const conv of pinned.slice(0, 4)) {
                    const card = pinnedGrid.createDiv({ cls: 'sidekick-starter-card sidekick-pinned-card' });
                    card.createSpan({ text: '📌', cls: 'sidekick-starter-icon' });
                    card.createSpan({ text: conv.title || 'Untitled', cls: 'sidekick-starter-text' });
                    card.addEventListener('click', () => this.switchConversation(conv.id));
                }
            }
            return;
        }

        const visible = this.conversation.messages.filter(m => m.role !== 'system' && m.role !== 'tool');
        let lastTimestamp = 0;
        for (let i = 0; i < visible.length; i++) {
            const msg = visible[i];
            // Insert time divider for messages >1 hour apart
            if (msg.timestamp && lastTimestamp && (msg.timestamp - lastTimestamp > 3600000)) {
                const divider = this.messagesContainer.createDiv({ cls: 'sidekick-time-divider' });
                divider.createSpan({ text: new Date(msg.timestamp).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
            }
            if (msg.timestamp) lastTimestamp = msg.timestamp;
            await renderMessage(this.app, this.renderComponent!, this.messagesContainer, msg, i, visible.length, this.messageActions);
        }
        this.scrollToBottom(true);
    }

    /**
     * Incrementally append new messages to the DOM without wiping existing ones.
     * Used during streaming flow so the chat doesn't flicker.
     */
    private async appendVisibleMessages(newMessages: ChatMessage[]): Promise<void> {
        // Remove the empty-state placeholder if present
        const emptyState = this.messagesContainer.querySelector('.sidekick-empty-state');
        if (emptyState) emptyState.remove();

        // Remove the regenerate button from the previous last assistant
        // (only the actual last assistant in the conversation should have it)
        const prevAssistants = this.messagesContainer.querySelectorAll('.sidekick-message-assistant');
        if (prevAssistants.length > 0) {
            const lastAssistantEl = prevAssistants[prevAssistants.length - 1];
            const regenBtn = lastAssistantEl.querySelector('button[title="Regenerate"]');
            if (regenBtn) regenBtn.remove();
        }

        // Calculate indices against the full visible list
        const visible = this.conversation!.messages.filter(m => m.role !== 'system' && m.role !== 'tool');
        const total = visible.length;

        const renderPromises: Promise<HTMLElement>[] = [];
        for (const msg of newMessages) {
            if (msg.role === 'system' || msg.role === 'tool') continue;
            const idx = visible.indexOf(msg);
            renderPromises.push(renderMessage(this.app, this.renderComponent ?? this, this.messagesContainer, msg, idx, total, this.messageActions));
        }
        await Promise.all(renderPromises);
    }

    // Debounce streaming renders to at most once per animation frame
    private pendingStreamContent: string | null = null;
    private streamRafId: number | null = null;

    private updateLastAssistant(content: string): void {
        if (!this.conversation?.messages.length) return;
        const last = this.conversation.messages[this.conversation.messages.length - 1];
        if (last.role !== 'assistant') return;
        last.content = content;

        // Remove typing indicator once content starts flowing
        this.messagesContainer.querySelector('.sidekick-typing-indicator')?.remove();

        // Batch rapid streaming updates into a single render per frame
        this.pendingStreamContent = content;
        if (this.streamRafId === null) {
            this.streamRafId = requestAnimationFrame(() => {
                this.streamRafId = null;
                if (this.pendingStreamContent !== null) {
                    updateLastAssistantContent(this.app, this.renderComponent ?? this, this.messagesContainer, this.pendingStreamContent);
                    this.pendingStreamContent = null;
                }
            });
        }
    }

    /** Flush any pending streaming render immediately (e.g. when streaming ends). */
    private async flushStreamRender(): Promise<void> {
        if (this.streamRafId !== null) {
            cancelAnimationFrame(this.streamRafId);
            this.streamRafId = null;
        }
        if (this.pendingStreamContent !== null) {
            await updateLastAssistantContent(this.app, this.renderComponent ?? this, this.messagesContainer, this.pendingStreamContent);
            this.pendingStreamContent = null;
        }
        // Remove streaming cursor after flush
        this.messagesContainer.querySelector('.sidekick-streaming-cursor')?.remove();
    }

    /** True when user is near the bottom of the messages container. */
    private isNearBottom(): boolean {
        const el = this.messagesContainer;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }

    private scrollToBottom(force = false): void {
        if (!force && !this.isNearBottom()) return;
        requestAnimationFrame(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        });
    }

    /** Uniform random sample without mutating the input array (Fisher-Yates). */
    private sampleRandom<T>(items: readonly T[], count: number): T[] {
        const copy = [...items];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, count);
    }

    // ── Suggestions ─────────────────────────────────────────────────

    private updateSuggestions(): void {
        const input = this.inputEl.value;

        // ── Slash commands (only at start of input) ─────────────────
        if (input.startsWith('/')) {
            this.showSlashSuggestions(input);
            return;
        }

        // ── @ mentions (anywhere in input) ──────────────────────────
        const mentionMatch = this.getMentionContext();
        if (mentionMatch) {
            this.showMentionSuggestions(mentionMatch.query);
            return;
        }

        this.hideSuggestions();
    }

    /**
     * Extract the @ mention context at the cursor position.
     * Returns the query text after @ (e.g. "@no" → "no"), or null if not in a mention.
     */
    private getMentionContext(): { query: string; start: number } | null {
        const cursorPos = this.inputEl.selectionStart ?? this.inputEl.value.length;
        const textBefore = this.inputEl.value.slice(0, cursorPos);

        // Find the last @ that is either at the start or preceded by whitespace
        const match = textBefore.match(/(?:^|\s)@(\S*)$/);
        if (!match) return null;

        const query = match[1].toLowerCase();
        const start = textBefore.length - match[0].length + (match[0].startsWith('@') ? 0 : 1); // offset of the @
        return { query, start };
    }

    private showSlashSuggestions(input: string): void {
        const suggestions = getCommandSuggestions(input, this.getAllCustomCommands());
        if (suggestions.length === 0) {
            this.hideSuggestions();
            return;
        }
        this.suggestionEl.empty();
        this.suggestionEl.style.display = 'block';
        this.suggestionMode = 'slash';
        this.suggestionIndex = -1;
        for (const s of suggestions) {
            const item = this.suggestionEl.createDiv({ cls: 'sidekick-suggestion-item', attr: { role: 'option' } });
            item.createEl('span', { text: `/${s.name}`, cls: 'sidekick-suggestion-name' });
            item.createEl('span', { text: s.description, cls: 'sidekick-suggestion-desc' });
            item.addEventListener('click', () => {
                this.inputEl.value = `/${s.name} `;
                this.inputEl.focus();
                this.hideSuggestions();
            });
        }
    }

    private showMentionSuggestions(query: string): void {
        // Built-in mention targets
        const builtIns: Array<{ name: string; icon: string; description: string; action: () => Promise<void> }> = [
            { name: 'current-note', icon: '📄', description: 'Attach active note as context', action: () => this.addNoteContext() },
            { name: 'selection', icon: '✂️', description: 'Attach selected text', action: () => this.addSelectionContext() },
        ];

        // Smart search: titles, aliases, headings, fuzzy matching
        const fileResults = searchFiles(this.app, query, 8);

        // Filter built-ins
        const filteredBuiltIns = builtIns.filter(b => b.name.includes(query));

        if (filteredBuiltIns.length === 0 && fileResults.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.suggestionEl.empty();
        this.suggestionEl.style.display = 'block';
        this.suggestionMode = 'mention';
        this.suggestionIndex = -1;

        // Built-in options
        for (const b of filteredBuiltIns) {
            const item = this.suggestionEl.createDiv({ cls: 'sidekick-suggestion-item', attr: { role: 'option' } });
            item.createEl('span', { text: `${b.icon} @${b.name}`, cls: 'sidekick-suggestion-name' });
            item.createEl('span', { text: b.description, cls: 'sidekick-suggestion-desc' });
            item.addEventListener('click', () => {
                this.removeMentionTrigger();
                b.action();
            });
        }

        // Vault note files (smart search results)
        for (const r of fileResults) {
            const item = this.suggestionEl.createDiv({ cls: 'sidekick-suggestion-item', attr: { role: 'option' } });
            const matchBadge = r.matchType === 'alias' ? ' (alias)' :
                r.matchType === 'heading' ? ' (heading)' :
                    r.matchType === 'fuzzy' ? ' (fuzzy)' : '';
            item.createEl('span', { text: `📝 ${r.file.basename}${matchBadge}`, cls: 'sidekick-suggestion-name' });
            item.createEl('span', { text: r.file.path, cls: 'sidekick-suggestion-desc' });
            item.addEventListener('click', () => {
                this.removeMentionTrigger();
                this.attachNoteByFile(r.file);
            });
        }
    }

    /** Remove the @query text that triggered the mention popup. */
    private removeMentionTrigger(): void {
        const ctx = this.getMentionContext();
        if (!ctx) return;
        const before = this.inputEl.value.slice(0, ctx.start);
        const after = this.inputEl.value.slice(this.inputEl.selectionStart ?? this.inputEl.value.length);
        this.inputEl.value = before + after;
        this.inputEl.selectionStart = this.inputEl.selectionEnd = before.length;
        this.hideSuggestions();
        this.inputEl.focus();
    }

    /** Attach a specific vault file as context. */
    private async attachNoteByFile(file: import('obsidian').TFile): Promise<void> {
        if (this.attachedNotes.some(n => n.path === file.path)) { this.showError('Note already attached.'); return; }
        try {
            const content = await this.app.vault.read(file);
            if (!content.trim()) { this.showError('Note is empty.'); return; }
            const images = await extractNoteImages(this.app, content, file.path);
            this.attachedNotes.push({ path: file.path, name: file.basename, content, images });
            if (!this.conversation) await this.newConversation();
            this.renderAttachedNotes();
            this.inputEl.focus();
        } catch (err: unknown) {
            this.showError(`Failed to read note: ${getErrorMessage(err)}`);
        }
    }

    private hideSuggestions(): void {
        this.suggestionEl.style.display = 'none';
        this.suggestionIndex = -1;
        this.suggestionMode = null;
    }

    // ── Send / command handling ──────────────────────────────────────

    private async handleSend(): Promise<void> {
        const input = this.inputEl.value.trim();
        if (!input && !this.isWaitingForFeedback && !this.isWaitingForResume) return;

        // Offline warning — only for actual message sends (not slash commands)
        if (!navigator.onLine && input && !input.startsWith('/')) {
            new Notice('You appear to be offline. Check your network connection and try again.', 5000);
            return;
        }

        // Queue the message if currently generating
        if (this.isLoading && !this.isWaitingForFeedback && !this.isWaitingForResume) {
            if (!input) return;
            this.queuedMessage = { text: input, images: [...this.pendingImages] };
            this.pendingImages = [];
            this.renderPendingImages();
            this.inputEl.value = '';
            this.autoResizeInput();
            this.showQueuedBanner();
            return;
        }

        // If we're waiting for iterate feedback, resolve the promise instead of sending
        if (this.isWaitingForFeedback) {
            const feedback = input || null;   // empty → treat as "done"
            const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
            this.inputEl.value = '';
            this.pendingImages = [];
            this.renderPendingImages();
            this.autoResizeInput();
            this.hideIterateFeedbackUI();
            if (feedback && feedback.toLowerCase() !== 'done') {
                this.iterateFeedbackResolve?.({ text: feedback, images });
            } else {
                this.iterateFeedbackResolve?.(null);
            }
            this.iterateFeedbackResolve = null;
            // Re-enable loading indicator while model processes feedback
            this.setLoading(true);
            return;
        }

        // If we're waiting to resume a paused iterate session, resume with feedback
        if (this.isWaitingForResume) {
            await this.resumeIterateSession(input || undefined);
            return;
        }

        // Push to input history
        if (this.sentHistory[this.sentHistory.length - 1] !== input) {
            this.sentHistory.push(input);
            if (this.sentHistory.length > 50) this.sentHistory.shift();
        }
        this.historyIndex = -1;
        this.draftInput = '';

        const images = [...this.pendingImages];
        this.pendingImages = [];
        this.renderPendingImages();

        this.inputEl.value = '';
        this.autoResizeInput();
        this.updateTokenCount();
        this.updateClearButton();
        this.suggestionEl.style.display = 'none';

        const parsed = parseSlashCommand(input, this.getAllCustomCommands());

        switch (parsed.type) {
            case 'command':
                await this.handleBuiltInCommand(parsed.command!, parsed.args || '');
                break;
            case 'custom': {
                const commandName = parsed.command!;
                let systemPrompt = parsed.systemPrompt || '';
                const userText = parsed.args || input;

                // Switch to mapped conversation if one exists for this command
                const mappedConvId = this.plugin.settings.commandSessionMap[commandName];
                if (mappedConvId && mappedConvId !== this.conversation?.id) {
                    // switchConversation loads + renders the target; no-op if not found
                    const prevConvId = this.conversation?.id;
                    await this.switchConversation(mappedConvId);
                    // If switch failed (conversation deleted), clean up mapping
                    if (this.conversation?.id === prevConvId || !this.conversation) {
                        delete this.plugin.settings.commandSessionMap[commandName];
                    }
                }

                if (this.plugin.promptManager && systemPrompt) {
                    const mdLeaf = this.getMarkdownLeaf();
                    const activeContent = mdLeaf?.file
                        ? await this.app.vault.read(mdLeaf.file)
                        : undefined;
                    systemPrompt = await this.plugin.promptManager.processTemplate(
                        systemPrompt, userText, activeContent,
                    );
                }
                await this.sendMessage(userText, systemPrompt, false, images);

                // Update mapping and persist once
                if (this.conversation) {
                    this.plugin.settings.commandSessionMap[commandName] = this.conversation.id;
                }
                await this.plugin.saveSettings();
                break;
            }
            case 'unknown':
                this.showError(`Unknown command: /${parsed.command}`);
                this.inputEl.value = input;
                break;
            default:
                await this.sendMessage(input, undefined, false, images);
                break;
        }
    }

    private async handleBuiltInCommand(command: string, args: string): Promise<void> {
        switch (command) {
            case 'help': this.addSystemMessage(slashHelpText(this.getAllCustomCommands())); break;
            case 'note': await this.addNoteContext(); break;
            case 'selection': await this.addSelectionContext(); break;
            case 'regen': await this.regenerate(); break;
            case 'iterate': await this.toggleIterateMode(); break;
            case 'clear': await this.clearChat(); break;
            case 'export': await this.exportChat(); break;
            case 'new': await this.newConversation(); break;
            case 'rename': this.renameConversation(args); break;
            case 'duplicate': await this.duplicateConversation(); break;
            case 'model': await this.openModelPicker(); break;
            case 'settings': this.openSettings(); break;
            case 'usage': await this.toggleCopilotUsage(); break;
            case 'pin': this.togglePin(); break;
            case 'info': this.showConversationInfo(); break;
            case 'stats': await this.showVaultStats(); break;
            case 'favorites': await this.showFavorites(); break;
            case 'search': await this.searchAllConversations(args); break;
            case 'undo': await this.undoLastExchange(); break;
            case 'summary': this.showConversationSummary(); break;
            case 'profile': this.showProfileSummary(); break;
            case 'agent': await this.switchAgent(args); break;
        }
    }

    async toggleIterateMode(): Promise<void> {
        this.plugin.settings.iterateMode = !this.plugin.settings.iterateMode;
        await this.plugin.saveSettings();
        updateToggleButton(this.iterateBtn, this.plugin.settings.iterateMode);
        const state = this.plugin.settings.iterateMode ? 'enabled' : 'disabled';
        this.addSystemMessage(`🔄 Iterate mode **${state}**. ${this.plugin.settings.iterateMode ? 'The AI will ask for feedback after each response.' : ''}`);
    }

    private addSystemMessage(content: string): void {
        if (!this.conversation) return;
        // Render as ephemeral UI notification — not saved to conversation history
        // to avoid polluting API messages and appearing as AI responses on reload.
        const el = this.messagesContainer.createDiv({ cls: 'sidekick-system-notice' });
        el.textContent = content.replace(/\*\*(.*?)\*\*/g, '$1');
        this.scrollToBottom(true);
    }

    // ── Context attachment ──────────────────────────────────────────

    addNoteContext = async (): Promise<void> => {
        const mdView = this.getMarkdownLeaf();
        const file = mdView?.file ?? this.app.workspace.getActiveFile();
        if (!file) { this.showError('No active note open. Open a note first.'); return; }
        if (this.attachedNotes.some(n => n.path === file.path)) { this.showError('Note already attached.'); return; }

        try {
            const content = await this.app.vault.read(file);
            if (!content.trim()) { this.showError('Active note is empty.'); return; }

            const images = await extractNoteImages(this.app, content, file.path);
            this.attachedNotes.push({ path: file.path, name: file.basename, content, images });
            if (!this.conversation) await this.newConversation();
            this.renderAttachedNotes();
            this.inputEl.focus();
        } catch (err: unknown) {
            this.showError(`Failed to read note: ${getErrorMessage(err)}`);
        }
    };

    addSelectionContext = async (): Promise<void> => {
        const mdView = this.getMarkdownLeaf();
        const editor = mdView?.editor;
        if (!editor) { this.showError('No active editor. Open a note first.'); return; }
        const selection = editor.getSelection();
        if (!selection?.trim()) { this.showError('No text selected.'); return; }
        if (!this.conversation) await this.newConversation();

        // Include source file and line range for richer context
        const file = mdView?.file;
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const lineInfo = from && to
            ? from.line === to.line
                ? `L${from.line + 1}`
                : `L${from.line + 1}–${to.line + 1}`
            : '';
        const source = file ? `\`${file.basename}${lineInfo ? ` ${lineInfo}` : ''}\`` : '';

        const msg: ChatMessage = { role: 'user', content: `✂️ **Selected Text**${source ? ` from ${source}` : ''}:\n\n${selection}` };
        this.conversation!.messages.push(msg);
        this.conversation!.updatedAt = Date.now();
        this.appendVisibleMessages([msg]);
        this.scrollToBottom(true);
        await this.plugin.storage.saveConversation(this.conversation!);
    };

    // ── Chat actions ────────────────────────────────────────────────

    private async clearChat(): Promise<void> {
        if (!this.conversation) return;
        if (this.conversation.messages.length > 0) {
            const count = this.conversation.messages.length;
            const confirmed = await new Promise<boolean>((resolve) => {
                const banner = this.containerEl.createDiv({ cls: 'sidekick-confirm-banner' });
                banner.createSpan({ text: `Clear ${count} messages? ` });
                const yesBtn = banner.createEl('button', { text: 'Yes', cls: 'sidekick-confirm-yes' });
                const noBtn = banner.createEl('button', { text: 'Cancel', cls: 'sidekick-confirm-no' });
                yesBtn.addEventListener('click', () => { banner.remove(); resolve(true); });
                noBtn.addEventListener('click', () => { banner.remove(); resolve(false); });
            });
            if (!confirmed) return;
        }
        this.conversation.messages = [];
        this.conversation.updatedAt = Date.now();
        this.renderMessages();
        await this.plugin.storage.saveConversation(this.conversation);
    }

    private renameConversation(args: string): void {
        if (!this.conversation) { new Notice('No active conversation.'); return; }
        const newTitle = args.trim();
        if (!newTitle) { this.addSystemMessage('Usage: `/rename New Title`'); return; }
        this.conversation.title = newTitle;
        this.plugin.storage.saveConversation(this.conversation);
        this.renderConversationListUI();
        this.addSystemMessage(`✅ Renamed to **${newTitle}**`);
    }

    private async undoLastExchange(): Promise<void> {
        if (!this.conversation) { new Notice('No active conversation.'); return; }
        const msgs = this.conversation.messages;
        // Find the last user message and remove it plus all subsequent messages
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx === -1) {
            this.addSystemMessage('Nothing to undo.');
            return;
        }
        const removed = msgs.length - lastUserIdx;
        msgs.splice(lastUserIdx);
        this.conversation.updatedAt = Date.now();
        await this.plugin.storage.saveConversation(this.conversation);
        this.renderMessages();
        this.addSystemMessage(`↩️ Removed ${removed} message${removed > 1 ? 's' : ''}.`);
    }

    private showConversationSummary(): void {
        if (!this.conversation) { new Notice('No active conversation.'); return; }
        const c = this.conversation;
        const userMsgs = c.messages.filter(m => m.role === 'user').length;
        const assistantMsgs = c.messages.filter(m => m.role === 'assistant').length;
        const totalWords = c.messages.reduce((sum, m) => sum + (m.content || '').split(/\s+/).filter(Boolean).length, 0);
        const totalTokens = c.messages.reduce((sum, m) => sum + (m.cost?.tokensPrompt || 0) + (m.cost?.tokensCompletion || 0), 0);
        const totalCost = c.usage?.totalCost ?? c.messages.reduce((sum, m) => sum + (m.cost?.total || 0), 0);
        const duration = c.updatedAt - c.createdAt;
        const durationStr = duration < 60000 ? '<1 min' : duration < 3600000 ? `${Math.floor(duration / 60000)} min` : `${(duration / 3600000).toFixed(1)} hrs`;

        const lines = [
            `**📊 Conversation Summary**`,
            '',
            `**Title:** ${c.title}`,
            `**Model:** ${c.model || 'default'}`,
            `**Provider:** ${c.provider || 'default'}`,
            `**Messages:** ${userMsgs} user + ${assistantMsgs} assistant = ${c.messages.length} total`,
            `**Words:** ${totalWords.toLocaleString()}`,
            `**Tokens:** ${totalTokens > 0 ? totalTokens.toLocaleString() : 'N/A'}`,
            `**Cost:** ${totalCost > 0 ? '$' + totalCost.toFixed(4) : 'N/A'}`,
            `**Duration:** ${durationStr}`,
            `**Created:** ${new Date(c.createdAt).toLocaleString()}`,
            `**Last updated:** ${new Date(c.updatedAt).toLocaleString()}`,
            c.pinned ? '**Pinned:** ✅' : '',
        ].filter(Boolean);
        this.addSystemMessage(lines.join('\n'));
    }

    private showProfileSummary(): void {
        const s = this.plugin.settings;
        if (!s.enableUserProfile) {
            this.addSystemMessage('👤 User profiling is disabled. Enable it in Settings → Profile.');
            return;
        }
        const facts = s.userProfile?.facts ?? [];
        if (!facts.length) {
            this.addSystemMessage('👤 No profile facts learned yet. Chat with the AI and it will learn about you over time.');
            return;
        }
        const byCategory = new Map<string, string[]>();
        for (const f of facts) {
            const list = byCategory.get(f.category) || [];
            list.push(f.content);
            byCategory.set(f.category, list);
        }
        const lines = [`**👤 Your Profile (${facts.length} facts)**`, ''];
        for (const [cat, items] of byCategory) {
            lines.push(`**${cat}:** ${items.join('; ')}`);
        }
        this.addSystemMessage(lines.join('\n'));
    }

    private async switchAgent(args: string): Promise<void> {
        const { BUILT_IN_PRESETS, getPreset, formatPresetList } = await import('../lib/agents');
        const preset = args.trim().toLowerCase();
        if (!preset) {
            const current = getPreset(this.plugin.settings.activeAgentPreset);
            const lines = [
                `**🤖 Agent Presets** (active: ${current?.icon ?? '🤖'} ${current?.name ?? 'Default'})`,
                '',
                formatPresetList(),
                '',
                'Usage: `/agent <id>` to switch (e.g. `/agent code-expert`)',
            ];
            this.addSystemMessage(lines.join('\n'));
            return;
        }
        const match = BUILT_IN_PRESETS.find(p => p.id === preset || p.name.toLowerCase() === preset);
        if (!match) {
            this.addSystemMessage(`Unknown agent "${args.trim()}". Use \`/agent\` to see available presets.`);
            return;
        }
        this.plugin.settings.activeAgentPreset = match.id;
        await this.plugin.saveSettings();
        this.addSystemMessage(`${match.icon} Switched to **${match.name}** — ${match.description}`);
    }

    private async duplicateConversation(): Promise<void> {
        if (!this.conversation) { new Notice('No active conversation.'); return; }
        const id = this.plugin.storage.generateId();
        const clone: Conversation = {
            id,
            title: `${this.conversation.title} (copy)`,
            messages: this.conversation.messages.map(m => ({ ...m })),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pinned: false,
            provider: this.conversation.provider,
            model: this.conversation.model,
        };
        await this.plugin.storage.saveConversation(clone);
        this.conversation = clone;
        await this.renderMessages();
        this.renderConversationListUI();
        this.addSystemMessage(`✅ Duplicated as **${clone.title}**`);
    }

    private async forkConversation(visibleIndex: number): Promise<void> {
        if (!this.conversation) return;
        // Map visible index back to real messages (including system/tool)
        const visible = this.conversation.messages.filter(m => m.role !== 'system' && m.role !== 'tool');
        const targetMsg = visible[visibleIndex];
        if (!targetMsg) return;

        const realIndex = this.conversation.messages.indexOf(targetMsg);
        if (realIndex < 0) return;

        // Include all messages up to and including the target message
        const forkedMessages = this.conversation.messages.slice(0, realIndex + 1).map(m => ({ ...m }));

        const id = this.plugin.storage.generateId();
        const fork: Conversation = {
            id,
            title: `${this.conversation.title} (fork)`,
            messages: forkedMessages,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pinned: false,
            provider: this.conversation.provider,
            model: this.conversation.model,
        };
        await this.plugin.storage.saveConversation(fork);
        this.conversation = fork;
        this.clearFollowUpChips();
        await this.renderMessages();
        this.renderConversationListUI();
        new Notice(`Forked conversation with ${forkedMessages.length} messages.`);
    }

    private async regenerate(): Promise<void> {
        if (!this.conversation) return;
        const msgs = this.conversation.messages;
        if (msgs.length === 0) return;
        if (msgs[msgs.length - 1].role === 'assistant') msgs.pop();
        const lastUser = msgs[msgs.length - 1];
        if (lastUser?.role !== 'user') return;
        await this.renderMessages();
        await this.sendMessage(lastUser.content, undefined, true);
    }

    private async openConversationNote(): Promise<void> {
        if (!this.conversation) { new Notice('No active conversation.'); return; }
        const notePath = `${this.plugin.settings.chatFolder}/${this.conversation.id}.md`;
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (!file) { new Notice('Chat note not found. Send a message first.'); return; }
        await this.app.workspace.openLinkText(notePath, '', 'tab');
    }

    private async toggleCopilotUsage(): Promise<void> {
        const isCopilot = this.plugin.settings.selectedProvider === 'copilot';
        const activeAcct = this.plugin.settings.copilotAccounts.find(a => a.id === this.plugin.settings.activeCopilotAccountId);
        const oauthToken = activeAcct?.oauthToken ?? this.plugin.settings.copilotToken;

        if (!isCopilot || !oauthToken) {
            // For non-Copilot providers, show session tokens as a simple notice
            const promptStr = this.sessionTokensPrompt.toLocaleString();
            const compStr = this.sessionTokensCompletion.toLocaleString();
            const totalStr = (this.sessionTokensPrompt + this.sessionTokensCompletion).toLocaleString();
            let msg = `Session Usage:\nPrompt: ${promptStr} tokens\nCompletion: ${compStr} tokens\nTotal: ${totalStr} tokens`;
            if (this.sessionCost > 0) msg += `\nEstimated Cost: $${this.sessionCost.toFixed(4)}`;
            new Notice(msg, 5000);
            return;
        }

        // Toggle visibility — if already visible, hide it
        if (this.quotaBarEl.style.display !== 'none') {
            this.quotaBarEl.style.display = 'none';
            return;
        }

        // Fetch and display
        try {
            this.quotaLabelEl.textContent = 'Loading…';
            this.quotaBarEl.style.display = 'flex';

            const quota = await fetchCopilotQuotaInfo(oauthToken);
            this.updateQuotaBar(quota);
        } catch (err: unknown) {
            this.quotaLabelEl.textContent = 'Failed to load';
            new Notice(`Copilot usage error: ${getErrorMessage(err)}`, 4000);
        }
    }

    private updateQuotaBar(quota: import('../lib/copilot-usage').CopilotQuotaInfo): void {
        if (!quota.premium) {
            this.quotaLabelEl.textContent = 'No premium quota data';
            this.quotaFillEl.style.width = '0%';
            return;
        }

        const usedPct = 100 - quota.premium.percent_remaining;
        const clampedPct = Math.max(0, Math.min(100, usedPct));

        // Update the small inline bar
        this.quotaFillEl.style.width = `${clampedPct.toFixed(1)}%`;
        this.quotaFillEl.classList.remove('sidekick-ctx-green', 'sidekick-ctx-yellow', 'sidekick-ctx-red');
        if (clampedPct < 50) this.quotaFillEl.classList.add('sidekick-ctx-green');
        else if (clampedPct < 80) this.quotaFillEl.classList.add('sidekick-ctx-yellow');
        else this.quotaFillEl.classList.add('sidekick-ctx-red');

        // Label
        this.quotaLabelEl.textContent = `Premium: ${clampedPct.toFixed(1)}%`;

        // Build tooltip
        this.quotaTooltipEl.empty();
        this.quotaTooltipEl.createEl('div', { text: 'Copilot Pro Usage', cls: 'sidekick-ctx-tooltip-title' });

        // Chat
        if (quota.chat) {
            const chatRow = this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
            chatRow.createSpan({ text: 'Inline Suggestions' });
            chatRow.createSpan({ text: quota.chat.unlimited ? 'Included' : `${quota.chat.remaining} left`, cls: 'sidekick-ctx-tooltip-val' });
        }

        // Completions
        if (quota.completions) {
            const compRow = this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
            compRow.createSpan({ text: 'Chat Messages' });
            compRow.createSpan({ text: quota.completions.unlimited ? 'Included' : `${quota.completions.remaining} left`, cls: 'sidekick-ctx-tooltip-val' });
        }

        // Premium progress bar in tooltip
        this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-section', text: 'Premium Requests' });
        const summaryStr = `${clampedPct.toFixed(1)}% used • ${quota.premium.remaining}/${quota.premium.entitlement} remaining`;
        this.quotaTooltipEl.createDiv({ text: summaryStr, cls: 'sidekick-ctx-tooltip-summary' });

        const barContainer = this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-bar-container' });
        const tooltipBar = barContainer.createDiv({ cls: 'sidekick-ctx-tooltip-bar' });
        tooltipBar.style.width = `${clampedPct.toFixed(1)}%`;
        // Color the tooltip bar too
        if (clampedPct >= 80) tooltipBar.style.background = 'linear-gradient(90deg, #ef4444, #f87171)';
        else if (clampedPct >= 50) tooltipBar.style.background = 'linear-gradient(90deg, #eab308, #facc15)';

        if (quota.premium.overage_permitted) {
            this.quotaTooltipEl.createDiv({ text: 'Additional premium requests approved.', cls: 'sidekick-ctx-tooltip-summary' });
        }

        // Session usage in tooltip
        if (this.sessionTokensPrompt > 0 || this.sessionTokensCompletion > 0) {
            this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-section', text: 'Session' });
            const row = this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
            row.createSpan({ text: 'Tokens' });
            row.createSpan({ text: `${this.sessionTokensPrompt.toLocaleString()}→${this.sessionTokensCompletion.toLocaleString()}`, cls: 'sidekick-ctx-tooltip-val' });
            if (this.sessionCost > 0) {
                const costRow = this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-row' });
                costRow.createSpan({ text: 'Cost' });
                const costStr = this.sessionCost < 0.001 ? this.sessionCost.toFixed(6) : this.sessionCost.toFixed(4);
                costRow.createSpan({ text: `$${costStr}`, cls: 'sidekick-ctx-tooltip-val' });
            }
        }

        // Reset date
        if (quota.quota_reset_date) {
            const resetDate = new Date(quota.quota_reset_date + 'T00:00:00');
            const formatted = resetDate.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
            this.quotaTooltipEl.createDiv({ cls: 'sidekick-ctx-tooltip-divider' });
            this.quotaTooltipEl.createDiv({ text: `Resets ${formatted}`, cls: 'sidekick-ctx-tooltip-summary' });
        }
    }

    private async exportChat(): Promise<void> {
        if (!this.conversation?.messages.length) { new Notice('No messages to export.'); return; }
        const conv = this.conversation;
        const totalTokens = conv.messages.reduce((sum, m) => sum + (m.cost?.tokensPrompt || 0) + (m.cost?.tokensCompletion || 0), 0);
        const totalCost = conv.usage?.totalCost ?? conv.messages.reduce((sum, m) => sum + (m.cost?.total || 0), 0);
        const md = buildExportMarkdown(conv.title, conv.messages, {
            model: conv.model,
            provider: conv.provider,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messageCount: conv.messages.filter(m => m.role !== 'system' && m.role !== 'tool').length,
            totalTokens: totalTokens || undefined,
            totalCost: totalCost || undefined,
        });
        const folder = `${this.plugin.settings.chatFolder}/exports`;
        const path = `${folder}/chat-${new Date().toISOString().slice(0, 10)}-${this.conversation.id}.md`;
        try {
            await ensureFolder(this.app, folder);
            await this.app.vault.create(path, md);
            new Notice(`Chat exported to ${path}`);
        } catch (err: unknown) {
            this.showError(`Export failed: ${getErrorMessage(err)}`);
        }
    }

    private async copyChat(): Promise<void> {
        if (!this.conversation?.messages.length) { new Notice('No messages to copy.'); return; }
        const md = buildExportMarkdown(this.conversation.title, this.conversation.messages);
        await navigator.clipboard.writeText(md);
        new Notice('Chat copied to clipboard');
    }

    // ── In-conversation search ──────────────────────────────────────

    private openSearch(): void {
        this.searchBarEl.style.display = 'flex';
        this.searchInputEl.value = '';
        this.searchCountEl.textContent = '';
        this.searchInputEl.focus();
    }

    private renameConversationInline(): void {
        if (!this.conversation) return;
        const current = this.conversation.title || 'New Chat';
        this.headerModelLabel.empty();
        const input = this.headerModelLabel.createEl('input', {
            cls: 'sidekick-inline-rename',
            attr: { type: 'text', value: current },
        });
        input.focus();
        input.select();

        const commit = async () => {
            const newTitle = input.value.trim() || current;
            if (this.conversation) {
                this.conversation.title = newTitle;
                this.conversation.updatedAt = Date.now();
                await this.plugin.storage.saveConversation(this.conversation);
            }
            this.headerModelLabel.textContent = newTitle;
            this.headerModelLabel.setAttribute('title', 'Double-click to rename');
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = current; input.blur(); }
        });
    }

    /** Generate a title for a conversation using AI (async, updates list when done). */
    private async generateTitleForConversation(conv: Conversation): Promise<void> {
        if (conv.messages.length < 2) return;
        const userMsg = conv.messages[0]?.content || '';
        const assistantMsg = conv.messages[1]?.content || '';
        if (!userMsg || !assistantMsg) return;

        const { buildTitlePromptMessages, parseTitleResponse } = await import('../lib/conversation');
        const { PROVIDERS } = await import('./constants');
        const { resolveApiKey } = await import('./api-helpers');

        const s = this.plugin.settings;
        const provider = s.selectedProvider;
        const providerConfig = PROVIDERS[provider];
        if (!providerConfig) return;

        let apiKey: string;
        try { apiKey = await resolveApiKey(provider, s); } catch { return; }

        const titleModel = provider === 'copilot' ? 'gpt-4o-mini' : s.selectedModel;
        const messages = buildTitlePromptMessages(userMsg, assistantMsg, s.autoTitlePrompt);

        try {
            const res = await fetch(providerConfig.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...providerConfig.headers(apiKey) },
                body: JSON.stringify({ model: titleModel, messages, max_tokens: 30, temperature: 0.3 }),
            });
            if (!res.ok) { new Notice(`Title generation failed: ${res.status}`); return; }
            const data = await res.json();
            const raw = data?.choices?.[0]?.message?.content;
            if (raw) {
                const title = parseTitleResponse(raw);
                conv.title = title;
                await this.plugin.storage.saveConversation(conv);
                if (this.conversation?.id === conv.id) this.conversation.title = title;
                await this.renderConversationListUI();
                new Notice(`Title: ${title}`);
            }
        } catch {
            new Notice('Failed to generate title');
        }
    }

    private showShortcutsOverlay(): void {
        // Remove existing overlay if any
        this.contentEl.querySelector('.sidekick-shortcuts-overlay')?.remove();

        const overlay = this.contentEl.createDiv({ cls: 'sidekick-shortcuts-overlay' });
        overlay.setAttribute('tabindex', '-1');
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') overlay.remove();
        });
        overlay.focus();

        const card = overlay.createDiv({ cls: 'sidekick-shortcuts-card' });
        const header = card.createDiv({ cls: 'sidekick-shortcuts-header' });
        header.createEl('h3', { text: 'Keyboard Shortcuts' });
        const closeBtn = header.createEl('button', { cls: 'sidekick-shortcuts-close', text: '×' });
        closeBtn.addEventListener('click', () => overlay.remove());

        const shortcuts = [
            ['Enter', 'Send message'],
            ['Shift+Enter', 'New line'],
            ['↑ / ↓', 'Navigate message history'],
            ['Ctrl+F', 'Search in conversation'],
            ['Ctrl+L', 'Focus chat input'],
            ['Ctrl+N', 'New conversation'],
            ['Ctrl+Shift+E', 'Export chat as note'],
            ['Ctrl+Shift+Z', 'Undo last exchange'],
            ['Ctrl+Shift+R', 'Regenerate last response'],
            ['Ctrl+/', 'Show this overlay'],
            ['Ctrl+Shift+M', 'Switch model'],
            ['Alt+\\', 'Trigger inline suggestion'],
            ['Escape', 'Stop generation / close search'],
            ['@filename', 'Attach a note as context'],
            ['/command', 'Run a slash command'],
        ];

        const grid = card.createDiv({ cls: 'sidekick-shortcuts-grid' });
        for (const [key, desc] of shortcuts) {
            const keyEl = grid.createSpan({ cls: 'sidekick-shortcut-key' });
            // Split on + for key combos, render each part as kbd
            const parts = key.includes('+') ? key.split('+') : [key];
            parts.forEach((part, i) => {
                keyEl.createEl('kbd', { text: part.trim() });
                if (i < parts.length - 1) keyEl.appendText('+');
            });
            grid.createSpan({ cls: 'sidekick-shortcut-desc', text: desc });
        }
    }

    private closeSearch(): void {
        this.searchBarEl.style.display = 'none';
        this.clearSearchHighlights();
        this.searchInputEl.value = '';
    }

    private performSearch(): void {
        this.clearSearchHighlights();
        const query = this.searchInputEl.value.trim().toLowerCase();
        if (!query) { this.searchCountEl.textContent = ''; return; }

        const walker = document.createTreeWalker(
            this.messagesContainer,
            NodeFilter.SHOW_TEXT,
            { acceptNode: (node) => node.textContent?.toLowerCase().includes(query) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT },
        );

        const textNodes: Text[] = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

        for (const node of textNodes) {
            const text = node.textContent || '';
            const idx = text.toLowerCase().indexOf(query);
            if (idx === -1) continue;
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + query.length);
            const mark = document.createElement('mark');
            mark.className = 'sidekick-search-highlight';
            range.surroundContents(mark);
            this.searchMatches.push(mark);
        }

        this.searchMatchIndex = this.searchMatches.length > 0 ? 0 : -1;
        this.updateSearchCount();
        if (this.searchMatches.length > 0) this.scrollToMatch();
    }

    private navigateSearch(dir: 1 | -1): void {
        if (this.searchMatches.length === 0) return;
        this.searchMatchIndex = (this.searchMatchIndex + dir + this.searchMatches.length) % this.searchMatches.length;
        this.updateSearchCount();
        this.scrollToMatch();
    }

    private updateSearchCount(): void {
        if (this.searchMatches.length === 0) {
            this.searchCountEl.textContent = 'No results';
        } else {
            this.searchCountEl.textContent = `${this.searchMatchIndex + 1} / ${this.searchMatches.length}`;
        }
    }

    private scrollToMatch(): void {
        const match = this.searchMatches[this.searchMatchIndex];
        if (!match) return;
        this.searchMatches.forEach(m => m.classList.remove('sidekick-search-active'));
        match.classList.add('sidekick-search-active');
        match.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    private clearSearchHighlights(): void {
        for (const mark of this.searchMatches) {
            const parent = mark.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
                parent.normalize();
            }
        }
        this.searchMatches = [];
        this.searchMatchIndex = -1;
    }

    // ── Loading state & stop ────────────────────────────────────────

    private stopGeneration(): void {
        // Resolve any pending iterate feedback promise first
        if (this.iterateFeedbackResolve) {
            this.iterateFeedbackResolve(null);
            this.iterateFeedbackResolve = null;
        }
        this.hideIterateFeedbackUI();
        this.clearQueuedMessage();

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.setLoading(false);
    }

    private setLoading(loading: boolean): void {
        this.isLoading = loading;
        this.stopBtn.style.display = loading ? 'flex' : 'none';
        this.submitBtn.style.display = loading ? 'none' : 'flex';
        this.modelPickerBtn.style.display = loading ? 'none' : '';
        this.loadingIndicator.style.display = loading ? 'flex' : 'none';
        if (!loading) {
            this.loadingTextEl.textContent = 'Generating...';
        }
        // Visual streaming indicator on messages container
        if (loading) {
            this.messagesContainer.classList.add('sidekick-generating');
        } else {
            this.messagesContainer.classList.remove('sidekick-generating');
        }
        // Typing indicator (three dots) in messages area
        const existingIndicator = this.messagesContainer.querySelector('.sidekick-typing-indicator');
        if (loading && !existingIndicator) {
            const indicator = this.messagesContainer.createDiv({ cls: 'sidekick-typing-indicator' });
            for (let i = 0; i < 3; i++) indicator.createSpan({ cls: 'sidekick-typing-dot' });
            this.scrollToBottom(false);
        } else if (!loading && existingIndicator) {
            existingIndicator.remove();
        }
        // Input stays enabled during generation so users can type queued messages
        if (!loading) {
            this.inputEl.placeholder = 'Ask anything... • /help for commands';
        } else {
            this.inputEl.placeholder = 'Type next message… (Enter to queue)';
        }
    }

    private setLoadingStatus(text: string): void {
        this.loadingTextEl.textContent = text;
    }

    private showUndoDeleteToast(snapshot: Conversation, removedMappings: Record<string, string>, wasActive: boolean): void {
        const toast = document.createElement('div');
        toast.className = 'sidekick-undo-toast';

        const label = document.createElement('span');
        label.textContent = 'Conversation deleted';
        toast.appendChild(label);

        const undoBtn = document.createElement('button');
        undoBtn.className = 'sidekick-undo-btn';
        undoBtn.textContent = 'Undo';
        toast.appendChild(undoBtn);

        document.body.appendChild(toast);
        let undone = false;
        const timer = setTimeout(() => { if (!undone) toast.remove(); }, 5000);

        undoBtn.addEventListener('click', async () => {
            undone = true;
            clearTimeout(timer);
            toast.remove();
            // Restore conversation
            await this.plugin.storage.saveConversation(snapshot);
            // Restore command session mappings
            if (Object.keys(removedMappings).length > 0) {
                Object.assign(this.plugin.settings.commandSessionMap, removedMappings);
                await this.plugin.saveSettings();
            }
            if (wasActive) {
                this.conversation = snapshot;
                await this.renderMessages();
            }
            await this.renderConversationListUI();
            new Notice('Conversation restored');
        });
    }

    // ── Main send message flow (delegates to ChatController) ────────

    async sendMessage(content: string, systemPromptOverride?: string, skipUserPush = false, userImages?: string[], resumeOptions?: { resumeIterate: boolean; iterateFeedback: string }): Promise<void> {
        const s = this.plugin.settings;
        const provider = s.selectedProvider;
        const cfg = PROVIDERS[provider];

        if (!cfg) { this.showError(`Unknown provider: ${provider}`); return; }
        // Copilot uses OAuth (managed by CopilotTokenManager), so skip the key check
        if (provider !== 'copilot') {
            const apiKey = provider === 'openai' ? s.openaiApiKey : s.openrouterApiKey;
            if (!apiKey) { this.showError(`Set your ${cfg.label} API key in Settings.`); return; }
        }
        if (!this.conversation) await this.newConversation();

        this.setLoading(true);
        this.errorBanner.style.display = 'none';

        const ac = new AbortController();
        this.abortController = ac;

        const attachedNotes = [...this.attachedNotes];
        this.attachedNotes = [];
        this.renderAttachedNotes();

        // Auto-RAG: On first message with no manual attachments, search vault for relevant context
        if (s.enableAutoRAG && attachedNotes.length === 0 && !skipUserPush) {
            const conv = this.conversation;
            const isFirstMessage = !conv || conv.messages.filter(m => m.role === 'user').length === 0;
            if (isFirstMessage) {
                try {
                    const { getVaultIndexer } = await import('./tools');
                    const indexer = getVaultIndexer();
                    if (indexer?.isReady()) {
                        const results = await indexer.search(content, 3, 0.4);
                        for (const r of results) {
                            const file = this.app.vault.getAbstractFileByPath(r.path);
                            if (file instanceof TFile) {
                                const noteContent = await this.app.vault.cachedRead(file);
                                attachedNotes.push({ path: file.path, name: file.basename, content: noteContent });
                            }
                        }
                        if (attachedNotes.length > 0) {
                            this.addSystemMessage(`📚 Auto-attached ${attachedNotes.length} relevant note${attachedNotes.length > 1 ? 's' : ''} as context`);
                        }
                    }
                } catch { /* silently skip auto-RAG on error */ }
            }
        }

        const msgOptions: any = { content, systemPromptOverride, skipUserPush, userImages, iterateMode: s.iterateMode };
        if (resumeOptions) {
            msgOptions.resumeIterate = resumeOptions.resumeIterate;
            msgOptions.iterateFeedback = resumeOptions.iterateFeedback;
            msgOptions.iterateMode = true;
        }

        const sendStartTime = Date.now();
        try {
            this.activeSend = orchestrateSendMessage(
                this.app,
                s,
                this.conversation!,
                attachedNotes,
                msgOptions,
                {
                    updateDisplay: (c) => this.updateLastAssistant(c),
                    showApproval: (a) => this.showApprovalUI(a),
                    hideApproval: () => this.hideApprovalUI(),
                    showCost: (t, p, c) => this.showCostDisplay(t, p, c),
                    showErrorWithRetry: (m, c, sp, i) => this.showErrorWithRetry(m, c, sp, i),
                    getCachedModels: () => this.modelPicker.getCachedModels(),
                    onMessagesPushed: async (newMessages) => {
                        await this.appendVisibleMessages(newMessages);
                        this.scrollToBottom();
                    },
                    onRequestIterateFeedback: (q) => this.requestIterateFeedback(q),
                    onRequestIterateChoice: (q, c, a) => this.requestIterateChoice(q, c, a),
                    updateContextBreakdown: (b, t) => this.updateContextBreakdown(b, t),
                    onTitleGenerated: (title) => {
                        if (this.conversation) this.conversation.title = title;
                        this.renderConversationListUI();
                    },
                    onStatusChange: (status) => this.setLoadingStatus(status),
                    saveProfileFact: this.plugin.settings.enableUserProfile
                        ? async (fact: string, category?: string) => {
                            const { addFact } = await import('../lib/profile');
                            const cat = (category as import('../lib/profile').FactCategory) || 'custom';
                            this.plugin.settings.userProfile = addFact(this.plugin.settings.userProfile, fact, cat, 'chat');
                            await this.plugin.saveSettings();
                        }
                        : undefined,
                },
                ac,
                (conv) => this.plugin.storage.saveConversation(conv),
                (img, prefix) => saveImageToVault(this.app, s.chatFolder, img, prefix),
                (convId, state) => this.plugin.storage.saveIterateState(convId, state),
                (convId) => this.plugin.storage.deleteIterateState(convId),
                (convId) => this.plugin.storage.loadIterateState(convId),
            );
            await this.activeSend;
        } finally {
            this.activeSend = null;
            await this.flushStreamRender();
            // Show elapsed time briefly before hiding the loading indicator
            const elapsed = ((Date.now() - sendStartTime) / 1000).toFixed(1);
            this.setLoadingStatus(`Done in ${elapsed}s`);
            setTimeout(() => this.setLoading(false), 2000);
            this.abortController = null;
            this.hideApprovalUI();
            this.hideIterateFeedbackUI();
            this.inputEl.focus();
            this.notifyIfUnfocused('Sidekick', 'Response complete');
            // Generate follow-up suggestions (fire-and-forget, non-blocking)
            this.generateFollowUpSuggestions();
            // Auto-send queued message if one was typed during generation
            if (this.queuedMessage) {
                await this.sendQueuedMessage();
            }
        }
    }

    // ── Follow-up suggestion chips ──────────────────────────────────

    private clearFollowUpChips(): void {
        this.followUpChipsEl.empty();
        this.followUpChipsEl.style.display = 'none';
    }

    private renderFollowUpChips(suggestions: FollowUpSuggestion[]): void {
        this.followUpChipsEl.empty();
        if (suggestions.length === 0) {
            this.followUpChipsEl.style.display = 'none';
            return;
        }
        this.followUpChipsEl.style.display = 'flex';
        for (const suggestion of suggestions) {
            const chip = this.followUpChipsEl.createEl('button', {
                cls: 'sidekick-followup-chip',
                text: suggestion.label,
                attr: { title: suggestion.text },
            });
            chip.addEventListener('click', () => {
                this.clearFollowUpChips();
                this.inputEl.value = suggestion.text;
                this.handleSend();
            });
        }
    }

    // ── Message queuing (type while generating) ─────────────────────

    private showQueuedBanner(): void {
        if (!this.queuedMessage) return;
        this.queuedBannerEl.empty();
        const label = this.queuedBannerEl.createSpan({ cls: 'sidekick-queued-label' });
        label.textContent = `⏳ Queued: "${this.queuedMessage.text.length > 60 ? this.queuedMessage.text.slice(0, 60) + '…' : this.queuedMessage.text}"`;
        const cancelBtn = this.queuedBannerEl.createEl('button', { cls: 'sidekick-queued-cancel', text: '✕' });
        cancelBtn.addEventListener('click', () => this.clearQueuedMessage());
        this.queuedBannerEl.style.display = 'flex';
    }

    private clearQueuedMessage(): void {
        this.queuedMessage = null;
        this.queuedBannerEl.empty();
        this.queuedBannerEl.style.display = 'none';
    }

    private async sendQueuedMessage(): Promise<void> {
        if (!this.queuedMessage) return;
        const { text, images } = this.queuedMessage;
        this.clearQueuedMessage();
        this.inputEl.value = text;
        if (images.length > 0) {
            this.pendingImages = images;
            this.renderPendingImages();
        }
        await this.handleSend();
    }

    private async generateFollowUpSuggestions(): Promise<void> {
        if (!this.conversation || this.conversation.messages.length < 2) return;

        const currentConvId = this.conversation.id;
        const msgs = this.conversation.messages;
        const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
        const lastUser = [...msgs].reverse().find(m => m.role === 'user');
        if (!lastAssistant || !lastUser) return;
        if (!shouldGenerateSuggestions(lastAssistant.content, lastUser.content)) return;

        const s = this.plugin.settings;
        if (s.followUpSuggestions === false) return;

        const provider = s.selectedProvider;
        const providerConfig = PROVIDERS[provider];
        if (!providerConfig) return;

        let apiKey: string;
        if (provider === 'copilot') {
            try { apiKey = await copilotTokenManager.getSessionToken(); } catch { return; }
        } else {
            apiKey = provider === 'openai' ? s.openaiApiKey : s.openrouterApiKey;
        }
        if (!apiKey) return;

        // Cancel any in-flight suggestion fetch
        this.suggestionAbortController?.abort();
        const ac = new AbortController();
        this.suggestionAbortController = ac;

        // 5s timeout
        const timeoutId = setTimeout(() => ac.abort(), 5000);

        // Use a small/fast model for suggestions
        const suggestionsModel = provider === 'copilot' ? 'gpt-4o-mini' : s.selectedModel;

        const promptMessages = buildFollowUpPromptMessages(lastAssistant.content, lastUser.content, s.followUpSuggestionsPrompt);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...providerConfig.headers(apiKey),
        };

        try {
            const res = await fetch(providerConfig.url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: suggestionsModel,
                    messages: promptMessages,
                    max_tokens: 150,
                    temperature: 0.7,
                }),
                signal: ac.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) return;
            // Guard: conversation may have changed during fetch
            if (this.conversation?.id !== currentConvId) return;
            const data = await res.json();
            const content = data?.choices?.[0]?.message?.content;
            if (content) {
                const suggestions = parseFollowUpResponse(content);
                // Final guard before rendering
                if (this.conversation?.id === currentConvId) {
                    this.renderFollowUpChips(suggestions);
                }
            }
        } catch {
            // Silently fail — suggestions are a nice-to-have (includes AbortError)
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // ── Iterate feedback UI ─────────────────────────────────────────

    private requestIterateFeedback(question: string): Promise<{ text: string; images?: string[] } | null> {
        // Guard: if the controller was already stopped (e.g. conversation switched),
        // return null immediately to avoid showing stale UI in the new chat.
        if (!this.abortController) {
            return Promise.resolve(null);
        }
        return new Promise<{ text: string; images?: string[] } | null>((resolve) => {
            this.iterateFeedbackResolve = resolve;
            this.showIterateFeedbackUI(question);
        });
    }

    private showIterateFeedbackUI(question: string): void {
        // Show banner with AI question and done button
        this.iterateFeedbackBanner.empty();
        this.iterateFeedbackBanner.style.display = 'flex';
        this.notifyIfUnfocused('Sidekick', 'AI is waiting for your input');

        const label = this.iterateFeedbackBanner.createDiv({ cls: 'sidekick-iterate-banner-text' });
        label.createSpan({ text: '🔄 AI asks: ', cls: 'sidekick-iterate-title' });
        const hintEl = label.createDiv({ cls: 'sidekick-iterate-hint markdown-rendered' });
        if (this.renderComponent) {
            MarkdownRenderer.render(this.app, question, hintEl, '', this.renderComponent);
        } else {
            hintEl.textContent = question;
        }

        // Expand/collapse toggle — shown only when content overflows the max-height
        const expandBtn = this.iterateFeedbackBanner.createEl('button', {
            text: '⤢',
            cls: 'sidekick-iterate-expand-btn',
            attr: { title: 'Expand / collapse' },
        });
        expandBtn.addEventListener('click', () => {
            const isExpanded = hintEl.classList.toggle('expanded');
            expandBtn.textContent = isExpanded ? '⤡' : '⤢';
        });
        // Hide toggle if content fits without scrolling
        requestAnimationFrame(() => {
            if (hintEl.scrollHeight <= hintEl.clientHeight) {
                expandBtn.style.display = 'none';
            }
        });

        const doneBtn = this.iterateFeedbackBanner.createEl('button', {
            text: '✓ Done',
            cls: 'sidekick-iterate-done-btn',
        });
        doneBtn.addEventListener('click', () => {
            this.inputEl.value = '';
            this.autoResizeInput();
            this.hideIterateFeedbackUI();
            this.iterateFeedbackResolve?.(null);
            this.iterateFeedbackResolve = null;
            // Re-enable loading indicator while orchestrator winds down
            this.setLoading(true);
        });

        // Switch main input to feedback mode
        this.isWaitingForFeedback = true;
        this.savedPlaceholder = this.inputEl.placeholder;
        this.inputEl.placeholder = 'Your feedback... (Enter to send, or click Done to finish)';

        // Enable loading state to be false while waiting for feedback
        this.setLoading(false);
        this.inputEl.focus();
        this.scrollToBottom();
    }

    private hideIterateFeedbackUI(): void {
        this.iterateFeedbackBanner.style.display = 'none';
        this.isWaitingForFeedback = false;
        this.inputEl.placeholder = this.savedPlaceholder || 'Ask anything... • /help for commands • ↑↓ history';
    }

    // ── Iterate choice UI (MCQ with clickable buttons) ───────────────

    private requestIterateChoice(
        question: string,
        choices: string[],
        allowCustom: boolean,
    ): Promise<{ text: string; images?: string[] } | null> {
        if (!this.abortController) {
            return Promise.resolve(null);
        }
        return new Promise<{ text: string; images?: string[] } | null>((resolve) => {
            this.iterateFeedbackResolve = resolve;
            this.showIterateChoiceUI(question, choices, allowCustom);
        });
    }

    private showIterateChoiceUI(question: string, choices: string[], allowCustom: boolean): void {
        this.iterateFeedbackBanner.empty();
        this.iterateFeedbackBanner.style.display = 'flex';
        this.iterateFeedbackBanner.style.flexDirection = 'column';

        // Header row with question + done button
        const headerRow = this.iterateFeedbackBanner.createDiv({ cls: 'sidekick-choice-header' });
        const label = headerRow.createDiv({ cls: 'sidekick-iterate-banner-text' });
        label.createSpan({ text: '🔄 AI asks: ', cls: 'sidekick-iterate-title' });
        const hintEl = label.createDiv({ cls: 'sidekick-iterate-hint markdown-rendered' });
        if (this.renderComponent) {
            MarkdownRenderer.render(this.app, question, hintEl, '', this.renderComponent);
        } else {
            hintEl.textContent = question;
        }

        // Expand/collapse toggle for long questions
        const expandBtn = headerRow.createEl('button', {
            text: '⤢',
            cls: 'sidekick-iterate-expand-btn',
            attr: { title: 'Expand / collapse' },
        });
        expandBtn.addEventListener('click', () => {
            const isExpanded = hintEl.classList.toggle('expanded');
            expandBtn.textContent = isExpanded ? '⤡' : '⤢';
        });
        requestAnimationFrame(() => {
            if (hintEl.scrollHeight <= hintEl.clientHeight) {
                expandBtn.style.display = 'none';
            }
        });

        const doneBtn = headerRow.createEl('button', {
            text: '✓ Done',
            cls: 'sidekick-iterate-done-btn',
        });
        doneBtn.addEventListener('click', () => {
            this.inputEl.value = '';
            this.autoResizeInput();
            this.hideIterateChoiceUI();
            this.iterateFeedbackResolve?.(null);
            this.iterateFeedbackResolve = null;
            this.setLoading(true);
        });

        // Choice buttons
        const choicesContainer = this.iterateFeedbackBanner.createDiv({ cls: 'sidekick-choice-buttons' });
        const choiceBtns: HTMLButtonElement[] = [];
        for (let i = 0; i < choices.length; i++) {
            const choice = choices[i];
            const btn = choicesContainer.createEl('button', {
                cls: 'sidekick-choice-btn',
                attr: {
                    'aria-label': `Choice ${i + 1}: ${choice}`,
                    role: 'option',
                },
            });
            btn.createSpan({ text: String(i + 1), cls: 'sidekick-choice-number' });
            btn.createSpan({ text: choice, cls: 'sidekick-choice-text' });
            btn.addEventListener('click', () => {
                this.hideIterateChoiceUI();
                this.iterateFeedbackResolve?.({ text: choice });
                this.iterateFeedbackResolve = null;
                this.setLoading(true);
            });
            choiceBtns.push(btn);
        }

        // Keyboard navigation: Arrow keys move focus between choices, Enter selects
        choicesContainer.addEventListener('keydown', (e: KeyboardEvent) => {
            const focused = document.activeElement as HTMLElement;
            const idx = choiceBtns.indexOf(focused as HTMLButtonElement);
            if (idx === -1) return;

            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                choiceBtns[(idx + 1) % choiceBtns.length].focus();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                choiceBtns[(idx - 1 + choiceBtns.length) % choiceBtns.length].focus();
            }
        });

        // Always add free-text input as the last option
        this.isWaitingForFeedback = true;
        this.savedPlaceholder = this.inputEl.placeholder;
        this.inputEl.placeholder = allowCustom
            ? 'Or type your own answer... (Enter to send)'
            : 'Or type a choice number/text... (Enter to send)';
        this.setLoading(false);
        this.inputEl.focus();
        this.scrollToBottom();
    }

    private hideIterateChoiceUI(): void {
        this.iterateFeedbackBanner.style.display = 'none';
        this.iterateFeedbackBanner.style.flexDirection = '';
        this.isWaitingForFeedback = false;
        this.inputEl.placeholder = this.savedPlaceholder || 'Ask anything... • /help for commands • ↑↓ history';
    }

    // ── Iterate resume banner ───────────────────────────────────────

    private async checkAndShowResumeBanner(): Promise<void> {
        this.hideResumeBanner();
        if (!this.conversation?.iterateSessionPaused) return;

        // Try to extract the last ask_user question from saved state
        let question = 'Continue the iterate session?';
        try {
            const state = await this.plugin.storage.loadIterateState(this.conversation.id);
            if (state) {
                // Find last ask_user tool call to extract the question.
                // Handles both Chat Completions format (assistant + tool_calls) and
                // Responses API format (function_call items with name field).
                for (let i = state.apiMessages.length - 1; i >= 0; i--) {
                    const msg = state.apiMessages[i];
                    // Chat Completions format
                    if (msg.role === 'assistant' && msg.tool_calls) {
                        const askCall = msg.tool_calls.find((tc: any) => tc.function?.name === 'ask_user');
                        if (askCall) {
                            try { question = JSON.parse(askCall.function.arguments).question || question; } catch { /* ok */ }
                            break;
                        }
                    }
                    // Responses API format
                    if (msg.type === 'function_call' && msg.name === 'ask_user') {
                        try { question = JSON.parse(msg.arguments || '{}').question || question; } catch { /* ok */ }
                        break;
                    }
                }
            }
        } catch { /* ok */ }

        this.showResumeBanner(question);
    }

    private showResumeBanner(question: string): void {
        this.iterateResumeBanner.empty();
        this.iterateResumeBanner.style.display = 'flex';

        const label = this.iterateResumeBanner.createDiv({ cls: 'sidekick-iterate-banner-text' });
        label.createSpan({ text: '⏸ Paused: ', cls: 'sidekick-iterate-title' });
        label.createSpan({ text: question, cls: 'sidekick-iterate-hint' });

        const btns = this.iterateResumeBanner.createDiv({ cls: 'sidekick-resume-btns' });

        const resumeBtn = btns.createEl('button', { text: '▶ Resume', cls: 'sidekick-resume-btn' });
        resumeBtn.addEventListener('click', () => this.resumeIterateSession());

        const discardBtn = btns.createEl('button', { text: '✕ Discard', cls: 'sidekick-iterate-done-btn' });
        discardBtn.addEventListener('click', () => this.discardIterateSession());

        // Switch input to resume feedback mode
        this.isWaitingForResume = true;
        this.savedPlaceholder = this.inputEl.placeholder;
        this.inputEl.placeholder = 'Type feedback and press Enter to resume, or click Resume/Discard...';
        this.inputEl.focus();
    }

    private hideResumeBanner(): void {
        this.iterateResumeBanner.style.display = 'none';
        if (this.isWaitingForResume) {
            this.isWaitingForResume = false;
            this.inputEl.placeholder = this.savedPlaceholder || 'Ask anything... • /help for commands • ↑↓ history';
        }
    }

    private async resumeIterateSession(feedback?: string): Promise<void> {
        if (!this.conversation) return;
        const userFeedback = feedback || this.inputEl.value.trim() || 'Continue';
        const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
        this.inputEl.value = '';
        this.pendingImages = [];
        this.renderPendingImages();
        this.autoResizeInput();
        this.hideResumeBanner();
        await this.sendMessage('', undefined, true, images, {
            resumeIterate: true,
            iterateFeedback: userFeedback,
        });
    }

    private async discardIterateSession(): Promise<void> {
        if (!this.conversation) return;
        this.hideResumeBanner();
        this.conversation.iterateSessionPaused = false;
        await this.plugin.storage.deleteIterateState(this.conversation.id);
        await this.plugin.storage.saveConversation(this.conversation);
        this.addSystemMessage('🗑️ Paused iterate session discarded.');
    }

    // ── Tool approval UI ────────────────────────────────────────────

    private showApprovalUI(approval: PendingToolApproval): void {
        this.pendingApproval = approval;
        this.approvalContainer.empty();
        this.approvalContainer.style.display = 'flex';
        this.notifyIfUnfocused('Sidekick', `Tool approval needed: ${approval.toolLabel}`);

        const info = this.approvalContainer.createDiv({ cls: 'sidekick-approval-info' });
        info.createEl('strong', { text: approval.toolLabel });
        if (approval.argsPreview) {
            info.createEl('span', { text: ` — ${approval.argsPreview}`, cls: 'sidekick-approval-args' });
        }

        const btns = this.approvalContainer.createDiv({ cls: 'sidekick-approval-btns' });
        const approveBtn = btns.createEl('button', { text: '✅ Allow', cls: 'sidekick-approve-btn' });
        const alwaysBtn = btns.createEl('button', { text: '🔓 Always', cls: 'sidekick-always-btn', attr: { title: 'Always allow this tool in this chat' } });
        const declineBtn = btns.createEl('button', { text: '❌ Decline', cls: 'sidekick-decline-btn' });
        approveBtn.addEventListener('click', () => resolveToolApproval('approve'));
        alwaysBtn.addEventListener('click', () => resolveToolApproval('always'));
        declineBtn.addEventListener('click', () => resolveToolApproval('decline'));
    }

    private hideApprovalUI(): void {
        this.pendingApproval = null;
        this.approvalContainer.style.display = 'none';
    }

    // ── Edit message ────────────────────────────────────────────────

    private editMessage(msg: ChatMessage): void {
        if (!this.conversation) return;
        const visibleMsgs = this.conversation.messages.filter(m => m.role !== 'system' && m.role !== 'tool');
        const msgIndex = visibleMsgs.indexOf(msg);
        if (msgIndex < 0) return;

        const wrapperEl = this.messagesContainer.children[msgIndex] as HTMLElement;
        if (!wrapperEl || wrapperEl.querySelector('.sidekick-edit-textarea')) return;

        const contentEl = wrapperEl.querySelector('.sidekick-message-content') as HTMLElement;
        if (!contentEl) return;

        contentEl.empty();
        const textarea = contentEl.createEl('textarea', {
            cls: 'sidekick-edit-textarea',
            attr: { rows: String(Math.min(10, msg.content.split('\n').length + 1)) },
        });
        textarea.value = msg.content;
        textarea.focus();

        const actionContainer = wrapperEl.querySelector('.sidekick-message-actions') as HTMLElement;
        if (!actionContainer) return;

        actionContainer.empty();
        const saveBtn = actionContainer.createEl('button', { text: 'Save & Resend', cls: 'sidekick-edit-save-btn' });
        const cancelBtn = actionContainer.createEl('button', { text: 'Cancel', cls: 'sidekick-edit-cancel-btn' });

        const doSave = async () => {
            const newContent = textarea.value.trim();
            if (!newContent) return;
            const realIndex = this.conversation!.messages.indexOf(msg);
            if (realIndex < 0) return;
            msg.content = newContent;
            this.conversation!.messages = this.conversation!.messages.slice(0, realIndex + 1);
            this.conversation!.updatedAt = Date.now();
            await this.renderMessages();
            await this.sendMessage(newContent, undefined, true, msg.images);
        };

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                doSave();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.renderMessages();
            }
        });

        saveBtn.addEventListener('click', () => doSave());

        cancelBtn.addEventListener('click', () => this.renderMessages());
    }

    // ── Attached notes chips ────────────────────────────────────────

    private renderAttachedNotes(): void {
        this.attachedNotesEl.empty();
        if (this.attachedNotes.length === 0) {
            this.attachedNotesEl.style.display = 'none';
            return;
        }
        this.attachedNotesEl.style.display = 'flex';
        for (const note of this.attachedNotes) {
            const chip = this.attachedNotesEl.createDiv({ cls: 'sidekick-note-chip' });
            chip.createEl('span', { text: `📄 ${note.name}`, cls: 'sidekick-note-chip-name' });
            if (note.images.length > 0) {
                chip.createEl('span', { text: `📷 ${note.images.length}`, cls: 'sidekick-note-chip-images' });
            }
            const removeBtn = chip.createEl('span', { text: '×', cls: 'sidekick-note-chip-remove' });
            removeBtn.addEventListener('click', () => {
                this.attachedNotes = this.attachedNotes.filter(n => n.path !== note.path);
                this.renderAttachedNotes();
            });
        }

        this.refreshContextBreakdown();
    }

    // ── Model Picker ────────────────────────────────────────────────

    /** Open the model picker overlay (also callable from commands). */
    async openModelPicker(): Promise<void> {
        await this.openModelPickerUI();
    }

    private async openModelPickerUI(): Promise<void> {
        await this.modelPicker.open({
            onSelect: async (modelId) => {
                this.plugin.settings.selectedModel = modelId;
                // Track recently used models (most recent first, max 5)
                const recent = this.plugin.settings.recentModels.filter(id => id !== modelId);
                recent.unshift(modelId);
                this.plugin.settings.recentModels = recent.slice(0, 5);
                await this.plugin.saveSettings();
                // Persist fetched models so capability badges survive view rebuilds
                this.plugin.cachedModels = this.modelPicker.getCachedModels();
                this.updateModelLabel();
                this.refreshContextBreakdown();
                // Update conversation model
                if (this.conversation) {
                    this.conversation.model = modelId;
                    this.conversation.updatedAt = Date.now();
                    await this.plugin.storage.saveConversation(this.conversation);
                }
            },
            onProviderSwitch: async (pid) => {
                this.plugin.settings.selectedProvider = pid;
                this.plugin.settings.selectedModel = resolveModelForProvider(pid, this.plugin.settings.selectedModel);
                await this.plugin.saveSettings();
                this.refreshContextBreakdown();
                // Update conversation provider
                if (this.conversation) {
                    this.conversation.provider = pid;
                    this.conversation.model = this.plugin.settings.selectedModel;
                    this.conversation.updatedAt = Date.now();
                    await this.plugin.storage.saveConversation(this.conversation);
                }
            },
            getSettings: () => this.plugin.settings,
        });
    }

    // ── Desktop notifications ───────────────────────────────────────

    /** Send a desktop notification if the window is not focused. */
    private notifyIfUnfocused(title: string, body: string): void {
        if (document.hasFocus()) return;
        if (!('Notification' in window)) return;

        if (Notification.permission === 'granted') {
            new Notification(title, { body, icon: 'message-circle' });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then((perm) => {
                if (perm === 'granted') {
                    new Notification(title, { body, icon: 'message-circle' });
                }
            });
        }
    }
}

import { MarkdownRenderer, setIcon, Notice } from 'obsidian';
import type { App, Component } from 'obsidian';
import type { ChatMessage } from './types';
import { getEditDiff, DiffModal } from './diff-modal';

/**
 * Standalone message rendering — extracted from ChatView.
 *
 * Each function takes explicit dependencies (app, callbacks) instead of
 * relying on a class instance, making it independently testable.
 */

// ── Callback interface ──────────────────────────────────────────────

export interface MessageActions {
    getResourceUrl(img: string): string;
    onEdit(msg: ChatMessage): void;
    onInsertAtCursor(content: string): void;
    onRegenerate(): void;
    onDelete(msg: ChatMessage): Promise<void>;
    onFork(upToIndex: number): void;
    onRate(msg: ChatMessage, rating: 1 | -1 | undefined): void;
    onSaveToNote?(content: string): void;
}

// ── Tool callout patterns for file path extraction ──────────────────

/** Verbs whose argument is a file path that can be opened */
const FILE_VERBS = /^(Read|Edit|Create|Delete|Open|View|Backlinks|Metadata|Outline)\s+/;

/**
 * Post-process rendered callouts: make file paths in tool call titles clickable.
 * Runs after MarkdownRenderer.render() to add interactive links.
 */
function postProcessToolCallouts(contentEl: HTMLElement, app: App): void {
    contentEl.querySelectorAll('.callout .callout-title-inner').forEach(titleEl => {
        // Skip if already processed (has a link)
        if (titleEl.querySelector('.sidekick-tool-file-link')) return;

        const text = titleEl.textContent || '';
        const verbMatch = text.match(FILE_VERBS);
        if (!verbMatch) return;

        const verb = verbMatch[1];
        const afterVerb = text.substring(verbMatch[0].length);

        // Extract file path: everything up to comma, arrow, or end of string
        const pathMatch = afterVerb.match(/^(.+?)(?:\s*,\s*|\s*→\s*|$)/);
        if (!pathMatch) return;
        const filePath = pathMatch[1].trim();
        // Skip placeholder values
        if (!filePath || filePath === 'note' || filePath === 'image' || filePath === '?') return;

        const remainderText = afterVerb.substring(filePath.length);

        // Rebuild title with clickable path
        titleEl.textContent = '';
        titleEl.appendText(verb + ' ');

        const link = createEl('a', {
            text: filePath,
            cls: 'sidekick-tool-file-link',
            attr: { title: `Open ${filePath}` },
        });
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            app.workspace.openLinkText(filePath, '', false);
        });
        titleEl.appendChild(link);

        if (remainderText) titleEl.appendText(remainderText);

        // For Edit callouts, add a "View Diff" button if diff data is available
        if (verb === 'Edit') {
            const diff = getEditDiff(filePath);
            if (diff) {
                const diffBtn = createEl('a', {
                    text: ' diff',
                    cls: 'sidekick-diff-btn',
                    attr: { title: 'View edit diff', role: 'button' },
                });
                diffBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const latestDiff = getEditDiff(filePath);
                    if (latestDiff) new DiffModal(app, latestDiff).open();
                });
                titleEl.appendChild(diffBtn);
            }
        }
    });
}

/**
 * Post-process rendered callouts: ensure they allow visible overflow for timeline dots.
 * Also clip the vertical line to span only between the first and last callout dots.
 */
function postProcessTimelineDots(contentEl: HTMLElement): void {
    const callouts = contentEl.querySelectorAll('.callout');
    if (callouts.length === 0) return;

    // Callouts need overflow:visible for CSS ::after dots to show outside their bounds
    callouts.forEach(callout => {
        (callout as HTMLElement).style.overflow = 'visible';
    });

    // Clip the vertical line to span from first dot to last dot (11px from callout top)
    const contentRect = contentEl.getBoundingClientRect();
    const first = callouts[0] as HTMLElement;
    const last = callouts[callouts.length - 1] as HTMLElement;
    const firstTop = first.getBoundingClientRect().top - contentRect.top + 11;
    const lastTop = last.getBoundingClientRect().top - contentRect.top + 11;
    const bottomOffset = contentRect.height - lastTop;
    contentEl.style.setProperty('--tl-top', `${firstTop}px`);
    contentEl.style.setProperty('--tl-bottom', `${bottomOffset}px`);
}

/**
 * Add copy buttons and language labels to code blocks in rendered markdown.
 */
function addCodeBlockCopyButtons(contentEl: HTMLElement): void {
    const codeBlocks = contentEl.querySelectorAll('pre > code');
    for (const codeEl of codeBlocks) {
        const pre = codeEl.parentElement;
        if (!pre || pre.querySelector('.sidekick-code-copy-btn')) continue;

        pre.style.position = 'relative';

        // Language label (extracted from class like "language-python")
        const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
        if (langClass) {
            const lang = langClass.replace('language-', '');
            const langLabel = document.createElement('span');
            langLabel.className = 'sidekick-code-lang';
            langLabel.textContent = lang;
            pre.appendChild(langLabel);
        }

        const btn = document.createElement('button');
        btn.className = 'sidekick-code-copy-btn';
        btn.setAttribute('title', 'Copy code');
        btn.textContent = '📋';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(codeEl.textContent || '');
            btn.textContent = '✓';
            // Show a brief "Copied!" toast
            const toast = document.createElement('div');
            toast.className = 'sidekick-copy-toast';
            toast.textContent = 'Copied!';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
            setTimeout(() => { btn.textContent = '📋'; }, 1500);
        });
        pre.appendChild(btn);
    }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Render a single chat message (user or assistant) into `container`.
 *
 * @returns The wrapper element that was appended to `container`.
 */
export async function renderMessage(
    app: App,
    component: Component,
    container: HTMLElement,
    msg: ChatMessage,
    index: number,
    total: number,
    actions: MessageActions,
): Promise<HTMLElement> {
    const wrapper = container.createDiv({
        cls: `sidekick-message sidekick-message-${msg.role}`,
    });

    const contentEl = wrapper.createDiv({ cls: 'sidekick-message-content markdown-rendered' });

    // Render markdown
    await MarkdownRenderer.render(app, msg.content || '_Empty_', contentEl, '', component);

    // Post-process tool callouts — add clickable file links + timeline dots
    if (msg.role === 'assistant') {
        postProcessToolCallouts(contentEl, app);
        postProcessTimelineDots(contentEl);
        addCodeBlockCopyButtons(contentEl);
    }

    // Click-to-edit on user messages
    if (msg.role === 'user') {
        contentEl.classList.add('sidekick-editable');
        contentEl.addEventListener('click', (e) => {
            // Don't trigger edit when clicking images, links, or already in edit mode
            if ((e.target as HTMLElement).closest('a, img, textarea, button')) return;
            actions.onEdit(msg);
        });
    }

    // Render attached images for user messages
    if (msg.role === 'user' && msg.images?.length) {
        const imagesRow = contentEl.createDiv({ cls: 'sidekick-msg-images' });
        for (const img of msg.images) {
            imagesRow.createEl('img', {
                cls: 'sidekick-msg-img-thumb',
                attr: { src: actions.getResourceUrl(img), alt: 'Attached image' },
            });
        }
    }

    // Collapse long user messages (>200 words)
    if (msg.role === 'user') {
        const wordCount = (msg.content || '').split(/\s+/).length;
        if (wordCount > 200) {
            contentEl.classList.add('sidekick-collapsed');
            const toggle = wrapper.createDiv({ cls: 'sidekick-collapse-toggle', attr: { role: 'button', tabindex: '0', title: 'Expand or collapse message' } });
            toggle.textContent = `Show full message (${wordCount} words)`;
            toggle.addEventListener('click', () => {
                const isCollapsed = contentEl.classList.contains('sidekick-collapsed');
                contentEl.classList.toggle('sidekick-collapsed');
                toggle.textContent = isCollapsed
                    ? 'Collapse message'
                    : `Show full message (${wordCount} words)`;
            });
            toggle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle.click();
                }
            });
        }
    }

    // ── Message footer with actions ─────────────────────────────
    const footer = wrapper.createDiv({ cls: 'sidekick-message-footer' });

    // Timestamp
    if (msg.timestamp) {
        const now = Date.now();
        const diff = now - msg.timestamp;
        const mins = Math.floor(diff / 60000);
        let timeStr: string;
        if (mins < 1) timeStr = 'just now';
        else if (mins < 60) timeStr = `${mins}m ago`;
        else if (mins < 1440) timeStr = `${Math.floor(mins / 60)}h ago`;
        else timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const timeSpan = footer.createSpan({ cls: 'sidekick-message-timestamp', text: timeStr });
        // Show full timestamp on hover
        timeSpan.setAttribute('title', new Date(msg.timestamp).toLocaleString());
    }

    // Word count for assistant messages
    if (msg.role === 'assistant' && msg.content) {
        const words = msg.content.split(/\s+/).filter(Boolean).length;
        footer.createSpan({ cls: 'sidekick-message-wordcount', text: `${words} words` });
    }

    // Token/cost info for assistant messages
    if (msg.role === 'assistant' && msg.cost) {
        const parts: string[] = [];
        const totalTokens = (msg.cost.tokensPrompt || 0) + (msg.cost.tokensCompletion || 0);
        if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString()} tok`);
        if (msg.cost.total > 0) {
            const costStr = msg.cost.total < 0.001 ? msg.cost.total.toFixed(6) : msg.cost.total.toFixed(4);
            parts.push(`$${costStr}`);
        }
        if (parts.length > 0) {
            const costSpan = footer.createSpan({ cls: 'sidekick-message-cost', text: parts.join(' · ') });
            const details = `Prompt: ${(msg.cost.tokensPrompt || 0).toLocaleString()} tokens\nCompletion: ${(msg.cost.tokensCompletion || 0).toLocaleString()} tokens`;
            costSpan.setAttribute('title', details);
        }
    }

    const actionBar = footer.createDiv({ cls: 'sidekick-message-actions' });

    // Copy
    const copyBtn = actionBar.createEl('button', { cls: 'sidekick-msg-action-btn', attr: { title: 'Copy' } });
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(msg.content);
        setIcon(copyBtn, 'check');
        const toast = document.createElement('div');
        toast.className = 'sidekick-copy-toast';
        toast.textContent = 'Copied!';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
        setTimeout(() => setIcon(copyBtn, 'copy'), 2000);
    });

    // Edit (user only)
    if (msg.role === 'user') {
        const editBtn = actionBar.createEl('button', { cls: 'sidekick-msg-action-btn', attr: { title: 'Edit' } });
        setIcon(editBtn, 'pen-square');
        editBtn.addEventListener('click', () => actions.onEdit(msg));
    }

    // Insert at cursor (assistant only)
    if (msg.role === 'assistant') {
        const insertBtn = actionBar.createEl('button', { cls: 'sidekick-msg-action-btn', attr: { title: 'Insert at cursor' } });
        setIcon(insertBtn, 'text-cursor-input');
        insertBtn.addEventListener('click', () => actions.onInsertAtCursor(msg.content));

        if (actions.onSaveToNote) {
            const saveBtn = actionBar.createEl('button', { cls: 'sidekick-msg-action-btn', attr: { title: 'Save as note' } });
            setIcon(saveBtn, 'file-plus-2');
            saveBtn.addEventListener('click', () => actions.onSaveToNote!(msg.content));
        }
    }

    // Thumbs up / down (assistant only)
    if (msg.role === 'assistant') {
        const thumbUpBtn = actionBar.createEl('button', {
            cls: `sidekick-msg-action-btn${msg.rating === 1 ? ' sidekick-rating-active' : ''}`,
            attr: { title: 'Good response' },
        });
        setIcon(thumbUpBtn, 'thumbs-up');

        const thumbDownBtn = actionBar.createEl('button', {
            cls: `sidekick-msg-action-btn${msg.rating === -1 ? ' sidekick-rating-active' : ''}`,
            attr: { title: 'Poor response' },
        });
        setIcon(thumbDownBtn, 'thumbs-down');

        thumbUpBtn.addEventListener('click', () => {
            const newRating = msg.rating === 1 ? undefined : 1;
            actions.onRate(msg, newRating);
            thumbUpBtn.classList.toggle('sidekick-rating-active', newRating === 1);
            thumbDownBtn.classList.remove('sidekick-rating-active');
        });
        thumbDownBtn.addEventListener('click', () => {
            const newRating = msg.rating === -1 ? undefined : -1;
            actions.onRate(msg, newRating);
            thumbDownBtn.classList.toggle('sidekick-rating-active', newRating === -1);
            thumbUpBtn.classList.remove('sidekick-rating-active');
        });
    }

    // Regenerate (last assistant only)
    if (msg.role === 'assistant' && index === total - 1) {
        const regenBtn = actionBar.createEl('button', { cls: 'sidekick-msg-action-btn', attr: { title: 'Regenerate' } });
        setIcon(regenBtn, 'rotate-cw');
        regenBtn.addEventListener('click', () => actions.onRegenerate());
    }

    // Fork from here (branch conversation)
    const forkBtn = actionBar.createEl('button', { cls: 'sidekick-msg-action-btn', attr: { title: 'Fork from here' } });
    setIcon(forkBtn, 'git-branch');
    forkBtn.addEventListener('click', () => actions.onFork(index));

    // Delete (all messages)
    const deleteBtn = actionBar.createEl('button', {
        cls: 'sidekick-msg-action-btn sidekick-msg-action-btn-danger',
        attr: { title: 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', () => actions.onDelete(msg));

    // Cost badge (assistant messages with cost data)
    if (msg.role === 'assistant' && msg.cost) {
        const costEl = footer.createEl('span', {
            cls: 'sidekick-msg-cost',
            attr: { title: `Prompt: ${msg.cost.tokensPrompt.toLocaleString()} · Completion: ${msg.cost.tokensCompletion.toLocaleString()} tokens` },
        });
        costEl.textContent = `$${msg.cost.total.toFixed(4)}`;
    }

    return wrapper;
}

/**
 * Update the last assistant message's rendered content in-place
 * (used during streaming).
 */
export async function updateLastAssistantContent(
    app: App,
    component: Component,
    messagesContainer: HTMLElement,
    content: string,
): Promise<void> {
    const lastEl = messagesContainer.lastElementChild as HTMLElement | null;
    if (!lastEl?.classList.contains('sidekick-message-assistant')) return;

    const contentEl = lastEl.querySelector('.sidekick-message-content');
    if (!contentEl) return;

    contentEl.empty();
    await MarkdownRenderer.render(
        app,
        content || '_Generating..._',
        contentEl as HTMLElement,
        '',
        component,
    );

    // Add blinking cursor at end of streaming content
    const cursor = document.createElement('span');
    cursor.className = 'sidekick-streaming-cursor';
    contentEl.appendChild(cursor);

    // Post-process tool callouts — add clickable file links + timeline dots
    postProcessToolCallouts(contentEl as HTMLElement, app);
    postProcessTimelineDots(contentEl as HTMLElement);
    addCodeBlockCopyButtons(contentEl as HTMLElement);
}

// ── Re-export from lib/ (single source of truth) ──
export { buildExportMarkdown } from '../lib/conversation';

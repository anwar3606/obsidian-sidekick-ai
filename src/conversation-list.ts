import { setIcon } from 'obsidian';
import type { Conversation } from './types';
import { PROVIDERS } from './constants';

// ── Re-export pure helpers from lib/ (single source of truth) ──
export {
    formatTimeAgo,
    getPreviewSnippet,
    sortConversations,
    filterConversations,
    categorizeByTime,
    groupByCollection,
} from '../lib/conversation';
export type { SortBy, SortDir, GroupBy, ConversationGroup, Collection } from '../lib/conversation';

import {
    formatTimeAgo,
    getPreviewSnippet,
    sortConversations,
    filterConversations,
    categorizeByTime,
    groupByCollection,
} from '../lib/conversation';
import type { SortBy, SortDir, GroupBy } from '../lib/conversation';
import type { Collection } from '../lib/conversation';

/**
 * Conversation list rendering — redesigned with search, sort, grouping,
 * preview snippets, and model/provider badges.
 *
 * Pure rendering function: takes conversations + callbacks,
 * making it testable without ChatView.
 */

/** Friendly label for the model (strip provider prefix). */
function modelLabel(model: string): string {
    return model.includes('/') ? model.split('/').pop()! : model;
}

/** Friendly provider label. */
function providerLabel(provider: string): string {
    return PROVIDERS[provider]?.label ?? provider;
}

// ── Grouping (uses Obsidian-aware label helpers) ────────────────────

import type { ConversationGroup } from '../lib/conversation';

/**
 * Group conversations by time, model, or provider.
 * Pinned items always go into a separate "📌 Pinned" group.
 */
export function groupConversations(
    conversations: Conversation[],
    groupBy: GroupBy,
    collections: Collection[] = [],
): ConversationGroup<Conversation>[] {
    if (groupBy === 'time') return categorizeByTime(conversations);
    if (groupBy === 'collection') return groupByCollection(conversations, collections);

    const pinned: Conversation[] = [];
    const buckets = new Map<string, Conversation[]>();
    for (const conv of conversations) {
        if (conv.pinned) { pinned.push(conv); continue; }
        const key = groupBy === 'model'
            ? modelLabel(conv.model ?? 'Unknown')
            : providerLabel(conv.provider ?? 'Unknown');
        const arr = buckets.get(key);
        if (arr) arr.push(conv); else buckets.set(key, [conv]);
    }
    const groups: ConversationGroup<Conversation>[] = [];
    for (const [label, convs] of buckets) {
        groups.push({ label, conversations: convs, initialLimit: Infinity });
    }
    if (pinned.length) groups.push({ label: '📌 Pinned', conversations: pinned, initialLimit: Infinity });
    return groups;
}

// ── Types ───────────────────────────────────────────────────────────

export interface ConversationListCallbacks {
    onSwitch(id: string): void;
    onPin(conv: Conversation): Promise<void>;
    onDelete(conv: Conversation): Promise<void>;
    onRename(conv: Conversation, newTitle: string): Promise<void>;
    onGenerateTitle?(conv: Conversation): void;
}

export interface ConversationListState {
    groupBy: GroupBy;
    sortBy: SortBy;
    sortDir: SortDir;
    searchQuery: string;
    collections: Collection[];
}

// ── Render ──────────────────────────────────────────────────────────

/**
 * Render the full conversation list UI: toolbar + items.
 */
export function renderConversationList(
    container: HTMLElement,
    conversations: Conversation[],
    activeId: string | null,
    callbacks: ConversationListCallbacks,
    state: ConversationListState = { groupBy: 'time', sortBy: 'date', sortDir: 'asc', searchQuery: '', collections: [] },
    onStateChange?: (state: ConversationListState) => void,
): void {
    container.empty();

    // ── Item list ───────────────────────────────────────────────
    const listEl = container.createDiv({ cls: 'sidekick-convlist-items' });

    // ── Toolbar: search + sort/group controls ───────────────────
    const toolbar = container.createDiv({ cls: 'sidekick-convlist-toolbar' });

    const searchInput = toolbar.createEl('input', {
        cls: 'sidekick-convlist-search',
        attr: { placeholder: 'Search conversations…', type: 'text', value: state.searchQuery },
    });

    const controlsRow = toolbar.createDiv({ cls: 'sidekick-convlist-controls' });

    // Group-by selector
    const groupLabel = controlsRow.createEl('span', { text: 'Group:', cls: 'sidekick-convlist-label' });
    const groupSelect = controlsRow.createEl('select', { cls: 'sidekick-convlist-select' });
    for (const opt of [
        { value: 'time', label: 'Time' },
        { value: 'model', label: 'Model' },
        { value: 'provider', label: 'Provider' },
        { value: 'collection', label: 'Collection' },
    ]) {
        const el = groupSelect.createEl('option', { text: opt.label, attr: { value: opt.value } });
        if (opt.value === state.groupBy) el.selected = true;
    }

    // Sort-by selector
    const sortLabel = controlsRow.createEl('span', { text: 'Sort:', cls: 'sidekick-convlist-label' });
    const sortSelect = controlsRow.createEl('select', { cls: 'sidekick-convlist-select' });
    for (const opt of [
        { value: 'date', label: 'Date' },
        { value: 'title', label: 'Title' },
        { value: 'size', label: 'Messages' },
    ]) {
        const el = sortSelect.createEl('option', { text: opt.label, attr: { value: opt.value } });
        if (opt.value === state.sortBy) el.selected = true;
    }

    // Sort direction toggle
    const dirBtn = controlsRow.createEl('button', {
        cls: 'sidekick-convlist-dir-btn',
        attr: { title: state.sortDir === 'asc' ? 'Ascending' : 'Descending' },
    });
    setIcon(dirBtn, state.sortDir === 'asc' ? 'arrow-up' : 'arrow-down');

    // Count label (at right of controls)
    const countEl = controlsRow.createEl('span', { cls: 'sidekick-convlist-count' });


    const renderItems = () => {
        listEl.empty();

        // Apply search + sort + grouping
        let filtered = filterConversations(conversations, state.searchQuery);
        filtered = sortConversations(filtered, state.sortBy, state.sortDir);
        const groups = groupConversations(filtered, state.groupBy, state.collections);

        countEl.textContent = `${filtered.length} / ${conversations.length}`;

        if (filtered.length === 0) {
            const emptyEl = listEl.createDiv({ cls: 'sidekick-convlist-empty' });
            if (state.searchQuery) {
                emptyEl.createEl('div', { cls: 'sidekick-convlist-empty-icon', text: '🔍' });
                emptyEl.createEl('div', { cls: 'sidekick-convlist-empty-title', text: 'No matching conversations' });
                emptyEl.createEl('div', { cls: 'sidekick-convlist-empty-hint', text: 'Try a different search term' });
            } else {
                emptyEl.createEl('div', { cls: 'sidekick-convlist-empty-icon', text: '💬' });
                emptyEl.createEl('div', { cls: 'sidekick-convlist-empty-title', text: 'No conversations yet' });
                emptyEl.createEl('div', { cls: 'sidekick-convlist-empty-hint', text: 'Start a new chat to begin' });
            }
            return;
        }

        for (const group of groups) {
            const section = listEl.createDiv({ cls: 'sidekick-conv-section' });
            section.createEl('div', { text: group.label, cls: 'sidekick-conv-section-header' });

            const visibleCount = Math.min(group.initialLimit, group.conversations.length);
            const hasMore = group.conversations.length > visibleCount;

            for (let i = 0; i < visibleCount; i++) {
                renderConversationItem(section, group.conversations[i], activeId, callbacks);
            }

            if (hasMore) {
                const remaining = group.conversations.length - visibleCount;
                const moreBtn = section.createEl('button', {
                    text: `Show ${remaining} more…`,
                    cls: 'sidekick-conv-show-more',
                });
                moreBtn.addEventListener('click', () => {
                    moreBtn.remove();
                    for (let i = visibleCount; i < group.conversations.length; i++) {
                        renderConversationItem(section, group.conversations[i], activeId, callbacks);
                    }
                });
            }
        }

        // Scroll to bottom and focus last item
        // Scroll the scrollable parent (container = .sidekick-conversation-list) to bottom
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
            const items = listEl.querySelectorAll('.sidekick-conv-item');
            const lastItem = items[items.length - 1] as HTMLElement | null;
            lastItem?.focus();
        });
    };

    // ── Event handlers ──────────────────────────────────────────
    const emitState = () => { onStateChange?.(state); renderItems(); };

    searchInput.addEventListener('input', () => {
        state.searchQuery = searchInput.value;
        emitState();
    });
    groupSelect.addEventListener('change', () => {
        state.groupBy = groupSelect.value as GroupBy;
        emitState();
    });
    sortSelect.addEventListener('change', () => {
        state.sortBy = sortSelect.value as SortBy;
        emitState();
    });
    dirBtn.addEventListener('click', () => {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        dirBtn.setAttribute('title', state.sortDir === 'asc' ? 'Ascending' : 'Descending');
        setIcon(dirBtn, state.sortDir === 'asc' ? 'arrow-up' : 'arrow-down');
        emitState();
    });

    // Initial render
    renderItems();
    setTimeout(() => searchInput.focus(), 50);
}

// ── Inline rename ───────────────────────────────────────────────────

function startInlineRename(
    titleEl: HTMLElement,
    titlePrefix: string,
    conv: Conversation,
    callbacks: ConversationListCallbacks,
): void {
    // Prevent double-activation
    if (titleEl.querySelector('.sidekick-conv-rename-input')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = conv.title;
    input.className = 'sidekick-conv-rename-input';

    const originalText = titleEl.textContent ?? '';
    titleEl.textContent = '';
    titleEl.appendChild(input);

    let committed = false;

    const commit = () => {
        if (committed) return;
        committed = true;
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== conv.title) {
            callbacks.onRename(conv, newTitle);
        } else {
            titleEl.textContent = originalText;
        }
    };

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); committed = true; titleEl.textContent = originalText; }
    });
    input.addEventListener('blur', () => commit());
    input.addEventListener('click', (e) => e.stopPropagation());

    input.focus();
    input.select();
}

// ── Single conversation item ────────────────────────────────────────

function renderConversationItem(
    parent: HTMLElement,
    conv: Conversation,
    activeId: string | null,
    callbacks: ConversationListCallbacks,
): void {
    const item = parent.createDiv({
        cls: `sidekick-conv-item ${conv.id === activeId ? 'sidekick-conv-active' : ''}`,
        attr: { tabindex: '0', 'data-conv-id': conv.id },
    });

    const info = item.createDiv({ cls: 'sidekick-conv-info' });

    // Title row
    const titleRow = info.createDiv({ cls: 'sidekick-conv-title-row' });
    const titlePrefix = (conv.pinned ? '📌 ' : '') + (conv.iterateSessionPaused ? '⏸ ' : '');
    const titleEl = titleRow.createEl('span', {
        text: titlePrefix + conv.title,
        cls: 'sidekick-conv-title',
    });
    titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineRename(titleEl, titlePrefix, conv, callbacks);
    });

    // Model & provider badges
    const badges = titleRow.createDiv({ cls: 'sidekick-conv-badges' });
    if (conv.model) {
        badges.createEl('span', {
            text: modelLabel(conv.model),
            cls: 'sidekick-conv-badge sidekick-conv-badge-model',
            attr: { title: conv.model },
        });
    }
    if (conv.provider) {
        badges.createEl('span', {
            text: providerLabel(conv.provider),
            cls: 'sidekick-conv-badge sidekick-conv-badge-provider',
        });
    }

    // Preview snippet
    const preview = getPreviewSnippet(conv);
    if (preview) {
        info.createEl('span', {
            text: preview,
            cls: 'sidekick-conv-preview',
        });
    }

    // Meta row
    const metaRow = info.createDiv({ cls: 'sidekick-conv-meta-row' });
    const metaParts = [`${conv.messages.length} msgs`];
    if (conv.usage?.totalCost) metaParts.push(`$${conv.usage.totalCost.toFixed(4)}`);
    metaParts.push(new Date(conv.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    metaRow.createEl('span', {
        text: metaParts.join(' · '),
        cls: 'sidekick-conv-meta',
    });
    metaRow.createEl('span', {
        text: formatTimeAgo(conv.updatedAt),
        cls: 'sidekick-conv-ago',
    });

    // Action buttons
    const actions = item.createDiv({ cls: 'sidekick-conv-actions' });

    const pinBtn = actions.createEl('button', {
        cls: 'sidekick-conv-btn',
        attr: { title: conv.pinned ? 'Unpin' : 'Pin' },
    });
    setIcon(pinBtn, conv.pinned ? 'pin-off' : 'pin');
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        callbacks.onPin(conv);
    });

    const renameBtn = actions.createEl('button', {
        cls: 'sidekick-conv-btn',
        attr: { title: 'Rename' },
    });
    setIcon(renameBtn, 'pencil');
    renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startInlineRename(titleEl, titlePrefix, conv, callbacks);
    });

    // Show "Generate title" button for conversations with default/empty titles
    if (callbacks.onGenerateTitle && (!conv.title || conv.title === 'New Chat') && conv.messages.length >= 2) {
        const genTitleBtn = actions.createEl('button', {
            cls: 'sidekick-conv-btn',
            attr: { title: 'Generate title' },
        });
        setIcon(genTitleBtn, 'sparkles');
        genTitleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            callbacks.onGenerateTitle!(conv);
        });
    }

    const delBtn = actions.createEl('button', {
        cls: 'sidekick-conv-btn sidekick-conv-btn-danger',
        attr: { title: 'Delete' },
    });
    setIcon(delBtn, 'trash-2');
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        callbacks.onDelete(conv);
    });

    item.addEventListener('click', () => callbacks.onSwitch(conv.id));
    item.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            callbacks.onSwitch(conv.id);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            findNextFocusable(item)?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            findPrevFocusable(item)?.focus();
        }
    });
}

/** Find the next focusable conversation item, skipping section headers and buttons. */
function findNextFocusable(el: HTMLElement): HTMLElement | null {
    let next = el.nextElementSibling;
    while (next && !next.classList.contains('sidekick-conv-item')) {
        next = next.nextElementSibling;
    }
    if (next) return next as HTMLElement;
    let section = el.closest('.sidekick-conv-section')?.nextElementSibling;
    while (section) {
        const item = section.querySelector('.sidekick-conv-item');
        if (item) return item as HTMLElement;
        section = section.nextElementSibling;
    }
    return null;
}

/** Find the previous focusable conversation item. */
function findPrevFocusable(el: HTMLElement): HTMLElement | null {
    let prev = el.previousElementSibling;
    while (prev && !prev.classList.contains('sidekick-conv-item')) {
        prev = prev.previousElementSibling;
    }
    if (prev) return prev as HTMLElement;
    let section = el.closest('.sidekick-conv-section')?.previousElementSibling;
    while (section) {
        const items = section.querySelectorAll('.sidekick-conv-item');
        if (items.length) return items[items.length - 1] as HTMLElement;
        section = section.previousElementSibling;
    }
    return null;
}

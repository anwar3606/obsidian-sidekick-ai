import { setIcon } from 'obsidian';
import type { ModelInfo, PluginSettings } from './types';
import { PROVIDERS } from './constants';
import { fetchProviderModels, categorizeModels } from './providers';
import { formatPrice } from './utils';
import { fuzzyScore } from '../lib/search';
import { PROVIDER_ICONS } from './icons';
import { copilotTokenManager } from './copilot-auth';
export { fuzzyScore } from '../lib/search';

/**
 * Model Picker — full-screen overlay for browsing and selecting AI models.
 *
 * Features: provider tabs, fuzzy search (across name, id, capabilities,
 * context length), capability filters (vision/thinking/image gen/free),
 * collapsible category sections, pricing + context badges.
 */

/**
 * Build a searchable text blob for a model, including all metadata.
 */
function modelSearchText(m: ModelInfo): string {
    const parts = [m.label, m.id];
    if (m.supportsVision) parts.push('vision');
    if (m.supportsThinking) parts.push('thinking reasoning');
    if (m.supportsImageGen) parts.push('image generation imagegen');
    if (m.supportsTools) parts.push('tools functions');
    if (m.context_length) parts.push(`${m.context_length} context`);
    if (m.included) parts.push('included free');
    if (m.multiplier) parts.push(`${m.multiplier}x multiplier`);
    return parts.join(' ');
}

/**
 * Fuzzy-filter and sort models by query. Returns models with positive matches,
 * sorted best-match-first.
 */
export function fuzzyFilterModels(models: ModelInfo[], query: string): ModelInfo[] {
    if (!query.trim()) return [...models];
    const q = query.trim();
    const scored: Array<{ model: ModelInfo; score: number }> = [];
    for (const m of models) {
        const text = modelSearchText(m);
        const s = fuzzyScore(q, text);
        if (s >= 0) scored.push({ model: m, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map(s => s.model);
}

export interface ModelPickerCallbacks {
    /** Called when user selects a model. */
    onSelect(modelId: string): Promise<void>;
    /** Called when user switches provider. */
    onProviderSwitch(providerId: string): Promise<void>;
    /** Get the current settings snapshot. */
    getSettings(): PluginSettings;
}

/** Filter definitions used in the capability filter bar. */
interface FilterDef { key: string; icon: string; label: string }

const COMMON_FILTERS: FilterDef[] = [
    { key: 'vision', icon: '📷', label: 'Vision' },
    { key: 'thinking', icon: '🧠', label: 'Thinking' },
    { key: 'tools', icon: '🔧', label: 'Tools' },
];

/** Provider-specific filter sets. */
function getFiltersForProvider(provider: string): FilterDef[] {
    if (provider === 'copilot') {
        return [
            ...COMMON_FILTERS,
            { key: 'free', icon: '✅', label: 'Included' },
        ];
    }
    return [
        ...COMMON_FILTERS,
        { key: 'imageGen', icon: '🎨', label: 'Image Gen' },
        { key: 'free', icon: '🆓', label: 'Free' },
    ];
}

export class ModelPicker {
    private overlay: HTMLElement;
    private cachedModels: ModelInfo[] = [];
    /** Generation counter to discard stale fetch results on rapid tab switching. */
    private fetchGeneration = 0;
    /** Stored escape handler for cleanup on close. */
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    /** Currently highlighted row index for keyboard navigation. */
    private highlightIndex = -1;
    constructor(overlay: HTMLElement) {
        this.overlay = overlay;
    }

    /** Get the cached model list (used for capability checks during API calls). */
    getCachedModels(): ModelInfo[] {
        return this.cachedModels;
    }

    /** Pre-populate the model cache with fallback models for the given provider. */
    initModels(providerId: string, persistedModels?: ModelInfo[]): void {
        if (persistedModels?.length) {
            this.cachedModels = persistedModels;
        } else if (this.cachedModels.length === 0) {
            const cfg = PROVIDERS[providerId];
            if (cfg) this.cachedModels = cfg.fallbackModels;
        }
    }

    private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

    close(): void {
        this.overlay.style.display = 'none';
        this.overlay.empty();
        this.highlightIndex = -1;
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.clickOutsideHandler) {
            document.removeEventListener('mousedown', this.clickOutsideHandler, true);
            this.clickOutsideHandler = null;
        }
    }

    // ── Public entry ────────────────────────────────────────────────

    async open(callbacks: ModelPickerCallbacks): Promise<void> {
        const s = callbacks.getSettings();
        const provider = s.selectedProvider;
        const cfg = PROVIDERS[provider];
        if (!cfg) return;

        this.overlay.empty();
        this.overlay.style.display = 'flex';

        const panel = this.overlay.createDiv({ cls: 'sidekick-mp-panel' });
        const activeFilters = new Set<string>();

        this.buildHeader(panel, provider, callbacks);
        const searchInput = this.buildSearch(panel);
        this.buildFilterBar(panel, provider, activeFilters, () => { this.highlightIndex = -1; renderList(searchInput.value); });

        const listContainer = panel.createDiv({ cls: 'sidekick-mp-list' });
        const footerCount = this.buildFooter(panel, () => loadModels());

        const renderList = (query: string) => {
            this.renderFilteredList(listContainer, footerCount, query, activeFilters, callbacks);
        };

        const loadModels = async () => {
            const gen = ++this.fetchGeneration;
            listContainer.empty();
            listContainer.createDiv({ cls: 'sidekick-mp-loading', text: 'Loading models...' });
            const currentSettings = callbacks.getSettings();
            let apiKey: string;
            if (provider === 'copilot') {
                try { apiKey = await copilotTokenManager.getSessionToken(); } catch (err: unknown) { console.warn('[Sidekick] Copilot token failed:', err); apiKey = ''; }
            } else {
                apiKey = provider === 'openai'
                    ? currentSettings.openaiApiKey
                    : currentSettings.openrouterApiKey;
            }
            try {
                const models = await fetchProviderModels(currentSettings.selectedProvider, apiKey);
                if (gen !== this.fetchGeneration) return; // stale — discard
                this.cachedModels = models;
            } catch (err: unknown) {
                if (gen !== this.fetchGeneration) return;
                console.warn('[Sidekick] Model fetch failed, using fallbacks:', err);
                this.cachedModels = cfg.fallbackModels;
            }
            renderList('');
        };

        searchInput.addEventListener('input', () => { this.highlightIndex = -1; renderList(searchInput.value); });
        this.bindCloseHandlers(listContainer, callbacks);

        if (this.cachedModels.length > 0) {
            renderList('');
        } else {
            await loadModels();
        }
    }

    // ── UI builders ─────────────────────────────────────────────────

    private buildHeader(panel: HTMLElement, provider: string, callbacks: ModelPickerCallbacks): void {
        const mpHeader = panel.createDiv({ cls: 'sidekick-mp-header' });
        const providerTabs = mpHeader.createDiv({ cls: 'sidekick-mp-tabs' });

        for (const pid of Object.keys(PROVIDERS)) {
            const pcfg = PROVIDERS[pid];
            if (!pcfg) continue;
            const tab = providerTabs.createEl('button', {
                cls: `sidekick-mp-tab${pid === provider ? ' sidekick-mp-tab-active' : ''}`,
            });
            const tabIconStr = PROVIDER_ICONS[pid];
            if (tabIconStr) {
                const tabIcon = tab.createSpan({ cls: 'sidekick-mp-tab-icon' });
                tabIcon.innerHTML = tabIconStr;
            }
            tab.createSpan({ text: pcfg.label });
            tab.addEventListener('click', async () => {
                await callbacks.onProviderSwitch(pid);
                this.cachedModels = [];
                this.close();
                this.open(callbacks);
            });
        }

        const closeBtn = mpHeader.createEl('button', { cls: 'sidekick-mp-close' });
        setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => this.close());
    }

    private buildSearch(panel: HTMLElement): HTMLInputElement {
        const searchInput = panel.createEl('input', {
            cls: 'sidekick-mp-search',
            attr: { placeholder: 'Search models, capabilities, context...', type: 'text' },
        });
        setTimeout(() => searchInput.focus(), 50);
        return searchInput;
    }

    private buildFilterBar(
        panel: HTMLElement,
        provider: string,
        activeFilters: Set<string>,
        onFilterChange: () => void,
    ): void {
        const filterBar = panel.createDiv({ cls: 'sidekick-mp-filters' });
        const filters = getFiltersForProvider(provider);

        for (const fd of filters) {
            const btn = filterBar.createEl('button', {
                cls: 'sidekick-mp-filter-btn',
                attr: { title: fd.label },
            });
            btn.createSpan({ text: fd.icon });
            btn.createSpan({ text: ` ${fd.label}` });
            btn.addEventListener('click', () => {
                if (activeFilters.has(fd.key)) {
                    activeFilters.delete(fd.key);
                    btn.classList.remove('sidekick-mp-filter-active');
                } else {
                    activeFilters.add(fd.key);
                    btn.classList.add('sidekick-mp-filter-active');
                }
                onFilterChange();
            });
        }
    }

    private buildFooter(panel: HTMLElement, onRefresh: () => void): HTMLSpanElement {
        const footer = panel.createDiv({ cls: 'sidekick-mp-footer' });
        const footerCount = footer.createSpan({ cls: 'sidekick-mp-count' });

        const expandAllBtn = footer.createEl('button', { cls: 'sidekick-mp-refresh' });
        setIcon(expandAllBtn, 'chevrons-down-up');
        expandAllBtn.createSpan({ text: ' Toggle All' });
        expandAllBtn.addEventListener('click', () => {
            const sections = panel.querySelectorAll('.sidekick-mp-section-body');
            const chevrons = panel.querySelectorAll('.sidekick-mp-section-chevron');
            // Expand all if any are collapsed, otherwise collapse all
            const anyCollapsed = Array.from(sections).some(s => (s as HTMLElement).style.display === 'none');
            sections.forEach((s, i) => {
                (s as HTMLElement).style.display = anyCollapsed ? '' : 'none';
                if (chevrons[i]) setIcon(chevrons[i] as HTMLElement, anyCollapsed ? 'chevron-down' : 'chevron-right');
            });
        });

        const refreshBtn = footer.createEl('button', { cls: 'sidekick-mp-refresh' });
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.createSpan({ text: ' Refresh' });
        refreshBtn.addEventListener('click', onRefresh);
        return footerCount;
    }

    private bindCloseHandlers(listContainer: HTMLElement, callbacks: ModelPickerCallbacks): void {
        // Click outside to close (dropdown mode)
        this.clickOutsideHandler = (e: MouseEvent) => {
            if (!this.overlay.contains(e.target as Node)) this.close();
        };
        // Use setTimeout to avoid immediately closing from the button click that opened it
        setTimeout(() => {
            if (this.clickOutsideHandler) {
                document.addEventListener('mousedown', this.clickOutsideHandler, true);
            }
        }, 50);

        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { this.close(); return; }

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const rows = listContainer.querySelectorAll('.sidekick-mp-row');
                if (rows.length === 0) return;

                // Remove previous highlight
                if (this.highlightIndex >= 0 && this.highlightIndex < rows.length) {
                    rows[this.highlightIndex].classList.remove('sidekick-mp-row-highlight');
                }

                // Move index
                if (e.key === 'ArrowDown') {
                    this.highlightIndex = this.highlightIndex < rows.length - 1 ? this.highlightIndex + 1 : 0;
                } else {
                    this.highlightIndex = this.highlightIndex > 0 ? this.highlightIndex - 1 : rows.length - 1;
                }

                // Apply highlight and scroll into view
                const row = rows[this.highlightIndex] as HTMLElement;
                row.classList.add('sidekick-mp-row-highlight');
                row.scrollIntoView({ block: 'nearest' });
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                const rows = listContainer.querySelectorAll('.sidekick-mp-row');
                if (this.highlightIndex >= 0 && this.highlightIndex < rows.length) {
                    (rows[this.highlightIndex] as HTMLElement).click();
                }
                return;
            }
        };
        document.addEventListener('keydown', this.keyHandler);
    }

    // ── Render logic ────────────────────────────────────────────────

    private renderFilteredList(
        listContainer: HTMLElement,
        footerCount: HTMLElement,
        query: string,
        activeFilters: Set<string>,
        callbacks: ModelPickerCallbacks,
    ): void {
        listContainer.empty();
        const q = query.trim();
        const currentSettings = callbacks.getSettings();

        let filtered = fuzzyFilterModels(this.cachedModels, q);

        filtered = this.applyCapabilityFilters(filtered, activeFilters);

        const hasFilters = q || activeFilters.size > 0;
        const categorized = categorizeModels(currentSettings.selectedProvider, filtered);
        footerCount.textContent = `${filtered.length} / ${this.cachedModels.length} models`;

        if (filtered.length === 0) {
            listContainer.createDiv({ cls: 'sidekick-mp-empty', text: 'No matching models' });
            return;
        }

        // Render "Recently Used" section at the top (only when not filtering/searching)
        if (!hasFilters && currentSettings.recentModels?.length) {
            const recentIds = new Set(currentSettings.recentModels);
            const recentModels = currentSettings.recentModels
                .map(id => filtered.find(m => m.id === id))
                .filter((m): m is ModelInfo => !!m);
            if (recentModels.length > 0) {
                this.renderCategorySection(listContainer, '⏱ Recently Used', recentModels, true, currentSettings, callbacks);
            }
        }

        for (const [group, models] of Object.entries(categorized)) {
            this.renderCategorySection(listContainer, group, models, !!hasFilters, currentSettings, callbacks);
        }
    }

    private applyCapabilityFilters(models: ModelInfo[], activeFilters: Set<string>): ModelInfo[] {
        let filtered = models;
        if (activeFilters.has('vision')) filtered = filtered.filter(m => m.supportsVision);
        if (activeFilters.has('thinking')) filtered = filtered.filter(m => m.supportsThinking);
        if (activeFilters.has('tools')) filtered = filtered.filter(m => m.supportsTools);
        if (activeFilters.has('imageGen')) filtered = filtered.filter(m => m.supportsImageGen);
        if (activeFilters.has('free')) {
            filtered = filtered.filter(m => {
                if (m.included) return true;
                if (!m.pricing) return false;
                const p = m.pricing as { prompt?: string; completion?: string };
                return parseFloat(p.prompt || '0') === 0 && parseFloat(p.completion || '0') === 0;
            });
        }
        return filtered;
    }

    private renderCategorySection(
        container: HTMLElement,
        group: string,
        models: ModelInfo[],
        expandByDefault: boolean,
        settings: PluginSettings,
        callbacks: ModelPickerCallbacks,
    ): void {
        const section = container.createDiv({ cls: 'sidekick-mp-section' });
        const sectionHeader = section.createDiv({ cls: 'sidekick-mp-section-header' });
        const chevron = sectionHeader.createSpan({ cls: 'sidekick-mp-section-chevron' });
        setIcon(chevron, expandByDefault ? 'chevron-down' : 'chevron-right');
        sectionHeader.createSpan({ text: group });
        sectionHeader.createSpan({ text: ` (${models.length})`, cls: 'sidekick-mp-section-count' });

        const sectionBody = section.createDiv({ cls: 'sidekick-mp-section-body' });
        if (!expandByDefault) sectionBody.style.display = 'none';

        sectionHeader.addEventListener('click', () => {
            const visible = sectionBody.style.display !== 'none';
            sectionBody.style.display = visible ? 'none' : '';
            setIcon(chevron, visible ? 'chevron-right' : 'chevron-down');
        });

        for (const model of models) {
            this.renderModelRow(sectionBody, model, settings, callbacks);
        }
    }

    private renderModelRow(
        container: HTMLElement,
        model: ModelInfo,
        settings: PluginSettings,
        callbacks: ModelPickerCallbacks,
    ): void {
        const isSelected = model.id === settings.selectedModel;
        const row = container.createDiv({
            cls: `sidekick-mp-row${isSelected ? ' sidekick-mp-row-selected' : ''}`,
        });

        row.addEventListener('click', async () => {
            await callbacks.onSelect(model.id);
            this.close();
        });

        // Left: dot + name
        const rowLeft = row.createDiv({ cls: 'sidekick-mp-row-left' });
        rowLeft.createSpan({ cls: `sidekick-mp-dot${isSelected ? ' sidekick-mp-dot-active' : ''}` });
        rowLeft.createSpan({ text: model.label, cls: 'sidekick-mp-name' });

        // Show model ID when it differs from the label for disambiguation
        if (model.id !== model.label) {
            rowLeft.createSpan({ text: model.id, cls: 'sidekick-mp-id' });
        }

        // Right: capability badges + pricing + context
        const rowRight = row.createDiv({ cls: 'sidekick-mp-row-right' });
        this.renderCapabilityBadges(rowRight, model);
        this.renderContextBadge(rowRight, model);
        this.renderPricingBadge(rowRight, model);
    }

    private renderCapabilityBadges(container: HTMLElement, model: ModelInfo): void {
        const badges: Array<{ emoji: string; title: string; show: boolean }> = [
            { emoji: '📷', title: 'Vision', show: !!model.supportsVision },
            { emoji: '🧠', title: 'Thinking / Reasoning', show: !!model.supportsThinking },
            { emoji: '🎨', title: 'Image Generation', show: !!model.supportsImageGen },
            { emoji: '🔧', title: 'Tool / Function Calling', show: !!model.supportsTools },
        ];

        // Wrap capability emojis in a fixed-width container for column alignment
        const capsWrap = container.createDiv({ cls: 'sidekick-mp-caps' });
        for (const { emoji, title, show } of badges) {
            capsWrap.createSpan({
                text: emoji,
                cls: show ? 'sidekick-mp-badge' : 'sidekick-mp-badge sidekick-mp-badge-hidden',
                attr: { title: show ? title : '' },
            });
        }

        // Copilot multiplier badge (fixed-width for alignment)
        if (model.multiplier !== undefined) {
            const text = model.included ? '✅ Included' : `${model.multiplier}×`;
            const cls = model.included ? 'sidekick-mp-badge sidekick-mp-multiplier sidekick-mp-badge-included' : 'sidekick-mp-badge sidekick-mp-multiplier sidekick-mp-badge-multiplier';
            container.createSpan({ text, cls, attr: { title: model.included ? 'Included with Copilot plan' : `Uses ${model.multiplier}× request(s)` } });
        }
    }

    private renderContextBadge(container: HTMLElement, model: ModelInfo): void {
        if (!model.context_length) {
            // Invisible placeholder to preserve column alignment
            container.createSpan({ text: '—', cls: 'sidekick-mp-ctx-placeholder' });
            return;
        }
        const ctx = model.context_length >= 1_000_000
            ? `${(model.context_length / 1_000_000).toFixed(1)}M`
            : `${Math.round(model.context_length / 1_000)}K`;
        container.createSpan({ text: ctx, cls: 'sidekick-mp-ctx', attr: { title: 'Context window' } });
    }

    private renderPricingBadge(container: HTMLElement, model: ModelInfo): void {
        if (!model.pricing) {
            // Invisible placeholder to preserve column alignment
            container.createSpan({ text: '—', cls: 'sidekick-mp-price-placeholder' });
            return;
        }
        const p = model.pricing as { prompt?: string; completion?: string };
        const pIn = parseFloat(p.prompt || '0') * 1_000_000;
        const pOut = parseFloat(p.completion || '0') * 1_000_000;
        const priceText = pIn === 0 && pOut === 0 ? 'Free' : `$${formatPrice(pIn)}/$${formatPrice(pOut)}`;
        container.createSpan({ text: priceText, cls: 'sidekick-mp-price', attr: { title: 'Input / Output per 1M tokens' } });
    }
}

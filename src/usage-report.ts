import { Modal, App } from 'obsidian';
import type { Conversation } from './types';
import { computeUsageReport, formatCost, formatTokens } from '../lib/usage-stats';
import type { ProviderReport, UsageReport } from '../lib/usage-stats';

/**
 * Modal showing per-provider usage reports.
 * Scans all conversations and aggregates stats.
 */
export class UsageReportModal extends Modal {
    private conversations: Conversation[];
    private providerLabels: Map<string, string>;

    constructor(app: App, conversations: Conversation[], providerLabels?: Map<string, string>) {
        super(app);
        this.conversations = conversations;
        this.providerLabels = providerLabels || new Map([
            ['copilot', 'GitHub Copilot'],
            ['openrouter', 'OpenRouter'],
            ['openai', 'OpenAI'],
        ]);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('sidekick-usage-report');

        const report = computeUsageReport(this.conversations);

        // Header
        contentEl.createEl('h2', { text: 'Usage Report' });

        // Summary bar
        const summary = contentEl.createDiv({ cls: 'sidekick-usage-summary' });
        this.renderStat(summary, 'Conversations', report.totalConversations.toString());
        this.renderStat(summary, 'Total Tokens', formatTokens(report.totalTokens));
        if (report.totalCost > 0) {
            this.renderStat(summary, 'Total Cost', formatCost(report.totalCost));
        }

        if (report.providers.length === 0) {
            contentEl.createEl('p', { text: 'No conversations found.', cls: 'sidekick-usage-empty' });
            return;
        }

        // Provider cards
        for (const prov of report.providers) {
            this.renderProviderCard(contentEl, prov);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderStat(container: HTMLElement, label: string, value: string): void {
        const stat = container.createDiv({ cls: 'sidekick-usage-stat' });
        stat.createDiv({ cls: 'sidekick-usage-stat-value', text: value });
        stat.createDiv({ cls: 'sidekick-usage-stat-label', text: label });
    }

    private renderProviderCard(container: HTMLElement, prov: ProviderReport): void {
        const card = container.createDiv({ cls: 'sidekick-usage-card' });
        const label = this.providerLabels.get(prov.provider) || prov.provider;

        // Provider header
        card.createEl('h3', { text: label });

        // Stats grid
        const grid = card.createDiv({ cls: 'sidekick-usage-grid' });
        this.renderGridRow(grid, 'Conversations', prov.conversations.toString());
        this.renderGridRow(grid, 'API Rounds', prov.apiRounds.toString());
        this.renderGridRow(grid, 'Tool Calls', prov.toolCalls.toString());
        this.renderGridRow(grid, 'Prompt Tokens', formatTokens(prov.tokensPrompt));
        this.renderGridRow(grid, 'Completion Tokens', formatTokens(prov.tokensCompletion));
        this.renderGridRow(grid, 'Total Tokens', formatTokens(prov.tokensPrompt + prov.tokensCompletion));
        if (prov.totalCost > 0) {
            this.renderGridRow(grid, 'Total Cost', formatCost(prov.totalCost));
        }

        // Date range
        if (prov.firstUsed && prov.lastUsed) {
            const fmt = (ts: number) => new Date(ts).toLocaleDateString();
            this.renderGridRow(grid, 'Period', `${fmt(prov.firstUsed)} — ${fmt(prov.lastUsed)}`);
        }

        // Model breakdown
        if (prov.models.length > 0) {
            const toggle = card.createEl('details', { cls: 'sidekick-usage-models' });
            toggle.createEl('summary', { text: `By Model (${prov.models.length})` });
            const table = toggle.createEl('table');
            const thead = table.createEl('thead');
            const headerRow = thead.createEl('tr');
            for (const h of ['Model', 'Chats', 'Tokens', 'Cost']) {
                headerRow.createEl('th', { text: h });
            }
            const tbody = table.createEl('tbody');
            for (const m of prov.models) {
                const row = tbody.createEl('tr');
                row.createEl('td', { text: m.model || '(unknown)', cls: 'sidekick-usage-model-name' });
                row.createEl('td', { text: m.conversations.toString() });
                row.createEl('td', { text: formatTokens(m.tokensPrompt + m.tokensCompletion) });
                row.createEl('td', { text: m.totalCost > 0 ? formatCost(m.totalCost) : '—' });
            }
        }
    }

    private renderGridRow(grid: HTMLElement, label: string, value: string): void {
        grid.createSpan({ cls: 'sidekick-usage-grid-label', text: label });
        grid.createSpan({ cls: 'sidekick-usage-grid-value', text: value });
    }
}

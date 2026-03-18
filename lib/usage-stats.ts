/**
 * Pure usage stats aggregation — zero Obsidian dependency.
 *
 * Scans conversation metadata and computes per-provider usage reports.
 */

import type { ConversationData, ConversationUsage } from './conversation';

// ── Types ───────────────────────────────────────────────────────────

export interface ModelStats {
    model: string;
    conversations: number;
    tokensPrompt: number;
    tokensCompletion: number;
    totalCost: number;
    toolCalls: number;
    apiRounds: number;
}

export interface ProviderReport {
    provider: string;
    conversations: number;
    tokensPrompt: number;
    tokensCompletion: number;
    totalCost: number;
    toolCalls: number;
    apiRounds: number;
    models: ModelStats[];
    /** Earliest conversation timestamp. */
    firstUsed: number;
    /** Latest conversation timestamp. */
    lastUsed: number;
}

export interface UsageReport {
    providers: ProviderReport[];
    totalConversations: number;
    totalCost: number;
    totalTokens: number;
}

// ── Aggregation ─────────────────────────────────────────────────────

/**
 * Compute per-provider usage reports from conversation metadata.
 * Accepts minimal conversation data — only needs frontmatter fields, not full message content.
 */
export function computeUsageReport(
    conversations: ReadonlyArray<Pick<ConversationData, 'provider' | 'model' | 'createdAt' | 'updatedAt' | 'usage'>>,
): UsageReport {
    const providerMap = new Map<string, {
        conversations: number;
        tokensPrompt: number;
        tokensCompletion: number;
        totalCost: number;
        toolCalls: number;
        apiRounds: number;
        firstUsed: number;
        lastUsed: number;
        models: Map<string, ModelStats>;
    }>();

    for (const conv of conversations) {
        const usage: ConversationUsage = conv.usage || { tokensPrompt: 0, tokensCompletion: 0, totalCost: 0, toolCalls: 0, apiRounds: 0 };

        let prov = providerMap.get(conv.provider);
        if (!prov) {
            prov = {
                conversations: 0,
                tokensPrompt: 0,
                tokensCompletion: 0,
                totalCost: 0,
                toolCalls: 0,
                apiRounds: 0,
                firstUsed: conv.createdAt,
                lastUsed: conv.updatedAt,
                models: new Map(),
            };
            providerMap.set(conv.provider, prov);
        }

        prov.conversations++;
        prov.tokensPrompt += usage.tokensPrompt;
        prov.tokensCompletion += usage.tokensCompletion;
        prov.totalCost += usage.totalCost;
        prov.toolCalls += usage.toolCalls;
        prov.apiRounds += usage.apiRounds;
        if (conv.createdAt < prov.firstUsed) prov.firstUsed = conv.createdAt;
        if (conv.updatedAt > prov.lastUsed) prov.lastUsed = conv.updatedAt;

        // Per-model stats
        let modelStat = prov.models.get(conv.model);
        if (!modelStat) {
            modelStat = { model: conv.model, conversations: 0, tokensPrompt: 0, tokensCompletion: 0, totalCost: 0, toolCalls: 0, apiRounds: 0 };
            prov.models.set(conv.model, modelStat);
        }
        modelStat.conversations++;
        modelStat.tokensPrompt += usage.tokensPrompt;
        modelStat.tokensCompletion += usage.tokensCompletion;
        modelStat.totalCost += usage.totalCost;
        modelStat.toolCalls += usage.toolCalls;
        modelStat.apiRounds += usage.apiRounds;
    }

    const providers: ProviderReport[] = [];
    let totalCost = 0;
    let totalTokens = 0;

    for (const [provider, data] of providerMap) {
        const models = Array.from(data.models.values()).sort((a, b) => b.conversations - a.conversations);
        providers.push({
            provider,
            conversations: data.conversations,
            tokensPrompt: data.tokensPrompt,
            tokensCompletion: data.tokensCompletion,
            totalCost: data.totalCost,
            toolCalls: data.toolCalls,
            apiRounds: data.apiRounds,
            models,
            firstUsed: data.firstUsed,
            lastUsed: data.lastUsed,
        });
        totalCost += data.totalCost;
        totalTokens += data.tokensPrompt + data.tokensCompletion;
    }

    providers.sort((a, b) => b.conversations - a.conversations);

    return {
        providers,
        totalConversations: conversations.length,
        totalCost,
        totalTokens,
    };
}

// ── Formatting helpers ──────────────────────────────────────────────

export function formatCost(cost: number): string {
    if (cost === 0) return '—';
    if (cost < 0.01) return `$${cost.toFixed(6)}`;
    if (cost < 1) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
    if (tokens === 0) return '0';
    if (tokens < 1000) return tokens.toLocaleString();
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1_000_000).toFixed(2)}M`;
}

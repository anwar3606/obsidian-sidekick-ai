import { describe, it, expect } from 'vitest';
import { computeUsageReport, formatCost, formatTokens } from '../lib/usage-stats';

describe('lib/usage-stats', () => {
    describe('computeUsageReport', () => {
        it('returns empty report for no conversations', () => {
            const report = computeUsageReport([]);
            expect(report.totalConversations).toBe(0);
            expect(report.totalCost).toBe(0);
            expect(report.totalTokens).toBe(0);
            expect(report.providers).toHaveLength(0);
        });

        it('aggregates single provider', () => {
            const report = computeUsageReport([
                {
                    provider: 'copilot',
                    model: 'gpt-4o',
                    createdAt: 1000,
                    updatedAt: 2000,
                    usage: { tokensPrompt: 100, tokensCompletion: 50, totalCost: 0, toolCalls: 3, apiRounds: 2 },
                },
                {
                    provider: 'copilot',
                    model: 'gpt-4o',
                    createdAt: 3000,
                    updatedAt: 4000,
                    usage: { tokensPrompt: 200, tokensCompletion: 80, totalCost: 0, toolCalls: 1, apiRounds: 1 },
                },
            ]);

            expect(report.totalConversations).toBe(2);
            expect(report.providers).toHaveLength(1);
            const prov = report.providers[0];
            expect(prov.provider).toBe('copilot');
            expect(prov.conversations).toBe(2);
            expect(prov.tokensPrompt).toBe(300);
            expect(prov.tokensCompletion).toBe(130);
            expect(prov.toolCalls).toBe(4);
            expect(prov.apiRounds).toBe(3);
            expect(prov.firstUsed).toBe(1000);
            expect(prov.lastUsed).toBe(4000);
        });

        it('aggregates multiple providers', () => {
            const report = computeUsageReport([
                {
                    provider: 'copilot',
                    model: 'gpt-4o',
                    createdAt: 1000,
                    updatedAt: 2000,
                    usage: { tokensPrompt: 100, tokensCompletion: 50, totalCost: 0, toolCalls: 0, apiRounds: 1 },
                },
                {
                    provider: 'openrouter',
                    model: 'claude-sonnet-4-20250514',
                    createdAt: 3000,
                    updatedAt: 4000,
                    usage: { tokensPrompt: 500, tokensCompletion: 200, totalCost: 0.05, toolCalls: 5, apiRounds: 3 },
                },
            ]);

            expect(report.providers).toHaveLength(2);
            expect(report.totalConversations).toBe(2);
            expect(report.totalCost).toBe(0.05);
            expect(report.totalTokens).toBe(850);
        });

        it('computes per-model breakdown', () => {
            const report = computeUsageReport([
                {
                    provider: 'copilot',
                    model: 'gpt-4o',
                    createdAt: 1000,
                    updatedAt: 2000,
                    usage: { tokensPrompt: 100, tokensCompletion: 50, totalCost: 0, toolCalls: 0, apiRounds: 1 },
                },
                {
                    provider: 'copilot',
                    model: 'claude-sonnet-4-20250514',
                    createdAt: 3000,
                    updatedAt: 4000,
                    usage: { tokensPrompt: 200, tokensCompletion: 100, totalCost: 0, toolCalls: 2, apiRounds: 1 },
                },
                {
                    provider: 'copilot',
                    model: 'gpt-4o',
                    createdAt: 5000,
                    updatedAt: 6000,
                    usage: { tokensPrompt: 300, tokensCompletion: 150, totalCost: 0, toolCalls: 1, apiRounds: 2 },
                },
            ]);

            const prov = report.providers[0];
            expect(prov.models).toHaveLength(2);
            // gpt-4o should be first (2 conversations vs 1)
            expect(prov.models[0].model).toBe('gpt-4o');
            expect(prov.models[0].conversations).toBe(2);
            expect(prov.models[0].tokensPrompt).toBe(400);
            expect(prov.models[1].model).toBe('claude-sonnet-4-20250514');
            expect(prov.models[1].conversations).toBe(1);
        });

        it('handles conversations without usage data', () => {
            const report = computeUsageReport([
                {
                    provider: 'copilot',
                    model: 'gpt-4o',
                    createdAt: 1000,
                    updatedAt: 2000,
                    usage: undefined,
                },
            ]);

            expect(report.totalConversations).toBe(1);
            const prov = report.providers[0];
            expect(prov.tokensPrompt).toBe(0);
            expect(prov.tokensCompletion).toBe(0);
            expect(prov.conversations).toBe(1);
        });

        it('sorts providers by conversation count descending', () => {
            const report = computeUsageReport([
                { provider: 'openai', model: 'gpt-4', createdAt: 1, updatedAt: 2, usage: undefined },
                { provider: 'copilot', model: 'gpt-4o', createdAt: 1, updatedAt: 2, usage: undefined },
                { provider: 'copilot', model: 'gpt-4o', createdAt: 3, updatedAt: 4, usage: undefined },
                { provider: 'copilot', model: 'gpt-4o', createdAt: 5, updatedAt: 6, usage: undefined },
            ]);

            expect(report.providers[0].provider).toBe('copilot');
            expect(report.providers[0].conversations).toBe(3);
            expect(report.providers[1].provider).toBe('openai');
        });
    });

    describe('formatCost', () => {
        it('returns dash for zero', () => {
            expect(formatCost(0)).toBe('—');
        });

        it('formats tiny costs with 6 decimals', () => {
            expect(formatCost(0.000123)).toBe('$0.000123');
        });

        it('formats small costs with 4 decimals', () => {
            expect(formatCost(0.0512)).toBe('$0.0512');
        });

        it('formats normal costs with 2 decimals', () => {
            expect(formatCost(1.5)).toBe('$1.50');
        });
    });

    describe('formatTokens', () => {
        it('returns 0 for zero', () => {
            expect(formatTokens(0)).toBe('0');
        });

        it('formats small numbers with locale', () => {
            expect(formatTokens(500)).toMatch(/500/);
        });

        it('formats thousands as K', () => {
            expect(formatTokens(5000)).toBe('5.0K');
        });

        it('formats millions as M', () => {
            expect(formatTokens(2_500_000)).toBe('2.50M');
        });
    });
});

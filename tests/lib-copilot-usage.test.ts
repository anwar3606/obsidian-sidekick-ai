/**
 * Unit tests for lib/copilot-usage.ts — quota parsing and formatting.
 */
import { describe, it, expect } from 'vitest';
import { parseCopilotQuota, formatQuotaSummary, COPILOT_INTERNAL_USER_URL, type CopilotQuotaInfo, type CopilotQuotaSnapshot } from '../lib/copilot-usage';

// ── Sample data based on real API response ──────────────────────────

const SAMPLE_API_RESPONSE = {
    login: 'testuser',
    access_type_sku: 'free_educational_quota',
    copilot_plan: 'individual',
    quota_reset_date: '2026-04-01',
    quota_reset_date_utc: '2026-04-01T00:00:00.000Z',
    quota_snapshots: {
        chat: {
            entitlement: 0,
            overage_count: 0,
            overage_permitted: false,
            percent_remaining: 100,
            quota_id: 'chat',
            quota_remaining: 0,
            remaining: 0,
            unlimited: true,
            timestamp_utc: '2026-03-09T04:06:13.526Z',
        },
        completions: {
            entitlement: 0,
            overage_count: 0,
            overage_permitted: false,
            percent_remaining: 100,
            quota_id: 'completions',
            quota_remaining: 0,
            remaining: 0,
            unlimited: true,
            timestamp_utc: '2026-03-09T04:06:13.526Z',
        },
        premium_interactions: {
            entitlement: 300,
            overage_count: 0,
            overage_permitted: true,
            percent_remaining: 48.84,
            quota_id: 'premium_interactions',
            quota_remaining: 146.52,
            remaining: 146,
            unlimited: false,
            timestamp_utc: '2026-03-09T04:06:13.526Z',
        },
    },
};

describe('copilot-usage', () => {
    describe('COPILOT_INTERNAL_USER_URL', () => {
        it('points to the correct endpoint', () => {
            expect(COPILOT_INTERNAL_USER_URL).toBe('https://api.github.com/copilot_internal/user');
        });
    });

    describe('parseCopilotQuota', () => {
        it('parses a full API response correctly', () => {
            const result = parseCopilotQuota(SAMPLE_API_RESPONSE);

            expect(result.login).toBe('testuser');
            expect(result.copilot_plan).toBe('individual');
            expect(result.sku).toBe('free_educational_quota');
            expect(result.quota_reset_date).toBe('2026-04-01');

            // Chat
            expect(result.chat).not.toBeNull();
            expect(result.chat!.unlimited).toBe(true);
            expect(result.chat!.percent_remaining).toBe(100);

            // Completions
            expect(result.completions).not.toBeNull();
            expect(result.completions!.unlimited).toBe(true);

            // Premium
            expect(result.premium).not.toBeNull();
            expect(result.premium!.entitlement).toBe(300);
            expect(result.premium!.remaining).toBe(146);
            expect(result.premium!.percent_remaining).toBe(48.84);
            expect(result.premium!.unlimited).toBe(false);
            expect(result.premium!.overage_permitted).toBe(true);
        });

        it('handles missing quota_snapshots gracefully', () => {
            const result = parseCopilotQuota({
                login: 'nosnaps',
                copilot_plan: 'free',
            });

            expect(result.login).toBe('nosnaps');
            expect(result.chat).toBeNull();
            expect(result.completions).toBeNull();
            expect(result.premium).toBeNull();
            expect(result.quota_reset_date).toBe('');
        });

        it('handles empty response object', () => {
            const result = parseCopilotQuota({});

            expect(result.login).toBe('');
            expect(result.copilot_plan).toBe('');
            expect(result.sku).toBe('');
            expect(result.chat).toBeNull();
            expect(result.premium).toBeNull();
        });

        it('prefers access_type_sku over sku for the sku field', () => {
            const result = parseCopilotQuota({
                access_type_sku: 'pro_plan',
                sku: 'fallback_sku',
            });
            expect(result.sku).toBe('pro_plan');
        });

        it('falls back to sku when access_type_sku is absent', () => {
            const result = parseCopilotQuota({
                sku: 'fallback_sku',
            });
            expect(result.sku).toBe('fallback_sku');
        });
    });

    describe('formatQuotaSummary', () => {
        it('formats a full quota info as human-readable text', () => {
            const quota = parseCopilotQuota(SAMPLE_API_RESPONSE);
            const summary = formatQuotaSummary(quota);

            expect(summary).toContain('Plan: individual');
            expect(summary).toContain('Chat: Included');
            expect(summary).toContain('Completions: Included');
            expect(summary).toContain('Premium requests: 51% used');
            expect(summary).toContain('146/300 remaining');
            expect(summary).toContain('Overage: Allowed');
            expect(summary).toContain('Resets: 2026-04-01');
        });

        it('formats non-unlimited quotas correctly', () => {
            const quota: CopilotQuotaInfo = {
                login: 'test',
                copilot_plan: 'free',
                sku: 'free_tier',
                quota_reset_date: '2026-05-01',
                chat: {
                    quota_id: 'chat',
                    entitlement: 100,
                    overage_count: 0,
                    overage_permitted: false,
                    percent_remaining: 50,
                    quota_remaining: 50,
                    remaining: 50,
                    unlimited: false,
                    timestamp_utc: '',
                },
                completions: null,
                premium: null,
            };

            const summary = formatQuotaSummary(quota);
            expect(summary).toContain('Chat: 50 remaining');
            expect(summary).not.toContain('Completions');
            expect(summary).not.toContain('Premium');
        });

        it('omits overage line when not permitted', () => {
            const quota: CopilotQuotaInfo = {
                login: 'test',
                copilot_plan: 'individual',
                sku: 'pro',
                quota_reset_date: '',
                chat: null,
                completions: null,
                premium: {
                    quota_id: 'premium_interactions',
                    entitlement: 100,
                    overage_count: 0,
                    overage_permitted: false,
                    percent_remaining: 75,
                    quota_remaining: 75,
                    remaining: 75,
                    unlimited: false,
                    timestamp_utc: '',
                },
            };

            const summary = formatQuotaSummary(quota);
            expect(summary).toContain('Premium requests: 25% used');
            expect(summary).not.toContain('Overage');
            expect(summary).not.toContain('Resets');
        });
    });
});

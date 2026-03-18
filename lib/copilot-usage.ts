/**
 * Copilot usage / quota helpers.
 *
 * Zero Obsidian dependency — pure logic only.
 * The actual HTTP calls are made from src/ using Obsidian's requestUrl.
 */

// ── Types ───────────────────────────────────────────────────────────

/** A single quota snapshot returned by the Copilot internal user endpoint. */
export interface CopilotQuotaSnapshot {
    quota_id: string;
    entitlement: number;
    overage_count: number;
    overage_permitted: boolean;
    percent_remaining: number;
    quota_remaining: number;
    remaining: number;
    unlimited: boolean;
    timestamp_utc: string;
}

/** Parsed response from /copilot_internal/user relevant to quota display. */
export interface CopilotQuotaInfo {
    login: string;
    copilot_plan: string;
    sku: string;
    quota_reset_date: string;
    chat: CopilotQuotaSnapshot | null;
    completions: CopilotQuotaSnapshot | null;
    premium: CopilotQuotaSnapshot | null;
}

// ── Parsing ─────────────────────────────────────────────────────────

/** URL for the Copilot internal user endpoint (requires OAuth token). */
export const COPILOT_INTERNAL_USER_URL = 'https://api.github.com/copilot_internal/user';

/**
 * Parse the raw JSON response from /copilot_internal/user into a CopilotQuotaInfo.
 * Throws if the response is missing expected fields.
 */
export function parseCopilotQuota(data: Record<string, any>): CopilotQuotaInfo {
    const snapshots = data.quota_snapshots || {};
    return {
        login: data.login ?? '',
        copilot_plan: data.copilot_plan ?? '',
        sku: data.access_type_sku ?? data.sku ?? '',
        quota_reset_date: data.quota_reset_date ?? '',
        chat: snapshots.chat ?? null,
        completions: snapshots.completions ?? null,
        premium: snapshots.premium_interactions ?? null,
    };
}

/**
 * Build a human-readable summary of quota info for display in a Notice.
 */
export function formatQuotaSummary(q: CopilotQuotaInfo): string {
    const lines: string[] = [];
    lines.push(`Plan: ${q.copilot_plan} (${q.sku})`);

    if (q.chat) {
        lines.push(`Chat: ${q.chat.unlimited ? 'Included' : `${q.chat.remaining} remaining`}`);
    }
    if (q.completions) {
        lines.push(`Completions: ${q.completions.unlimited ? 'Included' : `${q.completions.remaining} remaining`}`);
    }
    if (q.premium) {
        const used = Math.round(100 - q.premium.percent_remaining);
        lines.push(`Premium requests: ${used}% used (${q.premium.remaining}/${q.premium.entitlement} remaining)`);
        if (q.premium.overage_permitted) {
            lines.push(`Overage: Allowed`);
        }
    }

    if (q.quota_reset_date) {
        lines.push(`Resets: ${q.quota_reset_date}`);
    }

    return lines.join('\n');
}

// ── Legacy function (kept for backward compat) ─────────────────────

/**
 * Attempt to fetch Copilot usage limits via the public GitHub API.
 *
 * Note/Warning: Integration tests verify that standard GitHub Copilot SDK tokens (gho_/ghu_)
 * do not have OAuth scopes to access the /settings/billing/usage or /copilot/billing endpoints.
 * This function exists for testing and to gracefully handle the restriction.
 */
export async function fetchCopilotUsage(token: string): Promise<any> {
    // 1. Fetch user login
    const userRes = await fetch('https://api.github.com/user', {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!userRes.ok) {
        throw new Error(`Failed to fetch user context, status: ${userRes.status}`);
    }

    const user = await userRes.json();

    // 2. Attempt to fetch copilot billing (Requires PAT with appropriate scopes usually, not IDE tokens)
    const copilotRes = await fetch(`https://api.github.com/users/${user.login}/copilot/billing`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!copilotRes.ok) {
        throw new Error(`Copilot usage endpoint returned ${copilotRes.status}: Likely unauthorized token scope.`);
    }

    return await copilotRes.json();
}

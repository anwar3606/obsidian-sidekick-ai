import { requestUrl } from 'obsidian';
import { COPILOT_INTERNAL_USER_URL, parseCopilotQuota, type CopilotQuotaInfo } from '../lib/copilot-usage';

/**
 * GitHub Copilot OAuth Device Flow authentication.
 *
 * Flow:
 * 1. Request device code from GitHub
 * 2. User visits verification URL and enters the code
 * 3. Poll GitHub until user authorises → get OAuth token
 * 4. Exchange OAuth token for short-lived Copilot session token
 * 5. CopilotTokenManager caches + auto-refreshes the session token
 */

// ── Constants ───────────────────────────────────────────────────────

/** Official Copilot OAuth client ID (same one used by Copilot CLI). */
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// ── Types ───────────────────────────────────────────────────────────

export interface DeviceFlowResult {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
}

export interface CopilotSessionToken {
    token: string;
    expires_at: number; // Unix timestamp (seconds)
    /** Dynamic API base URL from token exchange (e.g. https://api.individual.githubcopilot.com). */
    apiEndpoint?: string;
}

// ── Device Flow ─────────────────────────────────────────────────────

/** Step 1: Request a device code from GitHub. */
export async function startDeviceFlow(): Promise<DeviceFlowResult> {
    const res = await requestUrl({
        url: GITHUB_DEVICE_CODE_URL,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            client_id: COPILOT_CLIENT_ID,
            scope: 'copilot',
        }),
    });

    if (res.status !== 200) {
        throw new Error(`GitHub device flow failed: ${res.status}`);
    }

    return res.json as DeviceFlowResult;
}

/**
 * Step 2: Poll GitHub until the user authorises.
 * Returns the OAuth access token (gho_...).
 */
export async function pollForToken(
    deviceCode: string,
    interval: number,
    signal?: AbortSignal,
): Promise<string> {
    const pollInterval = Math.max(interval, 5) * 1000; // At least 5s

    while (true) {
        if (signal?.aborted) throw new Error('Authentication cancelled');

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, pollInterval);
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('Authentication cancelled'));
                }, { once: true });
            }
        });

        if (signal?.aborted) throw new Error('Authentication cancelled');

        const res = await requestUrl({
            url: GITHUB_TOKEN_URL,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                client_id: COPILOT_CLIENT_ID,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        });

        const data = res.json;

        if (data.access_token) {
            return data.access_token as string;
        }

        if (data.error === 'authorization_pending') {
            continue; // User hasn't authorised yet
        }

        if (data.error === 'slow_down') {
            // GitHub wants us to slow down — add 5s
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        if (data.error === 'expired_token') {
            throw new Error('Device code expired. Please try signing in again.');
        }

        throw new Error(data.error_description || data.error || 'OAuth poll failed');
    }
}

// ── Session Token Exchange ──────────────────────────────────────────

/**
 * Step 3: Exchange a persistent OAuth token for a short-lived
 * Copilot session token used for API calls.
 */
export async function getCopilotSessionToken(oauthToken: string): Promise<CopilotSessionToken> {
    const res = await requestUrl({
        url: COPILOT_TOKEN_URL,
        headers: {
            Authorization: `token ${oauthToken}`,
            Accept: 'application/json',
        },
    });

    if (res.status !== 200) {
        throw new Error(`Failed to get Copilot session token: ${res.status}`);
    }

    const data = res.json;
    // The token response includes an `endpoints` map with the correct API URL
    // for this user's plan (individual, business, etc). Using this instead of
    // the hardcoded generic endpoint ensures proper billing attribution.
    const apiEndpoint = data.endpoints?.api || undefined;
    return {
        token: data.token,
        expires_at: data.expires_at,
        apiEndpoint,
    };
}

// ── Token Manager ───────────────────────────────────────────────────

/**
 * Manages the Copilot session token lifecycle:
 * - Caches the short-lived session token
 * - Auto-refreshes before expiry (with 5-minute buffer)
 * - Provides ready-to-use headers for API calls
 */
export class CopilotTokenManager {
    private oauthToken: string = '';
    private sessionToken: CopilotSessionToken | null = null;
    private pendingRefresh: Promise<CopilotSessionToken> | null = null;
    /** Dynamic API base URL from the last token exchange. */
    private _apiEndpoint: string | undefined;

    /** Set the persistent OAuth token (stored in settings). */
    setOAuthToken(token: string): void {
        this.oauthToken = token;
        this.sessionToken = null; // Force refresh on next use
    }

    /** Check if we have an OAuth token configured. */
    isAuthenticated(): boolean {
        return !!this.oauthToken;
    }

    /** Clear all tokens (sign out). */
    clear(): void {
        this.oauthToken = '';
        this.sessionToken = null;
        this._apiEndpoint = undefined;
    }

    /** Invalidate the cached session token (e.g. after a 401). Forces re-fetch on next use. */
    invalidateSession(): void {
        this.sessionToken = null;
    }

    /**
     * Get a valid session token, refreshing if needed.
     * Throws if not authenticated.
     */
    async getSessionToken(): Promise<string> {
        if (!this.oauthToken) {
            throw new Error('Not signed in to GitHub Copilot. Please sign in via Settings → API Keys.');
        }

        // Refresh if expired or will expire within 5 minutes
        const now = Math.floor(Date.now() / 1000);
        if (!this.sessionToken || this.sessionToken.expires_at - now < 300) {
            if (!this.pendingRefresh) {
                this.pendingRefresh = getCopilotSessionToken(this.oauthToken)
                    .finally(() => { this.pendingRefresh = null; });
            }
            this.sessionToken = await this.pendingRefresh;
            if (this.sessionToken.apiEndpoint) {
                this._apiEndpoint = this.sessionToken.apiEndpoint;
            }
        }

        return this.sessionToken.token;
    }

    /**
     * Get the dynamic API base URL from the last token exchange.
     * Returns the plan-specific endpoint (e.g. https://api.individual.githubcopilot.com)
     * or undefined if not yet available.
     */
    getApiEndpoint(): string | undefined {
        return this._apiEndpoint;
    }
}

/**
 * Get the active Copilot account's OAuth token from settings.
 * Falls back to legacy copilotToken if no accounts configured.
 */
export function getActiveCopilotOAuthToken(settings: { copilotAccounts: Array<{ id: string; oauthToken: string }>; activeCopilotAccountId: string; copilotToken: string }): string {
    const active = settings.copilotAccounts.find(a => a.id === settings.activeCopilotAccountId);
    return active?.oauthToken ?? settings.copilotToken;
}

// ── Singleton instance ──────────────────────────────────────────────

export const copilotTokenManager = new CopilotTokenManager();

// ── Quota fetch ─────────────────────────────────────────────────────

/**
 * Fetch Copilot quota/usage info using the OAuth token.
 * Uses the /copilot_internal/user endpoint which returns quota_snapshots.
 */
export async function fetchCopilotQuotaInfo(oauthToken: string): Promise<CopilotQuotaInfo> {
    const res = await requestUrl({
        url: COPILOT_INTERNAL_USER_URL,
        headers: {
            Authorization: `token ${oauthToken}`,
            Accept: 'application/json',
            'User-Agent': 'GitHubCopilotChat/0.37.0',
            'Editor-Version': 'vscode/1.109.5',
            'Editor-Plugin-Version': 'copilot-chat/0.37.0',
        },
    });

    if (res.status !== 200) {
        throw new Error(`Failed to fetch Copilot quota: ${res.status}`);
    }

    return parseCopilotQuota(res.json);
}

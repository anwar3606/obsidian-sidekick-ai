import { requestUrl } from 'obsidian';
import type { AutocompleteSettings } from './types';
import { PROVIDERS, AUTOCOMPLETE_SYSTEM_PROMPT } from './constants';
import { copilotTokenManager } from './copilot-auth';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';

// ── Re-export pure helpers from lib/ (single source of truth) ──
export { buildCompletionContext, buildCompletionPrompt, cleanCompletion, getNextWordBoundary, getFirstLine } from '../lib/autocomplete';
export type { CompletionContext } from '../lib/autocomplete';

import { buildCompletionPrompt, cleanCompletion } from '../lib/autocomplete';
import type { CompletionContext } from '../lib/autocomplete';

// ── Types ───────────────────────────────────────────────────────────

export interface CompletionResult {
    text: string;
}

// ── API fetch ───────────────────────────────────────────────────────

/**
 * Resolve the API key or session token for the autocomplete provider.
 */
async function resolveAutocompleteApiKey(providerId: string, apiKey: string): Promise<string> {
    if (providerId === 'copilot') {
        return copilotTokenManager.getSessionToken();
    }
    return apiKey;
}

/**
 * Fetch a completion from the configured LLM provider.
 * Uses non-streaming for simplicity and speed with small responses.
 *
 * @param settings - Auto-completion settings (provider, model, etc.)
 * @param apiKey - The API key for the selected provider
 * @param ctx - The completion context (prefix/suffix text)
 * @param abortSignal - Optional abort signal for cancellation
 * @returns The cleaned completion text, or null if cancelled/failed
 */
export async function fetchCompletion(
    settings: AutocompleteSettings,
    apiKey: string,
    ctx: CompletionContext,
    abortSignal?: AbortSignal,
): Promise<CompletionResult | null> {
    if (!apiKey && settings.provider !== 'copilot') return null;

    const provider = PROVIDERS[settings.provider];
    if (!provider) return null;

    // Check if already aborted
    if (abortSignal?.aborted) return null;

    // Resolve the actual API key (may involve async token exchange for Copilot)
    let resolvedKey: string;
    try {
        resolvedKey = await resolveAutocompleteApiKey(settings.provider, apiKey);
    } catch (err: unknown) {
        debugLog.log('autocomplete', 'API key resolution failed', { provider: settings.provider, error: getErrorMessage(err) });
        return null;
    }

    if (!resolvedKey) return null;

    const userPrompt = buildCompletionPrompt(ctx);

    const systemPrompt = settings.systemPrompt?.trim() || AUTOCOMPLETE_SYSTEM_PROMPT;

    const body = {
        model: settings.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: false,
    };

    try {
        const acStart = Date.now();
        const res = await requestUrl({
            url: provider.url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...provider.headers(resolvedKey),
            },
            body: JSON.stringify(body),
        });

        // Check abort after the request completes
        if (abortSignal?.aborted) return null;

        if (res.status !== 200) {
            debugLog.log('autocomplete', 'API error', { status: res.status, durationMs: Date.now() - acStart });
            return null;
        }

        const data = res.json;
        const content = data?.choices?.[0]?.message?.content;

        if (!content || typeof content !== 'string') return null;

        const cleaned = cleanCompletion(content);
        if (!cleaned) return null;

        debugLog.log('autocomplete', 'Completion received', {
            provider: settings.provider,
            model: settings.model,
            durationMs: Date.now() - acStart,
            resultLength: cleaned.length,
        });

        return { text: cleaned };
    } catch (err: unknown) {
        // Silently ignore aborted requests and network errors
        if (err instanceof Error && err.name === 'AbortError') return null;
        debugLog.log('autocomplete', 'Fetch error', { error: getErrorMessage(err) });
        return null;
    }
}

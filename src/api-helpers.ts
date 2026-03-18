import type { ChatMessage, NoteContext, ApiMessage, ApiContentPart, PluginSettings } from './types';
import { resolveImageForApi } from './image-utils';
import { stripBase64, buildNoteContextMessages } from '../lib/api';
import type { App } from 'obsidian';
import { copilotTokenManager } from './copilot-auth';

/**
 * API request building — pure protocol functions re-exported from lib/,
 * plus Obsidian-dependent helpers for message construction.
 */

// ── Re-export protocol-layer functions from lib/ (single source of truth) ──
export {
    MAX_RETRIES,
    RETRY_DELAY_MS,
    MAX_TOOL_ROUNDS,
    MAX_TOOL_ROUNDS_ITERATE,
    MAX_CONTENT_LENGTH,
    THINKING_BUDGET,
    formatToolArgsPreview,
    formatCleanToolHeader,
    shouldUseResponsesAPI,
    shouldUseMessagesAPI,
    getMessagesApiHeaders,
    convertMessagesForAnthropic,
    stripBase64,
    buildNoteContextMessages,
    convertMessagesForResponses,
    DisplayAccumulator,
    computeContextBreakdown,
    getRequestMessageCount,
    getRequestTemperature,
    getRequestToolCount,
    requestHasTools,
    updateRequestMessages,
    stripRequestParam,
    getRequestDebugInfo,
} from '../lib/api';

export type { ContextBreakdown } from '../lib/api';
export type { AnyRequestBody } from '../lib/types';

// Re-export request builders with the names src/ consumers expect
export {
    buildChatCompletionBody as buildRequestBody,
    buildResponsesBody as buildResponsesRequestBody,
    buildMessagesApiBody as buildMessagesRequestBody,
} from '../lib/api';

// ── Obsidian-dependent helpers (src-only) ───────────────────────────

/**
 * Resolve the API key for the given provider.
 * For Copilot, exchanges the OAuth token for a session token.
 * For other providers, returns the stored API key directly.
 */
export async function resolveApiKey(provider: string, settings: PluginSettings): Promise<string> {
    if (provider === 'copilot') {
        return copilotTokenManager.getSessionToken();
    }
    if (provider === 'openai') return settings.openaiApiKey;
    if (provider === 'openrouter') return settings.openrouterApiKey;
    return '';
}

/**
 * Get the raw API key for a provider (no Copilot token exchange).
 * Prefer resolveApiKey() for actual API calls; this is for non-async contexts.
 */
export function getApiKeyForProvider(provider: string, settings: PluginSettings): string {
    if (provider === 'openai') return settings.openaiApiKey;
    if (provider === 'openrouter') return settings.openrouterApiKey;
    if (provider === 'copilot') {
        const active = settings.copilotAccounts.find(a => a.id === settings.activeCopilotAccountId);
        return active?.oauthToken ?? settings.copilotToken;
    }
    return '';
}

/**
 * Resolve conversation history for the API:
 * - Messages with vault-stored images get resolved to base64 data URLs.
 * - Inline base64 `<img>` tags in text are stripped for payload size.
 */
export async function resolveHistoryForApi(
    app: App,
    history: ChatMessage[],
): Promise<ApiMessage[]> {
    return Promise.all(history.map(async (m): Promise<ApiMessage> => {
        // For assistant messages, prefer cleanContent (no callout formatting) over content
        const messageContent = (m.role === 'assistant' && m.cleanContent) ? m.cleanContent : m.content;
        if (m.images?.length) {
            const resolvedImages = await Promise.all(
                m.images.map(img => resolveImageForApi(app, img)),
            );
            const parts: ApiContentPart[] = [
                ...(messageContent ? [{ type: 'text' as const, text: messageContent }] : []),
                ...resolvedImages.map((img): ApiContentPart => ({ type: 'image_url', image_url: { url: img } })),
            ];
            return { role: m.role, content: parts };
        }
        const base: ApiMessage = { role: m.role, content: stripBase64(messageContent) };
        if (m.tool_calls) base.tool_calls = m.tool_calls;
        if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
        return base;
    }));
}

/**
 * Build the full API messages array: system prompt + note context + resolved history.
 */
export async function buildApiMessages(
    app: App,
    systemPrompt: string,
    attachedNotes: NoteContext[],
    history: ChatMessage[],
): Promise<ApiMessage[]> {
    const noteContext = buildNoteContextMessages(attachedNotes);
    const resolvedHistory = await resolveHistoryForApi(app, history);
    return [
        { role: 'system', content: systemPrompt },
        ...noteContext,
        ...resolvedHistory,
    ];
}

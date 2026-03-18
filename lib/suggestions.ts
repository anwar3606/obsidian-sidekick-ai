/**
 * Follow-up suggestion generation — zero Obsidian dependency.
 *
 * Generates 2-3 suggested follow-up questions based on the assistant's response,
 * giving users quick one-click options to continue the conversation.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface FollowUpSuggestion {
    text: string;
    /** Short label for the chip (≤40 chars). Falls back to truncated text. */
    label: string;
}

// ── Constants ───────────────────────────────────────────────────────

/** Min assistant response length to generate suggestions (skip trivial replies). */
const MIN_RESPONSE_LENGTH = 80;

/** Max suggestions to generate. */
const MAX_SUGGESTIONS = 3;

/** Max label length for chip display. */
const MAX_LABEL_LENGTH = 50;

// ── Suggestion generation ───────────────────────────────────────────

/**
 * Build a prompt that asks the AI to generate follow-up suggestions.
 * Returns messages array suitable for a Chat Completions call.
 */
export function buildFollowUpPromptMessages(
    assistantResponse: string,
    userMessage: string,
    customPrompt?: string,
): Array<{ role: string; content: string }> {
    const defaultPrompt = `You generate 2-3 short follow-up questions that a user might want to ask next, based on an AI assistant's response. Each suggestion should be a natural continuation of the conversation.

Rules:
- Output ONLY a JSON array of strings, no explanation
- Each string is a complete question (5-15 words)
- Questions should be diverse (don't repeat the same angle)
- Questions should be actionable and specific
- Output example: ["How can I optimize this further?", "What are the trade-offs?", "Can you show an example?"]`;
    const systemPrompt = customPrompt?.trim() || defaultPrompt;

    const context = `User asked: ${userMessage.substring(0, 300)}\n\nAssistant replied: ${assistantResponse.substring(0, 500)}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context },
    ];
}

/**
 * Parse the AI response into follow-up suggestions.
 * Handles JSON arrays and also plain text fallback.
 */
export function parseFollowUpResponse(response: string): FollowUpSuggestion[] {
    const trimmed = response.trim();

    // Try JSON array parse
    try {
        // Extract JSON array even if wrapped in markdown code fence
        const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const arr = JSON.parse(jsonMatch[0]);
            if (Array.isArray(arr)) {
                return dedupe(arr
                    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                    .map(s => s.trim()))
                    .slice(0, MAX_SUGGESTIONS)
                    .map(text => ({
                        text,
                        label: truncateLabel(text),
                    }));
            }
        }
    } catch { /* fall through to line-based parsing */ }

    // Fallback: split on newlines, strip numbering/bullets
    const lines = dedupe(trimmed
        .split('\n')
        .map(line => line.replace(/^\d+[.\)]\s*/, '').replace(/^[-•*]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(line => line.length > 5 && line.length < 200));

    return lines.slice(0, MAX_SUGGESTIONS).map(text => ({
        text,
        label: truncateLabel(text),
    }));
}

/**
 * Check whether follow-up suggestions should be generated for this exchange.
 */
export function shouldGenerateSuggestions(
    assistantResponse: string,
    userMessage: string,
): boolean {
    // Skip trivial responses
    if (assistantResponse.length < MIN_RESPONSE_LENGTH) return false;
    // Skip if user message was a command
    if (userMessage.trim().startsWith('/')) return false;
    return true;
}

// ── Helpers ─────────────────────────────────────────────────────────

function truncateLabel(text: string): string {
    if (text.length <= MAX_LABEL_LENGTH) return text;
    return text.substring(0, MAX_LABEL_LENGTH - 1) + '…';
}

function dedupe(items: string[]): string[] {
    const seen = new Set<string>();
    return items.filter(s => {
        const lower = s.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
    });
}

// ── Thinking summary generation ─────────────────────────────────────

/**
 * Build a prompt to generate a concise summary of AI reasoning/thinking content.
 * Returns messages array suitable for a Chat Completions call.
 */
export function buildThinkingSummaryPromptMessages(
    reasoningText: string,
): Array<{ role: string; content: string }> {
    const systemPrompt =
        'Summarize the following AI reasoning in a single short phrase (3-8 words) that captures what the AI was thinking about. ' +
        'Reply with ONLY the phrase — no quotes, no trailing punctuation, no explanation.';
    // Keep context small for speed
    const context = reasoningText.substring(0, 800);
    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context },
    ];
}

/**
 * Parse the AI response into a clean thinking summary string.
 */
export function parseThinkingSummaryResponse(response: string): string {
    let summary = response.trim().replace(/^["']|["']$/g, '').trim();
    summary = summary.split('\n')[0].trim();
    if (summary.endsWith('.')) summary = summary.slice(0, -1);
    if (summary.length > 80) summary = summary.slice(0, 77) + '…';
    return summary || 'Thinking';
}

/** Regex to find thinking callout blocks in accumulated markdown. */
export const THINKING_CALLOUT_RE = /> \[!abstract\][+-] 💭 (.+)\n((?:> .*\n?)+)/g;

/**
 * Extract thinking callout blocks from assistant message content.
 * Returns the summary text and full reasoning for each block.
 */
export function extractThinkingCallouts(content: string): Array<{ summary: string; reasoning: string; fullMatch: string }> {
    const results: Array<{ summary: string; reasoning: string; fullMatch: string }> = [];
    const re = new RegExp(THINKING_CALLOUT_RE.source, THINKING_CALLOUT_RE.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
        results.push({
            summary: m[1],
            reasoning: m[2].replace(/^> /gm, '').trim(),
            fullMatch: m[0],
        });
    }
    return results;
}

/**
 * Replace a thinking callout's summary title in message content.
 * Uses the full match to ensure the correct callout is targeted.
 */
export function replaceThinkingSummary(content: string, oldFullMatch: string, oldSummary: string, newSummary: string): string {
    const newFullMatch = oldFullMatch.replace(`💭 ${oldSummary}`, `💭 ${newSummary}`);
    return content.replace(oldFullMatch, newFullMatch);
}

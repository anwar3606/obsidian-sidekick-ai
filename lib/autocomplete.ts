/**
 * Pure autocomplete helpers — zero Obsidian dependency.
 *
 * Context building, prompt construction, and response cleaning for
 * inline completion suggestions.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface CompletionContext {
    noteTitle: string;
    prefix: string;   // text before cursor
    suffix: string;   // text after cursor
}

// ── Constants ───────────────────────────────────────────────────────

const PREFIX_LINES = 25;
const SUFFIX_LINES = 10;

// ── Context building ────────────────────────────────────────────────

/**
 * Build a completion context from the editor document.
 * Extracts a small window around the cursor for speed and cost efficiency.
 */
export function buildCompletionContext(
    doc: string,
    cursorOffset: number,
    noteTitle: string,
): CompletionContext {
    const before = doc.slice(0, cursorOffset);
    const after = doc.slice(cursorOffset);

    const beforeLines = before.split('\n');
    const prefixLines = beforeLines.slice(-PREFIX_LINES);
    const prefix = prefixLines.join('\n');

    const afterLines = after.split('\n');
    const suffixLines = afterLines.slice(0, SUFFIX_LINES);
    const suffix = suffixLines.join('\n');

    return { noteTitle, prefix, suffix };
}

/**
 * Build the user prompt for the fill-in-the-middle completion.
 * Uses a FIM-style format with <|cursor|> marker so the model
 * understands it must insert text at the cursor position, not
 * append after the block.
 */
export function buildCompletionPrompt(ctx: CompletionContext): string {
    let prompt = '';

    if (ctx.noteTitle) {
        prompt += `[Note: ${ctx.noteTitle}]\n\n`;
    }

    prompt += ctx.prefix + '<|cursor|>';

    if (ctx.suffix.trim()) {
        prompt += ctx.suffix;
    }

    prompt += '\n\n[Insert the most likely continuation at <|cursor|>. Complete the current word, then the rest of the line. Keep it brief and natural.]';

    return prompt;
}

// ── Response cleaning ───────────────────────────────────────────────

/**
 * Clean up the LLM response to extract just the completion text.
 * Removes code fences, excessive whitespace, and caps length.
 * Prioritises completing the current line before extending to new lines.
 */
export function cleanCompletion(raw: string): string {
    let text = raw;

    // Remove markdown code fences if the entire response is wrapped in them
    text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');

    // Strip the cursor marker if the model echoed it back
    text = text.replace(/<\|cursor\|>/g, '');

    // Strip leading newlines — the insertion point is inline, not below
    text = text.replace(/^\n+/, '');

    // Remove leading/trailing whitespace but preserve a single leading space
    const hadLeadingSpace = text.startsWith(' ');
    text = text.trim();
    if (hadLeadingSpace && text.length > 0) {
        text = ' ' + text;
    }

    // Cap at first double-newline (paragraph boundary)
    const paraBreak = text.indexOf('\n\n');
    if (paraBreak > 0) {
        text = text.slice(0, paraBreak);
    }

    // Limit to at most 5 lines to keep suggestions digestible
    const lines = text.split('\n');
    if (lines.length > 5) {
        text = lines.slice(0, 5).join('\n');
    }

    // Hard cap at ~300 characters
    if (text.length > 300) {
        const cutoff = text.lastIndexOf(' ', 300);
        text = text.slice(0, cutoff > 150 ? cutoff : 300);
    }

    return text;
}

// ── Partial acceptance helpers ───────────────────────────────────────

/**
 * Find the index of the next word boundary in the suggestion text.
 * Used for Ctrl+Right partial word acceptance.
 * Skips leading whitespace, then consumes the next word.
 * Handles Unicode (emoji, CJK, accented characters) correctly.
 */
export function getNextWordBoundary(text: string): number {
    if (!text) return 0;

    let i = 0;
    // Skip leading whitespace (but include it in the accepted region)
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) return text.length;

    const firstChar = text[i]!;

    // CJK ideographs: each character is its own "word"
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(firstChar)) {
        return i + 1;
    }

    // Word characters (letters, numbers, underscore — Unicode-aware)
    if (/[\p{L}\p{N}_]/u.test(firstChar)) {
        while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i]!)) i++;
        return i;
    }

    // Everything else (punctuation, symbols, emoji)
    while (i < text.length && !/[\p{L}\p{N}_\s]/u.test(text[i]!)) i++;
    return i;
}

/**
 * Extract the first line from a suggestion.
 * Used for Ctrl+Enter accept-line.
 */
export function getFirstLine(text: string): string {
    const newlineIdx = text.indexOf('\n');
    return newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
}

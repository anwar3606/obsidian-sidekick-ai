import {
    ViewPlugin,
    Decoration,
    WidgetType,
    EditorView,
    type ViewUpdate,
    type DecorationSet,
    keymap,
} from '@codemirror/view';
import {
    StateField,
    StateEffect,
    Transaction,
    Prec,
    type Extension,
} from '@codemirror/state';
import type { AutocompleteSettings, PluginSettings } from './types';
import { buildCompletionContext, fetchCompletion, getNextWordBoundary, getFirstLine } from './autocomplete-provider';
import { debugLog } from './debug-log';

// ── State effects ───────────────────────────────────────────────────

/** Set the current ghost text suggestion. */
const setSuggestion = StateEffect.define<string | null>();

/** Trigger a manual completion request via StateEffect (avoids CM6 internals). */
const triggerCompletion = StateEffect.define<PluginSettings>();

// ── Typing-as-suggested detection ───────────────────────────────────

/**
 * Extract text inserted in a transaction (simple insert only).
 * Returns null if the change is a deletion, replacement, or multi-cursor edit.
 */
function getInsertedText(tr: Transaction): string | null {
    if (!tr.docChanged) return null;
    // Only handle simple user input (typing, not paste/undo/delete)
    const userEvent = tr.annotation(Transaction.userEvent);
    if (!userEvent || !userEvent.startsWith('input')) return null;

    let inserted = '';
    let deletedLength = 0;
    let changeCount = 0;

    tr.changes.iterChanges((_fromA, toA, fromB, _toB, text) => {
        changeCount++;
        deletedLength += toA - _fromA;
        inserted += text.toString();
    });

    // Must be a single change point (no multi-cursor), simple insert (no deletion)
    if (changeCount !== 1 || deletedLength > 0 || !inserted) return null;
    return inserted;
}

/** State field holding the current suggestion text. */
const suggestionField = StateField.define<string | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setSuggestion)) return e.value;
        }

        // On user-initiated document changes, check for typing-as-suggested
        if (tr.docChanged && tr.annotation(Transaction.userEvent)) {
            if (value !== null) {
                const inserted = getInsertedText(tr);
                if (inserted && value.startsWith(inserted)) {
                    // User typed characters matching the start of the suggestion — trim it
                    const remaining = value.slice(inserted.length);
                    return remaining || null;
                }
            }
            return null;
        }

        // Clear on cursor movement (but not on doc changes — handled above)
        if (tr.selection) return null;
        return value;
    },
});

// ── Ghost text widgets ──────────────────────────────────────────────

/**
 * Inline widget for the first line of the ghost text suggestion.
 * Renders as a grey span at the cursor position on the current line.
 */
class GhostTextInlineWidget extends WidgetType {
    constructor(private readonly text: string) {
        super();
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'sidekick-ghost-text';
        span.textContent = this.text;
        return span;
    }

    eq(other: GhostTextInlineWidget): boolean {
        return this.text === other.text;
    }

    get estimatedHeight(): number {
        return -1; // inline widget
    }

    ignoreEvent(): boolean {
        return true;
    }
}

/**
 * Block widget for continuation lines of a multi-line ghost text suggestion.
 * Renders below the current line, styled like VSCode's ghost text blocks.
 */
class GhostTextBlockWidget extends WidgetType {
    constructor(private readonly lines: string[]) {
        super();
    }

    toDOM(): HTMLElement {
        const block = document.createElement('div');
        block.className = 'sidekick-ghost-text sidekick-ghost-text-block';
        block.textContent = this.lines.join('\n');
        return block;
    }

    eq(other: GhostTextBlockWidget): boolean {
        return this.lines.length === other.lines.length &&
            this.lines.every((l, i) => l === other.lines[i]);
    }

    ignoreEvent(): boolean {
        return true;
    }
}

// ── Decoration layer ────────────────────────────────────────────────

/** Compute decorations from the suggestion state. */
function computeDecorations(view: EditorView): DecorationSet {
    const suggestion = view.state.field(suggestionField);
    if (!suggestion) return Decoration.none;

    debugLog.log('autocomplete', 'Computing decorations', {
        suggestionLength: suggestion.length,
        suggestionPreview: suggestion.slice(0, 60),
        cursorPos: view.state.selection.main.head,
    });

    const pos = view.state.selection.main.head;
    const lines = suggestion.split('\n');
    const ranges: import('@codemirror/state').Range<Decoration>[] = [];

    // First line: inline widget at cursor position
    if (lines[0]) {
        ranges.push(
            Decoration.widget({
                widget: new GhostTextInlineWidget(lines[0]),
                side: 1, // after cursor
            }).range(pos),
        );
    }

    // Continuation lines: block widget below current line
    if (lines.length > 1) {
        const continuationLines = lines.slice(1);
        const lineEnd = view.state.doc.lineAt(pos).to;
        ranges.push(
            Decoration.widget({
                widget: new GhostTextBlockWidget(continuationLines),
                side: 1,
                block: true,
            }).range(lineEnd),
        );
    }

    // Decorations must be sorted by position
    ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);

    return Decoration.set(ranges);
}

// ── Keymap: Tab to accept, partial accept, and dismiss ──────────────

const autocompleteKeymap = keymap.of([
    {
        // Tab: accept full suggestion
        key: 'Tab',
        run(view: EditorView): boolean {
            const suggestion = view.state.field(suggestionField, false);
            if (!suggestion) return false;

            const pos = view.state.selection.main.head;
            view.dispatch({
                changes: { from: pos, insert: suggestion },
                selection: { anchor: pos + suggestion.length },
                effects: setSuggestion.of(null),
            });
            return true;
        },
    },
    {
        // Ctrl+Right: accept next word
        key: 'Ctrl-ArrowRight',
        mac: 'Cmd-ArrowRight',
        run(view: EditorView): boolean {
            const suggestion = view.state.field(suggestionField, false);
            if (!suggestion) return false;

            const boundary = getNextWordBoundary(suggestion);
            if (boundary <= 0) return false;

            const accepted = suggestion.slice(0, boundary);
            const remaining = suggestion.slice(boundary);
            const pos = view.state.selection.main.head;

            view.dispatch({
                changes: { from: pos, insert: accepted },
                selection: { anchor: pos + accepted.length },
                effects: setSuggestion.of(remaining.trim() ? remaining : null),
            });
            return true;
        },
    },
    {
        // Ctrl+Enter (or Cmd+Enter on Mac): accept first line only
        key: 'Ctrl-Enter',
        mac: 'Cmd-Enter',
        run(view: EditorView): boolean {
            const suggestion = view.state.field(suggestionField, false);
            if (!suggestion) return false;

            const firstLine = getFirstLine(suggestion);
            if (!firstLine) return false;

            // Remaining is everything after the first line (skip the \n separator)
            const remaining = suggestion.length > firstLine.length
                ? suggestion.slice(firstLine.length + 1)
                : null;
            const pos = view.state.selection.main.head;

            view.dispatch({
                changes: { from: pos, insert: firstLine },
                selection: { anchor: pos + firstLine.length },
                effects: setSuggestion.of(remaining || null),
            });
            return true;
        },
    },
    {
        // Escape: dismiss suggestion
        key: 'Escape',
        run(view: EditorView): boolean {
            const suggestion = view.state.field(suggestionField, false);
            if (!suggestion) return false;

            view.dispatch({
                effects: setSuggestion.of(null),
            });
            return true;
        },
    },
]);

// ── View plugin: manages debounced LLM requests ─────────────────────

interface AutocompletePluginConfig {
    getSettings: () => PluginSettings;
    getActiveNoteTitle: () => string;
}

function createAutocompletePlugin(config: AutocompletePluginConfig) {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet = Decoration.none;
            private debounceTimer: ReturnType<typeof setTimeout> | null = null;
            private abortController: AbortController | null = null;
            private lastRequestId = 0;
            /** Completion cache: reuse results when prefix matches. */
            private cachedResult: { prefix: string; text: string } | null = null;

            constructor(private view: EditorView) {
                this.decorations = computeDecorations(view);
            }

            update(update: ViewUpdate): void {
                // Check for manual trigger effect
                for (const tr of update.transactions) {
                    for (const effect of tr.effects) {
                        if (effect.is(triggerCompletion)) {
                            this.requestCompletion(effect.value);
                        }
                    }
                }

                // Always recompute decorations when state changes
                if (
                    update.docChanged ||
                    update.selectionSet ||
                    update.state.field(suggestionField) !==
                    update.startState.field(suggestionField)
                ) {
                    this.decorations = computeDecorations(update.view);
                }

                // Trigger new completion request on user-initiated document changes only
                // BUT skip if typing-as-suggested is active (suggestion still present after typing)
                if (update.docChanged && update.transactions.some(tr => !!tr.annotation(Transaction.userEvent))) {
                    const currentSuggestion = update.state.field(suggestionField);
                    const previousSuggestion = update.startState.field(suggestionField);

                    // If suggestion survived the docChange, it was typing-as-suggested — don't re-fetch
                    if (currentSuggestion !== null && previousSuggestion !== null) {
                        return;
                    }

                    const settings = config.getSettings();
                    if (
                        settings.autocomplete.enabled &&
                        settings.autocomplete.triggerMode === 'auto'
                    ) {
                        this.scheduleCompletion(settings);
                    }
                }
            }

            scheduleCompletion(settings: PluginSettings): void {
                this.cancelPending();

                const delay = settings.autocomplete.debounceMs;
                this.debounceTimer = setTimeout(() => {
                    this.requestCompletion(settings);
                }, delay);
            }

            async requestCompletion(settings: PluginSettings): Promise<void> {
                // Cancel any in-flight request
                if (this.abortController) {
                    this.abortController.abort();
                }
                this.abortController = new AbortController();
                const requestId = ++this.lastRequestId;

                const acSettings = settings.autocomplete;
                const apiKey =
                    acSettings.provider === 'openai'
                        ? settings.openaiApiKey
                        : acSettings.provider === 'copilot'
                            ? (settings.copilotAccounts.find(a => a.id === settings.activeCopilotAccountId)?.oauthToken ?? settings.copilotToken) || 'copilot' // placeholder — real key resolved in fetchCompletion via copilotTokenManager
                            : settings.openrouterApiKey;

                if (!apiKey) return;

                const doc = this.view.state.doc.toString();
                const cursorPos = this.view.state.selection.main.head;

                // Don't request if cursor is at start or line is empty
                if (cursorPos === 0) return;
                const line = this.view.state.doc.lineAt(cursorPos);
                if (line.text.trim().length === 0) return;

                const noteTitle = config.getActiveNoteTitle();
                const ctx = buildCompletionContext(doc, cursorPos, noteTitle);

                // Don't request if there's no meaningful prefix
                if (ctx.prefix.trim().length < 3) return;

                // Check cache: if the current prefix extends the cached prefix
                // and the extra typed text matches the start of the cached result, reuse it.
                if (this.cachedResult) {
                    const { prefix: cachedPrefix, text: cachedText } = this.cachedResult;
                    if (ctx.prefix.startsWith(cachedPrefix) && ctx.prefix.length > cachedPrefix.length) {
                        const extra = ctx.prefix.slice(cachedPrefix.length);
                        if (cachedText.startsWith(extra)) {
                            const remaining = cachedText.slice(extra.length);
                            if (remaining) {
                                debugLog.log('autocomplete', 'Cache hit — reusing trimmed completion', {
                                    extra,
                                    remainingLength: remaining.length,
                                });
                                this.view.dispatch({
                                    effects: setSuggestion.of(remaining),
                                });
                                return;
                            }
                        }
                    }
                }

                try {
                    const result = await fetchCompletion(
                        acSettings,
                        apiKey,
                        ctx,
                        this.abortController.signal,
                    );

                    // Verify this request is still the latest
                    if (requestId !== this.lastRequestId) return;
                    if (this.abortController?.signal.aborted) return;

                    if (result?.text) {
                        // Cache the result for potential reuse
                        this.cachedResult = { prefix: ctx.prefix, text: result.text };
                        debugLog.log('autocomplete', 'Dispatching setSuggestion', {
                            textLength: result.text.length,
                            textPreview: result.text.slice(0, 80),
                            cursorPos: this.view.state.selection.main.head,
                        });
                        this.view.dispatch({
                            effects: setSuggestion.of(result.text),
                        });
                    } else {
                        debugLog.log('autocomplete', 'No result text to dispatch', { result });
                    }
                } catch {
                    // Silently swallow errors (network, abort, etc.)
                }
            }

            cancelPending(): void {
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                    this.debounceTimer = null;
                }
                if (this.abortController) {
                    this.abortController.abort();
                    this.abortController = null;
                }
                this.cachedResult = null;
            }

            destroy(): void {
                this.cancelPending();
            }
        },
        {
            decorations: (v) => v.decorations,
        },
    );
}

// ── Manual trigger command ──────────────────────────────────────────

/**
 * Programmatically trigger a completion request via StateEffect.
 * Used by the manual trigger command.
 */
export function triggerAutocomplete(view: EditorView, settings: PluginSettings): void {
    view.dispatch({
        effects: triggerCompletion.of(settings),
    });
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create the CodeMirror 6 extension array for auto-completion.
 *
 * @param config - Configuration callbacks for settings and note title
 * @returns Array of CM6 extensions to register
 */
export function createAutocompleteExtension(
    config: AutocompletePluginConfig,
): Extension {
    return [
        suggestionField,
        Prec.highest(autocompleteKeymap),
        createAutocompletePlugin(config),
    ];
}

/** Re-export for use in commands */
export { setSuggestion };

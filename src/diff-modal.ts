// Diff modal — shows before/after file changes using CodeMirror MergeView
// Zero Obsidian-specific logic in the diff computation itself; Modal is the only Obsidian dep.

import { Modal, App } from 'obsidian';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// ── Diff store ──────────────────────────────────────────────────────
// Stores before/after content for file edits, keyed by vault path.
// Populated by processToolCall, consumed by postProcessToolCallouts.

export interface EditDiff {
    before: string;
    after: string;
    path: string;
}

const _editDiffs = new Map<string, EditDiff>();

export function storeEditDiff(path: string, diff: EditDiff): void {
    _editDiffs.set(path, diff);
}

export function getEditDiff(path: string): EditDiff | undefined {
    return _editDiffs.get(path);
}

export function clearEditDiffs(): void {
    _editDiffs.clear();
}

// ── DiffModal ───────────────────────────────────────────────────────

export class DiffModal extends Modal {
    private diff: EditDiff;
    private mergeView: MergeView | null = null;

    constructor(app: App, diff: EditDiff) {
        super(app);
        this.diff = diff;
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass('sidekick-diff-modal');
        contentEl.addClass('sidekick-diff-content');

        // Header
        contentEl.createEl('div', { cls: 'sidekick-diff-header' }, el => {
            el.createEl('span', { text: 'Before', cls: 'sidekick-diff-label sidekick-diff-label-before' });
            el.createEl('span', { text: this.diff.path, cls: 'sidekick-diff-path' });
            el.createEl('span', { text: 'After', cls: 'sidekick-diff-label sidekick-diff-label-after' });
        });

        // MergeView container
        const container = contentEl.createDiv({ cls: 'sidekick-diff-container' });

        this.mergeView = new MergeView({
            a: {
                doc: this.diff.before,
                extensions: [
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ],
            },
            b: {
                doc: this.diff.after,
                extensions: [
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ],
            },
            parent: container,
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: { margin: 3, minSize: 4 },
        });
    }

    onClose(): void {
        if (this.mergeView) {
            this.mergeView.a.destroy();
            this.mergeView.b.destroy();
            this.mergeView = null;
        }
        this.contentEl.empty();
    }
}

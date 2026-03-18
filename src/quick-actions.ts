/**
 * Quick Actions — Obsidian-specific context menu + floating result popup.
 *
 * Registers editor context menu items for AI actions on selected text.
 * Shows results in a floating popup with Replace / Insert Below / Copy actions.
 */

import { type App, type Editor, type Menu, type MarkdownView, requestUrl, Notice } from 'obsidian';
import { BUILT_IN_ACTIONS, buildQuickActionMessages, getAllActions } from '../lib/quick-actions';
import type { QuickAction } from '../lib/quick-actions';
import type { PluginSettings } from './types';
import { PROVIDERS } from './constants';
import { resolveApiKey } from './api-helpers';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';

/** Safely get the content element from a MarkdownView (undocumented Obsidian API). */
function getViewContentEl(view: MarkdownView): HTMLElement | null {
	const v = view as unknown as Record<string, unknown>;
	return (v.contentEl instanceof HTMLElement ? v.contentEl : null) || view.containerEl;
}

// Re-export pure logic
export { BUILT_IN_ACTIONS, buildQuickActionMessages, getActionById, getAllActions } from '../lib/quick-actions';
export type { QuickAction } from '../lib/quick-actions';

// ---------------------------------------------------------------------------
// Quick Action execution (non-streaming for simplicity)
// ---------------------------------------------------------------------------

export async function executeQuickAction(
	action: QuickAction,
	selectedText: string,
	settings: PluginSettings,
	signal?: AbortSignal,
): Promise<string | null> {
	const provider = settings.selectedProvider;
	const cfg = PROVIDERS[provider];
	if (!cfg) return null;

	let apiKey: string;
	try {
		apiKey = await resolveApiKey(provider, settings);
	} catch (err: unknown) {
		debugLog.log('quick-actions', 'API key resolution failed', { provider, error: getErrorMessage(err) });
		return null;
	}
	if (!apiKey && provider !== 'copilot') return null;

	const messages = buildQuickActionMessages(action, selectedText);

	const body = {
		model: settings.selectedModel,
		messages,
		temperature: 0.3,
		stream: false,
	};

	const start = Date.now();
	try {
		const res = await requestUrl({
			url: cfg.url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...cfg.headers(apiKey),
			},
			body: JSON.stringify(body),
		});

		if (signal?.aborted) return null;

		if (res.status !== 200) {
			debugLog.log('quick-actions', 'API error', { status: res.status, action: action.id });
			return null;
		}

		const content = res.json?.choices?.[0]?.message?.content;
		if (!content || typeof content !== 'string') return null;

		debugLog.log('quick-actions', 'Action completed', {
			action: action.id,
			durationMs: Date.now() - start,
			inputLen: selectedText.length,
			outputLen: content.length,
		});

		return content.trim();
	} catch (err: unknown) {
		if (err instanceof Error && err.name === 'AbortError') return null;
		debugLog.log('quick-actions', 'Error', { action: action.id, error: getErrorMessage(err) });
		return null;
	}
}

// ---------------------------------------------------------------------------
// Floating result popup
// ---------------------------------------------------------------------------

let activePopup: HTMLElement | null = null;
let activeEscHandler: ((e: KeyboardEvent) => void) | null = null;
let activeAbortController: AbortController | null = null;

function dismissPopup() {
	if (activePopup) {
		activePopup.remove();
		activePopup = null;
	}
	if (activeEscHandler) {
		document.removeEventListener('keydown', activeEscHandler);
		activeEscHandler = null;
	}
	if (activeAbortController) {
		activeAbortController.abort();
		activeAbortController = null;
	}
}

function showResultPopup(
	result: string,
	editor: Editor,
	view: MarkdownView,
): void {
	dismissPopup();

	const popup = document.createElement('div');
	popup.className = 'sidekick-quick-action-popup';

	// Result text
	const resultEl = popup.createDiv({ cls: 'sidekick-qa-result' });
	resultEl.textContent = result;

	// Action buttons
	const buttonsEl = popup.createDiv({ cls: 'sidekick-qa-buttons' });

	const replaceBtn = buttonsEl.createEl('button', { text: 'Replace', cls: 'sidekick-qa-btn sidekick-qa-btn-primary' });
	replaceBtn.addEventListener('click', () => {
		editor.replaceSelection(result);
		dismissPopup();
	});

	const insertBtn = buttonsEl.createEl('button', { text: 'Insert Below', cls: 'sidekick-qa-btn' });
	insertBtn.addEventListener('click', () => {
		const cursor = editor.getCursor('to');
		const lineEnd = editor.getLine(cursor.line).length;
		editor.replaceRange('\n\n' + result, { line: cursor.line, ch: lineEnd });
		dismissPopup();
	});

	const copyBtn = buttonsEl.createEl('button', { text: 'Copy', cls: 'sidekick-qa-btn' });
	copyBtn.addEventListener('click', () => {
		navigator.clipboard.writeText(result);
		new Notice('Copied to clipboard');
		dismissPopup();
	});

	const dismissBtn = buttonsEl.createEl('button', { text: '✕', cls: 'sidekick-qa-btn sidekick-qa-btn-dismiss' });
	dismissBtn.addEventListener('click', dismissPopup);

	// Position popup near the editor
	document.body.appendChild(popup);
	activePopup = popup;

	// Position relative to the editor view
	const editorEl = getViewContentEl(view);
	if (editorEl) {
		const rect = editorEl.getBoundingClientRect();
		popup.style.top = `${rect.top + 40}px`;
		popup.style.left = `${rect.left + 20}px`;
		popup.style.maxWidth = `${rect.width - 40}px`;
	}

	// Close on Escape
	activeEscHandler = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			dismissPopup();
		}
	};
	document.addEventListener('keydown', activeEscHandler);
}

function showLoadingPopup(view: MarkdownView): void {
	dismissPopup();

	const popup = document.createElement('div');
	popup.className = 'sidekick-quick-action-popup sidekick-qa-loading';
	popup.textContent = 'Processing…';

	document.body.appendChild(popup);
	activePopup = popup;

	const editorEl = getViewContentEl(view);
	if (editorEl) {
		const rect = editorEl.getBoundingClientRect();
		popup.style.top = `${rect.top + 40}px`;
		popup.style.left = `${rect.left + 20}px`;
	}
}

// ---------------------------------------------------------------------------
// Context menu registration
// ---------------------------------------------------------------------------

export function registerQuickActionsMenu(
	app: App,
	settings: PluginSettings,
): (menu: Menu, editor: Editor, view: MarkdownView) => void {
	return (menu: Menu, editor: Editor, view: MarkdownView) => {
		const selection = editor.getSelection();
		if (!selection?.trim()) return;

		const actions = getAllActions();

		menu.addSeparator();

		for (const action of actions) {
			menu.addItem((item) => {
				item.setTitle(`${action.icon} ${action.label}`)
					.onClick(async () => {
						showLoadingPopup(view);
						activeAbortController = new AbortController();

						const result = await executeQuickAction(action, selection, settings, activeAbortController.signal);

						if (result) {
							showResultPopup(result, editor, view);
						} else if (!activeAbortController?.signal.aborted) {
							dismissPopup();
							new Notice('Quick action failed — check API key and model settings.');
						}
					});
			});
		}
	};
}

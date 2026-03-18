/**
 * Quick Actions — zero Obsidian dependency.
 *
 * Pure action definitions and prompt building for context-menu AI actions
 * on selected text. No DOM, no Obsidian APIs.
 */

import type { ApiMessage, ApiSettings } from './types';

// ---------------------------------------------------------------------------
// Action definitions
// ---------------------------------------------------------------------------

export interface QuickAction {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly prompt: string;
}

export const BUILT_IN_ACTIONS: readonly QuickAction[] = [
	{
		id: 'summarize',
		label: 'Summarize',
		icon: '📝',
		prompt: 'Summarize the following text concisely. Return only the summary, no preamble.',
	},
	{
		id: 'explain',
		label: 'Explain',
		icon: '💡',
		prompt: 'Explain the following text in simple, clear terms. Return only the explanation.',
	},
	{
		id: 'fix-grammar',
		label: 'Fix Grammar',
		icon: '✏️',
		prompt: 'Fix all grammar and spelling errors in the following text. Preserve the original meaning and tone. Return only the corrected text.',
	},
	{
		id: 'make-concise',
		label: 'Make Concise',
		icon: '✂️',
		prompt: 'Rewrite the following text to be more concise while preserving all key information. Return only the rewritten text.',
	},
	{
		id: 'expand',
		label: 'Expand',
		icon: '📖',
		prompt: 'Expand the following text with more detail and examples. Return only the expanded text.',
	},
	{
		id: 'translate',
		label: 'Translate to English',
		icon: '🌐',
		prompt: 'Translate the following text to English. Return only the translation.',
	},
] as const;

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function buildQuickActionMessages(
	action: QuickAction,
	selectedText: string,
): ApiMessage[] {
	return [
		{ role: 'system', content: action.prompt },
		{ role: 'user', content: selectedText },
	];
}

export function getActionById(id: string): QuickAction | undefined {
	return BUILT_IN_ACTIONS.find(a => a.id === id);
}

export function getAllActions(customActions?: QuickAction[]): QuickAction[] {
	if (!customActions?.length) return [...BUILT_IN_ACTIONS];
	return [...BUILT_IN_ACTIONS, ...customActions];
}

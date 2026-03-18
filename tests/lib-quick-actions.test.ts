/**
 * Tests for lib/quick-actions.ts — pure quick-action logic.
 */
import { describe, it, expect } from 'vitest';
import {
	BUILT_IN_ACTIONS,
	buildQuickActionMessages,
	getActionById,
	getAllActions,
} from '../lib/quick-actions';
import type { QuickAction } from '../lib/quick-actions';

describe('lib/quick-actions', () => {
	describe('BUILT_IN_ACTIONS', () => {
		it('contains 6 built-in actions', () => {
			expect(BUILT_IN_ACTIONS).toHaveLength(6);
		});

		it('each action has required fields', () => {
			for (const action of BUILT_IN_ACTIONS) {
				expect(action.id).toBeTruthy();
				expect(action.label).toBeTruthy();
				expect(action.prompt).toBeTruthy();
				expect(action.icon).toBeTruthy();
			}
		});

		it('action IDs are unique', () => {
			const ids = BUILT_IN_ACTIONS.map((a) => a.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it('includes expected action IDs', () => {
			const ids = BUILT_IN_ACTIONS.map((a) => a.id);
			expect(ids).toContain('summarize');
			expect(ids).toContain('explain');
			expect(ids).toContain('fix-grammar');
			expect(ids).toContain('make-concise');
			expect(ids).toContain('expand');
			expect(ids).toContain('translate');
		});
	});

	describe('buildQuickActionMessages', () => {
		it('returns system + user messages', () => {
			const action = BUILT_IN_ACTIONS[0];
			const msgs = buildQuickActionMessages(action, 'Hello world');
			expect(msgs).toHaveLength(2);
			expect(msgs[0].role).toBe('system');
			expect(msgs[1].role).toBe('user');
		});

		it('system message contains action prompt', () => {
			const action = BUILT_IN_ACTIONS[0];
			const msgs = buildQuickActionMessages(action, 'test text');
			expect(msgs[0].content).toBe(action.prompt);
		});

		it('user message contains selected text', () => {
			const msgs = buildQuickActionMessages(BUILT_IN_ACTIONS[0], 'my selected text');
			expect(msgs[1].content).toBe('my selected text');
		});

		it('preserves multiline text', () => {
			const text = 'line one\nline two\nline three';
			const msgs = buildQuickActionMessages(BUILT_IN_ACTIONS[0], text);
			expect(msgs[1].content).toBe(text);
		});

		it('works with empty string', () => {
			const msgs = buildQuickActionMessages(BUILT_IN_ACTIONS[0], '');
			expect(msgs[1].content).toBe('');
		});

		it('works with custom action', () => {
			const custom: QuickAction = {
				id: 'custom-test',
				label: 'Test Action',
				prompt: 'Do something special',
				icon: '🎯',
			};
			const msgs = buildQuickActionMessages(custom, 'hello');
			expect(msgs[0].content).toBe('Do something special');
			expect(msgs[1].content).toBe('hello');
		});
	});

	describe('getActionById', () => {
		it('returns action for valid ID', () => {
			const action = getActionById('summarize');
			expect(action).toBeDefined();
			expect(action?.id).toBe('summarize');
		});

		it('returns action for each built-in ID', () => {
			for (const a of BUILT_IN_ACTIONS) {
				expect(getActionById(a.id)).toBe(a);
			}
		});

		it('returns undefined for unknown ID', () => {
			expect(getActionById('nonexistent')).toBeUndefined();
		});

		it('returns undefined for empty string', () => {
			expect(getActionById('')).toBeUndefined();
		});
	});

	describe('getAllActions', () => {
		it('returns built-in actions when no custom actions', () => {
			const all = getAllActions();
			expect(all).toEqual(BUILT_IN_ACTIONS);
		});

		it('returns built-in actions for empty custom array', () => {
			const all = getAllActions([]);
			expect(all).toEqual(BUILT_IN_ACTIONS);
		});

		it('appends custom actions after built-in ones', () => {
			const custom: QuickAction[] = [
				{ id: 'my-action', label: 'My Action', prompt: 'do X', icon: '🔥' },
			];
			const all = getAllActions(custom);
			expect(all.length).toBe(BUILT_IN_ACTIONS.length + 1);
			expect(all[all.length - 1].id).toBe('my-action');
		});

		it('appends multiple custom actions', () => {
			const custom: QuickAction[] = [
				{ id: 'a', label: 'A', prompt: 'pa', icon: '1️⃣' },
				{ id: 'b', label: 'B', prompt: 'pb', icon: '2️⃣' },
				{ id: 'c', label: 'C', prompt: 'pc', icon: '3️⃣' },
			];
			const all = getAllActions(custom);
			expect(all.length).toBe(BUILT_IN_ACTIONS.length + 3);
			expect(all.slice(-3).map((a) => a.id)).toEqual(['a', 'b', 'c']);
		});

		it('does not modify BUILT_IN_ACTIONS array', () => {
			const before = [...BUILT_IN_ACTIONS];
			getAllActions([{ id: 'x', label: 'X', prompt: 'px', icon: '💎' }]);
			expect(BUILT_IN_ACTIONS).toEqual(before);
		});

		it('preserves custom action fields', () => {
			const custom: QuickAction = {
				id: 'detailed',
				label: 'Detailed Label',
				prompt: 'A very detailed prompt with instructions',
				icon: '📝',
			};
			const all = getAllActions([custom]);
			const found = all.find((a) => a.id === 'detailed');
			expect(found).toBeDefined();
			expect(found?.label).toBe('Detailed Label');
			expect(found?.prompt).toBe('A very detailed prompt with instructions');
			expect(found?.icon).toBe('📝');
		});
	});

	// --- QA edge case tests ---

	describe('edge cases', () => {
		it('buildQuickActionMessages handles very long text', () => {
			const longText = 'x'.repeat(100_000);
			const msgs = buildQuickActionMessages(BUILT_IN_ACTIONS[0], longText);
			expect(msgs[1].content.length).toBe(100_000);
		});

		it('buildQuickActionMessages handles unicode and emoji', () => {
			const text = '你好世界 🌍 مرحبا 🎉';
			const msgs = buildQuickActionMessages(BUILT_IN_ACTIONS[0], text);
			expect(msgs[1].content).toBe(text);
		});

		it('buildQuickActionMessages handles special characters', () => {
			const text = '<script>alert("xss")</script> & "quotes" \'single\'';
			const msgs = buildQuickActionMessages(BUILT_IN_ACTIONS[0], text);
			expect(msgs[1].content).toBe(text);
		});

		it('getActionById is case-sensitive', () => {
			expect(getActionById('Summarize')).toBeUndefined();
			expect(getActionById('SUMMARIZE')).toBeUndefined();
			expect(getActionById('summarize')).toBeDefined();
		});

		it('getAllActions returns a new array each time', () => {
			const a = getAllActions();
			const b = getAllActions();
			expect(a).not.toBe(b);
			expect(a).toEqual(b);
		});

		it('all built-in prompts end with a period', () => {
			for (const action of BUILT_IN_ACTIONS) {
				expect(action.prompt.endsWith('.')).toBe(true);
			}
		});

		it('all built-in action IDs are kebab-case', () => {
			const kebabRe = /^[a-z]+(-[a-z]+)*$/;
			for (const action of BUILT_IN_ACTIONS) {
				expect(action.id).toMatch(kebabRe);
			}
		});

		it('custom action with same ID as built-in does not replace it', () => {
			const custom: QuickAction = {
				id: 'summarize',
				label: 'Custom Summarize',
				prompt: 'custom prompt',
				icon: '🔄',
			};
			const all = getAllActions([custom]);
			// Both should exist — built-in first, custom second
			const matches = all.filter((a) => a.id === 'summarize');
			expect(matches.length).toBe(2);
			expect(matches[0].label).toBe('Summarize');
			expect(matches[1].label).toBe('Custom Summarize');
		});
	});
});

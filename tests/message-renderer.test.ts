import { describe, it, expect, vi } from 'vitest';
import { buildExportMarkdown } from '../src/message-renderer';
import type { ChatMessage } from '../src/types';

// Note: renderMessage and updateLastAssistantContent require DOM elements
// (Obsidian's createDiv/createEl) which are hard to mock. We test the
// pure function buildExportMarkdown here. DOM-dependent rendering would
// need an integration test with a real Obsidian environment.

describe('buildExportMarkdown', () => {
    it('returns a title header', () => {
        const md = buildExportMarkdown('Test Chat', []);
        expect(md).toContain('# Chat — Test Chat');
    });

    it('includes user messages labeled "You"', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Hello world' },
        ];
        const md = buildExportMarkdown('T', messages);
        expect(md).toContain('### **You**');
        expect(md).toContain('Hello world');
    });

    it('includes assistant messages labeled "Assistant"', () => {
        const messages: ChatMessage[] = [
            { role: 'assistant', content: 'Hi there' },
        ];
        const md = buildExportMarkdown('T', messages);
        expect(md).toContain('### **Assistant**');
        expect(md).toContain('Hi there');
    });

    it('skips system and tool messages', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Question' },
            { role: 'tool', content: 'Tool result' },
            { role: 'assistant', content: 'Answer' },
        ];
        const md = buildExportMarkdown('T', messages);
        expect(md).not.toContain('System prompt');
        expect(md).not.toContain('Tool result');
        expect(md).toContain('Question');
        expect(md).toContain('Answer');
    });

    it('separates messages with horizontal rules', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Q' },
            { role: 'assistant', content: 'A' },
        ];
        const md = buildExportMarkdown('T', messages);
        expect(md.match(/---/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves markdown formatting in content', () => {
        const messages: ChatMessage[] = [
            { role: 'assistant', content: '**bold** and `code`' },
        ];
        const md = buildExportMarkdown('T', messages);
        expect(md).toContain('**bold** and `code`');
    });

    it('handles empty messages array', () => {
        const md = buildExportMarkdown('Empty', []);
        expect(md).toContain('# Chat — Empty');
        expect(md.split('\n').length).toBeLessThan(5);
    });

    it('handles multi-line content', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'line1\nline2\nline3' },
        ];
        const md = buildExportMarkdown('T', messages);
        expect(md).toContain('line1\nline2\nline3');
    });
});

describe('renderMessage', () => {
    it('does not trigger onEdit when clicking a link (a tag) inside user message', async () => {
        const { renderMessage } = await import('../src/message-renderer');

        let clickHandler: any = null;

        // Mock HTMLElement
        const mockTarget = {
            closest: (sel: string) => sel.includes('a') ? true : null
        };

        const mockContentEl = {
            classList: { add: vi.fn(), contains: vi.fn(), toggle: vi.fn() },
            addEventListener: (evt: string, cb: any) => { clickHandler = cb; },
            createDiv: () => ({ createEl: () => ({ addEventListener: vi.fn() }), addEventListener: vi.fn(), classList: { toggle: vi.fn() } }),
            createEl: () => ({ addEventListener: vi.fn() }),
            textContent: ''
        };

        const mockWrapper = {
            createDiv: () => mockContentEl,
            createEl: () => ({ addEventListener: vi.fn() })
        };

        const mockContainer = {
            createDiv: () => mockWrapper
        };

        const actions = {
            getResourceUrl: vi.fn(),
            onEdit: vi.fn(),
            onInsertAtCursor: vi.fn(),
            onRegenerate: vi.fn(),
            onDelete: vi.fn()
        };

        await renderMessage(
            {} as any,
            {} as any,
            mockContainer as any,
            { role: 'user', content: 'Hello' } as any,
            0,
            1,
            actions
        );

        expect(clickHandler).not.toBeNull();

        // Simulate click on <a>
        clickHandler({ target: mockTarget });
        expect(actions.onEdit).not.toHaveBeenCalled();
    });
});

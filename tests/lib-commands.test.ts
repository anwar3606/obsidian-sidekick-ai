import { describe, it, expect } from 'vitest';
import {
    getBuiltInCommands,
    getAllCommands,
    getCommandSuggestions,
    parseSlashCommand,
    slashHelpText,
} from '../lib/commands';

describe('lib/commands', () => {
    const customCommands = [
        { name: 'summarize', description: 'Summarize text', systemPrompt: 'You are a summarizer.' },
        { name: 'translate', description: 'Translate text', systemPrompt: 'You are a translator.' },
    ];

    describe('getBuiltInCommands', () => {
        it('returns the built-in command list', () => {
            const cmds = getBuiltInCommands();
            expect(cmds.length).toBe(22);
            expect(cmds.map(c => c.name)).toContain('help');
            expect(cmds.map(c => c.name)).toContain('clear');
            expect(cmds.map(c => c.name)).toContain('iterate');
        });
    });

    describe('getAllCommands', () => {
        it('returns built-in commands when no custom commands', () => {
            const all = getAllCommands();
            expect(all.length).toBe(22);
            expect(all.every(c => c.type === 'built-in')).toBe(true);
        });

        it('merges custom commands with built-in', () => {
            const all = getAllCommands(customCommands);
            expect(all.length).toBe(24);
            const customOnes = all.filter(c => c.type === 'custom');
            expect(customOnes.length).toBe(2);
            expect(customOnes[0].name).toBe('summarize');
        });
    });

    describe('getCommandSuggestions', () => {
        it('returns empty for non-slash input', () => {
            expect(getCommandSuggestions('hello')).toEqual([]);
        });

        it('returns all commands for bare /', () => {
            const suggestions = getCommandSuggestions('/');
            expect(suggestions.length).toBe(22);
        });

        it('filters by prefix', () => {
            const suggestions = getCommandSuggestions('/he');
            expect(suggestions.length).toBe(1);
            expect(suggestions[0].name).toBe('help');
        });

        it('includes custom commands in suggestions', () => {
            const suggestions = getCommandSuggestions('/s', customCommands);
            expect(suggestions.some(c => c.name === 'selection')).toBe(true);
            expect(suggestions.some(c => c.name === 'summarize')).toBe(true);
        });

        it('returns empty for no matches', () => {
            expect(getCommandSuggestions('/xyz')).toEqual([]);
        });
    });

    describe('parseSlashCommand', () => {
        it('returns message type for non-slash input', () => {
            expect(parseSlashCommand('hello')).toEqual({ type: 'message' });
        });

        it('returns help for bare slash', () => {
            expect(parseSlashCommand('/')).toEqual({ type: 'command', command: 'help', args: '' });
        });

        it('parses built-in command', () => {
            expect(parseSlashCommand('/clear')).toEqual({ type: 'command', command: 'clear', args: '' });
        });

        it('parses built-in command with args', () => {
            expect(parseSlashCommand('/note some args')).toEqual({
                type: 'command', command: 'note', args: 'some args',
            });
        });

        it('parses custom command', () => {
            const result = parseSlashCommand('/summarize this text', customCommands);
            expect(result).toEqual({
                type: 'custom',
                command: 'summarize',
                args: 'this text',
                systemPrompt: 'You are a summarizer.',
            });
        });

        it('returns unknown for unrecognized command', () => {
            expect(parseSlashCommand('/foobar')).toEqual({
                type: 'unknown', command: 'foobar', args: '',
            });
        });

        it('handles empty/null input', () => {
            expect(parseSlashCommand('')).toEqual({ type: 'message' });
        });

        it('is case-insensitive', () => {
            expect(parseSlashCommand('/CLEAR')).toEqual({ type: 'command', command: 'clear', args: '' });
        });
    });

    describe('slashHelpText', () => {
        it('includes all built-in commands', () => {
            const text = slashHelpText();
            expect(text).toContain('/help');
            expect(text).toContain('/clear');
            expect(text).toContain('/export');
        });

        it('includes custom commands section', () => {
            const text = slashHelpText(customCommands);
            expect(text).toContain('Custom Commands');
            expect(text).toContain('/summarize');
            expect(text).toContain('/translate');
        });

        it('excludes custom section when no custom commands', () => {
            const text = slashHelpText();
            expect(text).not.toContain('Custom Commands');
        });

        it('includes keyboard shortcuts section', () => {
            const text = slashHelpText();
            expect(text).toContain('Keyboard Shortcuts');
            expect(text).toContain('Ctrl/Cmd+L');
            expect(text).toContain('Ctrl/Cmd+F');
        });

        it('includes tips section', () => {
            const text = slashHelpText();
            expect(text).toContain('Tips');
            expect(text).toContain('@filename');
            expect(text).toContain('Drag & drop');
        });
    });
});

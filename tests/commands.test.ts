import { describe, it, expect } from 'vitest';
import {
    getBuiltInCommands,
    getAllCommands,
    getCommandSuggestions,
    parseSlashCommand,
    slashHelpText,
} from '../src/commands';
import type { CustomCommand } from '../src/types';

// ── Test fixtures ───────────────────────────────────────────────────

const sampleCustomCommands: CustomCommand[] = [
    { id: '1', name: 'translate', description: 'Translate text', systemPrompt: 'You are a translator.' },
    { id: '2', name: 'coder', description: 'Code assistant', systemPrompt: 'You are a coder.' },
    { id: '3', name: 'summarize', description: 'Summarize text', systemPrompt: 'Summarize the following.' },
];

// ── getBuiltInCommands ──────────────────────────────────────────────

describe('getBuiltInCommands', () => {
    it('returns an array of built-in commands', () => {
        const cmds = getBuiltInCommands();
        expect(cmds).toBeInstanceOf(Array);
        expect(cmds.length).toBeGreaterThan(0);
    });

    it('includes expected built-in commands', () => {
        const cmds = getBuiltInCommands();
        const names = cmds.map(c => c.name);
        expect(names).toContain('help');
        expect(names).toContain('note');
        expect(names).toContain('selection');
        expect(names).toContain('regen');
        expect(names).toContain('clear');
        expect(names).toContain('export');
        expect(names).toContain('new');
    });

    it('each command has name and description', () => {
        for (const cmd of getBuiltInCommands()) {
            expect(cmd.name).toBeTruthy();
            expect(cmd.description).toBeTruthy();
        }
    });
});

// ── getAllCommands ───────────────────────────────────────────────────

describe('getAllCommands', () => {
    it('returns only built-in commands when no custom commands', () => {
        const all = getAllCommands();
        const builtIn = getBuiltInCommands();
        expect(all.length).toBe(builtIn.length);
        expect(all.every(c => c.type === 'built-in')).toBe(true);
    });

    it('returns only built-in when empty array passed', () => {
        const all = getAllCommands([]);
        const builtIn = getBuiltInCommands();
        expect(all.length).toBe(builtIn.length);
    });

    it('includes custom commands after built-ins', () => {
        const all = getAllCommands(sampleCustomCommands);
        const builtIn = getBuiltInCommands();
        expect(all.length).toBe(builtIn.length + sampleCustomCommands.length);

        const customEntries = all.filter(c => c.type === 'custom');
        expect(customEntries.length).toBe(3);
        expect(customEntries[0].name).toBe('translate');
    });

    it('custom commands have correct type label', () => {
        const all = getAllCommands(sampleCustomCommands);
        const custom = all.filter(c => c.type === 'custom');
        expect(custom.every(c => c.type === 'custom')).toBe(true);
    });

    it('custom commands without description show "Custom prompt"', () => {
        const cmds: CustomCommand[] = [
            { id: 'x', name: 'test', description: '', systemPrompt: 'prompt' },
        ];
        const all = getAllCommands(cmds);
        const custom = all.find(c => c.name === 'test');
        expect(custom?.description).toBe('Custom prompt');
    });
});

// ── getCommandSuggestions ───────────────────────────────────────────

describe('getCommandSuggestions', () => {
    it('returns empty array for non-slash input', () => {
        expect(getCommandSuggestions('hello')).toEqual([]);
        expect(getCommandSuggestions('')).toEqual([]);
        expect(getCommandSuggestions('no slash')).toEqual([]);
    });

    it('returns all commands for bare slash', () => {
        const suggestions = getCommandSuggestions('/');
        const builtIn = getBuiltInCommands();
        expect(suggestions.length).toBe(builtIn.length);
    });

    it('returns all commands including custom for bare slash', () => {
        const suggestions = getCommandSuggestions('/', sampleCustomCommands);
        const builtIn = getBuiltInCommands();
        expect(suggestions.length).toBe(builtIn.length + sampleCustomCommands.length);
    });

    it('filters commands by prefix', () => {
        const suggestions = getCommandSuggestions('/he');
        expect(suggestions.length).toBe(1);
        expect(suggestions[0].name).toBe('help');
    });

    it('filters custom commands by prefix', () => {
        const suggestions = getCommandSuggestions('/tr', sampleCustomCommands);
        expect(suggestions.length).toBe(1);
        expect(suggestions[0].name).toBe('translate');
    });

    it('returns empty for no matching prefix', () => {
        expect(getCommandSuggestions('/zzz')).toEqual([]);
        expect(getCommandSuggestions('/xyz', sampleCustomCommands)).toEqual([]);
    });

    it('is case-insensitive', () => {
        const suggestions = getCommandSuggestions('/HE');
        expect(suggestions.length).toBe(1);
        expect(suggestions[0].name).toBe('help');
    });

    it('filters with partial match', () => {
        const suggestions = getCommandSuggestions('/n');
        const names = suggestions.map(s => s.name);
        expect(names).toContain('note');
        expect(names).toContain('new');
    });
});

// ── parseSlashCommand ───────────────────────────────────────────────

describe('parseSlashCommand', () => {
    // Regular messages
    it('returns message type for non-slash input', () => {
        expect(parseSlashCommand('hello')).toEqual({ type: 'message' });
    });

    it('returns message type for empty input', () => {
        expect(parseSlashCommand('')).toEqual({ type: 'message' });
    });

    it('returns message type for whitespace-only input', () => {
        expect(parseSlashCommand('   ')).toEqual({ type: 'message' });
    });

    // Bare slash
    it('returns help for bare slash', () => {
        expect(parseSlashCommand('/')).toEqual({ type: 'command', command: 'help', args: '' });
    });

    // Built-in commands
    it('parses built-in command without args', () => {
        expect(parseSlashCommand('/help')).toEqual({ type: 'command', command: 'help', args: '' });
    });

    it('parses built-in command with args', () => {
        const result = parseSlashCommand('/note my note');
        expect(result.type).toBe('command');
        expect(result.command).toBe('note');
        expect(result.args).toBe('my note');
    });

    it('parses all built-in commands', () => {
        for (const cmd of getBuiltInCommands()) {
            const result = parseSlashCommand(`/${cmd.name}`);
            expect(result.type).toBe('command');
            expect(result.command).toBe(cmd.name);
        }
    });

    it('is case-insensitive for built-in commands', () => {
        const result = parseSlashCommand('/HELP');
        expect(result.type).toBe('command');
        expect(result.command).toBe('help');
    });

    // Custom commands
    it('parses custom command', () => {
        const result = parseSlashCommand('/translate hello world', sampleCustomCommands);
        expect(result.type).toBe('custom');
        expect(result.command).toBe('translate');
        expect(result.args).toBe('hello world');
        expect(result.systemPrompt).toBe('You are a translator.');
    });

    it('custom command without args', () => {
        const result = parseSlashCommand('/coder', sampleCustomCommands);
        expect(result.type).toBe('custom');
        expect(result.command).toBe('coder');
        expect(result.args).toBe('');
    });

    it('built-in takes priority over custom with same name', () => {
        const cmds: CustomCommand[] = [
            { id: 'x', name: 'help', description: 'Custom help', systemPrompt: 'custom' },
        ];
        const result = parseSlashCommand('/help', cmds);
        // Built-in 'help' should take priority
        expect(result.type).toBe('command');
    });

    // Unknown commands
    it('returns unknown for unrecognized command', () => {
        const result = parseSlashCommand('/nonexistent');
        expect(result.type).toBe('unknown');
        expect(result.command).toBe('nonexistent');
    });

    it('returns unknown for unrecognized command with args', () => {
        const result = parseSlashCommand('/foo bar baz');
        expect(result.type).toBe('unknown');
        expect(result.command).toBe('foo');
        expect(result.args).toBe('bar baz');
    });

    // Edge cases
    it('handles multiple spaces between command and args', () => {
        const result = parseSlashCommand('/note   multiple   spaces');
        expect(result.type).toBe('command');
        expect(result.command).toBe('note');
        expect(result.args).toBe('multiple spaces');
    });

    it('trims input before parsing', () => {
        const result = parseSlashCommand('  /help  ');
        expect(result.type).toBe('command');
        expect(result.command).toBe('help');
    });

    it('handles null/undefined input gracefully', () => {
        expect(parseSlashCommand(null as any)).toEqual({ type: 'message' });
        expect(parseSlashCommand(undefined as any)).toEqual({ type: 'message' });
    });
});

// ── slashHelpText ───────────────────────────────────────────────────

describe('slashHelpText', () => {
    it('returns help text for built-in commands', () => {
        const text = slashHelpText();
        expect(text).toContain('/help');
        expect(text).toContain('/note');
        expect(text).toContain('/clear');
    });

    it('includes custom commands when provided', () => {
        const text = slashHelpText(sampleCustomCommands);
        expect(text).toContain('/translate');
        expect(text).toContain('/coder');
        expect(text).toContain('Custom Commands');
    });

    it('does not show custom section when no custom commands', () => {
        const text = slashHelpText();
        expect(text).not.toContain('Custom Commands');
    });

    it('each command has a description', () => {
        const text = slashHelpText();
        const lines = text.split('\n').filter(l => l.startsWith('/'));
        for (const line of lines) {
            expect(line).toContain('—');
        }
    });
});

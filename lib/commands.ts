/**
 * Slash command parsing — zero Obsidian dependency.
 *
 * All command parsing, suggestion, and help-text generation is pure logic
 * that can run in any environment.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface CommandDef {
    name: string;
    description: string;
}

export interface CustomCommandInput {
    name: string;
    description?: string;
    systemPrompt?: string;
}

export interface ParsedCommand {
    type: 'message' | 'command' | 'custom' | 'unknown';
    command?: string;
    args?: string;
    systemPrompt?: string;
}

// ── Built-in slash commands ─────────────────────────────────────────

const BUILT_IN_COMMANDS: CommandDef[] = [
    { name: 'help', description: 'Show command list' },
    { name: 'note', description: 'Add active note content as context' },
    { name: 'selection', description: 'Add selected text as context' },
    { name: 'regen', description: 'Regenerate last response' },
    { name: 'iterate', description: 'Toggle iterate mode' },
    { name: 'clear', description: 'Clear current chat' },
    { name: 'export', description: 'Export current chat to a note' },
    { name: 'new', description: 'Start a new conversation' },
    { name: 'rename', description: 'Rename current conversation' },
    { name: 'duplicate', description: 'Duplicate current conversation' },
    { name: 'model', description: 'Open model picker' },
    { name: 'settings', description: 'Open plugin settings' },
    { name: 'usage', description: 'Show Copilot usage quota' },
    { name: 'pin', description: 'Toggle pin on current conversation' },
    { name: 'info', description: 'Show current conversation info' },
    { name: 'stats', description: 'Show vault-wide chat statistics' },
    { name: 'favorites', description: 'Show favorited (thumbs-up) messages' },
    { name: 'search', description: 'Search across all conversations' },
    { name: 'undo', description: 'Remove last user message and response' },
    { name: 'summary', description: 'Show conversation summary (messages, cost, model)' },
    { name: 'profile', description: 'Show your learned user profile' },
    { name: 'agent', description: 'Switch AI persona (e.g. /agent code-expert)' },
];

const BUILT_IN_NAMES = new Set(BUILT_IN_COMMANDS.map(c => c.name));

export function getBuiltInCommands(): CommandDef[] {
    return BUILT_IN_COMMANDS;
}

export function getAllCommands(customCommands: CustomCommandInput[] = []) {
    return [
        ...BUILT_IN_COMMANDS.map(c => ({ ...c, type: 'built-in' as const })),
        ...customCommands.map(c => ({
            name: c.name,
            description: c.description || 'Custom prompt',
            systemPrompt: c.systemPrompt,
            type: 'custom' as const,
        })),
    ];
}

export function getCommandSuggestions(input: string, customCommands: CustomCommandInput[] = []) {
    if (!input.startsWith('/')) return [];
    const query = input.slice(1).toLowerCase();
    const all = getAllCommands(customCommands);
    if (!query) return all;
    return all.filter(c => c.name.toLowerCase().startsWith(query));
}

export function parseSlashCommand(input: string, customCommands: CustomCommandInput[] = []): ParsedCommand {
    const raw = (input || '').trim();
    if (!raw.startsWith('/')) return { type: 'message' };

    const withoutSlash = raw.slice(1).trim();
    if (!withoutSlash) return { type: 'command', command: 'help', args: '' };

    const [commandRaw, ...rest] = withoutSlash.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const args = rest.join(' ').trim();

    if (BUILT_IN_NAMES.has(command)) {
        return { type: 'command', command, args };
    }

    const custom = customCommands.find(c => c.name.toLowerCase() === command);
    if (custom) {
        return { type: 'custom', command: custom.name, args, systemPrompt: custom.systemPrompt };
    }

    return { type: 'unknown', command, args };
}

export function slashHelpText(customCommands: CustomCommandInput[] = []): string {
    const lines = BUILT_IN_COMMANDS.map(c => `/${c.name} — ${c.description}`);
    if (customCommands.length) {
        lines.push('', '── Custom Commands ──');
        for (const c of customCommands) {
            lines.push(`/${c.name} — ${c.description || 'Custom prompt'}`);
        }
    }
    lines.push(
        '', '── Keyboard Shortcuts ──',
        'Enter — Send message',
        'Shift+Enter — New line',
        '↑/↓ — Navigate message history',
        'Ctrl/Cmd+L — Focus chat input',
        'Ctrl/Cmd+F — Search in conversation',
        'Ctrl/Cmd+N — New conversation',
        'Ctrl/Cmd+Shift+E — Export chat',
        'Ctrl/Cmd+Shift+Z — Undo last exchange',
        'Ctrl/Cmd+Shift+R — Regenerate last response',
        'Ctrl+Shift+M — Switch model',
        'Alt+\\ — Trigger inline suggestion',
        'Escape — Stop generation / close search',
        '',
        '── Tips ──',
        '@filename — Attach a note as context',
        'Drag & drop files into the chat input',
        'Click the 📎 icon to attach the active note',
    );
    return lines.join('\n');
}

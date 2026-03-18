/**
 * Slash commands — re-exported from lib/ (single source of truth).
 * All command parsing logic is pure and lives in lib/commands.ts.
 */

export {
    getBuiltInCommands,
    getAllCommands,
    getCommandSuggestions,
    parseSlashCommand,
    slashHelpText,
} from '../lib/commands';

export type { CommandDef, ParsedCommand } from '../lib/commands';

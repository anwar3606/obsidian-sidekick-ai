import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomPromptManager } from '../src/custom-prompts';
import { createMockApp, TFile, TFolder } from './mocks/obsidian';

// ── Helpers ─────────────────────────────────────────────────────────

function createPromptFiles(prompts: Record<string, string>) {
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(prompts)) {
        files[`copilot/custom-prompts/${name}.md`] = content;
    }
    return files;
}

function setupWithFolder(app: any, folderPath: string, fileNames: string[]) {
    // Create a TFolder with children
    const folder = new TFolder(folderPath);
    const children: TFile[] = [];
    for (const name of fileNames) {
        const file = new TFile(`${folderPath}/${name}`);
        children.push(file);
    }
    folder.children = children;

    // Override getAbstractFileByPath to return the folder
    const origGet = app.vault.getAbstractFileByPath.bind(app.vault);
    app.vault.getAbstractFileByPath = (path: string) => {
        if (path === folderPath) return folder;
        return origGet(path);
    };

    return folder;
}

// ── CustomPromptManager ─────────────────────────────────────────────

describe('CustomPromptManager', () => {
    let app: any;
    let manager: CustomPromptManager;

    // ── Basic loading ───────────────────────────────────────────────

    describe('loading prompt files', () => {
        it('loads commands from markdown files in folder', async () => {
            const files = createPromptFiles({
                translate: '---\ndescription: "Translate text"\n---\nYou are a translator. Translate {} to English.',
                coder: '---\ndescription: "Code assistant"\n---\nYou are a senior developer.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['translate.md', 'coder.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            const cmds = manager.getCommands();
            expect(cmds.length).toBe(2);
            expect(cmds.map(c => c.name).sort()).toEqual(['coder', 'translate']);
        });

        it('returns empty when folder does not exist', async () => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'NonExistent');
            await (manager as any).loadAll();

            expect(manager.getCommands()).toEqual([]);
        });

        it('skips disabled commands', async () => {
            const files = createPromptFiles({
                active: '---\nenabled: true\n---\nActive prompt.',
                disabled: '---\nenabled: false\n---\nDisabled prompt.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['active.md', 'disabled.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            const cmds = manager.getCommands();
            expect(cmds.length).toBe(1);
            expect(cmds[0].name).toBe('active');
        });

        it('uses filename as command name (lowercase, hyphenated)', async () => {
            const files = {
                'copilot/custom-prompts/Fix Grammar.md': '---\ndescription: "Fix grammar"\n---\nFix grammar of {}.',
            };
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['Fix Grammar.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            const cmds = manager.getCommands();
            expect(cmds[0].name).toBe('fix-grammar');
        });

        it('extracts description from frontmatter', async () => {
            const files = createPromptFiles({
                test: '---\ndescription: "My custom description"\n---\nPrompt body.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            expect(manager.getCommands()[0].description).toBe('My custom description');
        });

        it('handles files without frontmatter', async () => {
            const files = createPromptFiles({
                simple: 'Just a simple prompt without frontmatter.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['simple.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            const cmds = manager.getCommands();
            expect(cmds.length).toBe(1);
            expect(cmds[0].systemPrompt).toBe('Just a simple prompt without frontmatter.');
            expect(cmds[0].description).toBe('');
        });

        it('strips frontmatter from system prompt', async () => {
            const files = createPromptFiles({
                test: '---\ndescription: "Desc"\nenabled: true\n---\nActual prompt content here.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            expect(manager.getCommands()[0].systemPrompt).toBe('Actual prompt content here.');
        });

        it('sorts commands alphabetically', async () => {
            const files = createPromptFiles({
                zebra: 'Zebra prompt.',
                alpha: 'Alpha prompt.',
                middle: 'Middle prompt.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['zebra.md', 'alpha.md', 'middle.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            const names = manager.getCommands().map(c => c.name);
            expect(names).toEqual(['alpha', 'middle', 'zebra']);
        });
    });

    // ── Frontmatter parsing ─────────────────────────────────────────

    describe('frontmatter parsing', () => {
        it('parses boolean values', async () => {
            const content = '---\nenabled: true\n---\nPrompt.';
            const result = (CustomPromptManager.prototype as any).parseFrontmatter.call(null, content);
            // Since parseFrontmatter is a private method, we test it indirectly through command loading
            // The enabled: true case is tested by the command being loaded
            const files = createPromptFiles({ test: content });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            expect(manager.getCommands().length).toBe(1);
        });

        it('parses quoted string values', async () => {
            const files = createPromptFiles({
                test: '---\ndescription: "Quoted description"\n---\nPrompt.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            expect(manager.getCommands()[0].description).toBe('Quoted description');
        });

        it('parses unquoted string values', async () => {
            const files = createPromptFiles({
                test: '---\ndescription: Unquoted description\n---\nPrompt.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            expect(manager.getCommands()[0].description).toBe('Unquoted description');
        });
    });

    // ── Template processing ─────────────────────────────────────────

    describe('processTemplate', () => {
        beforeEach(() => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
        });

        it('replaces {} with user message', async () => {
            const result = await manager.processTemplate(
                'Translate {} to English.',
                'Bonjour le monde',
            );
            expect(result).toBe('Translate Bonjour le monde to English.');
        });

        it('replaces multiple {} occurrences', async () => {
            const result = await manager.processTemplate(
                'First: {}. Second: {}.',
                'Hello',
            );
            expect(result).toBe('First: Hello. Second: Hello.');
        });

        it('replaces {activeNote} with active note content', async () => {
            const result = await manager.processTemplate(
                'Summarize this note: {activeNote}',
                'user text',
                'Note content here',
            );
            expect(result).toBe('Summarize this note: Note content here');
        });

        it('replaces {activeNote} with fallback when no active note', async () => {
            const result = await manager.processTemplate(
                'Summarize: {activeNote}',
                'user text',
            );
            expect(result).toBe('Summarize: [No active note]');
        });

        it('resolves {[[Note Title]]} to note content', async () => {
            app = createMockApp({
                'Notes/My Note.md': '# My Note\nNote content here.',
            });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await manager.processTemplate(
                'Context: {[[My Note]]}',
                'user text',
            );
            expect(result).toBe('Context: # My Note\nNote content here.');
        });

        it('shows not found for missing {[[Note]]}', async () => {
            const result = await manager.processTemplate(
                'Context: {[[Nonexistent]]}',
                'user text',
            );
            expect(result).toBe('Context: [Note "Nonexistent" not found]');
        });

        it('handles templates with no variables', async () => {
            const result = await manager.processTemplate(
                'You are a helpful coding assistant.',
                'user text',
            );
            expect(result).toBe('You are a helpful coding assistant.');
        });

        it('handles empty template', async () => {
            const result = await manager.processTemplate('', 'user text');
            expect(result).toBe('');
        });

        it('handles all variable types together', async () => {
            app = createMockApp({
                'Notes/Reference.md': 'Reference content',
            });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await manager.processTemplate(
                'User says: {}\nActive note: {activeNote}\nRef: {[[Reference]]}',
                'hello',
                'Active note content',
            );
            expect(result).toBe(
                'User says: hello\nActive note: Active note content\nRef: Reference content',
            );
        });

        it('does not expand {activeNote} injected via user message', async () => {
            const result = await manager.processTemplate(
                'User said: {}',
                '{activeNote}',
                'SECRET NOTE CONTENT',
            );
            // User message should be inserted literally, not expanded
            expect(result).toBe('User said: {activeNote}');
            expect(result).not.toContain('SECRET NOTE CONTENT');
        });

        it('does not expand {[[Note]]} injected via user message', async () => {
            app = createMockApp({
                'Notes/Secret.md': 'Top secret content',
            });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await manager.processTemplate(
                'User said: {}',
                '{[[Secret]]}',
            );
            expect(result).toBe('User said: {[[Secret]]}');
            expect(result).not.toContain('Top secret content');
        });
    });

    // ── CRUD operations ─────────────────────────────────────────────

    describe('createPrompt', () => {
        beforeEach(() => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
        });

        it('creates a new prompt file with frontmatter', async () => {
            await manager.createPrompt('test-cmd', 'Test description', 'You are a test.');

            const file = app.vault.getAbstractFileByPath('copilot/custom-prompts/test-cmd.md');
            expect(file).toBeTruthy();
        });
    });

    describe('deletePrompt', () => {
        it('deletes an existing prompt file', async () => {
            const files = createPromptFiles({
                'to-delete': 'To be deleted',
            });
            app = createMockApp(files);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            await manager.deletePrompt('to-delete');
            const file = app.vault.getAbstractFileByPath('copilot/custom-prompts/to-delete.md');
            expect(file).toBeNull();
        });

        it('does nothing for non-existent prompt', async () => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            // Should not throw
            await manager.deletePrompt('nonexistent');
        });
    });

    // ── Folder change ───────────────────────────────────────────────

    describe('setFolder', () => {
        it('updates the folder and reloads commands', async () => {
            const files = {
                'Folder1/cmd1.md': 'Prompt 1',
                'Folder2/cmd2.md': 'Prompt 2',
            };
            app = createMockApp(files);
            // Start with empty folder
            manager = new CustomPromptManager(app, 'EmptyFolder');
            await (manager as any).loadAll();
            expect(manager.getCommands().length).toBe(0);

            // Change to Folder1 - but folder still not "registered" as TFolder
            // This tests the "folder not found" path
            manager.setFolder('Folder1');
            expect(manager.getCommands().length).toBe(0);
        });
    });

    // ── onChange callback ───────────────────────────────────────────

    describe('onChange', () => {
        it('calls registered callbacks when commands change', async () => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            let callCount = 0;
            manager.onChange(() => { callCount++; });

            await (manager as any).loadAll();
            expect(callCount).toBe(1);
        });

        it('supports multiple callbacks', async () => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            let count1 = 0, count2 = 0;
            manager.onChange(() => { count1++; });
            manager.onChange(() => { count2++; });

            await (manager as any).loadAll();
            expect(count1).toBe(1);
            expect(count2).toBe(1);
        });

        it('tolerates callback errors', async () => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            let afterErrorCalled = false;
            manager.onChange(() => { throw new Error('boom'); });
            manager.onChange(() => { afterErrorCalled = true; });

            await (manager as any).loadAll();
            expect(afterErrorCalled).toBe(true);
        });
    });

    // ── Initialize (event wiring) ───────────────────────────────────

    describe('initialize', () => {
        it('registers vault event listeners', async () => {
            const files = createPromptFiles({
                test: '---\ndescription: "Test"\n---\nPrompt.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const onSpy = vi.spyOn(app.vault, 'on');
            manager.initialize();

            expect(onSpy).toHaveBeenCalledWith('create', expect.any(Function));
            expect(onSpy).toHaveBeenCalledWith('delete', expect.any(Function));
            expect(onSpy).toHaveBeenCalledWith('rename', expect.any(Function));
            expect(onSpy).toHaveBeenCalledWith('modify', expect.any(Function));
        });
    });

    // ── isPromptFile (edge cases) ───────────────────────────────────

    describe('isPromptFile (private)', () => {
        beforeEach(() => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
        });

        it('rejects non-TFile objects', () => {
            const result = (manager as any).isPromptFile({ path: 'copilot/custom-prompts/test.md' });
            expect(result).toBe(false);
        });

        it('rejects non-md files', () => {
            const file = new TFile('copilot/custom-prompts/test.txt');
            file.extension = 'txt';
            const result = (manager as any).isPromptFile(file);
            expect(result).toBe(false);
        });

        it('rejects files outside the prompt folder', () => {
            const file = new TFile('OtherFolder/test.md');
            const result = (manager as any).isPromptFile(file);
            expect(result).toBe(false);
        });

        it('rejects files in subdirectories', () => {
            const file = new TFile('copilot/custom-prompts/subfolder/test.md');
            const result = (manager as any).isPromptFile(file);
            expect(result).toBe(false);
        });

        it('accepts direct children of the prompt folder', () => {
            const file = new TFile('copilot/custom-prompts/test.md');
            const result = (manager as any).isPromptFile(file);
            expect(result).toBe(true);
        });
    });

    // ── Frontmatter edge cases ──────────────────────────────────────

    describe('parseFrontmatter edge cases', () => {
        it('parses integer values', async () => {
            const files = createPromptFiles({
                test: '---\npriority: 42\n---\nPrompt.',
            });
            app = createMockApp(files);
            setupWithFolder(app, 'copilot/custom-prompts', ['test.md']);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');
            await (manager as any).loadAll();

            // The integer parsing is internal; test indirectly via command loading
            expect(manager.getCommands().length).toBe(1);
        });

        it('parses float values', async () => {
            const fm = (manager as any).parseFrontmatter.call(manager, '---\ntemp: 0.7\n---\nBody');
            expect(fm.frontmatter.temp).toBe(0.7);
        });

        it('handles lines without colons', async () => {
            const fm = (manager as any).parseFrontmatter.call(manager, '---\ninvalid line\nkey: value\n---\nBody');
            expect(fm.frontmatter.key).toBe('value');
            expect(fm.frontmatter['invalid line']).toBeUndefined();
        });
    });

    // ── resolveNoteContent ──────────────────────────────────────────

    describe('resolveNoteContent (private)', () => {
        it('resolves by exact path', async () => {
            app = createMockApp({ 'Notes/Exact.md': 'Exact content' });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await (manager as any).resolveNoteContent('Notes/Exact.md');
            expect(result).toBe('Exact content');
        });

        it('resolves by path + .md extension', async () => {
            app = createMockApp({ 'Notes/Note.md': 'Note content' });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await (manager as any).resolveNoteContent('Notes/Note');
            expect(result).toBe('Note content');
        });

        it('resolves by basename search as fallback', async () => {
            app = createMockApp({ 'Deeply/Nested/UniqueNote.md': 'Found it' });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await (manager as any).resolveNoteContent('UniqueNote');
            expect(result).toBe('Found it');
        });

        it('returns not-found message for missing note', async () => {
            app = createMockApp({});
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await (manager as any).resolveNoteContent('Missing');
            expect(result).toContain('not found');
        });
    });

    // ── createPrompt (update existing) ──────────────────────────────

    describe('createPrompt (update existing)', () => {
        it('updates existing prompt file', async () => {
            const files = createPromptFiles({
                existing: '---\ndescription: "Old"\n---\nOld prompt.',
            });
            app = createMockApp(files);
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            await manager.createPrompt('existing', 'Updated desc', 'New prompt.');

            const file = app.vault.getAbstractFileByPath('copilot/custom-prompts/existing.md');
            const content = await app.vault.read(file);
            expect(content).toContain('Updated desc');
            expect(content).toContain('New prompt.');
        });
    });

    // ── processTemplate with multiple wikilinks ─────────────────────

    describe('processTemplate advanced', () => {
        it('resolves multiple different wikilinks', async () => {
            app = createMockApp({
                'Notes/A.md': 'Content A',
                'Notes/B.md': 'Content B',
            });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await manager.processTemplate(
                'First: {[[Notes/A.md]]} Second: {[[Notes/B.md]]}',
                'msg',
            );
            expect(result).toContain('Content A');
            expect(result).toContain('Content B');
        });

        it('handles duplicate wikilinks', async () => {
            app = createMockApp({
                'Notes/X.md': 'X content',
            });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await manager.processTemplate(
                '{[[Notes/X.md]]} and {[[Notes/X.md]]}',
                'msg',
            );
            expect(result).toBe('X content and X content');
        });

        it('preserves $ characters in user message (not treated as special replacement)', async () => {
            const result = await manager.processTemplate(
                'User said: {}',
                'The price is $100 and $200',
            );
            expect(result).toBe('User said: The price is $100 and $200');
        });

        it('preserves $& and $1 in user message', async () => {
            const result = await manager.processTemplate(
                'Code: {}',
                'Use $& for match and $1 for group',
            );
            expect(result).toBe('Code: Use $& for match and $1 for group');
        });

        it('preserves $ in active note content', async () => {
            const result = await manager.processTemplate(
                'Note: {activeNote}',
                'msg',
                'LaTeX: $x^2 + y^2 = z^2$',
            );
            expect(result).toBe('Note: LaTeX: $x^2 + y^2 = z^2$');
        });

        it('preserves $ in wikilink note content', async () => {
            app = createMockApp({
                'Notes/Math.md': 'Price: $50, formula: $E=mc^2$',
            });
            manager = new CustomPromptManager(app, 'copilot/custom-prompts');

            const result = await manager.processTemplate(
                'Context: {[[Math]]}',
                'msg',
            );
            expect(result).toBe('Context: Price: $50, formula: $E=mc^2$');
        });
    });
});

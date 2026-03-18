/**
 * Unit tests for lib/tools.ts pure functions — parseMarkdownOutline, extractMarkdownSection.
 * These test the zero-dependency markdown parsing logic directly.
 */

import { describe, it, expect } from 'vitest';
import { parseMarkdownOutline, extractMarkdownSection, TOOL_SCHEMAS, RISKY_TOOLS, TOOL_LABELS, toResponsesFormat, getEnabledTools, getEnabledToolsForResponses } from '../lib/tools';
import type { ApiSettings } from '../lib/types';

// ── parseMarkdownOutline ────────────────────────────────────────────

describe('parseMarkdownOutline', () => {
    it('extracts headings with levels and line numbers', () => {
        const content = [
            '# Title',
            'Some text.',
            '## Section A',
            '### Sub A1',
            '## Section B',
        ].join('\n');
        const headings = parseMarkdownOutline(content);
        expect(headings).toEqual([
            { heading: 'Title', level: 1, line: 1 },
            { heading: 'Section A', level: 2, line: 3 },
            { heading: 'Sub A1', level: 3, line: 4 },
            { heading: 'Section B', level: 2, line: 5 },
        ]);
    });

    it('returns empty array for no headings', () => {
        expect(parseMarkdownOutline('Just plain text.')).toEqual([]);
    });

    it('returns empty array for empty content', () => {
        expect(parseMarkdownOutline('')).toEqual([]);
    });

    it('ignores headings inside fenced code blocks (```)', () => {
        const content = [
            '# Real',
            '```',
            '## Inside Code',
            '```',
            '## Also Real',
        ].join('\n');
        const headings = parseMarkdownOutline(content);
        expect(headings).toHaveLength(2);
        expect(headings[0].heading).toBe('Real');
        expect(headings[1].heading).toBe('Also Real');
    });

    it('ignores headings inside tilde code blocks (~~~)', () => {
        const content = [
            '# Top',
            '~~~',
            '## Hidden',
            '~~~',
            '## Visible',
        ].join('\n');
        const headings = parseMarkdownOutline(content);
        expect(headings).toHaveLength(2);
        expect(headings[0].heading).toBe('Top');
        expect(headings[1].heading).toBe('Visible');
    });

    it('handles all 6 heading levels', () => {
        const content = [
            '# H1',
            '## H2',
            '### H3',
            '#### H4',
            '##### H5',
            '###### H6',
        ].join('\n');
        const headings = parseMarkdownOutline(content);
        expect(headings).toHaveLength(6);
        for (let i = 0; i < 6; i++) {
            expect(headings[i].level).toBe(i + 1);
        }
    });

    it('ignores lines with # but no space (not valid ATX heading)', () => {
        const content = '#NoSpace\n#Not a heading\n# Valid Heading';
        const headings = parseMarkdownOutline(content);
        expect(headings).toHaveLength(1);
        expect(headings[0].heading).toBe('Valid Heading');
    });

    it('handles headings with trailing hashes', () => {
        const content = '## Section ## \n### Sub ###';
        const headings = parseMarkdownOutline(content);
        // Trailing hashes are part of the heading text (we return raw match)
        expect(headings).toHaveLength(2);
    });

    it('handles consecutive headings with no content between them', () => {
        const content = '# A\n## B\n### C';
        const headings = parseMarkdownOutline(content);
        expect(headings).toHaveLength(3);
    });
});

// ── extractMarkdownSection ──────────────────────────────────────────

describe('extractMarkdownSection', () => {
    const projectDoc = [
        '# Project Overview',       // line 1
        'Introduction text.',        // line 2
        '',                          // line 3
        '## Architecture',           // line 4
        'Design details here.',      // line 5
        '',                          // line 6
        '### Frontend',              // line 7
        'React components.',         // line 8
        '',                          // line 9
        '### Backend',               // line 10
        'API layer.',                // line 11
        '',                          // line 12
        '## Deployment',             // line 13
        'CI/CD pipeline.',           // line 14
    ].join('\n');

    it('extracts section including child headings by default', () => {
        const result = extractMarkdownSection(projectDoc, 'Architecture');
        expect(result).not.toBeNull();
        expect(result!.heading).toBe('Architecture');
        expect(result!.level).toBe(2);
        expect(result!.startLine).toBe(4);
        expect(result!.endLine).toBe(12);
        expect(result!.content).toContain('Design details');
        expect(result!.content).toContain('Frontend');
        expect(result!.content).toContain('Backend');
        expect(result!.content).not.toContain('Deployment');
    });

    it('stops at child heading when includeChildren is false', () => {
        const result = extractMarkdownSection(projectDoc, 'Architecture', false);
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(4);
        expect(result!.endLine).toBe(6);
        expect(result!.content).toContain('Design details');
        expect(result!.content).not.toContain('Frontend');
    });

    it('reads last section to end of file', () => {
        const result = extractMarkdownSection(projectDoc, 'Deployment');
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(13);
        expect(result!.endLine).toBe(14);
        expect(result!.content).toContain('CI/CD pipeline');
    });

    it('is case-insensitive', () => {
        const result = extractMarkdownSection(projectDoc, 'frontend');
        expect(result).not.toBeNull();
        expect(result!.heading).toBe('Frontend');
    });

    it('returns null for non-existent heading', () => {
        expect(extractMarkdownSection(projectDoc, 'Nonexistent')).toBeNull();
    });

    it('returns null for empty content', () => {
        expect(extractMarkdownSection('', 'Anything')).toBeNull();
    });

    it('handles top-level heading spanning to EOF when only H1', () => {
        const result = extractMarkdownSection(projectDoc, 'Project Overview');
        expect(result).not.toBeNull();
        // Only one H1, so it goes to end of file
        expect(result!.startLine).toBe(1);
        expect(result!.endLine).toBe(14);
    });

    it('extracts leaf section (### with no children)', () => {
        const result = extractMarkdownSection(projectDoc, 'Frontend');
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(7);
        expect(result!.endLine).toBe(9); // stops at ### Backend
        expect(result!.content).toContain('React components');
        expect(result!.content).not.toContain('API layer');
    });

    it('handles document with only one heading', () => {
        const content = '## Only Heading\nSome content\nMore content';
        const result = extractMarkdownSection(content, 'Only Heading');
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(1);
        expect(result!.endLine).toBe(3);
        expect(result!.content).toContain('Some content');
        expect(result!.content).toContain('More content');
    });
});

// ── TOOL_SCHEMAS validation ─────────────────────────────────────────

describe('TOOL_SCHEMAS', () => {
    it('all schemas have type "function"', () => {
        for (const tool of TOOL_SCHEMAS) {
            expect(tool.type).toBe('function');
        }
    });

    it('all schemas have name, description, and parameters', () => {
        for (const tool of TOOL_SCHEMAS) {
            expect(tool.function.name).toBeTruthy();
            expect(tool.function.description).toBeTruthy();
            expect(tool.function.parameters).toBeTruthy();
            expect(tool.function.parameters.type).toBe('object');
        }
    });

    it('all schema names are unique', () => {
        const names = TOOL_SCHEMAS.map(t => t.function.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('all required fields exist in properties', () => {
        for (const tool of TOOL_SCHEMAS) {
            const props = Object.keys(tool.function.parameters.properties || {});
            for (const req of tool.function.parameters.required || []) {
                expect(props).toContain(req);
            }
        }
    });
});

// ── RISKY_TOOLS & TOOL_LABELS ───────────────────────────────────────

describe('RISKY_TOOLS', () => {
    it('contains only known tool names', () => {
        const knownNames = new Set(TOOL_SCHEMAS.map(t => t.function.name));
        for (const name of RISKY_TOOLS) {
            expect(knownNames.has(name)).toBe(true);
        }
    });

    it('includes destructive tools', () => {
        expect(RISKY_TOOLS.has('delete_note')).toBe(true);
        expect(RISKY_TOOLS.has('create_note')).toBe(true);
        expect(RISKY_TOOLS.has('edit_note')).toBe(true);
    });

    it('does not include read-only tools', () => {
        expect(RISKY_TOOLS.has('search_vault')).toBe(false);
        expect(RISKY_TOOLS.has('read_note')).toBe(false);
        expect(RISKY_TOOLS.has('list_files')).toBe(false);
    });
});

describe('TOOL_LABELS', () => {
    it('has a label for every tool schema', () => {
        for (const tool of TOOL_SCHEMAS) {
            expect(TOOL_LABELS[tool.function.name]).toBeTruthy();
        }
    });
});

// ── toResponsesFormat ───────────────────────────────────────────────

describe('toResponsesFormat', () => {
    it('converts nested format to flat format', () => {
        const input = [TOOL_SCHEMAS[0]];
        const result = toResponsesFormat(input);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('function');
        expect(result[0].name).toBe(input[0].function.name);
        expect(result[0].description).toBe(input[0].function.description);
        expect(result[0].parameters).toBe(input[0].function.parameters);
    });

    it('converts all schemas', () => {
        const result = toResponsesFormat(TOOL_SCHEMAS);
        expect(result).toHaveLength(TOOL_SCHEMAS.length);
        for (let i = 0; i < TOOL_SCHEMAS.length; i++) {
            expect(result[i].name).toBe(TOOL_SCHEMAS[i].function.name);
        }
    });

    it('returns empty array for empty input', () => {
        expect(toResponsesFormat([])).toEqual([]);
    });
});

// ── getEnabledTools ─────────────────────────────────────────────────

describe('getEnabledTools', () => {
    const baseSettings: ApiSettings = {
        toolsEnabled: true,
        disabledTools: [],
        iterateMode: false,
    } as ApiSettings;

    it('returns all tools when all enabled', () => {
        const result = getEnabledTools(baseSettings);
        expect(result).toBeDefined();
        // web_search excluded (webSearchEnabled not set), reddit (2), jira (5), remember_user_fact excluded (no config)
        expect(result!.length).toBe(TOOL_SCHEMAS.length - 9);
    });

    it('returns undefined when tools disabled and iterate off', () => {
        const result = getEnabledTools({ ...baseSettings, toolsEnabled: false });
        expect(result).toBeUndefined();
    });

    it('excludes disabled tools', () => {
        const result = getEnabledTools({ ...baseSettings, disabledTools: ['fetch_url', 'generate_image'] });
        expect(result).toBeDefined();
        expect(result!.some(t => t.function.name === 'fetch_url')).toBe(false);
        expect(result!.some(t => t.function.name === 'generate_image')).toBe(false);
        // web_search also excluded (webSearchEnabled not set), reddit (2), jira (5), remember_user_fact excluded (no config), so -11
        expect(result!.length).toBe(TOOL_SCHEMAS.length - 11);
    });

    it('forces ask_user in iterate mode even when tools disabled', () => {
        const result = getEnabledTools({ ...baseSettings, toolsEnabled: false, iterateMode: true });
        expect(result).toBeDefined();
        expect(result!.length).toBe(1);
        expect(result![0].function.name).toBe('ask_user');
    });

    it('does not duplicate ask_user in iterate mode when already enabled', () => {
        const result = getEnabledTools({ ...baseSettings, iterateMode: true });
        expect(result).toBeDefined();
        const askUserCount = result!.filter(t => t.function.name === 'ask_user').length;
        expect(askUserCount).toBe(1);
    });

    it('excludes web_search when webSearchEnabled is false', () => {
        const result = getEnabledTools({ ...baseSettings, webSearchEnabled: false });
        expect(result).toBeDefined();
        expect(result!.some(t => t.function.name === 'web_search')).toBe(false);
    });

    it('excludes web_search when webSearchEnabled is undefined', () => {
        const result = getEnabledTools({ ...baseSettings });
        expect(result).toBeDefined();
        expect(result!.some(t => t.function.name === 'web_search')).toBe(false);
    });

    it('includes web_search when webSearchEnabled is true', () => {
        const result = getEnabledTools({ ...baseSettings, webSearchEnabled: true });
        expect(result).toBeDefined();
        expect(result!.some(t => t.function.name === 'web_search')).toBe(true);
    });

    it('includes MCP tools from settings.mcpTools', () => {
        const mcpTool = { type: 'function' as const, function: { name: 'mcp__github__search', description: 'Search GitHub', parameters: { type: 'object', properties: {} } } };
        const result = getEnabledTools({ ...baseSettings, mcpTools: [mcpTool] });
        expect(result).toBeDefined();
        expect(result!.some(t => t.function.name === 'mcp__github__search')).toBe(true);
    });

    it('excludes disabled MCP tools', () => {
        const mcpTool = { type: 'function' as const, function: { name: 'mcp__github__search', description: 'Search GitHub', parameters: { type: 'object', properties: {} } } };
        const result = getEnabledTools({ ...baseSettings, mcpTools: [mcpTool], disabledTools: ['mcp__github__search'] });
        expect(result).toBeDefined();
        expect(result!.some(t => t.function.name === 'mcp__github__search')).toBe(false);
    });

    it('does not include MCP tools when tools disabled', () => {
        const mcpTool = { type: 'function' as const, function: { name: 'mcp__github__search', description: 'Search GitHub', parameters: { type: 'object', properties: {} } } };
        const result = getEnabledTools({ ...baseSettings, toolsEnabled: false, mcpTools: [mcpTool] });
        // tools disabled, only ask_user if iterate mode
        expect(result).toBeUndefined();
    });
});

// ── getEnabledToolsForResponses ─────────────────────────────────────

describe('getEnabledToolsForResponses', () => {
    it('returns flat format tools', () => {
        const result = getEnabledToolsForResponses({
            toolsEnabled: true,
            disabledTools: [],
            iterateMode: false,
        } as ApiSettings);
        expect(result).toBeDefined();
        expect(result![0].name).toBeTruthy();
        expect((result![0] as any).function).toBeUndefined(); // flat, not nested
    });

    it('returns undefined when no tools enabled', () => {
        const result = getEnabledToolsForResponses({
            toolsEnabled: false,
            disabledTools: [],
            iterateMode: false,
        } as ApiSettings);
        expect(result).toBeUndefined();
    });
});

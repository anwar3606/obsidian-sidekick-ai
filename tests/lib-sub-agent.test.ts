import { describe, it, expect } from 'vitest';
import {
    ROLE_CONFIGS,
    VALID_ROLES,
    MAX_PARALLEL_AGENTS,
    MAX_TOKENS_PER_AGENT,
    MAX_SUB_AGENT_TOOL_ROUNDS,
    getToolsForRole,
    calculateTokenBudget,
    buildSubAgentMessages,
    validateSubAgentArgs,
    validateParallelAgentsArgs,
    formatSubAgentResults,
} from '../lib/sub-agent';
import type { SubAgentRole, SubAgentResult } from '../lib/sub-agent';
import { TOOL_SCHEMAS } from '../lib/tools';

describe('lib/sub-agent', () => {
    describe('ROLE_CONFIGS', () => {
        it('has all valid roles defined', () => {
            for (const role of VALID_ROLES) {
                expect(ROLE_CONFIGS[role]).toBeDefined();
                expect(ROLE_CONFIGS[role].tools.length).toBeGreaterThan(0);
                expect(ROLE_CONFIGS[role].systemPrompt).toBeTruthy();
            }
        });

        it('does not include delegate/spawn tools in any role', () => {
            for (const role of VALID_ROLES) {
                expect(ROLE_CONFIGS[role].tools).not.toContain('delegate_to_agent');
                expect(ROLE_CONFIGS[role].tools).not.toContain('spawn_parallel_agents');
            }
        });

        it('researcher has search + fetch tools', () => {
            const tools = ROLE_CONFIGS.researcher.tools;
            expect(tools).toContain('search_vault');
            expect(tools).toContain('fetch_url');
            expect(tools).toContain('web_search');
        });

        it('writer has create + edit tools', () => {
            const tools = ROLE_CONFIGS.writer.tools;
            expect(tools).toContain('create_note');
            expect(tools).toContain('edit_note');
        });
    });

    describe('getToolsForRole', () => {
        it('filters TOOL_SCHEMAS to role-allowed tools', () => {
            const tools = getToolsForRole(TOOL_SCHEMAS, 'researcher');
            const names = tools.map(t => t.function.name);
            expect(names).toContain('search_vault');
            expect(names).toContain('fetch_url');
            expect(names).not.toContain('create_note');
            expect(names).not.toContain('delegate_to_agent');
        });

        it('returns empty array for invalid role', () => {
            const tools = getToolsForRole(TOOL_SCHEMAS, 'invalid' as SubAgentRole);
            expect(tools).toEqual([]);
        });

        it('analyst gets read-only tools', () => {
            const tools = getToolsForRole(TOOL_SCHEMAS, 'analyst');
            const names = tools.map(t => t.function.name);
            expect(names).toContain('read_note');
            expect(names).toContain('search_vault');
            expect(names).not.toContain('create_note');
            expect(names).not.toContain('edit_note');
        });

        it('summarizer cannot write', () => {
            const tools = getToolsForRole(TOOL_SCHEMAS, 'summarizer');
            const names = tools.map(t => t.function.name);
            expect(names).not.toContain('create_note');
            expect(names).not.toContain('edit_note');
            expect(names).not.toContain('delete_note');
        });

        it('writer has both read and write tools', () => {
            const tools = getToolsForRole(TOOL_SCHEMAS, 'writer');
            const names = tools.map(t => t.function.name);
            expect(names).toContain('read_note');
            expect(names).toContain('create_note');
            expect(names).toContain('edit_note');
        });
    });

    describe('calculateTokenBudget', () => {
        it('reserves 20% for parent', () => {
            const budget = calculateTokenBudget(100000, 1);
            expect(budget.reservedForParent).toBe(20000);
            expect(budget.availableForAgents).toBe(80000);
        });

        it('splits budget across agents', () => {
            const budget = calculateTokenBudget(100000, 4);
            expect(budget.perAgent).toBe(Math.min(20000, MAX_TOKENS_PER_AGENT));
        });

        it('caps per-agent at MAX_TOKENS_PER_AGENT', () => {
            const budget = calculateTokenBudget(1000000, 1);
            expect(budget.perAgent).toBe(MAX_TOKENS_PER_AGENT);
        });

        it('clamps agent count to 1-MAX_PARALLEL_AGENTS', () => {
            const low = calculateTokenBudget(100000, 0);
            expect(low.perAgent).toBeGreaterThan(0);
            const high = calculateTokenBudget(100000, 100);
            expect(high.perAgent).toBe(Math.min(
                Math.floor(80000 / MAX_PARALLEL_AGENTS),
                MAX_TOKENS_PER_AGENT,
            ));
        });
    });

    describe('buildSubAgentMessages', () => {
        it('builds system + user messages', () => {
            const msgs = buildSubAgentMessages('Find info about X', 'researcher');
            expect(msgs).toHaveLength(2);
            expect(msgs[0].role).toBe('system');
            expect(msgs[0].content).toContain('research');
            expect(msgs[1].role).toBe('user');
            expect(msgs[1].content).toBe('Find info about X');
        });

        it('adds context with task in single message', () => {
            const msgs = buildSubAgentMessages('Task', 'analyst', 'Some context');
            expect(msgs).toHaveLength(2);
            expect(msgs[0].role).toBe('system');
            expect(msgs[1].role).toBe('user');
            expect((msgs[1].content as string)).toContain('Some context');
            expect((msgs[1].content as string)).toContain('Task');
        });

        it('throws for invalid role', () => {
            expect(() => buildSubAgentMessages('task', 'invalid' as SubAgentRole)).toThrow();
        });
    });

    describe('validateSubAgentArgs', () => {
        it('returns null for valid args', () => {
            expect(validateSubAgentArgs('task', 'researcher')).toBeNull();
        });

        it('rejects empty task', () => {
            expect(validateSubAgentArgs('', 'researcher')).toContain('empty');
        });

        it('rejects invalid role', () => {
            expect(validateSubAgentArgs('task', 'hacker')).toContain('Invalid role');
        });

        it('validates all valid roles', () => {
            for (const role of VALID_ROLES) {
                expect(validateSubAgentArgs('task', role)).toBeNull();
            }
        });
    });

    describe('validateParallelAgentsArgs', () => {
        it('returns null for valid args', () => {
            const agents = [
                { task: 'task1', role: 'researcher' },
                { task: 'task2', role: 'analyst' },
            ];
            expect(validateParallelAgentsArgs(agents)).toBeNull();
        });

        it('rejects empty array', () => {
            expect(validateParallelAgentsArgs([])).toContain('empty');
        });

        it('rejects too many agents', () => {
            const agents = Array.from({ length: MAX_PARALLEL_AGENTS + 1 }, (_, i) => ({
                task: `task${i}`, role: 'researcher',
            }));
            expect(validateParallelAgentsArgs(agents)).toContain('Maximum');
        });

        it('rejects invalid agent entries', () => {
            expect(validateParallelAgentsArgs([{ task: '', role: 'researcher' }])).toContain('empty');
            expect(validateParallelAgentsArgs([{ task: 'ok', role: 'invalid' }])).toContain('Invalid role');
        });

        it('rejects non-object entries', () => {
            expect(validateParallelAgentsArgs(['string' as any])).toContain('invalid');
        });
    });

    describe('formatSubAgentResults', () => {
        it('formats single result as plain text', () => {
            const results: SubAgentResult[] = [
                { role: 'researcher', task: 'find x', content: 'Found X', toolRounds: 2 },
            ];
            expect(formatSubAgentResults(results)).toBe('Found X');
        });

        it('formats single error result', () => {
            const results: SubAgentResult[] = [
                { role: 'analyst', task: 'analyze', content: '', toolRounds: 0, error: 'timeout' },
            ];
            expect(formatSubAgentResults(results)).toContain('failed');
            expect(formatSubAgentResults(results)).toContain('timeout');
        });

        it('formats multiple results with headers', () => {
            const results: SubAgentResult[] = [
                { role: 'researcher', task: 't1', content: 'Result A', toolRounds: 1 },
                { role: 'analyst', task: 't2', content: 'Result B', toolRounds: 0 },
            ];
            const text = formatSubAgentResults(results);
            expect(text).toContain('Agent 1');
            expect(text).toContain('researcher');
            expect(text).toContain('Result A');
            expect(text).toContain('Agent 2');
            expect(text).toContain('analyst');
            expect(text).toContain('Result B');
        });

        it('formats mixed success/error results', () => {
            const results: SubAgentResult[] = [
                { role: 'researcher', task: 't1', content: 'OK', toolRounds: 1 },
                { role: 'writer', task: 't2', content: '', toolRounds: 0, error: 'failed' },
            ];
            const text = formatSubAgentResults(results);
            expect(text).toContain('OK');
            expect(text).toContain('Error');
            expect(text).toContain('failed');
        });
    });

    describe('constants', () => {
        it('MAX_PARALLEL_AGENTS is 5', () => {
            expect(MAX_PARALLEL_AGENTS).toBe(5);
        });

        it('MAX_TOKENS_PER_AGENT is 8000', () => {
            expect(MAX_TOKENS_PER_AGENT).toBe(8000);
        });

        it('MAX_SUB_AGENT_TOOL_ROUNDS is 10', () => {
            expect(MAX_SUB_AGENT_TOOL_ROUNDS).toBe(10);
        });

        it('VALID_ROLES has exactly 4 roles', () => {
            expect(VALID_ROLES).toHaveLength(4);
        });
    });
});

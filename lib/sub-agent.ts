/**
 * Sub-Agent Delegation — Pure logic, zero Obsidian dependency.
 *
 * Defines sub-agent roles, tool filtering, token budgeting,
 * and message construction for delegated subtasks.
 */

import type { ChatCompletionTool, ApiMessage } from './types';

// ── Types ───────────────────────────────────────────────────────────

export type SubAgentRole = 'researcher' | 'analyst' | 'writer' | 'summarizer';

export interface RoleConfig {
    tools: string[];
    systemPrompt: string;
}

export interface TokenBudget {
    total: number;
    reservedForParent: number;
    availableForAgents: number;
    perAgent: number;
}

export interface SubAgentResult {
    role: SubAgentRole;
    task: string;
    content: string;
    toolRounds: number;
    error?: string;
}

// ── Role Definitions ────────────────────────────────────────────────

/** Tool allowlists and system prompts per role. */
export const ROLE_CONFIGS: Record<SubAgentRole, RoleConfig> = {
    researcher: {
        tools: ['search_vault', 'read_note', 'fetch_url', 'view_image', 'list_files', 'grep_search', 'web_search'],
        systemPrompt: 'You are a research assistant. Your job is to find and gather information relevant to the task. Use search and read tools to explore the vault and web. Return a comprehensive summary of your findings.',
    },
    analyst: {
        tools: ['read_note', 'search_vault', 'view_image', 'read_note_outline', 'read_note_section', 'get_backlinks', 'get_note_metadata'],
        systemPrompt: 'You are an analysis assistant. Your job is to analyze existing content and extract insights. Read notes carefully and provide structured analysis with key findings.',
    },
    writer: {
        tools: ['create_note', 'edit_note', 'read_note', 'search_vault', 'list_files'],
        systemPrompt: 'You are a writing assistant. Your job is to create or modify notes based on the task. Read existing content for context, then write or edit as needed. Be concise and well-structured.',
    },
    summarizer: {
        tools: ['read_note', 'search_vault', 'view_image', 'read_note_section'],
        systemPrompt: 'You are a summarization assistant. Your job is to read content and produce clear, concise summaries. Focus on key points and main ideas.',
    },
};

export const VALID_ROLES: SubAgentRole[] = ['researcher', 'analyst', 'writer', 'summarizer'];

/** Maximum number of parallel agents. */
export const MAX_PARALLEL_AGENTS = 5;

/** Maximum token budget per sub-agent. */
export const MAX_TOKENS_PER_AGENT = 8000;

/** Maximum tool rounds per sub-agent (simpler than parent). */
export const MAX_SUB_AGENT_TOOL_ROUNDS = 10;

/** Fraction of total budget reserved for the parent response. */
const PARENT_RESERVE_FRACTION = 0.2;

// ── Tool Filtering ──────────────────────────────────────────────────

/** Filter a list of ChatCompletionTool schemas to only those allowed for a role. */
export function getToolsForRole(
    allTools: ChatCompletionTool[],
    role: SubAgentRole,
): ChatCompletionTool[] {
    const config = ROLE_CONFIGS[role];
    if (!config) return [];
    const allowed = new Set(config.tools);
    // Never allow sub-agent to spawn more sub-agents
    return allTools.filter(t => allowed.has(t.function.name));
}

// ── Token Budgeting ─────────────────────────────────────────────────

/** Calculate token budget for sub-agents given total context limit. */
export function calculateTokenBudget(
    contextLimit: number,
    numAgents: number,
): TokenBudget {
    const clamped = Math.min(Math.max(numAgents, 1), MAX_PARALLEL_AGENTS);
    const reservedForParent = Math.floor(contextLimit * PARENT_RESERVE_FRACTION);
    const availableForAgents = contextLimit - reservedForParent;
    const perAgent = Math.min(
        Math.floor(availableForAgents / clamped),
        MAX_TOKENS_PER_AGENT,
    );
    return {
        total: contextLimit,
        reservedForParent,
        availableForAgents,
        perAgent,
    };
}

// ── Message Construction ────────────────────────────────────────────

/** Build the initial messages for a sub-agent. */
export function buildSubAgentMessages(
    task: string,
    role: SubAgentRole,
    context?: string,
): ApiMessage[] {
    const config = ROLE_CONFIGS[role];
    if (!config) throw new Error(`Invalid sub-agent role: ${role}`);

    const messages: ApiMessage[] = [
        { role: 'system', content: config.systemPrompt },
    ];

    // Combine context + task into single user message to save tokens
    if (context) {
        messages.push({
            role: 'user',
            content: `Context:\n${context}\n\nTask: ${task}`,
        });
    } else {
        messages.push({ role: 'user', content: task });
    }
    return messages;
}

/** Validate sub-agent arguments. Returns error message or null if valid. */
export function validateSubAgentArgs(
    task: string,
    role: string,
): string | null {
    if (!task || !task.trim()) return 'Task cannot be empty';
    if (!VALID_ROLES.includes(role as SubAgentRole)) {
        return `Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}`;
    }
    return null;
}

/** Validate parallel agents arguments. Returns error message or null if valid. */
export function validateParallelAgentsArgs(
    agents: unknown[],
): string | null {
    if (!Array.isArray(agents) || agents.length === 0) {
        return 'agents array cannot be empty';
    }
    if (agents.length > MAX_PARALLEL_AGENTS) {
        return `Maximum ${MAX_PARALLEL_AGENTS} parallel agents allowed`;
    }
    for (let i = 0; i < agents.length; i++) {
        const a = agents[i] as Record<string, unknown>;
        if (!a || typeof a !== 'object') return `Agent ${i}: invalid entry`;
        const err = validateSubAgentArgs(
            String(a.task ?? ''),
            String(a.role ?? ''),
        );
        if (err) return `Agent ${i}: ${err}`;
    }
    return null;
}

/** Format sub-agent results for the parent AI to consume. */
export function formatSubAgentResults(results: SubAgentResult[]): string {
    if (results.length === 1) {
        const r = results[0];
        if (r.error) return `Sub-agent (${r.role}) failed: ${r.error}`;
        return r.content;
    }
    return results.map((r, i) => {
        const header = `## Agent ${i + 1} (${r.role})`;
        if (r.error) return `${header}\n**Error:** ${r.error}`;
        return `${header}\n${r.content}`;
    }).join('\n\n');
}

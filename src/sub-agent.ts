/**
 * Sub-Agent Execution — Obsidian integration layer.
 *
 * Runs sub-agent tool loops using the existing streaming and tool
 * execution infrastructure. Sub-agents always use Chat Completions.
 */

import { App } from 'obsidian';
import { buildChatCompletionBody, formatToolResultForChatCompletions, formatAssistantToolCalls } from '../lib/api';
import { PROVIDERS } from '../lib/providers';
import { streamChatCompletions } from '../lib/streaming';
import {
    getToolsForRole,
    buildSubAgentMessages,
    MAX_SUB_AGENT_TOOL_ROUNDS,
    type SubAgentRole,
    type SubAgentResult,
    type TokenBudget,
} from '../lib/sub-agent';
import { TOOL_SCHEMAS } from '../lib/tools';
import type { ApiMessage, ModelInfo, ToolCall } from '../lib/types';
import type { PluginSettings, ToolContext, ToolExecutionResult } from './types';
import { executeTool } from './tools';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';

// Re-export lib types
export type { SubAgentRole, SubAgentResult, TokenBudget } from '../lib/sub-agent';
export {
    ROLE_CONFIGS,
    VALID_ROLES,
    MAX_PARALLEL_AGENTS,
    MAX_TOKENS_PER_AGENT,
    getToolsForRole,
    calculateTokenBudget,
    buildSubAgentMessages,
    validateSubAgentArgs,
    validateParallelAgentsArgs,
    formatSubAgentResults,
} from '../lib/sub-agent';

/** Execute a single sub-agent: stream response + tool loop. */
export async function executeSubAgent(
    task: string,
    role: SubAgentRole,
    app: App,
    settings: PluginSettings,
    cachedModels: ModelInfo[],
    budget: TokenBudget,
    toolContext: ToolContext,
    context?: string,
    signal?: AbortSignal,
): Promise<SubAgentResult> {
    debugLog.log('tool', `Sub-agent starting: role=${role}`, { task: task.substring(0, 100), budget: budget.perAgent });

    let accumulatedContent = '';
    let toolRounds = 0;

    try {
        // Build initial messages
        const messages: ApiMessage[] = buildSubAgentMessages(task, role, context);

        // Get role-filtered tools
        const roleTools = getToolsForRole(TOOL_SCHEMAS, role);

        // Build API request (reuses existing builder)
        const agentSettings = {
            ...settings,
            thinkingEnabled: false, // sub-agents don't need thinking mode
        };
        const body = buildChatCompletionBody(agentSettings, messages, cachedModels);
        // Override tools with role-specific subset
        body.tools = roleTools.length > 0 ? roleTools : undefined;
        body.max_tokens = budget.perAgent;

        // Resolve provider config
        const provider = settings.selectedProvider;
        const cfg = PROVIDERS[provider];
        const apiKey = toolContext.apiKey;
        const headers = cfg.headers(apiKey, { hasTools: roleTools.length > 0 });

        // Tool loop (simplified version of parent's loop)
        for (let round = 0; round < MAX_SUB_AGENT_TOOL_ROUNDS; round++) {
            if (signal?.aborted) {
                return { role, task, content: accumulatedContent || 'Aborted', toolRounds, error: 'Aborted' };
            }

            let roundContent = '';
            const result = await streamChatCompletions(
                cfg.url,
                headers,
                body as unknown as Record<string, unknown>,
                (token, type) => {
                    if (type === 'content' && token) {
                        roundContent += token;
                    }
                },
                signal,
            );

            accumulatedContent += roundContent;

            // No tool calls — done
            if (!result.toolCalls || result.toolCalls.length === 0) {
                break;
            }

            toolRounds++;

            // Process tool calls
            const toolResults: { toolCallId: string; result: string }[] = [];
            for (const tc of result.toolCalls) {
                // Sub-agents can't spawn more sub-agents
                if (tc.function.name === 'delegate_to_agent' || tc.function.name === 'spawn_parallel_agents') {
                    toolResults.push({
                        toolCallId: tc.id,
                        result: JSON.stringify({ error: 'Sub-agents cannot spawn other sub-agents' }),
                    });
                    continue;
                }

                const execResult: ToolExecutionResult = await executeTool(
                    tc.function.name,
                    tc.function.arguments,
                    app,
                    toolContext,
                );
                toolResults.push({ toolCallId: tc.id, result: execResult.result });
            }

            // Append assistant + tool messages for next round
            const assistantMsg = formatAssistantToolCalls(result.toolCalls);
            body.messages = [
                ...(body.messages as ApiMessage[]),
                assistantMsg,
                ...toolResults.map(tr => formatToolResultForChatCompletions(tr.toolCallId, tr.result)),
            ];
        }

        debugLog.log('tool', `Sub-agent completed: role=${role}`, {
            contentLen: accumulatedContent.length,
            toolRounds,
        });

        return { role, task, content: accumulatedContent, toolRounds };
    } catch (err) {
        const errMsg = getErrorMessage(err);
        debugLog.log('tool', `Sub-agent failed: role=${role}: ${errMsg}`);
        return { role, task, content: accumulatedContent, toolRounds, error: errMsg };
    }
}

/** Spawn multiple sub-agents in parallel. */
export async function spawnParallelAgents(
    agents: Array<{ task: string; role: SubAgentRole; context?: string }>,
    app: App,
    settings: PluginSettings,
    cachedModels: ModelInfo[],
    budget: TokenBudget,
    toolContext: ToolContext,
    signal?: AbortSignal,
): Promise<SubAgentResult[]> {
    debugLog.log('tool', `Spawning ${agents.length} parallel agents`, {
        roles: agents.map(a => a.role),
    });

    const settled = await Promise.allSettled(
        agents.map(a =>
            executeSubAgent(
                a.task, a.role, app, settings, cachedModels,
                budget, toolContext, a.context, signal,
            ),
        ),
    );
    const results = settled.map((s, i) =>
        s.status === 'fulfilled'
            ? s.value
            : { role: agents[i].role, task: agents[i].task, content: '', toolRounds: 0, error: getErrorMessage(s.reason) },
    );

    const succeeded = results.filter(r => !r.error).length;
    debugLog.log('tool', `Parallel agents complete: ${succeeded}/${agents.length} succeeded`);

    return results;
}

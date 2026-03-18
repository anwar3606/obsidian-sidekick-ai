/**
 * MCP Client — Obsidian integration layer.
 * 
 * Makes HTTP requests to MCP servers via Obsidian's requestUrl,
 * manages tool discovery cache, and executes MCP tool calls.
 */

import { requestUrl } from 'obsidian';
import {
    buildInitializeRequest,
    buildToolsListRequest,
    buildToolsCallRequest,
    buildMCPHttpRequest,
    parseJsonRpcResponse,
    parseToolsList,
    parseToolCallResult,
    mcpToolsToChatCompletions,
    mcpResultToText,
    parseMCPToolName,
} from '../lib/mcp';
import type { MCPServerConfig, DiscoveredMCPTool } from '../lib/mcp';
import type { ToolExecutionResult } from './types';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';

// Re-export lib types for convenience
export type { MCPServerConfig, DiscoveredMCPTool } from '../lib/mcp';
export { parseMCPToolName } from '../lib/mcp';

// ── Tool Cache ──────────────────────────────────────────────────────

interface CachedToolList {
    tools: DiscoveredMCPTool[];
    fetchedAt: number;
}

const toolCache = new Map<string, CachedToolList>();

/** Clear cached tools for a specific server or all servers. */
export function clearMCPToolCache(serverId?: string): void {
    if (serverId) {
        toolCache.delete(serverId);
    } else {
        toolCache.clear();
    }
}

// ── Server Communication ────────────────────────────────────────────

const DEFAULT_TIMEOUT = 10000; // 10s

/** Send a JSON-RPC request to an MCP server and parse the response. */
async function mcpRequest(server: MCPServerConfig, body: ReturnType<typeof buildInitializeRequest>): Promise<unknown> {
    const req = buildMCPHttpRequest(server.url, server.apiKey, body);
    const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        throw: false,
    });
    if (res.status >= 400) {
        throw new Error(`MCP server "${server.name}" returned HTTP ${res.status}`);
    }
    const parsed = parseJsonRpcResponse(res.json);
    return parsed.result;
}

/** Initialize connection to an MCP server. */
async function initializeServer(server: MCPServerConfig): Promise<void> {
    const req = buildInitializeRequest();
    await mcpRequest(server, req);
    debugLog.log('tool', `MCP: initialized "${server.name}"`);
}

// ── Tool Discovery ──────────────────────────────────────────────────

/** Discover tools from a single MCP server. Returns tools in Chat Completions format. */
export async function discoverServerTools(server: MCPServerConfig): Promise<DiscoveredMCPTool[]> {
    debugLog.log('tool', `MCP: discovering tools from "${server.name}" at ${server.url}`);
    try {
        // Initialize handshake
        await initializeServer(server);

        // List tools
        const listReq = buildToolsListRequest();
        const result = await mcpRequest(server, listReq);
        const mcpTools = parseToolsList(result);

        // Convert to Chat Completions format
        const tools = mcpToolsToChatCompletions(mcpTools, server.id, server.name);
        debugLog.log('tool', `MCP: discovered ${tools.length} tools from "${server.name}"`, {
            tools: tools.map(t => t.originalName),
        });

        // Cache
        toolCache.set(server.id, { tools, fetchedAt: Date.now() });
        return tools;
    } catch (err) {
        debugLog.log('tool', `MCP: failed to discover tools from "${server.name}": ${getErrorMessage(err)}`);
        throw err;
    }
}

/** Get all discovered MCP tools from cache, refreshing stale entries. */
export async function getAllMCPTools(
    servers: MCPServerConfig[],
    cacheTTL: number = 3600,
): Promise<DiscoveredMCPTool[]> {
    const enabled = servers.filter(s => s.enabled);
    if (enabled.length === 0) return [];

    const now = Date.now();
    const allTools: DiscoveredMCPTool[] = [];

    for (const server of enabled) {
        const cached = toolCache.get(server.id);
        if (cached && (now - cached.fetchedAt) < cacheTTL * 1000) {
            allTools.push(...cached.tools);
            continue;
        }

        try {
            const tools = await discoverServerTools(server);
            allTools.push(...tools);
        } catch {
            // If refresh fails, use stale cache if available
            if (cached) {
                debugLog.log('tool', `MCP: using stale cache for "${server.name}"`);
                allTools.push(...cached.tools);
            }
        }
    }

    return allTools;
}

// ── Tool Execution ──────────────────────────────────────────────────

/** Execute an MCP tool call. Returns the result as a tool execution result. */
export async function executeMCPTool(
    prefixedToolName: string,
    args: Record<string, unknown>,
    servers: MCPServerConfig[],
): Promise<ToolExecutionResult> {
    const parsed = parseMCPToolName(prefixedToolName);
    if (!parsed) {
        return { result: JSON.stringify({ error: `Invalid MCP tool name: ${prefixedToolName}` }) };
    }

    const server = servers.find(s => s.id === parsed.serverId && s.enabled);
    if (!server) {
        return { result: JSON.stringify({ error: `MCP server "${parsed.serverId}" not found or disabled` }) };
    }

    try {
        debugLog.log('tool', `MCP: calling "${parsed.toolName}" on "${server.name}"`, { args });
        const callReq = buildToolsCallRequest(parsed.toolName, args);
        const result = await mcpRequest(server, callReq);
        const callResult = parseToolCallResult(result);
        const text = mcpResultToText(callResult);

        if (callResult.isError) {
            return { result: JSON.stringify({ error: text }) };
        }
        return { result: text };
    } catch (err) {
        const errMsg = getErrorMessage(err);
        if (errMsg.includes('401') || errMsg.includes('403')) {
            return { result: JSON.stringify({ error: `MCP server "${server.name}" authentication failed. Check API key in settings.` }) };
        }
        return { result: JSON.stringify({ error: `MCP tool "${parsed.toolName}" failed: ${errMsg}` }) };
    }
}

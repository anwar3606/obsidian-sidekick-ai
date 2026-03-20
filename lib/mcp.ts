/**
 * MCP Client — Pure logic, zero Obsidian dependency.
 * 
 * Implements Model Context Protocol (JSON-RPC 2.0) client for discovering
 * and calling tools on remote MCP servers via Streamable HTTP transport.
 */

import type { ChatCompletionTool } from './types';

// ── MCP Protocol Types ──────────────────────────────────────────────

export interface MCPServerConfig {
    id: string;
    name: string;
    url: string;
    apiKey: string;
    enabled: boolean;
}

/** JSON-RPC 2.0 request. */
interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

/** MCP tool as returned by servers. */
export interface MCPToolSchema {
    name: string;
    description?: string;
    inputSchema?: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

/** Result of an MCP tool call. */
export interface MCPToolCallResult {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
}

/** Discovered tool with server provenance. */
export interface DiscoveredMCPTool {
    schema: ChatCompletionTool;
    serverId: string;
    serverName: string;
    originalName: string;
}

// ── JSON-RPC Builders ───────────────────────────────────────────────

let rpcIdCounter = 0;

function nextRpcId(): number {
    return ++rpcIdCounter;
}

/** Build an MCP initialize request. */
export function buildInitializeRequest(): JsonRpcRequest {
    return {
        jsonrpc: '2.0',
        id: nextRpcId(),
        method: 'initialize',
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'obsidian-sidekick', version: '1.0.0' },
        },
    };
}

/** Build an MCP tools/list request. */
export function buildToolsListRequest(): JsonRpcRequest {
    return {
        jsonrpc: '2.0',
        id: nextRpcId(),
        method: 'tools/list',
    };
}

/** Build an MCP tools/call request. */
export function buildToolsCallRequest(toolName: string, args: Record<string, unknown>): JsonRpcRequest {
    return {
        jsonrpc: '2.0',
        id: nextRpcId(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    };
}

/** Build HTTP request details for an MCP JSON-RPC call. */
export function buildMCPHttpRequest(
    serverUrl: string,
    apiKey: string,
    body: JsonRpcRequest,
): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return {
        url: serverUrl,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    };
}

// ── Response Parsers ────────────────────────────────────────────────

/** Parse a JSON-RPC response, throwing on protocol errors. */
export function parseJsonRpcResponse(raw: unknown): JsonRpcResponse {
    const data = raw as Record<string, unknown>;
    if (data.jsonrpc !== '2.0') {
        throw new Error('Invalid JSON-RPC response: missing jsonrpc="2.0"');
    }
    if (data.error) {
        const err = data.error as { code?: number; message?: string };
        throw new Error(`MCP error ${err.code ?? 'unknown'}: ${err.message ?? 'Unknown error'}`);
    }
    return data as unknown as JsonRpcResponse;
}

/** Parse the result of tools/list into MCP tool schemas. */
export function parseToolsList(result: unknown): MCPToolSchema[] {
    const data = result as Record<string, unknown>;
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const parsed: MCPToolSchema[] = [];
    for (const t of tools) {
        if (!t || typeof t !== 'object') continue;
        const tool = t as Record<string, unknown>;
        if (typeof tool.name !== 'string' || !tool.name) continue;
        parsed.push({
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : undefined,
            inputSchema: tool.inputSchema as MCPToolSchema['inputSchema'],
        });
    }
    return parsed;
}

/** Parse a tools/call result. */
export function parseToolCallResult(result: unknown): MCPToolCallResult {
    const data = result as Record<string, unknown>;
    const content = Array.isArray(data.content) ? data.content : [];
    return {
        content: content.map((c: unknown) => {
            const item = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
            return {
                type: String(item.type ?? 'text'),
                text: typeof item.text === 'string' ? item.text : undefined,
                data: typeof item.data === 'string' ? item.data : undefined,
                mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
            };
        }),
        isError: typeof data.isError === 'boolean' ? data.isError : false,
    };
}

// ── Schema Conversion ───────────────────────────────────────────────

/** Sanitize a tool name to be valid as a function name (alphanumeric + underscores + hyphens). */
function sanitizeToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Convert MCP tool schemas to Chat Completions format with server prefixing.
 *  Uses double underscore (__) as delimiter between server ID and tool name
 *  so that single underscores in either part are preserved. */
export function mcpToolsToChatCompletions(
    tools: MCPToolSchema[],
    serverId: string,
    serverName: string,
): DiscoveredMCPTool[] {
    return tools.map(t => ({
        schema: {
            type: 'function' as const,
            function: {
                name: `mcp__${sanitizeToolName(serverId)}__${sanitizeToolName(t.name)}`,
                description: `[MCP: ${serverName}] ${t.description || t.name}`,
                parameters: t.inputSchema || { type: 'object' as const, properties: {} },
            },
        },
        serverId,
        serverName,
        originalName: t.name,
    }));
}

/** Extract the original tool name and server ID from a prefixed MCP tool name.
 *  Delimiter: double underscore (__). */
export function parseMCPToolName(prefixedName: string): { serverId: string; toolName: string } | null {
    const match = prefixedName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return null;
    return { serverId: match[1], toolName: match[2] };
}

/** Convert MCP tool call result content to a plain text string for the AI. */
export function mcpResultToText(result: MCPToolCallResult): string {
    const parts: string[] = [];
    for (const item of result.content) {
        if (item.type === 'text' && item.text) {
            parts.push(item.text);
        } else if (item.type === 'image' && item.data) {
            parts.push(`[Image: ${item.mimeType || 'image/png'}]`);
        } else if (item.type === 'resource' && item.text) {
            parts.push(item.text);
        }
    }
    if (parts.length === 0) {
        return result.isError ? 'MCP tool returned an error with no details.' : 'MCP tool returned empty result.';
    }
    return parts.join('\n');
}

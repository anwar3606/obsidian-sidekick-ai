import { describe, it, expect, beforeEach } from 'vitest';
import {
    buildInitializeRequest,
    buildToolsListRequest,
    buildToolsCallRequest,
    buildMCPHttpRequest,
    parseJsonRpcResponse,
    parseToolsList,
    parseToolCallResult,
    mcpToolsToChatCompletions,
    parseMCPToolName,
    mcpResultToText,
} from '../lib/mcp';

describe('lib/mcp', () => {
    // ── JSON-RPC Builders ───────────────────────────────────────

    describe('buildInitializeRequest', () => {
        it('builds valid JSON-RPC initialize request', () => {
            const req = buildInitializeRequest();
            expect(req.jsonrpc).toBe('2.0');
            expect(req.method).toBe('initialize');
            expect(typeof req.id).toBe('number');
            expect(req.params).toBeDefined();
            expect((req.params as any).protocolVersion).toBe('2025-03-26');
            expect((req.params as any).clientInfo.name).toBe('obsidian-sidekick');
        });
    });

    describe('buildToolsListRequest', () => {
        it('builds valid JSON-RPC tools/list request', () => {
            const req = buildToolsListRequest();
            expect(req.jsonrpc).toBe('2.0');
            expect(req.method).toBe('tools/list');
            expect(typeof req.id).toBe('number');
        });
    });

    describe('buildToolsCallRequest', () => {
        it('builds request with tool name and arguments', () => {
            const req = buildToolsCallRequest('search', { query: 'test' });
            expect(req.method).toBe('tools/call');
            expect((req.params as any).name).toBe('search');
            expect((req.params as any).arguments).toEqual({ query: 'test' });
        });

        it('passes empty args', () => {
            const req = buildToolsCallRequest('ping', {});
            expect((req.params as any).arguments).toEqual({});
        });
    });

    describe('buildMCPHttpRequest', () => {
        it('builds POST request with auth header', () => {
            const body = buildToolsListRequest();
            const req = buildMCPHttpRequest('https://mcp.example.com', 'key123', body);
            expect(req.url).toBe('https://mcp.example.com');
            expect(req.method).toBe('POST');
            expect(req.headers['Content-Type']).toBe('application/json');
            expect(req.headers['Authorization']).toBe('Bearer key123');
            expect(JSON.parse(req.body)).toEqual(body);
        });

        it('omits Authorization header when no API key', () => {
            const body = buildToolsListRequest();
            const req = buildMCPHttpRequest('https://mcp.example.com', '', body);
            expect(req.headers['Authorization']).toBeUndefined();
        });
    });

    // ── Response Parsers ────────────────────────────────────────

    describe('parseJsonRpcResponse', () => {
        it('parses valid response', () => {
            const res = parseJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
            expect(res.result).toEqual({ tools: [] });
        });

        it('throws on missing jsonrpc field', () => {
            expect(() => parseJsonRpcResponse({ id: 1, result: {} })).toThrow('Invalid JSON-RPC response');
        });

        it('throws on error response', () => {
            expect(() => parseJsonRpcResponse({
                jsonrpc: '2.0', id: 1,
                error: { code: -32600, message: 'Invalid Request' },
            })).toThrow('MCP error -32600: Invalid Request');
        });

        it('throws with unknown code if missing', () => {
            expect(() => parseJsonRpcResponse({
                jsonrpc: '2.0', id: 1,
                error: {},
            })).toThrow('MCP error unknown');
        });
    });

    describe('parseToolsList', () => {
        it('parses valid tool list', () => {
            const tools = parseToolsList({
                tools: [
                    { name: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
                    { name: 'read_file', description: 'Read a file' },
                ],
            });
            expect(tools).toHaveLength(2);
            expect(tools[0].name).toBe('search');
            expect(tools[0].description).toBe('Search docs');
            expect(tools[0].inputSchema?.properties).toEqual({ q: { type: 'string' } });
            expect(tools[1].name).toBe('read_file');
            expect(tools[1].inputSchema).toBeUndefined();
        });

        it('skips invalid entries', () => {
            const tools = parseToolsList({
                tools: [null, undefined, 'bad', { notAName: true }, { name: '' }, { name: 'valid' }],
            });
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe('valid');
        });

        it('handles missing tools array', () => {
            expect(parseToolsList({})).toEqual([]);
            expect(parseToolsList({ tools: 'not an array' })).toEqual([]);
        });
    });

    describe('parseToolCallResult', () => {
        it('parses text content', () => {
            const result = parseToolCallResult({
                content: [{ type: 'text', text: 'hello world' }],
            });
            expect(result.content).toHaveLength(1);
            expect(result.content[0].text).toBe('hello world');
            expect(result.isError).toBe(false);
        });

        it('parses error result', () => {
            const result = parseToolCallResult({
                content: [{ type: 'text', text: 'something went wrong' }],
                isError: true,
            });
            expect(result.isError).toBe(true);
        });

        it('handles empty content', () => {
            const result = parseToolCallResult({});
            expect(result.content).toEqual([]);
        });

        it('handles image content', () => {
            const result = parseToolCallResult({
                content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
            });
            expect(result.content[0].type).toBe('image');
            expect(result.content[0].data).toBe('base64data');
        });
    });

    // ── Schema Conversion ───────────────────────────────────────

    describe('mcpToolsToChatCompletions', () => {
        it('converts tools with server prefix', () => {
            const tools = mcpToolsToChatCompletions(
                [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
                'github',
                'GitHub Tools',
            );
            expect(tools).toHaveLength(1);
            expect(tools[0].schema.function.name).toBe('mcp__github__search');
            expect(tools[0].schema.function.description).toBe('[MCP: GitHub Tools] Search docs');
            expect(tools[0].serverId).toBe('github');
            expect(tools[0].serverName).toBe('GitHub Tools');
            expect(tools[0].originalName).toBe('search');
        });

        it('sanitizes special characters in names', () => {
            const tools = mcpToolsToChatCompletions(
                [{ name: 'read-file.txt' }],
                'my server!',
                'Server',
            );
            expect(tools[0].schema.function.name).toBe('mcp__my_server___read-file_txt');
        });

        it('handles tools without description', () => {
            const tools = mcpToolsToChatCompletions(
                [{ name: 'ping' }],
                'test',
                'Test',
            );
            expect(tools[0].schema.function.description).toBe('[MCP: Test] ping');
        });

        it('provides empty parameters when no inputSchema', () => {
            const tools = mcpToolsToChatCompletions(
                [{ name: 'ping' }],
                'test',
                'Test',
            );
            expect(tools[0].schema.function.parameters).toEqual({ type: 'object', properties: {} });
        });
    });

    describe('parseMCPToolName', () => {
        it('parses valid MCP tool name', () => {
            const result = parseMCPToolName('mcp__github__search');
            expect(result).toEqual({ serverId: 'github', toolName: 'search' });
        });

        it('parses tool name with underscores in server ID and tool name', () => {
            const result = parseMCPToolName('mcp__my_server__read_file');
            expect(result).toEqual({ serverId: 'my_server', toolName: 'read_file' });
        });

        it('returns null for non-MCP tool names', () => {
            expect(parseMCPToolName('search_vault')).toBeNull();
            expect(parseMCPToolName('mcp_')).toBeNull();
            expect(parseMCPToolName('mcp__')).toBeNull();
            expect(parseMCPToolName('mcp__only')).toBeNull();
            expect(parseMCPToolName('')).toBeNull();
        });
    });

    describe('mcpResultToText', () => {
        it('joins text content', () => {
            const text = mcpResultToText({
                content: [
                    { type: 'text', text: 'Line 1' },
                    { type: 'text', text: 'Line 2' },
                ],
            });
            expect(text).toBe('Line 1\nLine 2');
        });

        it('shows image placeholder', () => {
            const text = mcpResultToText({
                content: [{ type: 'image', data: 'abc', mimeType: 'image/jpeg' }],
            });
            expect(text).toBe('[Image: image/jpeg]');
        });

        it('handles empty error result', () => {
            const text = mcpResultToText({ content: [], isError: true });
            expect(text).toBe('MCP tool returned an error with no details.');
        });

        it('handles empty success result', () => {
            const text = mcpResultToText({ content: [] });
            expect(text).toBe('MCP tool returned empty result.');
        });
    });
});

import type { ToolExecutionResult, ToolContext, SearchVaultArgs, ReadNoteArgs, ReadNoteOutlineArgs, ReadNoteSectionArgs, CreateNoteArgs, EditNoteArgs, FetchUrlArgs, GenerateImageArgs, AskUserArgs, AskUserChoiceArgs, ViewImageArgs, ListFilesArgs, GrepSearchArgs, OpenNoteArgs, GetBacklinksArgs, GetNoteMetadataArgs, SearchByTagArgs, GetRecentNotesArgs, MoveNoteArgs, DeleteNoteArgs, SemanticSearchVaultArgs, WebSearchArgs, RedditSearchArgs, RedditReadPostArgs, JiraSearchArgs, JiraGetIssueArgs, JiraCreateIssueArgs, JiraAddCommentArgs, JiraUpdateIssueArgs, RememberUserFactArgs } from './types';
import { ensureParentFolder } from './utils';
import { searchVault } from './search';
import { requestUrl, TFile, TFolder } from 'obsidian';
import type { App, CachedMetadata } from 'obsidian';
import { getImageModalities } from '../lib/providers';
import { buildOpenRouterImageRequest, buildOpenRouterImageHeaders, parseOpenRouterImageResponse } from '../lib/image-gen';
import { sanitizeVaultPath, getErrorMessage } from '../lib/utils';
import { arrayBufferToBase64, extensionToMime } from '../lib/image-utils';
import { parseMarkdownOutline, extractMarkdownSection } from '../lib/tools';
import { buildTavilySearchRequest, buildBraveSearchRequest, buildGoogleSearchRequest, parseTavilyResponse, parseBraveResponse, parseGoogleResponse } from '../lib/search';
import type { WebSearchResult } from '../lib/search';
import { parseMCPToolName } from '../lib/mcp';
import { validateSubAgentArgs, validateParallelAgentsArgs, calculateTokenBudget, formatSubAgentResults } from '../lib/sub-agent';
import type { SubAgentRole } from '../lib/sub-agent';
import { enhanceNoteContent, generateConflictSummary } from '../lib/note-suggestions';
import { executeMCPTool } from './mcp';
import { executeSubAgent, spawnParallelAgents } from './sub-agent';
import { debugLog } from './debug-log';

// Re-export tool schemas, labels, and risk classification from lib/ (single source of truth)
export { TOOL_SCHEMAS, RISKY_TOOLS, TOOL_LABELS, parseMarkdownOutline, extractMarkdownSection } from '../lib/tools';

import { MAX_CONTENT_LENGTH } from '../lib/api';

/** Retry delay for OpenRouter image gen (ms). Use setImageRetryDelay() for testing. */
let _imageRetryDelay = 2000;
export function setImageRetryDelay(ms: number): void { _imageRetryDelay = ms; }

/**
 * Tool definitions and executors for AI agent tool-calling.
 *
 * Tools:
 *   - search_vault     — search notes in the vault
 *   - read_note        — read a specific note's content
 *   - create_note      — create or append to a note
 *   - fetch_url        — fetch any URL
 *   - generate_image   — generate an image from a text prompt
 */

// ── Constants ───────────────────────────────────────────────────────

const MAX_SEARCH_RESULTS = 50;

// ── Tool approval mechanism ─────────────────────────────────────────

// ── Tool approval ───────────────────────────────────────────────────

export type ApprovalResult = 'approve' | 'always' | 'decline';

const _approvalQueue: Array<(result: ApprovalResult) => void> = [];

/** Timeout for pending tool approvals (5 minutes). */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function requestToolApproval(): Promise<ApprovalResult> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const idx = _approvalQueue.indexOf(wrappedResolve);
            if (idx !== -1) _approvalQueue.splice(idx, 1);
            resolve('decline');
        }, APPROVAL_TIMEOUT_MS);

        const wrappedResolve = (result: ApprovalResult) => {
            clearTimeout(timer);
            resolve(result);
        };
        _approvalQueue.push(wrappedResolve);
    });
}

export function resolveToolApproval(result: ApprovalResult): void {
    const resolver = _approvalQueue.shift();
    if (resolver) {
        resolver(result);
    }
}

/** Drain all pending approvals (e.g. when closing a chat view). */
export function clearPendingApprovals(): void {
    while (_approvalQueue.length > 0) {
        const resolver = _approvalQueue.shift();
        if (resolver) resolver('decline');
    }
}

// ── Tool executors ──────────────────────────────────────────────────

async function executeSearchVault(app: App, args: SearchVaultArgs): Promise<ToolExecutionResult> {
    const rawVal = Number(args.max_results);
    const maxResults = Math.min(Math.max(1, isNaN(rawVal) ? 10 : rawVal), MAX_SEARCH_RESULTS);
    const query = args.query || '';

    if (!query.trim()) {
        return { result: JSON.stringify([]) };
    }

    const searchResults = await searchVault(app, query, {
        maxResults,
        searchContent: true,
    });

    const results = searchResults.map(r => ({
        path: r.path,
        snippet: r.snippet,
        score: Math.round(r.score * 100) / 100,
        matched: r.matchedFields.join(', '),
    }));

    return { result: JSON.stringify(results) };
}

async function executeReadNote(app: App, args: ReadNoteArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const file = app.vault.getAbstractFileByPath(args.path);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${args.path}` }) };
    }
    try {
        const maxLen = context?.maxContentLength ?? MAX_CONTENT_LENGTH;
        const content = await app.vault.read(file);
        const allLines = content.split('\n');
        const totalLines = allLines.length;

        // Chunked reading: if start_line or end_line is provided, return a line range
        if (args.start_line !== undefined || args.end_line !== undefined) {
            const start = Math.max(1, args.start_line ?? 1);
            const end = Math.min(totalLines, args.end_line ?? totalLines);
            if (start > totalLines) {
                return {
                    result: JSON.stringify({
                        path: args.path,
                        error: `start_line ${start} exceeds total lines (${totalLines})`,
                        total_lines: totalLines,
                    }),
                };
            }
            const sliced = allLines.slice(start - 1, end).join('\n');
            return {
                result: JSON.stringify({
                    path: args.path,
                    content: sliced.length > maxLen ? sliced.substring(0, maxLen) : sliced,
                    start_line: start,
                    end_line: Math.min(end, totalLines),
                    total_lines: totalLines,
                    truncated: sliced.length > maxLen,
                }),
            };
        }

        // Full read (backward compatible)
        return {
            result: JSON.stringify({
                path: args.path,
                content: content.length > maxLen
                    ? content.substring(0, maxLen)
                    : content,
                total_lines: totalLines,
                truncated: content.length > maxLen,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to read: ${getErrorMessage(err)}` }) };
    }
}

async function executeCreateNote(app: App, args: CreateNoteArgs): Promise<ToolExecutionResult> {
    try {
        // Sanitize path to prevent directory traversal (LLM-generated paths are untrusted)
        let safePath: string;
        try {
            safePath = sanitizeVaultPath(args.path);
        } catch (err: unknown) {
            return { result: JSON.stringify({ error: `Invalid path: ${getErrorMessage(err)}` }) };
        }

        // Fix double-escaped newlines: some models (e.g. Claude Haiku 4.5) send literal
        // "\n" strings that survive JSON.parse. If the content has literal "\n" but no
        // actual newlines, it's almost certainly double-escaped.
        let content = args.content;
        if (content.includes('\\n') && !content.includes('\n')) {
            content = content.replace(/\\n/g, '\n');
        }

        // Smart enhance: auto-add tags + related note wikilinks (default: true unless append)
        const smartEnhance = args.smart_enhance !== false && !args.append;
        let enhancements: { suggestedTags: string[]; addedLinks: Array<{ name: string; path: string }> } | undefined;

        if (smartEnhance && _vaultIndexer?.isReady()) {
            try {
                const results = await _vaultIndexer.search(content.substring(0, 500), 10, 0.3);
                const relatedNotes = results.map(r => ({
                    path: r.path,
                    heading: r.heading,
                    score: r.score,
                }));
                const enhanced = enhanceNoteContent(content, relatedNotes, safePath);
                content = enhanced.enhancedContent;
                enhancements = {
                    suggestedTags: enhanced.suggestedTags,
                    addedLinks: enhanced.addedLinks.map(l => ({ name: l.name, path: l.path })),
                };
            } catch {
                // Enhancement failed silently — proceed with original content
            }
        }

        const existing = app.vault.getAbstractFileByPath(safePath);
        if (existing instanceof TFile && args.append) {
            const current = await app.vault.read(existing);
            await app.vault.modify(existing, current + '\n' + content);
            return { result: JSON.stringify({ path: safePath, action: 'appended', success: true }) };
        } else if (existing instanceof TFile) {
            const current = await app.vault.read(existing);
            const conflict = generateConflictSummary(current, content);
            await app.vault.modify(existing, content);
            return { result: JSON.stringify({
                path: safePath,
                action: 'overwritten',
                warning: 'Existing file content was replaced',
                conflict_summary: conflict,
                success: true,
                ...(enhancements && { enhancements }),
            }) };
        } else {
            await ensureParentFolder(app, safePath);
            await app.vault.create(safePath, content);
            return { result: JSON.stringify({
                path: safePath,
                action: 'created',
                success: true,
                ...(enhancements && { enhancements }),
            }) };
        }
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to create/modify ${args.path}: ${getErrorMessage(err)}` }) };
    }
}

async function executeFetchUrl(args: FetchUrlArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    try {
        // Validate URL protocol — only allow HTTP(S)
        const url = args.url?.trim();
        if (!url) {
            return { result: JSON.stringify({ error: 'Missing URL' }) };
        }
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return { result: JSON.stringify({ error: `Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.` }) };
            }
        } catch {
            return { result: JSON.stringify({ error: `Invalid URL: ${url}` }) };
        }

        const maxLen = context?.maxContentLength ?? MAX_CONTENT_LENGTH;
        const res = await requestUrl({ url });
        const text = typeof res.text === 'string' ? res.text : JSON.stringify(res.json);
        return {
            result: JSON.stringify({
                status: res.status,
                content_type: res.headers['content-type'] || '',
                body: text.length > maxLen
                    ? text.substring(0, maxLen)
                    : text,
                truncated: text.length > maxLen,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: getErrorMessage(err) }) };
    }
}

async function executeGenerateImageViaOpenRouter(
    args: GenerateImageArgs,
    apiKey: string,
    model: string,
    aspectRatio?: string,
): Promise<ToolExecutionResult> {
    const body = buildOpenRouterImageRequest(model, args.prompt, aspectRatio);
    const headers = buildOpenRouterImageHeaders(apiKey);

    // Retry up to 2 extra times — flash/free models on OpenRouter often fail
    // on the first attempt due to cold-start (returns 200 but no image).
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY = _imageRetryDelay;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await requestUrl({
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
            const { imageUrl } = parseOpenRouterImageResponse(res.json);
            if (imageUrl) {
                return { result: JSON.stringify({ image_url: imageUrl }), generatedImageUrl: imageUrl };
            }
            // No image in response — retry if attempts remain
            if (attempt < MAX_ATTEMPTS) {
                debugLog.log('tool', 'Image gen via OpenRouter: no image, retrying', { attempt, retryDelay: RETRY_DELAY });
                await new Promise(r => setTimeout(r, RETRY_DELAY));
            }
        } catch (err: unknown) {
            if (attempt < MAX_ATTEMPTS) {
                debugLog.log('tool', 'Image gen via OpenRouter: error, retrying', { attempt, error: getErrorMessage(err) });
                await new Promise(r => setTimeout(r, RETRY_DELAY));
            } else {
                return { result: JSON.stringify({ error: `Image generation failed after ${MAX_ATTEMPTS} attempts: ${getErrorMessage(err)}` }) };
            }
        }
    }
    return { result: JSON.stringify({ error: `No image returned from OpenRouter after ${MAX_ATTEMPTS} attempts` }) };
}

async function executeGenerateImageViaOpenAI(
    args: GenerateImageArgs,
    apiKey: string,
    model: string,
    size: string,
    quality: string,
): Promise<ToolExecutionResult> {
    const res = await requestUrl({
        url: 'https://api.openai.com/v1/images/generations',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            prompt: args.prompt,
            n: 1,
            size: args.size || size,
            model,
            quality,
        }),
    });

    const data = res.json;
    const b64 = data?.data?.[0]?.b64_json;
    const imageUrl = b64 ? `data:image/png;base64,${b64}` : data?.data?.[0]?.url;
    if (imageUrl) {
        return {
            result: JSON.stringify({ image_url: imageUrl, revised_prompt: data.data[0].revised_prompt }),
            generatedImageUrl: imageUrl,
        };
    }
    return { result: JSON.stringify({ error: 'No image returned' }) };
}

async function executeGenerateImage(
    args: GenerateImageArgs,
    context: ToolContext,
): Promise<ToolExecutionResult> {
    const imgApiKey = context.imageGenApiKey || context.apiKey;
    const imgProvider = context.imageGenProvider || context.provider;
    const model = context.imageGenModel || 'dall-e-3';
    const size = context.imageGenSize || '1024x1024';
    const quality = context.imageGenQuality || 'standard';
    const aspectRatio = context.imageGenAspectRatio;

    if (imgProvider === 'copilot') {
        return { result: JSON.stringify({ error: 'GitHub Copilot does not support standalone image generation. Set "Image Gen Provider" to OpenAI or OpenRouter in Sidekick settings.' }) };
    }

    if (!imgApiKey) {
        return { result: JSON.stringify({ error: 'No API key configured for image generation' }) };
    }

    try {
        return imgProvider === 'openrouter'
            ? await executeGenerateImageViaOpenRouter(args, imgApiKey, model, aspectRatio)
            : await executeGenerateImageViaOpenAI(args, imgApiKey, model, size, quality);
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: getErrorMessage(err) }) };
    }
}

/** Max image file size for view_image tool (10 MB). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Supported image extensions for view_image. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

async function executeViewImage(app: App, args: ViewImageArgs): Promise<ToolExecutionResult> {
    const path = args.path?.trim();
    if (!path) {
        return { result: JSON.stringify({ error: 'Missing image path' }) };
    }

    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `Image file not found: ${path}` }) };
    }

    if (!IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) {
        return { result: JSON.stringify({ error: `Not an image file (${file.extension}). Supported: ${[...IMAGE_EXTENSIONS].join(', ')}` }) };
    }

    if (file.stat.size > MAX_IMAGE_SIZE) {
        return { result: JSON.stringify({ error: `Image too large (${(file.stat.size / 1024 / 1024).toFixed(1)} MB). Max: 10 MB.` }) };
    }

    try {
        const buf = await app.vault.readBinary(file);
        const mime = extensionToMime(file.extension);
        const b64 = arrayBufferToBase64(buf);
        const dataUrl = `data:${mime};base64,${b64}`;

        return {
            result: JSON.stringify({
                path,
                format: file.extension,
                size_bytes: file.stat.size,
                message: 'Image loaded successfully. It has been attached for your visual analysis.',
            }),
            viewedImageUrl: dataUrl,
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to read image: ${getErrorMessage(err)}` }) };
    }
}

async function executeListFiles(app: App, args: ListFilesArgs): Promise<ToolExecutionResult> {
    const dirPath = (args.path || '').trim().replace(/^\/+|\/+$/g, '');

    try {
        // Get all files and find children of the target directory
        const allFiles = app.vault.getFiles();
        const seen = new Set<string>();
        const entries: Array<{ name: string; type: 'file' | 'folder'; size?: number; extension?: string }> = [];

        for (const file of allFiles) {
            const filePath = file.path;
            const prefix = dirPath ? dirPath + '/' : '';

            if (!filePath.startsWith(prefix)) continue;

            // Get the relative path after the directory prefix
            const relative = filePath.substring(prefix.length);
            const slashIdx = relative.indexOf('/');

            if (slashIdx === -1) {
                // Direct child file
                if (!seen.has(relative)) {
                    seen.add(relative);
                    entries.push({
                        name: relative,
                        type: 'file',
                        size: file.stat.size,
                        extension: file.extension,
                    });
                }
            } else {
                // Child is nested → this means there's a folder
                const folderName = relative.substring(0, slashIdx);
                if (!seen.has(folderName + '/')) {
                    seen.add(folderName + '/');
                    entries.push({ name: folderName, type: 'folder' });
                }
            }
        }

        // Sort: folders first, then files, alphabetical within each group
        entries.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        return {
            result: JSON.stringify({
                path: dirPath || '/',
                count: entries.length,
                entries,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to list directory: ${getErrorMessage(err)}` }) };
    }
}

async function executeGrepSearch(app: App, args: GrepSearchArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const pattern = args.pattern?.trim();
    if (!pattern) {
        return { result: JSON.stringify({ error: 'Missing search pattern' }) };
    }

    const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 100);
    const maxContentLen = context?.maxContentLength ?? MAX_CONTENT_LENGTH;
    const folder = args.folder?.trim().replace(/\/+$/, '');

    try {
        let files = app.vault.getMarkdownFiles();
        if (folder) {
            files = files.filter(f => f.path.startsWith(folder + '/') || f.path === folder);
        }
        const matches: Array<{ file: string; line: number; text: string }> = [];
        const patternLower = pattern.toLowerCase();

        for (const file of files) {
            if (matches.length >= maxResults) break;

            const content = await app.vault.read(file);
            // Limit content we scan to prevent OOM on huge files
            const scanContent = content.length > maxContentLen ? content.substring(0, maxContentLen) : content;
            const lines = scanContent.split('\n');

            for (let i = 0; i < lines.length; i++) {
                if (matches.length >= maxResults) break;
                if (lines[i].toLowerCase().includes(patternLower)) {
                    matches.push({
                        file: file.path,
                        line: i + 1,
                        text: lines[i].length > 200 ? lines[i].substring(0, 200) + '…' : lines[i],
                    });
                }
            }
        }

        return {
            result: JSON.stringify({
                pattern,
                total_matches: matches.length,
                matches,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Grep search for "${args.pattern}" failed: ${getErrorMessage(err)}` }) };
    }
}

async function executeOpenNote(app: App, args: OpenNoteArgs): Promise<ToolExecutionResult> {
    const path = args.path?.trim();
    if (!path) {
        return { result: JSON.stringify({ error: 'Missing note path' }) };
    }

    const file = app.vault.getAbstractFileByPath(path);
    if (!file) {
        return { result: JSON.stringify({ error: `File not found: ${path}` }) };
    }

    try {
        await app.workspace.openLinkText(path, '', 'tab');
        return { result: JSON.stringify({ path, opened: true, message: `Opened "${path}" in a new tab.` }) };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to open note: ${getErrorMessage(err)}` }) };
    }
}

async function executeAskUser(
    args: AskUserArgs,
    context: ToolContext,
): Promise<ToolExecutionResult> {
    const question = args.question || 'Please provide input.';
    if (!context.callbacks?.onRequestIterateFeedback) {
        return { result: JSON.stringify({ error: 'UI does not support asking user for input right now.' }) };
    }
    const answer = await context.callbacks.onRequestIterateFeedback(question);
    if (answer === null) {
        return { result: 'User cancelled or closed the prompt.' };
    }
    return { result: answer.text, feedbackImages: answer.images };
}

async function executeAskUserChoice(
    args: AskUserChoiceArgs,
    context: ToolContext,
): Promise<ToolExecutionResult> {
    if (!context.callbacks?.onRequestIterateFeedback) {
        return { result: JSON.stringify({ error: 'UI does not support asking user for input right now.' }) };
    }

    const question = args.question || 'Please make a selection:';
    const choices = args.choices || [];

    if (!Array.isArray(choices) || choices.length === 0) {
        return { result: JSON.stringify({ error: 'Missing or empty "choices" array parameter.' }) };
    }

    const allowCustom = args.allow_custom_answer !== false; // default true

    // Use dedicated choice UI if available, otherwise fall back to plain text
    let answer: { text: string; images?: string[] } | null;
    if (context.callbacks.onRequestIterateChoice) {
        answer = await context.callbacks.onRequestIterateChoice(question, choices, allowCustom);
    } else {
        let formattedQuestion = `${question}\n\nChoices:\n`;
        choices.forEach((choice, index) => {
            formattedQuestion += `${index + 1}. ${choice}\n`;
        });
        if (allowCustom) {
            formattedQuestion += `\n(Or type your own custom answer)`;
        } else {
            formattedQuestion += `\n(Please reply with the exact text or number of your choice)`;
        }
        answer = await context.callbacks.onRequestIterateFeedback(formattedQuestion);
    }

    if (answer === null) {
        return { result: 'User cancelled or closed the prompt.' };
    }

    return { result: answer.text, feedbackImages: answer.images };
}

async function executeEditNote(app: App, args: EditNoteArgs): Promise<ToolExecutionResult> {
    try {
        let safePath: string;
        try {
            safePath = sanitizeVaultPath(args.path);
        } catch (err: unknown) {
            return { result: JSON.stringify({ error: `Invalid path: ${getErrorMessage(err)}` }) };
        }

        const file = app.vault.getAbstractFileByPath(safePath);
        if (!file || !(file instanceof TFile)) {
            return { result: JSON.stringify({ error: `File not found: ${safePath}` }) };
        }

        const current = await app.vault.read(file);

        if (args.operation === 'replace') {
            if (!args.search) {
                return { result: JSON.stringify({ error: 'Missing "search" parameter for replace operation' }) };
            }
            if (!current.includes(args.search)) {
                return { result: JSON.stringify({ error: 'Search text not found in file', search: args.search }) };
            }
            const updated = current.replace(args.search, args.replace ?? '');
            await app.vault.modify(file, updated);
            return { result: JSON.stringify({ path: safePath, operation: 'replace', success: true }), editDiff: { before: current, after: updated, path: safePath } };
        }

        if (args.operation === 'insert') {
            if (args.content === undefined || args.content === null) {
                return { result: JSON.stringify({ error: 'Missing "content" parameter for insert operation' }) };
            }
            if (args.line_number === undefined || args.line_number === null) {
                return { result: JSON.stringify({ error: 'Missing "line_number" parameter for insert operation' }) };
            }
            const lines = current.split('\n');
            const lineNum = args.line_number;
            if (lineNum < 1 || lineNum > lines.length + 1) {
                return { result: JSON.stringify({ error: `Line number ${lineNum} out of range (1-${lines.length + 1})`, total_lines: lines.length }) };
            }
            lines.splice(lineNum - 1, 0, args.content);
            const updated = lines.join('\n');
            await app.vault.modify(file, updated);
            return { result: JSON.stringify({ path: safePath, operation: 'insert', line_number: lineNum, success: true }), editDiff: { before: current, after: updated, path: safePath } };
        }

        return { result: JSON.stringify({ error: `Unknown operation: ${args.operation}. Use "replace" or "insert".` }) };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to edit ${args.path}: ${getErrorMessage(err)}` }) };
    }
}

async function executeReadNoteOutline(app: App, args: ReadNoteOutlineArgs): Promise<ToolExecutionResult> {
    const file = app.vault.getAbstractFileByPath(args.path);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${args.path}` }) };
    }
    try {
        const content = await app.vault.read(file);
        const totalLines = content.split('\n').length;
        const sections = parseMarkdownOutline(content);

        return {
            result: JSON.stringify({
                path: args.path,
                total_lines: totalLines,
                sections,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to read outline of ${args.path}: ${getErrorMessage(err)}` }) };
    }
}

async function executeReadNoteSection(app: App, args: ReadNoteSectionArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const file = app.vault.getAbstractFileByPath(args.path);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${args.path}` }) };
    }
    try {
        const maxLen = context?.maxContentLength ?? MAX_CONTENT_LENGTH;
        const content = await app.vault.read(file);
        const totalLines = content.split('\n').length;
        const includeChildren = args.include_children !== false; // default true
        const section = extractMarkdownSection(content, args.heading, includeChildren);

        if (!section) {
            // Provide available headings as hints
            const headings = parseMarkdownOutline(content).map(h => h.heading);
            return {
                result: JSON.stringify({
                    error: `Section not found: "${args.heading}"`,
                    available_headings: headings,
                    total_lines: totalLines,
                }),
            };
        }

        const truncated = section.content.length > maxLen;
        return {
            result: JSON.stringify({
                path: args.path,
                heading: section.heading,
                level: section.level,
                content: truncated ? section.content.substring(0, maxLen) : section.content,
                start_line: section.startLine,
                end_line: section.endLine,
                total_lines: totalLines,
                truncated,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to read section "${args.heading}" of ${args.path}: ${getErrorMessage(err)}` }) };
    }
}

// ── Backlinks ───────────────────────────────────────────────────────

async function executeGetBacklinks(app: App, args: GetBacklinksArgs): Promise<ToolExecutionResult> {
    const rawMax = Number(args.max_results);
    const maxResults = Math.min(Math.max(1, isNaN(rawMax) ? 20 : rawMax), 100);
    const targetPath = sanitizeVaultPath(args.path);

    const file = app.vault.getAbstractFileByPath(targetPath);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${targetPath}` }) };
    }

    const resolved = app.metadataCache.resolvedLinks;
    const backlinks: Array<{ source: string; links: Array<{ line: number; text: string }> }> = [];

    for (const sourcePath in resolved) {
        const targets = resolved[sourcePath];
        if (!targets || !targets[targetPath]) continue;

        const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
        if (!sourceFile || !(sourceFile instanceof TFile)) continue;

        // Find the actual link text and line numbers from the source file's cache
        const cache = app.metadataCache.getFileCache(sourceFile as TFile);
        const linkInstances: Array<{ line: number; text: string }> = [];

        if (cache?.links) {
            for (const link of cache.links) {
                const resolvedPath = app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);
                if (resolvedPath?.path === targetPath) {
                    linkInstances.push({
                        line: (link.position?.start?.line ?? 0) + 1,
                        text: link.displayText || link.link,
                    });
                }
            }
        }
        if (cache?.embeds) {
            for (const embed of cache.embeds) {
                const resolvedPath = app.metadataCache.getFirstLinkpathDest(embed.link, sourcePath);
                if (resolvedPath?.path === targetPath) {
                    linkInstances.push({
                        line: (embed.position?.start?.line ?? 0) + 1,
                        text: `![[${embed.displayText || embed.link}]]`,
                    });
                }
            }
        }

        if (linkInstances.length > 0) {
            backlinks.push({ source: sourcePath, links: linkInstances });
        }

        if (backlinks.length >= maxResults) break;
    }

    return {
        result: JSON.stringify({
            target: targetPath,
            backlink_count: backlinks.length,
            backlinks: backlinks.slice(0, maxResults),
        }),
    };
}

// ── Note metadata ───────────────────────────────────────────────────

async function executeGetNoteMetadata(app: App, args: GetNoteMetadataArgs): Promise<ToolExecutionResult> {
    const path = sanitizeVaultPath(args.path);
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${path}` }) };
    }

    const cache: CachedMetadata | null = app.metadataCache.getFileCache(file as TFile);
    const content = await app.vault.read(file as TFile);
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    // Frontmatter properties
    const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : {};
    delete frontmatter.position; // internal Obsidian field

    // Tags (inline + frontmatter)
    const tags: string[] = [];
    if (cache?.tags) {
        for (const t of cache.tags) tags.push(t.tag);
    }
    if (cache?.frontmatter?.tags) {
        const fmTags = Array.isArray(cache.frontmatter.tags) ? cache.frontmatter.tags : [cache.frontmatter.tags];
        for (const t of fmTags) {
            const s = `#${String(t).replace(/^#/, '')}`;
            if (!tags.includes(s)) tags.push(s);
        }
    }

    // Aliases
    const aliases: string[] = [];
    if (cache?.frontmatter?.aliases) {
        const raw = cache.frontmatter.aliases;
        if (Array.isArray(raw)) aliases.push(...raw.map(String));
        else if (typeof raw === 'string') aliases.push(raw);
    }

    // Outgoing links
    const links: string[] = [];
    if (cache?.links) {
        for (const l of cache.links) {
            const resolved = app.metadataCache.getFirstLinkpathDest(l.link, path);
            links.push(resolved?.path || l.link);
        }
    }

    // Headings count
    const headingCount = cache?.headings?.length || 0;

    return {
        result: JSON.stringify({
            path,
            size_bytes: (file as TFile).stat.size,
            created: (file as TFile).stat.ctime,
            modified: (file as TFile).stat.mtime,
            word_count: wordCount,
            heading_count: headingCount,
            frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
            tags: tags.length > 0 ? tags : undefined,
            aliases: aliases.length > 0 ? aliases : undefined,
            outgoing_links: links.length > 0 ? [...new Set(links)] : undefined,
        }),
    };
}

// ── Search by tag ───────────────────────────────────────────────────

async function executeSearchByTag(app: App, args: SearchByTagArgs): Promise<ToolExecutionResult> {
    const rawMax = Number(args.max_results);
    const maxResults = Math.min(Math.max(1, isNaN(rawMax) ? 50 : rawMax), 200);
    const searchTag = args.tag.replace(/^#/, '').toLowerCase();
    const exactMatch = args.exact ?? false;

    const files = app.vault.getMarkdownFiles();
    const matches: Array<{ path: string; tags: string[]; modified: number }> = [];

    for (const file of files) {
        if (matches.length >= maxResults) break;

        const cache = app.metadataCache.getFileCache(file);
        if (!cache) continue;

        const fileTags: string[] = [];

        // Inline tags
        if (cache.tags) {
            for (const t of cache.tags) fileTags.push(t.tag.replace(/^#/, '').toLowerCase());
        }

        // Frontmatter tags
        if (cache.frontmatter?.tags) {
            const fmTags = Array.isArray(cache.frontmatter.tags) ? cache.frontmatter.tags : [cache.frontmatter.tags];
            for (const t of fmTags) {
                const s = String(t).replace(/^#/, '').toLowerCase();
                if (!fileTags.includes(s)) fileTags.push(s);
            }
        }

        const matched = fileTags.filter(t =>
            exactMatch ? t === searchTag : (t === searchTag || t.startsWith(searchTag + '/')),
        );

        if (matched.length > 0) {
            matches.push({
                path: file.path,
                tags: matched.map(t => `#${t}`),
                modified: file.stat.mtime,
            });
        }
    }

    // Sort by modification time (newest first)
    matches.sort((a, b) => b.modified - a.modified);

    return {
        result: JSON.stringify({
            tag: `#${searchTag}`,
            exact: exactMatch,
            count: matches.length,
            results: matches,
        }),
    };
}

// ── Recent notes ────────────────────────────────────────────────────

async function executeGetRecentNotes(app: App, args: GetRecentNotesArgs): Promise<ToolExecutionResult> {
    const rawMax = Number(args.max_results);
    const maxResults = Math.min(Math.max(1, isNaN(rawMax) ? 10 : rawMax), 50);
    const folder = args.folder ? sanitizeVaultPath(args.folder) : undefined;

    let files = app.vault.getMarkdownFiles();

    if (folder) {
        const prefix = folder.endsWith('/') ? folder : folder + '/';
        files = files.filter(f => f.path.startsWith(prefix) || f.path === folder);
    }

    // Sort by mtime descending
    files.sort((a, b) => b.stat.mtime - a.stat.mtime);

    const results = files.slice(0, maxResults).map(f => ({
        path: f.path,
        modified: f.stat.mtime,
        size_bytes: f.stat.size,
    }));

    return {
        result: JSON.stringify({
            count: results.length,
            total_notes: files.length,
            results,
        }),
    };
}

// ── Open notes ──────────────────────────────────────────────────────

async function executeGetOpenNotes(app: App): Promise<ToolExecutionResult> {
    const leaves = app.workspace.getLeavesOfType('markdown');
    const activeFile = app.workspace.getActiveFile();

    const openNotes: Array<{ path: string; active: boolean }> = [];
    for (const leaf of leaves) {
        const file = (leaf.view as { file?: TFile })?.file;
        if (file && file instanceof TFile) {
            openNotes.push({
                path: file.path,
                active: file.path === activeFile?.path,
            });
        }
    }

    return {
        result: JSON.stringify({
            count: openNotes.length,
            notes: openNotes,
        }),
    };
}

// ── Move note ───────────────────────────────────────────────────────

async function executeMoveNote(app: App, args: MoveNoteArgs): Promise<ToolExecutionResult> {
    const fromPath = sanitizeVaultPath(args.from);
    const toPath = sanitizeVaultPath(args.to);

    const file = app.vault.getAbstractFileByPath(fromPath);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${fromPath}` }) };
    }

    // Check destination doesn't already exist
    const existing = app.vault.getAbstractFileByPath(toPath);
    if (existing) {
        return { result: JSON.stringify({ error: `Destination already exists: ${toPath}` }) };
    }

    // Ensure destination folder exists
    const destFolder = toPath.substring(0, toPath.lastIndexOf('/'));
    if (destFolder) {
        await ensureParentFolder(app, toPath);
    }

    // Use fileManager.renameFile which updates all links automatically
    await app.fileManager.renameFile(file, toPath);

    return {
        result: JSON.stringify({
            success: true,
            from: fromPath,
            to: toPath,
            message: 'Note moved successfully. All links have been updated.',
        }),
    };
}

// ── Delete note ─────────────────────────────────────────────────────

async function executeDeleteNote(app: App, args: DeleteNoteArgs): Promise<ToolExecutionResult> {
    const path = sanitizeVaultPath(args.path);

    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
        return { result: JSON.stringify({ error: `File not found: ${path}` }) };
    }

    await app.vault.trash(file, false);

    return {
        result: JSON.stringify({
            success: true,
            path,
            message: 'Note moved to trash.',
        }),
    };
}

// ── Semantic Search (Embeddings) ────────────────────────────────────

import type { VaultIndexer } from './embeddings';

/** Singleton vault indexer — set by main.ts during plugin startup. */
let _vaultIndexer: VaultIndexer | null = null;

/** Called from main.ts to register the indexer instance. */
export function setVaultIndexer(indexer: VaultIndexer | null): void {
    _vaultIndexer = indexer;
}

/** Get the vault indexer (for use in executeSemanticSearchVault and elsewhere). */
export function getVaultIndexer(): VaultIndexer | null {
    return _vaultIndexer;
}

async function executeSemanticSearchVault(args: SemanticSearchVaultArgs): Promise<ToolExecutionResult> {
    if (!_vaultIndexer || !_vaultIndexer.isReady()) {
        return {
            result: JSON.stringify({
                error: 'Vector index not available. Enable embeddings in Settings → Embeddings and wait for indexing to complete.',
            }),
        };
    }

    const maxResults = Math.min(Math.max(args.max_results ?? 10, 1), 30);
    const minScore = Math.max(Math.min(args.min_score ?? 0.3, 1), 0);

    try {
        const results = await _vaultIndexer.search(args.query, maxResults, minScore);
        return {
            result: JSON.stringify({
                query: args.query,
                results: results.map(r => ({
                    path: r.path,
                    heading: r.heading,
                    snippet: r.text.slice(0, 300),
                    score: Math.round(r.score * 1000) / 1000,
                })),
                total: results.length,
            }),
        };
    } catch (err: unknown) {
        return {
            result: JSON.stringify({
                error: `Semantic search failed: ${getErrorMessage(err)}`,
            }),
        };
    }
}

// ── Web search ──────────────────────────────────────────────────────

async function executeWebSearch(args: WebSearchArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const query = args.query?.trim();
    if (!query) {
        return { result: JSON.stringify({ error: 'Missing search query' }) };
    }

    const provider = context?.webSearchProvider || 'tavily';
    const apiKey = context?.webSearchApiKey;
    if (!apiKey) {
        return { result: JSON.stringify({ error: 'Web search not configured. Add an API key in Settings → Tools.' }) };
    }

    const maxLen = context?.maxContentLength ?? 15000;

    try {
        debugLog.log('tool', `web_search: ${provider} query="${query.substring(0, 80)}"`, { provider, queryLen: query.length, max_results: args.max_results });
        let response;
        if (provider === 'google') {
            const cxId = context?.googleSearchCxId;
            if (!cxId) {
                return { result: JSON.stringify({ error: 'Google Search not configured. Add a Search Engine ID (cx) in Settings → Tools.' }) };
            }
            const req = buildGoogleSearchRequest(apiKey, cxId, query, args.max_results);
            const res = await requestUrl({ url: req.url, headers: req.headers });
            const json = res.json as Record<string, unknown>;
            if (json.error) {
                const apiErr = json.error as Record<string, unknown>;
                return { result: JSON.stringify({ error: `Google API error: ${apiErr.message || 'Unknown error'}` }) };
            }
            response = parseGoogleResponse(json);
        } else if (provider === 'brave') {
            const req = buildBraveSearchRequest(apiKey, query, args.max_results);
            const res = await requestUrl({ url: req.url, headers: req.headers });
            response = parseBraveResponse(res.json);
        } else {
            const req = buildTavilySearchRequest(apiKey, query, args.max_results, args.topic);
            const res = await requestUrl({ url: req.url, method: 'POST', headers: req.headers, body: req.body });
            response = parseTavilyResponse(res.json);
        }
        debugLog.log('tool', `web_search: ${response.results.length} results`, { resultCount: response.results.length, hasAnswer: !!response.answer });

        // Truncate total content to avoid blowing the context window
        let totalLen = 0;
        const truncatedResults: WebSearchResult[] = [];
        for (const r of response.results) {
            if (totalLen >= maxLen) break;
            if (totalLen + r.content.length > maxLen) {
                truncatedResults.push({ ...r, content: r.content.substring(0, maxLen - totalLen) });
                totalLen = maxLen;
            } else {
                truncatedResults.push(r);
                totalLen += r.content.length;
            }
        }

        return {
            result: JSON.stringify({
                query: response.query,
                results: truncatedResults,
                answer: response.answer,
            }),
        };
    } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        if (errMsg.includes('401') || errMsg.includes('403')) {
            return { result: JSON.stringify({ error: 'Invalid web search API key. Check Settings → Tools.' }) };
        }
        if (errMsg.includes('429')) {
            return { result: JSON.stringify({ error: 'Web search rate limit reached. Try again later.' }) };
        }
        return { result: JSON.stringify({ error: `Web search failed: ${errMsg}` }) };
    }
}

// ── Sub-agent executors ─────────────────────────────────────────────

async function executeDelegateToAgent(
    app: App,
    args: { task: string; role: string; context?: string },
    context: ToolContext,
): Promise<ToolExecutionResult> {
    const err = validateSubAgentArgs(args.task, args.role);
    if (err) return { result: JSON.stringify({ error: err }) };

    const { cachedModels, pluginSettings } = context;
    if (!cachedModels || !pluginSettings) {
        return { result: JSON.stringify({ error: 'Sub-agent context not available' }) };
    }

    const model = cachedModels.find(m => m.id === pluginSettings.selectedModel);
    const contextLimit = model?.context_length ?? 128000;
    const budget = calculateTokenBudget(contextLimit, 1);
    const result = await executeSubAgent(
        args.task,
        args.role as SubAgentRole,
        app,
        pluginSettings,
        cachedModels,
        budget,
        context,
        args.context,
    );

    return { result: formatSubAgentResults([result]) };
}

async function executeSpawnParallelAgents(
    app: App,
    args: { agents: Array<{ task: string; role: string; context?: string }> },
    context: ToolContext,
): Promise<ToolExecutionResult> {
    const err = validateParallelAgentsArgs(args.agents || []);
    if (err) return { result: JSON.stringify({ error: err }) };

    const { cachedModels, pluginSettings } = context;
    if (!cachedModels || !pluginSettings) {
        return { result: JSON.stringify({ error: 'Sub-agent context not available' }) };
    }

    const model = cachedModels.find(m => m.id === pluginSettings.selectedModel);
    const contextLimit = model?.context_length ?? 128000;
    const budget = calculateTokenBudget(contextLimit, args.agents.length);
    const results = await spawnParallelAgents(
        args.agents.map(a => ({ task: a.task, role: a.role as SubAgentRole, context: a.context })),
        app,
        pluginSettings,
        cachedModels,
        budget,
        context,
    );

    return { result: formatSubAgentResults(results) };
}

// ── Reddit tools ────────────────────────────────────────────────────

/** Cached Reddit access token and expiry */
let redditToken: { token: string; expires: number } | null = null;

async function getRedditAccessToken(clientId: string, clientSecret: string): Promise<string> {
    if (redditToken && Date.now() < redditToken.expires) return redditToken.token;
    const credentials = btoa(`${clientId}:${clientSecret}`);
    const res = await requestUrl({
        url: 'https://www.reddit.com/api/v1/access_token',
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'ObsidianSidekick/2.0',
        },
        body: 'grant_type=client_credentials',
    });
    const data = res.json;
    if (!data.access_token) throw new Error(data.error || 'Failed to get Reddit token');
    redditToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
}

async function executeRedditSearch(args: RedditSearchArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const query = args.query?.trim();
    if (!query) return { result: JSON.stringify({ error: 'Missing search query' }) };
    if (!context?.redditClientId || !context?.redditClientSecret) {
        return { result: JSON.stringify({ error: 'Reddit not configured. Add Client ID and Secret in Settings → Tools.' }) };
    }

    try {
        const token = await getRedditAccessToken(context.redditClientId, context.redditClientSecret);
        const maxResults = Math.min(args.max_results ?? 5, 20);
        const sort = args.sort ?? 'relevance';
        const timeFilter = args.time_filter ?? 'all';
        const subredditPath = args.subreddit ? `/r/${encodeURIComponent(args.subreddit)}` : '';
        const url = `https://oauth.reddit.com${subredditPath}/search.json?q=${encodeURIComponent(query)}&restrict_sr=${args.subreddit ? 'true' : 'false'}&sort=${sort}&t=${timeFilter}&limit=${maxResults}`;

        const res = await requestUrl({
            url,
            headers: {
                'Authorization': `bearer ${token}`,
                'User-Agent': 'ObsidianSidekick/2.0',
            },
        });

        const posts = (res.json?.data?.children ?? [])
            .filter((child: any) => child?.data)
            .map((child: any) => {
                const d = child.data;
                return {
                    title: d.title,
                    subreddit: d.subreddit_name_prefixed,
                    score: d.score,
                    num_comments: d.num_comments,
                    url: `https://www.reddit.com${d.permalink}`,
                    selftext: (d.selftext || '').slice(0, 500),
                    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
                    author: d.author,
                };
            });

        return { result: JSON.stringify({ query, results: posts }) };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Reddit search failed: ${getErrorMessage(err)}` }) };
    }
}

async function executeRedditReadPost(args: RedditReadPostArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const postUrl = args.post_url?.trim();
    if (!postUrl) return { result: JSON.stringify({ error: 'Missing post_url' }) };
    if (!context?.redditClientId || !context?.redditClientSecret) {
        return { result: JSON.stringify({ error: 'Reddit not configured. Add Client ID and Secret in Settings → Tools.' }) };
    }

    try {
        const token = await getRedditAccessToken(context.redditClientId, context.redditClientSecret);
        const maxComments = Math.min(args.max_comments ?? 10, 50);

        // Extract the path from the URL
        const urlObj = new URL(postUrl);
        const path = urlObj.pathname.replace(/\/$/, '');
        const apiUrl = `https://oauth.reddit.com${path}.json?limit=${maxComments}&depth=1`;

        const res = await requestUrl({
            url: apiUrl,
            headers: {
                'Authorization': `bearer ${token}`,
                'User-Agent': 'ObsidianSidekick/2.0',
            },
        });

        const data = res.json;
        if (!Array.isArray(data) || data.length < 2) {
            return { result: JSON.stringify({ error: 'Unexpected Reddit API response format' }) };
        }

        const post = data[0].data.children[0]?.data;
        const comments = data[1].data.children
            .filter((c: any) => c.kind === 't1')
            .slice(0, maxComments)
            .map((c: any) => ({
                author: c.data.author,
                score: c.data.score,
                body: (c.data.body || '').slice(0, 1000),
                created: new Date(c.data.created_utc * 1000).toISOString(),
            }));

        return {
            result: JSON.stringify({
                title: post?.title,
                subreddit: post?.subreddit_name_prefixed,
                author: post?.author,
                score: post?.score,
                selftext: (post?.selftext || '').slice(0, 3000),
                num_comments: post?.num_comments,
                url: postUrl,
                comments,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Reddit read post failed: ${getErrorMessage(err)}` }) };
    }
}

// ── Jira tools ──────────────────────────────────────────────────────

async function executeJiraSearch(args: JiraSearchArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const jql = args.jql?.trim();
    if (!jql) return { result: JSON.stringify({ error: 'Missing JQL query' }) };
    if (!context?.jiraBaseUrl || !context?.jiraEmail || !context?.jiraApiToken) {
        return { result: JSON.stringify({ error: 'Jira not configured. Add Base URL, Email, and API Token in Settings → Tools.' }) };
    }

    try {
        const maxResults = Math.min(args.max_results ?? 10, 50);
        const baseUrl = context.jiraBaseUrl.replace(/\/$/, '');
        const credentials = btoa(`${context.jiraEmail}:${context.jiraApiToken}`);
        const url = `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status,assignee,priority,issuetype,created,updated`;

        const res = await requestUrl({
            url,
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Accept': 'application/json',
            },
        });

        const issues = (res.json?.issues ?? []).map((issue: any) => ({
            key: issue?.key,
            summary: issue?.fields?.summary,
            status: issue?.fields?.status?.name,
            assignee: issue?.fields?.assignee?.displayName ?? 'Unassigned',
            priority: issue?.fields?.priority?.name,
            type: issue?.fields?.issuetype?.name,
            created: issue?.fields?.created,
            updated: issue?.fields?.updated,
            url: `${baseUrl}/browse/${issue?.key}`,
        }));

        return { result: JSON.stringify({ jql, total: res.json?.total, results: issues }) };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Jira search failed: ${getErrorMessage(err)}` }) };
    }
}

async function executeJiraGetIssue(args: JiraGetIssueArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const issueKey = args.issue_key?.trim();
    if (!issueKey) return { result: JSON.stringify({ error: 'Missing issue_key' }) };
    if (!context?.jiraBaseUrl || !context?.jiraEmail || !context?.jiraApiToken) {
        return { result: JSON.stringify({ error: 'Jira not configured. Add Base URL, Email, and API Token in Settings → Tools.' }) };
    }

    // Validate issue key format to prevent path traversal
    if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(issueKey)) {
        return { result: JSON.stringify({ error: 'Invalid issue key format. Expected format: PROJ-123' }) };
    }

    try {
        const baseUrl = context.jiraBaseUrl.replace(/\/$/, '');
        const credentials = btoa(`${context.jiraEmail}:${context.jiraApiToken}`);
        const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,assignee,reporter,priority,issuetype,created,updated,comment,issuelinks,labels,components`;

        const res = await requestUrl({
            url,
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Accept': 'application/json',
            },
        });

        const fields = res.json?.fields;
        // Extract plain text from Atlassian Document Format (ADF)
        const desc = fields?.description?.content
            ?.map((block: any) => block.content?.map((c: any) => c.text).join('') ?? '')
            .join('\n') ?? '';

        const comments = fields?.comment?.comments?.slice(-10).map((c: any) => ({
            author: c.author?.displayName,
            created: c.created,
            body: c.body?.content?.map((block: any) => block.content?.map((t: any) => t.text).join('') ?? '').join('\n') ?? '',
        })) ?? [];

        const linked = fields?.issuelinks?.map((link: any) => ({
            type: link.type?.name,
            key: link.inwardIssue?.key ?? link.outwardIssue?.key,
            summary: link.inwardIssue?.fields?.summary ?? link.outwardIssue?.fields?.summary,
        })) ?? [];

        return {
            result: JSON.stringify({
                key: res.json?.key,
                summary: fields?.summary,
                status: fields?.status?.name,
                assignee: fields?.assignee?.displayName ?? 'Unassigned',
                reporter: fields?.reporter?.displayName,
                priority: fields?.priority?.name,
                type: fields?.issuetype?.name,
                labels: fields?.labels,
                components: fields?.components?.map((c: any) => c.name),
                description: desc.slice(0, 3000),
                created: fields?.created,
                updated: fields?.updated,
                comments,
                linkedIssues: linked,
                url: `${baseUrl}/browse/${issueKey}`,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Jira get issue failed: ${getErrorMessage(err)}` }) };
    }
}

// ── Jira Write Operations ───────────────────────────────────────────

function getJiraCredentials(context?: ToolContext): { baseUrl: string; credentials: string } | null {
    if (!context?.jiraBaseUrl || !context?.jiraEmail || !context?.jiraApiToken) return null;
    return {
        baseUrl: context.jiraBaseUrl.replace(/\/$/, ''),
        credentials: btoa(`${context.jiraEmail}:${context.jiraApiToken}`),
    };
}

/** Convert plain text to Atlassian Document Format (ADF). */
function textToADF(text: string) {
    return {
        type: 'doc',
        version: 1,
        content: text.split('\n').map(line => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
        })),
    };
}

async function executeJiraCreateIssue(args: JiraCreateIssueArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const { project_key, summary } = args;
    if (!project_key?.trim() || !summary?.trim()) {
        return { result: JSON.stringify({ error: 'Missing project_key or summary' }) };
    }
    const creds = getJiraCredentials(context);
    if (!creds) return { result: JSON.stringify({ error: 'Jira not configured. Add Base URL, Email, and API Token in Settings → Tools.' }) };

    // Validate project key format
    if (!/^[A-Z][A-Z0-9]*$/i.test(project_key.trim())) {
        return { result: JSON.stringify({ error: 'Invalid project key format. Expected format: PROJ' }) };
    }

    try {
        const fields: Record<string, unknown> = {
            project: { key: project_key.trim() },
            summary: summary.trim(),
            issuetype: { name: args.issue_type || 'Task' },
        };
        if (args.description) fields.description = textToADF(args.description);
        if (args.priority) fields.priority = { name: args.priority };
        if (args.assignee_id) fields.assignee = { accountId: args.assignee_id };
        if (args.labels?.length) fields.labels = args.labels;

        const res = await requestUrl({
            url: `${creds.baseUrl}/rest/api/3/issue`,
            method: 'POST',
            headers: {
                'Authorization': `Basic ${creds.credentials}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ fields }),
        });

        return {
            result: JSON.stringify({
                key: res.json?.key,
                id: res.json?.id,
                url: `${creds.baseUrl}/browse/${res.json?.key}`,
                message: `Created issue ${res.json?.key}`,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Jira create issue failed: ${getErrorMessage(err)}` }) };
    }
}

async function executeJiraAddComment(args: JiraAddCommentArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const { issue_key, comment } = args;
    if (!issue_key?.trim() || !comment?.trim()) {
        return { result: JSON.stringify({ error: 'Missing issue_key or comment' }) };
    }
    if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(issue_key.trim())) {
        return { result: JSON.stringify({ error: 'Invalid issue key format. Expected format: PROJ-123' }) };
    }
    const creds = getJiraCredentials(context);
    if (!creds) return { result: JSON.stringify({ error: 'Jira not configured. Add Base URL, Email, and API Token in Settings → Tools.' }) };

    try {
        const res = await requestUrl({
            url: `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(issue_key.trim())}/comment`,
            method: 'POST',
            headers: {
                'Authorization': `Basic ${creds.credentials}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ body: textToADF(comment) }),
        });

        return {
            result: JSON.stringify({
                id: res.json?.id,
                issue_key: issue_key.trim(),
                message: `Comment added to ${issue_key.trim()}`,
            }),
        };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Jira add comment failed: ${getErrorMessage(err)}` }) };
    }
}

async function executeJiraUpdateIssue(args: JiraUpdateIssueArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const { issue_key } = args;
    if (!issue_key?.trim()) {
        return { result: JSON.stringify({ error: 'Missing issue_key' }) };
    }
    if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(issue_key.trim())) {
        return { result: JSON.stringify({ error: 'Invalid issue key format. Expected format: PROJ-123' }) };
    }
    const creds = getJiraCredentials(context);
    if (!creds) return { result: JSON.stringify({ error: 'Jira not configured. Add Base URL, Email, and API Token in Settings → Tools.' }) };

    const key = issue_key.trim();
    const results: string[] = [];

    // Update fields (summary, description, priority, labels, assignee)
    const fields: Record<string, unknown> = {};
    if (args.summary) fields.summary = args.summary;
    if (args.description) fields.description = textToADF(args.description);
    if (args.priority) fields.priority = { name: args.priority };
    if (args.labels) fields.labels = args.labels;
    if (args.assignee_id) fields.assignee = { accountId: args.assignee_id };

    if (Object.keys(fields).length > 0) {
        try {
            await requestUrl({
                url: `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`,
                method: 'PUT',
                headers: {
                    'Authorization': `Basic ${creds.credentials}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ fields }),
            });
            results.push(`Updated fields: ${Object.keys(fields).join(', ')}`);
        } catch (err: unknown) {
            results.push(`Field update failed: ${getErrorMessage(err)}`);
        }
    }

    // Status transition (separate API call)
    if (args.status) {
        try {
            // First get available transitions
            const transRes = await requestUrl({
                url: `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
                headers: {
                    'Authorization': `Basic ${creds.credentials}`,
                    'Accept': 'application/json',
                },
            });
            const transitions = transRes.json?.transitions ?? [];
            const target = transitions.find((t: { name: string }) =>
                t.name.toLowerCase() === args.status!.toLowerCase()
            );
            if (target) {
                await requestUrl({
                    url: `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${creds.credentials}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({ transition: { id: target.id } }),
                });
                results.push(`Status changed to "${target.name}"`);
            } else {
                const available = transitions.map((t: { name: string }) => t.name).join(', ');
                results.push(`Cannot transition to "${args.status}". Available: ${available}`);
            }
        } catch (err: unknown) {
            results.push(`Status transition failed: ${getErrorMessage(err)}`);
        }
    }

    if (results.length === 0) {
        return { result: JSON.stringify({ error: 'No fields to update' }) };
    }

    return {
        result: JSON.stringify({
            issue_key: key,
            url: `${creds.baseUrl}/browse/${key}`,
            updates: results,
        }),
    };
}

// ── User Profile ────────────────────────────────────────────────────

async function executeRememberUserFact(args: RememberUserFactArgs, context?: ToolContext): Promise<ToolExecutionResult> {
    const { fact, category } = args;
    if (!fact?.trim()) {
        return { result: JSON.stringify({ error: 'fact is required' }) };
    }
    if (!context?.saveProfileFact) {
        return { result: JSON.stringify({ error: 'User profiling is not enabled' }) };
    }
    try {
        await context.saveProfileFact(fact.trim(), category);
        return { result: JSON.stringify({ success: true, message: `Remembered: "${fact.trim()}"` }) };
    } catch (err: unknown) {
        return { result: JSON.stringify({ error: `Failed to save fact: ${getErrorMessage(err)}` }) };
    }
}

// ── Main executor ───────────────────────────────────────────────────

/** Tool executor registry mapping tool names to their handlers. */
const TOOL_EXECUTORS: Record<string, (app: App, args: any, context: ToolContext) => Promise<ToolExecutionResult>> = {
    search_vault: (app, args) => executeSearchVault(app, args),
    read_note: (app, args, ctx) => executeReadNote(app, args, ctx),
    create_note: (app, args) => executeCreateNote(app, args),
    fetch_url: (_app, args, ctx) => executeFetchUrl(args, ctx),
    generate_image: (_app, args, ctx) => executeGenerateImage(args, ctx),
    ask_user: (_app, args, ctx) => executeAskUser(args, ctx),
    ask_user_choice: (_app, args, ctx) => executeAskUserChoice(args, ctx),
    view_image: (app, args) => executeViewImage(app, args),
    list_files: (app, args) => executeListFiles(app, args),
    grep_search: (app, args, ctx) => executeGrepSearch(app, args, ctx),
    open_note: (app, args) => executeOpenNote(app, args),
    edit_note: (app, args) => executeEditNote(app, args),
    read_note_outline: (app, args) => executeReadNoteOutline(app, args),
    read_note_section: (app, args, ctx) => executeReadNoteSection(app, args, ctx),
    get_backlinks: (app, args) => executeGetBacklinks(app, args),
    get_note_metadata: (app, args) => executeGetNoteMetadata(app, args),
    search_by_tag: (app, args) => executeSearchByTag(app, args),
    get_recent_notes: (app, args) => executeGetRecentNotes(app, args),
    get_open_notes: (app) => executeGetOpenNotes(app),
    move_note: (app, args) => executeMoveNote(app, args),
    delete_note: (app, args) => executeDeleteNote(app, args),
    semantic_search_vault: (_app, args) => executeSemanticSearchVault(args),
    web_search: (_app, args, ctx) => executeWebSearch(args, ctx),
    search_reddit: (_app, args, ctx) => executeRedditSearch(args, ctx),
    read_reddit_post: (_app, args, ctx) => executeRedditReadPost(args, ctx),
    jira_search: (_app, args, ctx) => executeJiraSearch(args, ctx),
    jira_get_issue: (_app, args, ctx) => executeJiraGetIssue(args, ctx),
    jira_create_issue: (_app, args, ctx) => executeJiraCreateIssue(args, ctx),
    jira_add_comment: (_app, args, ctx) => executeJiraAddComment(args, ctx),
    jira_update_issue: (_app, args, ctx) => executeJiraUpdateIssue(args, ctx),
    remember_user_fact: (_app, args, ctx) => executeRememberUserFact(args, ctx),
    delegate_to_agent: (app, args, ctx) => executeDelegateToAgent(app, args, ctx),
    spawn_parallel_agents: (app, args, ctx) => executeSpawnParallelAgents(app, args, ctx),
};

export async function executeTool(
    toolName: string,
    toolArgsJson: string,
    app: App,
    context: ToolContext,
): Promise<ToolExecutionResult> {
    let args: Record<string, unknown>;
    try {
        args = toolArgsJson.trim() ? JSON.parse(toolArgsJson) : {};
    } catch {
        return { result: JSON.stringify({ error: 'Invalid tool arguments JSON' }) };
    }

    const executor = TOOL_EXECUTORS[toolName];
    if (executor) {
        return executor(app, args, context);
    }

    // Route to MCP if the tool name matches the mcp_ prefix pattern
    if (parseMCPToolName(toolName) && context.mcpServers?.length) {
        return executeMCPTool(toolName, args, context.mcpServers);
    }

    return { result: JSON.stringify({ error: `Unknown tool: ${toolName}` }) };
}

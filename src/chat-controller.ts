import type { ChatMessage, Conversation, StreamResult, ToolCall, ToolContext, NoteContext, ApiMessage, PluginSettings, IterateState, ChatCompletionRequest, ResponsesApiRequest, MessagesApiRequest } from './types';
import type { App } from 'obsidian';
import { streamSSE, streamResponsesAPI, streamMessagesAPI } from './streaming';
import { RISKY_TOOLS, TOOL_LABELS, executeTool, requestToolApproval, resolveToolApproval } from './tools';
import type { ApprovalResult } from './tools';
import { buildApiMessages, buildRequestBody, buildResponsesRequestBody, buildMessagesRequestBody, shouldUseResponsesAPI, shouldUseMessagesAPI, getMessagesApiHeaders, convertMessagesForAnthropic, formatToolArgsPreview, formatCleanToolHeader, convertMessagesForResponses, MAX_RETRIES, RETRY_DELAY_MS, MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_ITERATE, DisplayAccumulator, computeContextBreakdown, resolveApiKey, getApiKeyForProvider, getRequestMessageCount, getRequestToolCount, requestHasTools, updateRequestMessages, stripRequestParam, getRequestDebugInfo } from './api-helpers';
import type { ContextBreakdown, AnyRequestBody } from './api-helpers';
import { saveImageToVault, resolveImageForApi } from './image-utils';
import { fetchGenerationCost } from './providers';
import { PROVIDERS, ITERATE_FEEDBACK_INSTRUCTION, ITERATE_REPROMPT } from './constants';
import { buildProfileContext, buildLearningInstructions } from '../lib/profile';
import { getEffectivePrompt } from '../lib/agents';
import { sleep } from './utils';
import { copilotTokenManager } from './copilot-auth';
import type { ModelInfo, PendingToolApproval } from './types';
import { storeEditDiff } from './diff-modal';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';
import { buildTitlePromptMessages, parseTitleResponse } from '../lib/conversation';
import { buildThinkingSummaryPromptMessages, parseThinkingSummaryResponse, extractThinkingCallouts, replaceThinkingSummary } from '../lib/suggestions';
import { getAllMCPTools } from './mcp';

/**
 * Chat controller — handles the streaming + tool call orchestration logic
 * extracted from ChatView.sendMessage().
 *
 * This separates the business logic (API calls, tool loops, cost tracking)
 * from the UI layer (DOM manipulation, rendering).
 */

// ── Callbacks the controller uses to communicate with the view ──────

export interface ChatControllerCallbacks {
    /** Update the displayed content of the last assistant message. */
    updateDisplay(content: string): void;
    /** Show the tool approval UI and return whether user approved. */
    showApproval(approval: PendingToolApproval): void;
    /** Hide the tool approval UI. */
    hideApproval(): void;
    /** Show cost information. */
    showCost(total: number, promptTokens: number, completionTokens: number): void;
    /** Show an error with retry option. */
    showErrorWithRetry(msg: string, content: string, systemPrompt?: string, images?: string[]): void;
    /** Get the cached model list for capability checks. */
    getCachedModels(): ModelInfo[];
    /** Called after user + assistant placeholder messages are pushed, so the view can render them incrementally. */
    onMessagesPushed(newMessages: ChatMessage[]): Promise<void>;
    /** Request inline feedback from the user for iterate mode. Returns the user's feedback text and optional images. */
    onRequestIterateFeedback(question: string): Promise<{ text: string; images?: string[] } | null>;
    /** Request a choice selection from the user. Shows clickable options + optional free-text input. */
    onRequestIterateChoice(question: string, choices: string[], allowCustom: boolean): Promise<{ text: string; images?: string[] } | null>;
    /** Live context window fraction + hover breakdown. Passes exact tokens if known. */
    updateContextBreakdown(breakdown: ContextBreakdown, apiTokens?: number): void;
    /** Called when an auto-generated title is available for the conversation. */
    onTitleGenerated?(title: string): void;
    /** Update the loading status text (e.g. "Thinking...", "Running search_vault..."). */
    onStatusChange?(status: string): void;
    /** Save a user profile fact (from remember_user_fact tool). */
    saveProfileFact?(fact: string, category?: string): Promise<void>;
}

// Re-export DisplayAccumulator for external consumers
export { DisplayAccumulator } from './api-helpers';

// ── Tool call processor ─────────────────────────────────────────────

/**
 * Process a single tool call. Returns `true` when the iterate loop should stop
 * (i.e. the user clicked "Done" on the ask_user feedback prompt).
 * User messages from image tools are collected in `deferredUserMessages` to avoid
 * breaking tool result contiguity (all tool results must be consecutive).
 */
async function processToolCall(
    tc: ToolCall,
    app: App,
    settings: PluginSettings,
    conversation: Conversation,
    apiMessages: ApiMessage[],
    display: DisplayAccumulator,
    callbacks: ChatControllerCallbacks,
    useResponses = false,
    deferredUserMessages: ApiMessage[] = [],
    autoApprovedTools?: Set<string>,
): Promise<boolean> {
    const toolName = tc.function.name;
    const toolArgs = tc.function.arguments;
    const label = TOOL_LABELS[toolName] || toolName;
    const argsPreview = formatToolArgsPreview(toolArgs);
    const toolHeader = formatCleanToolHeader(toolName, toolArgs);

    // Unique marker per tool call — prevents status update collisions when the
    // same tool is called multiple times with the same arguments in one round.
    const tcId = tc.callId || tc.id;
    const runningCallout = `> [!example]+ ${toolHeader}<!--${tcId}-->\n> _Running…_\n`;

    // Start tool step callout
    display.accumulated += `\n\n${runningCallout}`;
    callbacks.updateDisplay(display.buildDisplay());
    callbacks.onStatusChange?.(`Running ${label}…`);

    // Helper to push tool result in the correct format
    const pushToolResult = (callId: string, content: string) => {
        if (useResponses) {
            // Responses API: no 'role' field — uses 'type' only
            apiMessages.push({ type: 'function_call_output', call_id: callId, output: content } as ApiMessage);
        } else {
            apiMessages.push({ role: 'tool', tool_call_id: callId, content });
        }
    };

    // Approval gate for risky tools and MCP tools (skip if auto-approved for this chat)
    const isMcpTool = toolName.startsWith('mcp__');
    if ((RISKY_TOOLS.has(toolName) || isMcpTool) && !autoApprovedTools?.has(toolName)) {
        const result = await handleToolApproval(tc, toolHeader, display, callbacks, argsPreview, label, runningCallout);
        if (result === 'decline') {
            pushToolResult(tc.callId || tc.id, 'User declined this tool call.');
            return false;
        }
        if (result === 'always' && autoApprovedTools) {
            autoApprovedTools.add(toolName);
            // Persist to conversation so approvals survive session switches
            conversation.alwaysAllowedTools = Array.from(autoApprovedTools);
        }
    }

    // Execute tool
    const provider = settings.selectedProvider;
    const apiKey = getApiKeyForProvider(provider, settings);

    // Resolve image generation provider/key (may differ from chat provider)
    const imgProvider = settings.imageGenProvider === 'same' ? provider : settings.imageGenProvider;
    const imgApiKey = getApiKeyForProvider(imgProvider, settings);

    const toolContext: ToolContext = {
        provider, apiKey, callbacks,
        imageGenProvider: imgProvider,
        imageGenApiKey: imgApiKey,
        imageGenModel: settings.imageGenModel,
        imageGenSize: settings.imageGenSize,
        imageGenQuality: settings.imageGenQuality,
        imageGenAspectRatio: settings.imageGenAspectRatio,
        maxContentLength: settings.maxContentLength,
        webSearchProvider: settings.webSearchProvider,
        webSearchApiKey: settings.webSearchApiKey,
        googleSearchCxId: settings.googleSearchCxId,
        redditClientId: settings.redditClientId,
        redditClientSecret: settings.redditClientSecret,
        jiraBaseUrl: settings.jiraBaseUrl,
        jiraEmail: settings.jiraEmail,
        jiraApiToken: settings.jiraApiToken,
        mcpServers: settings.mcpServers,
        pluginSettings: settings,
        cachedModels: callbacks.getCachedModels(),
        saveProfileFact: callbacks.saveProfileFact,
    };

    try {
        debugLog.log('tool', `Executing: ${toolName}`, { toolName, args: toolArgs });
        const execStart = Date.now();
        const { result, generatedImageUrl, viewedImageUrl, feedbackImages, editDiff } = await executeTool(toolName, toolArgs, app, toolContext);
        debugLog.log('tool', `Completed: ${toolName}`, {
            toolName,
            durationMs: Date.now() - execStart,
            resultLength: result.length,
            result,
            hasGeneratedImage: !!generatedImageUrl,
            hasViewedImage: !!viewedImageUrl,
            hasFeedbackImages: !!(feedbackImages?.length),
        });

        if (generatedImageUrl) {
            const savedPath = await saveImageToVault(app, settings.chatFolder, generatedImageUrl, 'gen');
            display.replaceInAccumulated(
                runningCallout,
                `> [!done]+ ${toolHeader}\n> ![[${savedPath}]]\n`,
            );
            callbacks.updateDisplay(display.buildDisplay());

            // Push a compact tool result — never send raw image data (base64 data
            // URLs can be 1M+ tokens and blow the context window on the next round).
            pushToolResult(tc.callId || tc.id, JSON.stringify({
                success: true,
                vault_path: savedPath,
                message: 'Image generated and saved to vault.',
            }));

            // Text-only confirmation — the model already knows what it generated.
            // Deferred to avoid breaking tool result contiguity.
            deferredUserMessages.push({
                role: 'user',
                content: `The image was generated successfully and saved as "${savedPath}".`,
            });
        } else if (viewedImageUrl) {
            // view_image tool — inject image as a user message so the model can see it.
            // The tool result is text-only metadata; the actual image is a separate user message
            // with multi-part content (text + image_url) that vision models can process.
            let parsedResult: any;
            try { parsedResult = JSON.parse(result); } catch { parsedResult = {}; }
            display.replaceInAccumulated(
                runningCallout,
                `> [!done]+ ${toolHeader}\n> ![[${parsedResult.path ?? 'unknown'}]]\n`,
            );
            callbacks.updateDisplay(display.buildDisplay());

            pushToolResult(tc.callId || tc.id, result);

            // Inject user message with image content for the model to analyze.
            // Deferred to avoid breaking tool result contiguity.
            deferredUserMessages.push({
                role: 'user',
                content: [
                    { type: 'text' as const, text: `Here is the image from "${parsedResult.path}":` },
                    { type: 'image_url' as const, image_url: { url: viewedImageUrl } },
                ],
            });
        } else {
            const preview = result.length > 500 ? result.substring(0, 500) + '…' : result;
            display.replaceInAccumulated(
                runningCallout,
                `> [!done]- ${toolHeader}\n> \`\`\`\n> ${preview.replace(/\n/g, '\n> ')}\n> \`\`\`\n`,
            );
            callbacks.updateDisplay(display.buildDisplay());

            pushToolResult(tc.callId || tc.id, result);

            // Store diff data for the "View Diff" button in post-processing
            if (editDiff) {
                storeEditDiff(editDiff.path, editDiff);
            }
        }

        // If iterate feedback includes user-attached images, inject them as a user message
        if (feedbackImages && feedbackImages.length > 0) {
            const savedPaths: string[] = [];
            const parts: any[] = [{ type: 'text' as const, text: 'The user attached these images with their feedback:' }];
            for (const img of feedbackImages) {
                // Save to vault so images appear in the conversation note
                const savedPath = await saveImageToVault(app, settings.chatFolder, img, 'feedback');
                savedPaths.push(savedPath);
                const resolved = await resolveImageForApi(app, savedPath);
                parts.push({ type: 'image_url' as const, image_url: { url: resolved } });
            }
            // Deferred to avoid breaking tool result contiguity
            deferredUserMessages.push({ role: 'user', content: parts });

            // Add image embeds to display so they render in the chat
            const embeds = savedPaths.map(p => `![[${p}]]`).join('\n');
            display.accumulated += `\n${embeds}\n`;
            callbacks.updateDisplay(display.buildDisplay());
        }

        // Signal iterate-done when the user clicked "Done" on the ask_user prompt
        if (toolName === 'ask_user' && result === 'User cancelled or closed the prompt.') {
            return true;
        }
        return false;
    } catch (toolErr: unknown) {
        debugLog.log('tool', `Error: ${toolName}`, { toolName, error: getErrorMessage(toolErr) });
        display.replaceInAccumulated(
            runningCallout,
            `> [!fail]- ${toolHeader}\n> ${getErrorMessage(toolErr)}\n`,
        );
        callbacks.updateDisplay(display.buildDisplay());
        pushToolResult(tc.callId || tc.id, JSON.stringify({ error: getErrorMessage(toolErr) }));
        return false;
    }
}

async function handleToolApproval(
    tc: ToolCall,
    toolHeader: string,
    display: DisplayAccumulator,
    callbacks: ChatControllerCallbacks,
    argsPreview: string,
    label: string,
    runningCallout: string,
): Promise<ApprovalResult> {
    // Show "awaiting approval" state
    const approvalCallout = `> [!warning]+ ${toolHeader}<!--${tc.callId || tc.id}-->\n> _Awaiting approval…_\n`;
    display.replaceInAccumulated(
        runningCallout,
        approvalCallout,
    );
    callbacks.updateDisplay(display.buildDisplay());

    callbacks.showApproval({
        toolName: tc.function.name,
        toolLabel: label,
        args: tc.function.arguments,
        argsPreview,
        toolCallId: tc.id,
    });

    const result = await requestToolApproval();
    callbacks.hideApproval();

    if (result === 'decline') {
        display.replaceInAccumulated(
            approvalCallout,
            `> [!fail]- ${toolHeader}\n> _Declined by user._\n`,
        );
        callbacks.updateDisplay(display.buildDisplay());
        return 'decline';
    }

    // Approved — switch back to running state
    display.replaceInAccumulated(
        approvalCallout,
        runningCallout,
    );
    callbacks.updateDisplay(display.buildDisplay());
    return result;
}

// ── Stream a single round ───────────────────────────────────────────

async function streamRound(
    cfg: { url: string; responsesUrl?: string; messagesUrl?: string; headers: (key: string, options?: { isAgent?: boolean; hasTools?: boolean }) => Record<string, string> },
    apiKey: string,
    requestBody: ChatCompletionRequest | ResponsesApiRequest | MessagesApiRequest,
    display: DisplayAccumulator,
    callbacks: ChatControllerCallbacks,
    app: App,
    chatFolder: string,
    signal: AbortSignal,
    isAgent = false,
    useResponsesAPI = false,
    hasTools = false,
    useMessagesAPI = false,
): Promise<StreamResult> {
    let url: string;
    let streamFn: typeof streamSSE;
    let headers: Record<string, string>;

    if (useMessagesAPI && cfg.messagesUrl) {
        url = cfg.messagesUrl;
        streamFn = streamMessagesAPI;
        headers = { ...cfg.headers(apiKey, { isAgent, hasTools }), ...getMessagesApiHeaders() };
    } else if (useResponsesAPI && cfg.responsesUrl) {
        url = cfg.responsesUrl;
        streamFn = streamResponsesAPI;
        headers = cfg.headers(apiKey, { isAgent, hasTools });
    } else {
        url = cfg.url;
        streamFn = streamSSE;
        headers = cfg.headers(apiKey, { isAgent, hasTools });
    }

    debugLog.log('api', 'Stream round starting', {
        url,
        api: useMessagesAPI ? 'messages' : useResponsesAPI ? 'responses' : 'chat-completions',
        isAgent,
        hasTools,
        model: requestBody.model,
        messageCount: 'messages' in requestBody ? requestBody.messages.length : 'input' in requestBody ? requestBody.input.length : 0,
        toolCount: requestBody.tools?.length ?? 0,
    });

    callbacks.onStatusChange?.('Generating…');
    const startTime = Date.now();
    let statusIsReasoning = false;
    let tokenCount = 0;
    let lastStatusUpdate = startTime;
    const result = await streamFn(
        url,
        headers,
        requestBody as unknown as Record<string, unknown>,
        (token, type) => {
            if (type === 'reasoning') {
                if (!statusIsReasoning) { statusIsReasoning = true; callbacks.onStatusChange?.('Thinking…'); }
                debugLog.log('chat', 'Reasoning chunk', { preview: token?.slice(0, 100) });
                display.addReasoning(token!);
            } else if (type === 'image') {
                const placeholder = `\n\n![generating image...]()\n\n`;
                display.addImagePlaceholder(placeholder);
                saveImageToVault(app, chatFolder, token!, 'gen').then(path => {
                    const vaultLink = `\n\n![[${path}]]\n\n`;
                    display.replaceInContent(placeholder, vaultLink);
                    display.replaceInAccumulated(placeholder, vaultLink);
                    callbacks.updateDisplay(display.buildDisplay());
                }).catch((err: unknown) => { debugLog.log('chat', 'Image save to vault failed', { error: getErrorMessage(err) }); });
            } else if (type === 'tool_calls') {
                // handled after stream ends
            } else if (token) {
                if (statusIsReasoning) { statusIsReasoning = false; callbacks.onStatusChange?.('Generating…'); }
                display.addContent(token);
            }
            // Update streaming status with token throughput
            if (token && (type !== 'tool_calls')) {
                tokenCount++;
                const now = Date.now();
                if (now - lastStatusUpdate > 1000) {
                    lastStatusUpdate = now;
                    const elapsed = (now - startTime) / 1000;
                    const tps = Math.round(tokenCount / elapsed);
                    const label = statusIsReasoning ? 'Thinking' : 'Generating';
                    callbacks.onStatusChange?.(`${label}… ${tokenCount} tokens · ${tps} t/s`);
                }
            }
            callbacks.updateDisplay(display.buildDisplay());
        },
        signal,
    );

    debugLog.log('api', 'Stream round completed', {
        durationMs: Date.now() - startTime,
        finishReason: result.finishReason,
        toolCallCount: result.toolCalls?.length ?? 0,
        toolNames: result.toolCalls?.map(tc => tc.function.name),
        usage: result.usage,
        generationId: result.generationId,
        hasReasoningSignature: !!result.reasoningOpaque,
        reasoningSignatureLength: result.reasoningOpaque?.length ?? 0,
    });

    return result;
}

// ── Main send message orchestrator ──────────────────────────────────

/** Build Copilot-specific config with dynamic endpoint from token exchange. */
function resolveCopilotConfig(baseCfg: typeof PROVIDERS[string]): typeof PROVIDERS[string] {
    const dynamicEndpoint = copilotTokenManager.getApiEndpoint();
    if (!dynamicEndpoint) return baseCfg;
    return {
        ...baseCfg,
        url: `${dynamicEndpoint}/chat/completions`,
        responsesUrl: `${dynamicEndpoint}/responses`,
        messagesUrl: `${dynamicEndpoint}/v1/messages`,
    };
}

/** Auto-strip unsupported parameters from the request body when the API returns 400. */
export function autoStripBadParams(req: AnyRequestBody, errMsg: string, attempt?: number): void {
    debugLog.log('api', '400 error — auto-stripping params', { attempt, errMsg });
    if (errMsg.includes('temperature')) {
        stripRequestParam(req, 'temperature');
    } else if (errMsg.includes('tools')) {
        debugLog.log('api', 'Stripping tools from request after 400', { errMsg });
        stripRequestParam(req, 'tools');
    } else if (errMsg.includes('reason') || errMsg.includes('think') || errMsg.includes('max_tokens') || errMsg.includes('model_not_supported')) {
        debugLog.log('api', 'Stripping reasoning params after 400', { errMsg });
        stripRequestParam(req, 'reasoning_effort');
        stripRequestParam(req, 'reasoning_summary');
        stripRequestParam(req, 'reasoning');
        stripRequestParam(req, 'thinking_budget');
        stripRequestParam(req, 'max_tokens');
    }
}

/** Update the context breakdown UI with token-scaled estimates as the context grows. */
function updateScaledContextBreakdown(
    apiMessages: ApiMessage[],
    ctxLimit: number,
    basePromptTokens: number | undefined,
    baseCharCount: number,
    callbacks: ChatControllerCallbacks,
): void {
    const breakdown = computeContextBreakdown(apiMessages, ctxLimit);
    const scaledTokens = basePromptTokens && baseCharCount > 0
        ? Math.round(basePromptTokens * breakdown.totalChars / baseCharCount)
        : basePromptTokens;
    callbacks.updateContextBreakdown(breakdown, scaledTokens);
}

/** Format apiMessages for debug logging (truncated previews). */
export function formatMessagesForLog(messages: unknown[]): unknown[] {
    return messages.map((m: any) => ({
        role: m.role || m.type,
        contentPreview: typeof m.content === 'string'
            ? m.content.substring(0, 500)
            : Array.isArray(m.content) ? `[${m.content.length} parts]` : String(m.content ?? ''),
        tool_calls: m.tool_calls?.map((tc: any) => ({
            name: tc.function?.name,
            arguments: tc.function?.arguments,
        })),
        tool_call_id: m.tool_call_id,
        call_id: m.call_id,
        output: m.output,
        name: m.name,
    }));
}

/** Append tool call messages to apiMessages in the format expected by the current API. */
export function appendToolCallMessages(
    apiMessages: ApiMessage[],
    toolCalls: ToolCall[],
    useResponses: boolean,
    roundReasoning: string,
    roundReasoningSignature: string,
): void {
    if (useResponses) {
        // Responses API: push function_call items (no 'role' — Responses API uses 'type' only)
        for (const tc of toolCalls) {
            apiMessages.push({
                type: 'function_call',
                id: tc.id,
                call_id: tc.callId || tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
            } as ApiMessage);
        }
    } else {
        // Chat Completions / Messages API: push assistant message with tool_calls
        const assistantMsg: ApiMessage = {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
        };
        // Preserve thinking for Messages API multi-turn (Anthropic requires thinking blocks)
        if (roundReasoning) {
            assistantMsg._thinking = roundReasoning;
            if (roundReasoningSignature) assistantMsg._thinkingSignature = roundReasoningSignature;
        }
        apiMessages.push(assistantMsg);
    }
}

/** Sync the display accumulator content into the last assistant message and persist. */
async function syncDisplayAndSave(
    conversation: Conversation,
    display: DisplayAccumulator,
    saveConversation: (conv: Conversation) => Promise<void>,
): Promise<void> {
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (lastMsg?.role === 'assistant') {
        lastMsg.content = display.accumulated || lastMsg.content;
        lastMsg.cleanContent = display.cleanOutput || undefined;
    }
    conversation.updatedAt = Date.now();
    await saveConversation(conversation);
}

export interface SendMessageOptions {
    content: string;
    systemPromptOverride?: string;
    skipUserPush?: boolean;
    userImages?: string[];
    iterateMode?: boolean;
    /** When true, resumes a paused iterate session using saved apiMessages. */
    resumeIterate?: boolean;
    /** User feedback provided when resuming an iterate session. */
    iterateFeedback?: string;
}

/** Result of session initialization — either resume or fresh build. */
interface SessionState {
    apiMessages: ApiMessage[];
    display: DisplayAccumulator;
    startToolRound: number;
    forceAllAgent: boolean;
    forceUseResponses?: boolean;
}

/** Restore a paused iterate session from persisted state. Returns null to abort. */
async function restoreIterateSession(
    app: App,
    conversation: Conversation,
    loadIterateState: (convId: string) => Promise<IterateState | null>,
    deleteIterateState: ((convId: string) => Promise<void>) | undefined,
    saveConversation: (conv: Conversation) => Promise<void>,
    callbacks: ChatControllerCallbacks,
    iterateFeedback: string | undefined,
    userImages: string[] | undefined,
): Promise<SessionState | null> {
    const savedState = await loadIterateState(conversation.id);
    if (!savedState) {
        callbacks.updateDisplay('_No saved iterate state found. Starting fresh._');
        return null;
    }

    const apiMessages = savedState.apiMessages;
    const display = new DisplayAccumulator();
    display.accumulated = savedState.displayAccumulated;
    const forceUseResponses = savedState.useResponses;

    // Sanitize: replace null content with empty string to prevent API 400 errors.
    // Chat Completions assistant messages with tool_calls have content: null which is
    // standard, but some API endpoints reject it.
    // Skip Responses API items (which use 'type' instead of 'role').
    for (const msg of apiMessages) {
        if (msg.type) continue;
        if (msg.content === null || msg.content === undefined) {
            msg.content = '';
        }
    }

    // Replace the last tool result ("User cancelled") with the user's actual feedback
    if (iterateFeedback) {
        for (let i = apiMessages.length - 1; i >= 0; i--) {
            const msg = apiMessages[i];
            if (msg.role === 'tool' && typeof msg.content === 'string'
                && msg.content === 'User cancelled or closed the prompt.') {
                msg.content = iterateFeedback;
                break;
            }
            if (msg.type === 'function_call_output' && typeof msg.output === 'string'
                && msg.output === 'User cancelled or closed the prompt.') {
                msg.output = iterateFeedback;
                break;
            }
        }

        // Inject resume images (if the user attached images when resuming)
        if (userImages && userImages.length > 0) {
            const parts: any[] = [{ type: 'text' as const, text: 'The user attached these images with their feedback:' }];
            for (const img of userImages) {
                const resolved = await resolveImageForApi(app, img);
                parts.push({ type: 'image_url' as const, image_url: { url: resolved } });
            }
            apiMessages.push({ role: 'user', content: parts });
        }
    }

    // Clear the paused flag
    conversation.iterateSessionPaused = false;
    await saveConversation(conversation);
    if (deleteIterateState) await deleteIterateState(conversation.id);

    // Show restored display
    callbacks.updateDisplay(display.buildDisplay());

    return {
        apiMessages,
        display,
        startToolRound: savedState.toolRound,
        forceAllAgent: true,
        forceUseResponses,
    };
}

/** Build a fresh session from user content and conversation history. Returns null to abort. */
async function buildFreshSession(
    app: App,
    settings: PluginSettings,
    conversation: Conversation,
    attachedNotes: NoteContext[],
    options: SendMessageOptions,
    callbacks: ChatControllerCallbacks,
    saveConversation: (conv: Conversation) => Promise<void>,
    saveImageFn: (img: string, prefix: string) => Promise<string>,
): Promise<SessionState | null> {
    const { content, systemPromptOverride, skipUserPush = false, userImages, iterateMode = false } = options;
    const newlyPushed: ChatMessage[] = [];

    if (!skipUserPush) {
        if (conversation.messages.length === 0) {
            conversation.title = content.substring(0, 50).replace(/\n/g, ' ').trim() || 'Chat';
        }

        let displayContent = content;
        if (attachedNotes.length > 0) {
            const noteNames = attachedNotes.map(n => `📄 ${n.path}`).join('\n');
            displayContent = `> **Attached context:**\n> ${noteNames.replace(/\n/g, '\n> ')}\n\n${content}`;
        }

        const msg: ChatMessage = { role: 'user', content: displayContent, timestamp: Date.now() };
        if (userImages?.length) {
            const savedPaths: string[] = [];
            for (const img of userImages) {
                try {
                    savedPaths.push(await saveImageFn(img, 'user'));
                } catch {
                    savedPaths.push(img);
                }
            }
            msg.images = savedPaths;
        }
        conversation.messages.push(msg);
        newlyPushed.push(msg);
    }

    const assistantPlaceholder: ChatMessage = { role: 'assistant', content: '', timestamp: Date.now() };
    conversation.messages.push(assistantPlaceholder);
    newlyPushed.push(assistantPlaceholder);
    conversation.updatedAt = Date.now();
    conversation.provider = settings.selectedProvider;
    conversation.model = settings.selectedModel;

    await callbacks.onMessagesPushed(newlyPushed);
    await saveConversation(conversation);

    const baseSystemPrompt = systemPromptOverride || getEffectivePrompt(settings.activeAgentPreset, settings.systemPrompt);
    // Append user profile context and learning instructions if enabled
    const profileCtx = settings.enableUserProfile ? buildProfileContext(settings.userProfile) : '';
    const learningCtx = settings.enableUserProfile ? buildLearningInstructions() : '';
    const systemPrompt = iterateMode
        ? `${baseSystemPrompt}${profileCtx}${learningCtx}\n\n${settings.iterateInstruction || ITERATE_FEEDBACK_INSTRUCTION}`
        : `${baseSystemPrompt}${profileCtx}${learningCtx}`;

    let apiMessages: ApiMessage[];
    try {
        apiMessages = await buildApiMessages(app, systemPrompt, attachedNotes, conversation.messages.slice(0, -1));
    } catch (err: unknown) {
        callbacks.showErrorWithRetry(getErrorMessage(err), content, systemPromptOverride, userImages);
        callbacks.updateDisplay(`**Error:** ${getErrorMessage(err)}`);
        return null;
    }

    return {
        apiMessages,
        display: new DisplayAccumulator(),
        startToolRound: 0,
        forceAllAgent: false,
    };
}

export async function orchestrateSendMessage(
    app: App,
    settings: PluginSettings,
    conversation: Conversation,
    attachedNotes: NoteContext[],
    options: SendMessageOptions,
    callbacks: ChatControllerCallbacks,
    abortController: AbortController,
    saveConversation: (conv: Conversation) => Promise<void>,
    saveImageFn: (img: string, prefix: string) => Promise<string>,
    saveIterateState?: (convId: string, state: IterateState) => Promise<void>,
    deleteIterateState?: (convId: string) => Promise<void>,
    loadIterateState?: (convId: string) => Promise<IterateState | null>,
): Promise<void> {
    const { content, systemPromptOverride, userImages, iterateMode = false, resumeIterate = false, iterateFeedback } = options;
    const provider = settings.selectedProvider;
    const baseCfg = PROVIDERS[provider];
    let apiKey = await resolveApiKey(provider, settings);

    // For Copilot: use the dynamic API endpoint from the token exchange instead of the
    // hardcoded generic URL. The token response includes a plan-specific endpoint
    // (e.g. api.individual.githubcopilot.com) that ensures proper billing attribution.
    let cfg = provider === 'copilot' ? resolveCopilotConfig(baseCfg) : baseCfg;

    debugLog.log('orchestrator', 'Send message started', {
        provider,
        model: settings.selectedModel,
        iterateMode,
        resumeIterate,
        contentLength: content.length,
        attachedNotes: attachedNotes.length,
        hasImages: !!(userImages?.length),
        hasSystemOverride: !!systemPromptOverride,
        apiUrl: cfg.url,
    });

    // ── Initialize session (resume saved iterate state or build fresh) ──
    const autoApprovedTools = new Set<string>(conversation.alwaysAllowedTools || []);

    let session: SessionState | null;
    if (resumeIterate && loadIterateState) {
        session = await restoreIterateSession(
            app, conversation, loadIterateState, deleteIterateState,
            saveConversation, callbacks, iterateFeedback, userImages,
        );
    } else {
        session = await buildFreshSession(
            app, settings, conversation, attachedNotes, options,
            callbacks, saveConversation, saveImageFn,
        );
    }
    if (!session) return;

    const { apiMessages, display, startToolRound, forceAllAgent, forceUseResponses } = session;

    // We no longer show initial breakdown here, we wait for actual API usage during the loop.

    // Load MCP tools if any servers are configured and enabled
    if (settings.mcpServers?.length) {
        try {
            const mcpToolSchemas = await getAllMCPTools(settings.mcpServers, settings.mcpCacheTTL);
            if (mcpToolSchemas.length > 0) {
                settings.mcpTools = mcpToolSchemas.map(t => t.schema);
                debugLog.log('tool', `MCP: ${mcpToolSchemas.length} tools loaded from ${new Set(mcpToolSchemas.map(t => t.serverId)).size} server(s)`);
            }
        } catch (err) {
            debugLog.log('tool', `MCP: failed to load tools: ${getErrorMessage(err)}`);
        }
    }

    const useMessages = shouldUseMessagesAPI(settings, callbacks.getCachedModels());
    const useResponses = !useMessages && (forceUseResponses ?? shouldUseResponsesAPI(settings, callbacks.getCachedModels()));
    const req: AnyRequestBody = useMessages
        ? { api: 'messages', body: buildMessagesRequestBody(settings, apiMessages, callbacks.getCachedModels()) }
        : useResponses
            ? { api: 'responses', body: buildResponsesRequestBody(settings, apiMessages, callbacks.getCachedModels()) }
            : { api: 'chat-completions', body: buildRequestBody(settings, apiMessages, callbacks.getCachedModels()) };

    debugLog.log('api', 'Request body built', {
        ...getRequestDebugInfo(req),
        thinkingEnabled: settings.thinkingEnabled,
    });

    let generationId: string | null = null;
    const generationIds: string[] = [];
    let lastStreamResult: StreamResult | null = null;
    /** Accumulate token usage across all tool rounds. */
    let accumulatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let totalToolCalls = 0;
    const maxRounds = (iterateMode || resumeIterate)
        ? (settings.maxToolRoundsIterate ?? MAX_TOOL_ROUNDS_ITERATE)
        : (settings.maxToolRounds ?? MAX_TOOL_ROUNDS);
    let iterateRepromptUsed = false;
    let currentToolRound = startToolRound;
    let roundReasoning = '';
    let roundReasoningSignature = '';

    try {
        const maxRetries = settings.maxRetries ?? MAX_RETRIES;
        const retryDelay = settings.retryDelayMs ?? RETRY_DELAY_MS;
        for (let toolRound = startToolRound; toolRound < maxRounds; toolRound++) {
            currentToolRound = toolRound;
            let streamResult: StreamResult | null = null;
            let lastError: Error | null = null;

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                if (attempt > 0) {
                    display.resetForRetry(toolRound === 0 && !forceAllAgent);
                    callbacks.updateDisplay(`_Retrying… (attempt ${attempt + 1} of ${maxRetries})_`);
                    await sleep(retryDelay, abortController.signal);
                }
                try {
                    // Re-resolve Copilot session token before each attempt
                    // (session tokens expire every ~30min, iterate loops can run for hours)
                    if (provider === 'copilot') {
                        apiKey = await resolveApiKey(provider, settings);
                        cfg = resolveCopilotConfig(baseCfg);
                    }
                    updateRequestMessages(req, apiMessages, convertMessagesForResponses, convertMessagesForAnthropic);
                    const hasTools = requestHasTools(req);

                    // Log raw request (exclude tools array — too large)
                    debugLog.log('api', 'Raw request', {
                        toolRound,
                        attempt,
                        ...getRequestDebugInfo(req),
                        messages: formatMessagesForLog(req.api === 'responses' ? req.body.input : req.body.messages),
                    });

                    // isAgent (billing): true for continuations/resumes, false for the initial user turn.
                    // hasTools (API gate): passed separately to set Openai-Intent: conversation-edits
                    // (needed for tool calling on all models including Claude).
                    // x-initiator follows standard billing logic for ALL models:
                    //   round 0 = user (premium request), round > 0 = agent (free continuation).
                    const isAgentTurn = forceAllAgent || toolRound > 0;
                    streamResult = await streamRound(
                        cfg, apiKey, req.body, display, callbacks,
                        app, settings.chatFolder, abortController.signal,
                        isAgentTurn,
                        useResponses,
                        hasTools,
                        useMessages,
                    );
                    // Capture reasoning BEFORE flushRound clears it (needed for Messages API multi-turn)
                    roundReasoning = useMessages ? display.getRoundReasoning() : '';
                    roundReasoningSignature = (useMessages && streamResult?.reasoningOpaque) ? streamResult.reasoningOpaque : '';
                    display.flushRound();
                    callbacks.updateDisplay(display.buildDisplay());
                    lastError = null;
                    break;
                } catch (innerErr: unknown) {
                    if (innerErr instanceof Error && innerErr.name === 'AbortError') throw innerErr;
                    const errMsg = getErrorMessage(innerErr);

                    // Log every error with full details
                    let logData: Record<string, unknown>;
                    try {
                        logData = {
                            toolRound,
                            attempt,
                            error: errMsg,
                            stack: innerErr instanceof Error ? innerErr.stack : undefined,
                            model: req.body.model,
                            apiMessageCount: apiMessages.length,
                            apiMessages: formatMessagesForLog(apiMessages),
                        };
                    } catch (logErr: unknown) {
                        logData = { toolRound, attempt, error: errMsg, logError: getErrorMessage(logErr) };
                    }
                    debugLog.log('api', 'Stream error', logData);

                    // 401 with Copilot: token expired — invalidate cache and retry with fresh token
                    if (errMsg.includes('401') && provider === 'copilot') {
                        debugLog.log('api', 'Copilot token expired, refreshing…');
                        debugLog.log('api', 'Copilot 401 — refreshing token', { attempt, errMsg });
                        copilotTokenManager.invalidateSession();
                        try {
                            apiKey = await resolveApiKey(provider, settings);
                            cfg = resolveCopilotConfig(baseCfg);
                        } catch (refreshErr) {
                            debugLog.log('api', 'Copilot token refresh failed', { error: String(refreshErr) });
                            lastError = refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr));
                            continue;
                        }
                        lastError = innerErr instanceof Error ? innerErr : new Error(String(innerErr));
                        continue;
                    }
                    // Auto-strip unsupported parameters on 400 errors
                    if (errMsg.includes('400')) {
                        autoStripBadParams(req, errMsg, attempt);
                    }
                    // Only throw immediately if we already sent content to the user
                    // (reasoning-only content shouldn't prevent retries)
                    const hasVisibleContent = display.cleanOutput.trim() || display.accumulated.replace(/> \[!abstract\][^\n]*Thinking[\s\S]*?\n\n/g, '').trim();
                    if (hasVisibleContent) throw innerErr;
                    lastError = innerErr instanceof Error ? innerErr : new Error(String(innerErr));
                }
            }
            if (lastError) throw lastError;

            if (streamResult?.generationId) {
                generationId = streamResult.generationId;
                generationIds.push(streamResult.generationId);
            }
            lastStreamResult = streamResult;

            // Accumulate usage tokens across all rounds (for session totals)
            if (streamResult?.usage) {
                accumulatedUsage.prompt_tokens += streamResult.usage.prompt_tokens;
                accumulatedUsage.completion_tokens += streamResult.usage.completion_tokens;
                accumulatedUsage.total_tokens += streamResult.usage.total_tokens ?? 0;
            }

            // Real-time UI update — use the LATEST round's prompt_tokens (= actual context window)
            const currentModel = callbacks.getCachedModels().find(m => m.id === settings.selectedModel);
            const ctxLimit = currentModel?.context_length || 128_000;
            const latestPromptTokens = streamResult?.usage?.prompt_tokens || undefined;
            const postStreamBreakdown = computeContextBreakdown(apiMessages, ctxLimit);
            // Snapshot char count when we get real API tokens — used to scale estimates as context grows
            const charsAtApi = latestPromptTokens ? postStreamBreakdown.totalChars : 0;
            callbacks.updateContextBreakdown(postStreamBreakdown, latestPromptTokens);

            // If no tool calls — in iterate mode, re-prompt once to use ask_user
            if (!streamResult?.toolCalls?.length || streamResult.finishReason !== 'tool_calls') {
                if ((iterateMode || resumeIterate) && !iterateRepromptUsed && display.accumulated.trim()) {
                    // Model forgot to call ask_user — nudge it
                    iterateRepromptUsed = true;
                    // Use clean output (no callouts) so the API doesn't see Obsidian formatting
                    const repromptMsg: ApiMessage = { role: 'assistant', content: display.cleanOutput || display.accumulated };
                    if (roundReasoning) {
                        repromptMsg._thinking = roundReasoning;
                        if (roundReasoningSignature) repromptMsg._thinkingSignature = roundReasoningSignature;
                    }
                    apiMessages.push(repromptMsg);
                    apiMessages.push({ role: 'user', content: settings.iterateReprompt || ITERATE_REPROMPT });
                    continue;
                }
                break;
            }
            iterateRepromptUsed = false; // reset after a successful tool call round

            // Process tool calls — format depends on API endpoint
            appendToolCallMessages(apiMessages, streamResult.toolCalls, useResponses, roundReasoning, roundReasoningSignature);

            // Save before tool processing so the chat note file reflects streamed content
            // while potentially-blocking tools (e.g. ask_user) wait for user input.
            await syncDisplayAndSave(conversation, display, saveConversation);

            let iterateDone = false;
            const deferredUserMessages: ApiMessage[] = [];
            totalToolCalls += streamResult.toolCalls.length;
            for (const tc of streamResult.toolCalls) {
                const shouldStop = await processToolCall(tc, app, settings, conversation, apiMessages, display, callbacks, useResponses, deferredUserMessages, autoApprovedTools);
                if (shouldStop) iterateDone = true;
                updateScaledContextBreakdown(apiMessages, ctxLimit, latestPromptTokens, charsAtApi, callbacks);
            }
            // Flush deferred user messages after all tool results are contiguous
            apiMessages.push(...deferredUserMessages);

            // Update context breakdown after tool results — includes deferred user messages now
            updateScaledContextBreakdown(apiMessages, ctxLimit, latestPromptTokens, charsAtApi, callbacks);

            // User clicked "Done" on the ask_user prompt — stop the iterate loop.
            // But if the abort signal was also fired (user stopped/switched chat),
            // throw AbortError so the catch block saves iterate state for resume.
            if (iterateDone) {
                if (abortController.signal.aborted) {
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }
                break;
            }

            // Save incrementally after each tool round so conversation persists during long iterate sessions
            await syncDisplayAndSave(conversation, display, saveConversation);

            display.accumulated += '\n';
            callbacks.updateDisplay(display.buildDisplay());
        }

        // Iterate loop finished normally — clean up saved state
        if ((iterateMode || resumeIterate) && deleteIterateState) {
            conversation.iterateSessionPaused = false;
            await deleteIterateState(conversation.id);
        }

        if (!display.accumulated.trim()) {
            callbacks.updateDisplay('_No response from model._');
        }
    } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
            debugLog.log('orchestrator', 'Aborted', { toolRound: currentToolRound, hasContent: !!display.accumulated.trim() });
            // Flush any partial content from the interrupted round
            display.flushRound();
            if (!display.accumulated.trim()) {
                callbacks.updateDisplay('_Generation stopped._');
            }

            // Save iterate state on abort so the session can be resumed
            if ((iterateMode || resumeIterate) && saveIterateState && apiMessages.length > 0) {
                try {
                    await saveIterateState(conversation.id, {
                        apiMessages,
                        displayAccumulated: display.accumulated,
                        toolRound: currentToolRound,
                        useResponses,
                    });
                    conversation.iterateSessionPaused = true;
                    await saveConversation(conversation);
                } catch { /* best effort */ }
            }
        } else {
            const errMsg = getErrorMessage(err);
            debugLog.log('orchestrator', 'Error', { error: errMsg, toolRound: currentToolRound });
            callbacks.showErrorWithRetry(errMsg, content, systemPromptOverride, userImages);
            // Preserve any partial content accumulated before the error —
            // flush the current round and append the error instead of replacing everything.
            display.flushRound();
            const existing = display.buildDisplay();
            const errorSuffix = `\n\n**Error:** ${errMsg}`;
            callbacks.updateDisplay(existing ? existing + errorSuffix : errorSuffix.trimStart());
        }
    }

    // Flush any remaining round content (defensive — should already be flushed by streamRound,
    // but ensures content is captured after errors or unusual control flow).
    display.flushRound();

    // Update the assistant message content
    // Expand the last reasoning callout so users can see the most recent reasoning
    display.expandLastReasoning();
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (lastMsg?.role === 'assistant') {
        lastMsg.content = display.accumulated || lastMsg.content;
        lastMsg.cleanContent = display.cleanOutput || undefined;
    }

    // Persist usage stats in conversation frontmatter
    const prevUsage = conversation.usage || { tokensPrompt: 0, tokensCompletion: 0, totalCost: 0, toolCalls: 0, apiRounds: 0 };
    conversation.usage = {
        tokensPrompt: prevUsage.tokensPrompt + accumulatedUsage.prompt_tokens,
        tokensCompletion: prevUsage.tokensCompletion + accumulatedUsage.completion_tokens,
        totalCost: prevUsage.totalCost, // updated async by handleCostTracking for OpenRouter
        toolCalls: prevUsage.toolCalls + totalToolCalls,
        apiRounds: prevUsage.apiRounds + currentToolRound + 1,
    };

    // Save conversation
    await saveConversation(conversation);

    // Fetch generation cost
    debugLog.log('orchestrator', 'Send message completed', {
        toolRounds: currentToolRound,
        accumulatedUsage,
        generationId,
        generationIds,
        contentLength: display.accumulated.length,
    });
    handleCostTracking(provider, generationIds, lastStreamResult, accumulatedUsage, apiKey, conversation, callbacks, saveConversation);

    // Auto-generate title after first exchange (1 user + 1 assistant = 2 messages)
    if (settings.autoTitle && conversation.messages.length === 2 && callbacks.onTitleGenerated) {
        const userMsg = conversation.messages[0]?.content || '';
        const assistantMsg = conversation.messages[1]?.content || '';
        generateAutoTitle(provider, apiKey, settings.selectedModel, userMsg, assistantMsg, conversation, callbacks, saveConversation, settings.autoTitlePrompt);
    }

    // Generate AI thinking summaries for reasoning callouts (fire-and-forget)
    generateThinkingSummaries(provider, apiKey, settings.selectedModel, conversation, callbacks, saveConversation);
}

// ── Auto title generation ───────────────────────────────────────────

function generateAutoTitle(
    provider: string,
    apiKey: string,
    model: string,
    userMessage: string,
    assistantReply: string,
    conversation: Conversation,
    callbacks: ChatControllerCallbacks,
    saveConversation: (conv: Conversation) => Promise<void>,
    customPrompt?: string,
): void {
    const titleMessages = buildTitlePromptMessages(userMessage, assistantReply, customPrompt);
    const providerConfig = PROVIDERS[provider];
    if (!providerConfig) return;

    // Use a small/cheap model for title generation when available
    const titleModel = provider === 'copilot' ? 'gpt-4o-mini' : model;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...providerConfig.headers(apiKey),
    };

    fetch(providerConfig.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: titleModel,
            messages: titleMessages,
            max_tokens: 30,
            temperature: 0.3,
        }),
    })
    .then(res => res.ok ? res.json() : Promise.reject(new Error(`Title gen failed: ${res.status}`)))
    .then(data => {
        const raw = data?.choices?.[0]?.message?.content;
        if (raw) {
            const title = parseTitleResponse(raw);
            conversation.title = title;
            saveConversation(conversation);
            callbacks.onTitleGenerated?.(title);
            debugLog.log('orchestrator', 'Auto-generated title', { title });
        }
    })
    .catch((err: unknown) => {
        debugLog.log('orchestrator', 'Title generation failed', { error: getErrorMessage(err) });
    });
}

// ── Thinking summary generation ─────────────────────────────────────

function generateThinkingSummaries(
    provider: string,
    apiKey: string,
    model: string,
    conversation: Conversation,
    callbacks: ChatControllerCallbacks,
    saveConversation: (conv: Conversation) => Promise<void>,
): void {
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;

    const callouts = extractThinkingCallouts(lastMsg.content);
    if (callouts.length === 0) return;

    const providerConfig = PROVIDERS[provider];
    if (!providerConfig) return;

    const summaryModel = provider === 'copilot' ? 'gpt-4o-mini' : model;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...providerConfig.headers(apiKey),
    };

    for (const callout of callouts) {
        const messages = buildThinkingSummaryPromptMessages(callout.reasoning);
        fetch(providerConfig.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: summaryModel,
                messages,
                max_tokens: 30,
                temperature: 0.3,
            }),
        })
        .then(res => res.ok ? res.json() : Promise.reject(new Error(`Thinking summary failed: ${res.status}`)))
        .then(data => {
            const raw = data?.choices?.[0]?.message?.content;
            if (raw) {
                const newSummary = parseThinkingSummaryResponse(raw);
                if (newSummary !== 'Thinking' && newSummary !== callout.summary) {
                    lastMsg.content = replaceThinkingSummary(lastMsg.content, callout.fullMatch, callout.summary, newSummary);
                    callbacks.updateDisplay(lastMsg.content);
                    saveConversation(conversation);
                    debugLog.log('orchestrator', 'AI thinking summary generated', { old: callout.summary, new: newSummary });
                }
            }
        })
        .catch((err: unknown) => {
            debugLog.log('orchestrator', 'Thinking summary generation failed', { error: getErrorMessage(err) });
        });
    }
}

// ── Cost tracking ───────────────────────────────────────────────────

function handleCostTracking(
    provider: string,
    generationIds: string[],
    lastStreamResult: StreamResult | null,
    accumulatedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    apiKey: string,
    conversation: Conversation,
    callbacks: ChatControllerCallbacks,
    saveConversation: (conv: Conversation) => Promise<void>,
): void {
    // OpenRouter: fetch cost for ALL generation IDs (one per tool round)
    if (provider === 'openrouter' && generationIds.length > 0) {
        Promise.all(generationIds.map(id => fetchGenerationCost(id, apiKey)))
            .then(results => {
                let totalCost = 0;
                let totalPrompt = 0;
                let totalCompletion = 0;
                for (const data of results) {
                    if (!data) continue;
                    totalCost += data.total_cost;
                    totalPrompt += data.tokens_prompt;
                    totalCompletion += data.tokens_completion;
                }
                if (totalCost === 0 && totalPrompt === 0) return;
                const last = conversation.messages[conversation.messages.length - 1];
                if (last?.role === 'assistant') {
                    last.cost = { total: totalCost, tokensPrompt: totalPrompt, tokensCompletion: totalCompletion };
                    // Also update conversation-level usage stats with accurate cost
                    if (conversation.usage) {
                        conversation.usage.totalCost += totalCost;
                    }
                    saveConversation(conversation);
                    callbacks.showCost(totalCost, totalPrompt, totalCompletion);
                }
            })
            .catch((err: unknown) => { debugLog.log('chat', 'Cost fetch failed', { error: getErrorMessage(err) }); });
    }

    // OpenAI / Copilot: usage from accumulated stream rounds
    if ((provider === 'openai' || provider === 'copilot') && accumulatedUsage.prompt_tokens > 0) {
        const u = accumulatedUsage;
        const last = conversation.messages[conversation.messages.length - 1];
        if (last?.role === 'assistant') {
            last.cost = { total: 0, tokensPrompt: u.prompt_tokens, tokensCompletion: u.completion_tokens };
            saveConversation(conversation);
        }
        callbacks.showCost(0, u.prompt_tokens, u.completion_tokens);
    }
}

// (resolveApiKey and getApiKeyForProvider are now in api-helpers.ts)

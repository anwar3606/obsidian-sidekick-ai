/**
 * Pure conversation helpers — zero Obsidian dependency.
 *
 * Sorting, filtering, grouping, time formatting, serialization.
 * Used by both lib/ (tests) and src/ (Obsidian plugin).
 */

// ── Minimal types (subset of src/types Conversation) ────────────────

/** A named collection for grouping conversations. */
export interface Collection {
    id: string;
    name: string;
    color?: string;
    order?: number;
}

/** Minimal conversation shape for pure operations. */
export interface ConversationData {
    id: string;
    title: string;
    messages: Array<{ role: string; content: string; images?: string[]; rating?: 1 | -1 }>;
    createdAt: number;
    updatedAt: number;
    pinned: boolean;
    provider: string;
    model: string;
    iterateSessionPaused?: boolean;
    /** Persisted usage stats (aggregated across all rounds in the conversation). */
    usage?: ConversationUsage;
    /** Tools auto-approved via "Always Allow" — persisted per conversation. */
    alwaysAllowedTools?: string[];
    /** Collection this conversation belongs to (undefined = uncollected). */
    collectionId?: string;
}

/** Aggregated usage stats for a single conversation. */
export interface ConversationUsage {
    tokensPrompt: number;
    tokensCompletion: number;
    totalCost: number;
    toolCalls: number;
    apiRounds: number;
}

// ── Time formatting ─────────────────────────────────────────────────

export function formatTimeAgo(timestamp: number, now = Date.now()): string {
    const seconds = Math.floor((now - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}

// ── Preview snippet ─────────────────────────────────────────────────

/** Extract a short preview snippet from the first user message. */
export function getPreviewSnippet(conv: ConversationData, maxLen = 100): string {
    const first = conv.messages.find(m => m.role === 'user');
    if (!first) return '';
    const text = first.content.replace(/[#*_`~>\[\]!]/g, '').replace(/\s+/g, ' ').trim();
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

// ── Sorting ─────────────────────────────────────────────────────────

export type SortBy = 'date' | 'title' | 'size';
export type SortDir = 'asc' | 'desc';

export function sortConversations<T extends ConversationData>(
    conversations: T[],
    sortBy: SortBy,
    dir: SortDir,
): T[] {
    const sorted = [...conversations];
    const mul = dir === 'asc' ? 1 : -1;
    switch (sortBy) {
        case 'title':
            sorted.sort((a, b) => mul * a.title.localeCompare(b.title));
            break;
        case 'size':
            sorted.sort((a, b) => mul * (a.messages.length - b.messages.length));
            break;
        case 'date':
        default:
            sorted.sort((a, b) => mul * (a.updatedAt - b.updatedAt));
            break;
    }
    return sorted;
}

// ── Filtering ───────────────────────────────────────────────────────

/** Build a title from the AI-generated response, or fall back to extracting from content. */
export function parseTitleResponse(response: string): string {
    // Strip quotes and whitespace
    let title = response.trim().replace(/^["']|["']$/g, '').trim();
    // Take first line only
    title = title.split('\n')[0].trim();
    // Remove trailing period
    if (title.endsWith('.')) title = title.slice(0, -1);
    // Truncate to 60 chars
    if (title.length > 60) title = title.substring(0, 57) + '…';
    return title || 'Chat';
}

/** Build the messages array for a title generation API call. */
export function buildTitlePromptMessages(userMessage: string, assistantReply: string, customPrompt?: string): Array<{ role: string; content: string }> {
    const systemPrompt = customPrompt?.trim() || 'Generate a short, descriptive title (3-8 words) for this conversation. Reply with ONLY the title, no quotes, no punctuation, no explanation.';
    const summary = `User: ${userMessage.substring(0, 200)}\n\nAssistant: ${assistantReply.substring(0, 200)}`;
    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: summary },
    ];
}

/** Filter conversations by search query (title, model, provider, message content). */
export function filterConversations<T extends ConversationData>(
    conversations: T[],
    query: string,
    providerLabelFn?: (provider: string) => string,
): T[] {
    const q = query.toLowerCase().trim();
    if (!q) return conversations;
    return conversations.filter(conv => {
        if (conv.title.toLowerCase().includes(q)) return true;
        if (conv.model.toLowerCase().includes(q)) return true;
        if (conv.provider.toLowerCase().includes(q)) return true;
        if (providerLabelFn && providerLabelFn(conv.provider).toLowerCase().includes(q)) return true;
        // Search in message content
        for (const msg of conv.messages) {
            if (msg.content.toLowerCase().includes(q)) return true;
        }
        return false;
    });
}

// ── Time-based grouping ─────────────────────────────────────────────

export type GroupBy = 'time' | 'model' | 'provider' | 'collection';

export interface ConversationGroup<T = ConversationData> {
    label: string;
    conversations: T[];
    initialLimit: number;
}

export function categorizeByTime<T extends ConversationData>(
    conversations: T[],
    now = Date.now(),
): ConversationGroup<T>[] {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

    const todayStart = startOfDay(new Date(now));
    const yesterdayStart = todayStart - 86400000;
    const weekStart = todayStart - 7 * 86400000;
    const monthStart = todayStart - 30 * 86400000;

    const pinned: T[] = [];
    const today: T[] = [];
    const yesterday: T[] = [];
    const lastWeek: T[] = [];
    const lastMonth: T[] = [];
    const older: T[] = [];

    for (const conv of conversations) {
        if (conv.pinned) { pinned.push(conv); continue; }
        const t = conv.updatedAt;
        if (t >= todayStart) today.push(conv);
        else if (t >= yesterdayStart) yesterday.push(conv);
        else if (t >= weekStart) lastWeek.push(conv);
        else if (t >= monthStart) lastMonth.push(conv);
        else older.push(conv);
    }

    const buckets: ConversationGroup<T>[] = [];
    if (older.length) buckets.push({ label: 'Older', conversations: older, initialLimit: 3 });
    if (lastMonth.length) buckets.push({ label: 'Last Month', conversations: lastMonth, initialLimit: 3 });
    if (lastWeek.length) buckets.push({ label: 'Last Week', conversations: lastWeek, initialLimit: 5 });
    if (yesterday.length) buckets.push({ label: 'Yesterday', conversations: yesterday, initialLimit: 5 });
    if (today.length) buckets.push({ label: 'Today', conversations: today, initialLimit: Infinity });
    if (pinned.length) buckets.push({ label: '📌 Pinned', conversations: pinned, initialLimit: Infinity });
    return buckets;
}

/**
 * Group conversations by collection.
 * Conversations without a collection go into "Uncollected".
 * Pinned items always go into a separate "📌 Pinned" group.
 */
export function groupByCollection<T extends ConversationData>(
    conversations: T[],
    collections: Collection[],
): ConversationGroup<T>[] {
    const pinned: T[] = [];
    const uncollected: T[] = [];
    const buckets = new Map<string, T[]>();

    // Pre-index collections by id
    const collectionMap = new Map(collections.map(c => [c.id, c]));

    for (const conv of conversations) {
        if (conv.pinned) { pinned.push(conv); continue; }
        if (!conv.collectionId || !collectionMap.has(conv.collectionId)) {
            uncollected.push(conv);
            continue;
        }
        const arr = buckets.get(conv.collectionId);
        if (arr) arr.push(conv); else buckets.set(conv.collectionId, [conv]);
    }

    // Build groups in collection order
    const ordered = [...collections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const groups: ConversationGroup<T>[] = [];
    for (const col of ordered) {
        const convs = buckets.get(col.id);
        if (convs?.length) {
            groups.push({ label: col.name, conversations: convs, initialLimit: Infinity });
        }
    }
    if (uncollected.length) groups.push({ label: 'Uncollected', conversations: uncollected, initialLimit: Infinity });
    if (pinned.length) groups.push({ label: '📌 Pinned', conversations: pinned, initialLimit: Infinity });
    return groups;
}

// ── Markdown serialization ──────────────────────────────────────────

/** Roles that are persisted to markdown (system/tool messages are ephemeral). */
const PERSISTED_ROLES: ReadonlySet<string> = new Set(['user', 'assistant']);

/** Serialize a conversation to markdown with YAML frontmatter. */
export function conversationToMarkdown(conv: ConversationData): string {
    const fmLines = [
        '---',
        `id: "${conv.id}"`,
        `title: "${conv.title.replace(/[\n\r]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
        `created: ${conv.createdAt}`,
        `updated: ${conv.updatedAt}`,
        `pinned: ${conv.pinned}`,
        `provider: "${conv.provider}"`,
        `model: "${conv.model}"`,
    ];
    if (conv.iterateSessionPaused) {
        fmLines.push('iterateSessionPaused: true');
    }
    if (conv.alwaysAllowedTools?.length) {
        fmLines.push(`alwaysAllowedTools: ${JSON.stringify(conv.alwaysAllowedTools)}`);
    }
    if (conv.collectionId) {
        fmLines.push(`collection: "${conv.collectionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }
    if (conv.usage) {
        fmLines.push(`tokensPrompt: ${conv.usage.tokensPrompt}`);
        fmLines.push(`tokensCompletion: ${conv.usage.tokensCompletion}`);
        fmLines.push(`totalCost: ${conv.usage.totalCost}`);
        fmLines.push(`toolCalls: ${conv.usage.toolCalls}`);
        fmLines.push(`apiRounds: ${conv.usage.apiRounds}`);
    }
    // Build ratings map (message index → rating) for persisted messages only
    const persistedMessages = conv.messages.filter(m => PERSISTED_ROLES.has(m.role));
    const ratings: Record<number, number> = {};
    for (let i = 0; i < persistedMessages.length; i++) {
        if (persistedMessages[i].rating) ratings[i] = persistedMessages[i].rating!;
    }
    if (Object.keys(ratings).length) {
        fmLines.push(`ratings: ${JSON.stringify(ratings)}`);
    }
    fmLines.push('---', '');
    const frontmatter = fmLines.join('\n');

    const messages = persistedMessages
        .map(m => {
            const label = m.role === 'user' ? 'User' : 'Assistant';
            let body = m.content;
            if (m.images?.length) {
                const embeds = m.images.map(img => `![[${img}]]`).join('\n');
                body += '\n\n' + embeds;
            }
            return `### ${label}\n\n${body}`;
        })
        .join('\n\n---\n\n');

    return frontmatter + messages;
}

/** Deserialize markdown with YAML frontmatter back to a conversation. */
export function markdownToConversation(content: string): ConversationData | null {
    try {
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
        if (!fmMatch) return null;

        const fm = fmMatch[1];
        const getValue = (key: string): string => {
            const quotedMatch = fm.match(new RegExp(`^${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'));
            if (quotedMatch) return quotedMatch[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
            const unquotedMatch = fm.match(new RegExp(`^${key}:\\s*(.*)`, 'm'));
            return unquotedMatch ? unquotedMatch[1].trim() : '';
        };

        const id = getValue('id');
        if (!id) return null;
        const title = getValue('title');
        const createdAt = parseInt(getValue('created')) || Date.now();
        const updatedAt = parseInt(getValue('updated')) || Date.now();
        const pinned = getValue('pinned') === 'true';
        const provider = getValue('provider') || 'openai';
        const model = getValue('model') || '';
        const iterateSessionPaused = getValue('iterateSessionPaused') === 'true';

        // Parse alwaysAllowedTools from frontmatter (stored as JSON array)
        const alwaysAllowedToolsRaw = getValue('alwaysAllowedTools');
        let alwaysAllowedTools: string[] | undefined;
        if (alwaysAllowedToolsRaw) {
            try { alwaysAllowedTools = JSON.parse(alwaysAllowedToolsRaw); } catch { /* ignore invalid */ }
        }

        // Parse collection ID from frontmatter (if present)
        const collectionId = getValue('collection') || undefined;

        // Parse usage stats from frontmatter (if present)
        const tokensPrompt = parseInt(getValue('tokensPrompt')) || 0;
        const tokensCompletion = parseInt(getValue('tokensCompletion')) || 0;
        const totalCost = parseFloat(getValue('totalCost')) || 0;
        const toolCalls = parseInt(getValue('toolCalls')) || 0;
        const apiRounds = parseInt(getValue('apiRounds')) || 0;
        const usage: ConversationUsage | undefined =
            (tokensPrompt || tokensCompletion || totalCost || toolCalls || apiRounds)
                ? { tokensPrompt, tokensCompletion, totalCost, toolCalls, apiRounds }
                : undefined;

        // Parse ratings map from frontmatter (message index → 1 or -1)
        const ratingsRaw = getValue('ratings');
        let ratingsMap: Record<string, number> = {};
        if (ratingsRaw) {
            try { ratingsMap = JSON.parse(ratingsRaw); } catch { /* ignore invalid */ }
        }

        const body = content.slice(fmMatch[0].length);
        const sections = body.split(/\n---\n(?=\s*### (?:User|Assistant)\b)/).filter(s => s.trim());
        const messages: ConversationData['messages'] = [];

        for (const section of sections) {
            const headerMatch = section.match(/###\s+(User|Assistant)\n\n([\s\S]*)/);
            if (!headerMatch) continue;
            const role = headerMatch[1] === 'User' ? 'user' : 'assistant';
            let messageContent = headerMatch[2].trim();

            if (role === 'assistant') {
                messageContent = messageContent.replace(/\n\n> Cost: \$[0-9.]+ \| Prompt: \d+ tokens \| Completion: \d+ tokens$/, '').trim();
            }

            const imageEmbedPattern = /!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))\]\]/gi;
            const images: string[] = [];
            let embedMatch;
            while ((embedMatch = imageEmbedPattern.exec(messageContent)) !== null) {
                images.push(embedMatch[1]);
            }
            if (images.length) {
                messageContent = messageContent.replace(/\n*!\[\[[^\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)\]\]\n*/gi, '').trim();
            }

            // Backward compat: parse rating from HTML comment if present (old format)
            let rating: 1 | -1 | undefined;
            const ratingMatch = messageContent.match(/\n*<!-- rating: (-?1) -->$/);
            if (ratingMatch) {
                rating = parseInt(ratingMatch[1]) as 1 | -1;
                messageContent = messageContent.replace(/\n*<!-- rating: -?1 -->$/, '').trim();
            }

            // Frontmatter ratings take precedence
            const fmRating = ratingsMap[String(messages.length)];
            if (fmRating === 1 || fmRating === -1) rating = fmRating;

            messages.push({
                role,
                content: messageContent,
                ...(images.length ? { images } : {}),
                ...(rating ? { rating } : {}),
            });
        }

        return { id, title, messages, createdAt, updatedAt, pinned, provider, model, iterateSessionPaused: iterateSessionPaused || undefined, usage, alwaysAllowedTools, collectionId };
    } catch {
        // Malformed markdown — return null so caller can skip/recover
        return null;
    }
}

/** Metadata options for enriched export. */
export interface ExportMetadata {
    model?: string;
    provider?: string;
    createdAt?: number;
    updatedAt?: number;
    totalCost?: number;
    totalTokens?: number;
    messageCount?: number;
}

/** Build export markdown for a conversation (for /export command). */
export function buildExportMarkdown(title: string, messages: ConversationData['messages'], metadata?: ExportMetadata): string {
    let md = '';

    // Add YAML frontmatter if metadata is provided
    if (metadata) {
        const fm: string[] = ['---'];
        fm.push(`title: "${title.replace(/"/g, '\\"')}"`);
        if (metadata.model) fm.push(`model: ${metadata.model}`);
        if (metadata.provider) fm.push(`provider: ${metadata.provider}`);
        if (metadata.createdAt) fm.push(`created: ${new Date(metadata.createdAt).toISOString()}`);
        if (metadata.updatedAt) fm.push(`updated: ${new Date(metadata.updatedAt).toISOString()}`);
        if (metadata.messageCount !== undefined) fm.push(`messages: ${metadata.messageCount}`);
        if (metadata.totalTokens) fm.push(`tokens: ${metadata.totalTokens}`);
        if (metadata.totalCost) fm.push(`cost: ${metadata.totalCost.toFixed(6)}`);
        fm.push('---', '');
        md += fm.join('\n');
    }

    md += `# Chat — ${title}\n\n`;
    for (const m of messages) {
        if (m.role === 'system' || m.role === 'tool') continue;
        const label = m.role === 'user' ? '**You**' : '**Assistant**';
        let body = m.content;
        if (m.images?.length) {
            const embeds = m.images.map(img => `![[${img}]]`).join('\n');
            body += '\n\n' + embeds;
        }
        md += `### ${label}\n\n${body}\n\n---\n\n`;
    }
    return md;
}

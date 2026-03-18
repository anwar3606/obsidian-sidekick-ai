/**
 * Pure search algorithms — zero Obsidian dependency.
 *
 * Contains tokenization, BM25 scoring, and fuzzy matching that can be
 * used by both lib/ and src/ layers. The Obsidian-dependent vault search
 * remains in src/search.ts.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface CorpusStats {
    /** Total number of documents */
    N: number;
    /** Average document length in tokens */
    avgDl: number;
    /** Number of docs containing each term */
    df: Map<string, number>;
}

// ── Constants ───────────────────────────────────────────────────────

/** BM25 tuning parameters */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

// ── Tokenization ────────────────────────────────────────────────────

/** Split text into lowercase terms, stripping common noise. */
export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\w\s#/-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1);
}

// ── BM25 ────────────────────────────────────────────────────────────

/**
 * Compute BM25 score for a single term in a document.
 */
export function bm25Score(
    termFreq: number,
    docLen: number,
    stats: CorpusStats,
    term: string,
): number {
    const df = stats.df.get(term) || 0;
    if (df === 0 || termFreq === 0) return 0;

    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((stats.N - df + 0.5) / (df + 0.5) + 1);

    // TF saturation
    const tf = (termFreq * (BM25_K1 + 1)) /
        (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / stats.avgDl)));

    return idf * tf;
}

// ── Fuzzy matching ──────────────────────────────────────────────────

/**
 * Simple fuzzy score: returns a non-negative score (lower = better match),
 * or -1 if no match. Checks for substring first, then character sequence.
 */
export function fuzzyScore(pattern: string, text: string): number {
    if (pattern.length === 0) return 0;
    const pLow = pattern.toLowerCase();
    const tLow = text.toLowerCase();

    // Exact substring match
    const subIdx = tLow.indexOf(pLow);
    if (subIdx !== -1) {
        return subIdx === 0 ? 0 : subIdx;
    }

    // Character-by-character fuzzy
    let pi = 0;
    let score = 0;
    let lastMatch = -1;
    for (let ti = 0; ti < tLow.length && pi < pLow.length; ti++) {
        if (tLow[ti] === pLow[pi]) {
            if (lastMatch >= 0) score += (ti - lastMatch - 1) * 2;
            const atStart = ti === 0 || /[\s\-_/.]/.test(text[ti - 1]) || (text[ti - 1] === text[ti - 1].toLowerCase() && text[ti] === text[ti].toUpperCase());
            if (!atStart) score += 1;
            lastMatch = ti;
            pi++;
        }
    }
    return pi === pLow.length ? score : -1;
}

// ── Web Search ──────────────────────────────────────────────────────

export interface WebSearchResult {
    title: string;
    url: string;
    content: string;
    score: number;
}

export interface WebSearchResponse {
    query: string;
    results: WebSearchResult[];
    answer?: string;
}

/** Max query length for search APIs. */
const MAX_QUERY_LENGTH = 400;

/** Clamp max results to 1-10 range. */
function clampMaxResults(maxResults: number): number {
    return Math.min(Math.max(maxResults, 1), 10);
}

/** Clamp and validate a search query. */
function sanitizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) throw new Error('Search query cannot be empty');
    return trimmed.length > MAX_QUERY_LENGTH ? trimmed.substring(0, MAX_QUERY_LENGTH) : trimmed;
}

/** Build Tavily search API request. */
export function buildTavilySearchRequest(
    apiKey: string,
    query: string,
    maxResults = 5,
    topic: 'general' | 'news' = 'general',
): { url: string; headers: Record<string, string>; body: string } {
    const q = sanitizeQuery(query);
    const count = clampMaxResults(maxResults);
    return {
        url: 'https://api.tavily.com/search',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: apiKey,
            query: q,
            max_results: count,
            topic,
            include_answer: true,
        }),
    };
}

/** Build Brave Search API request. */
export function buildBraveSearchRequest(
    apiKey: string,
    query: string,
    maxResults = 5,
): { url: string; headers: Record<string, string> } {
    const q = sanitizeQuery(query);
    const count = clampMaxResults(maxResults);
    const params = new URLSearchParams({ q, count: String(count) });
    return {
        url: `https://api.search.brave.com/res/v1/web/search?${params}`,
        headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
        },
    };
}

/** Parse Tavily API response into common format. */
export function parseTavilyResponse(raw: unknown): WebSearchResponse {
    const data = raw as Record<string, unknown>;
    const results: WebSearchResult[] = [];
    const rawResults = Array.isArray(data.results) ? data.results : [];
    for (const r of rawResults) {
        if (!r || typeof r !== 'object') continue;
        const item = r as Record<string, unknown>;
        results.push({
            title: String(item.title || ''),
            url: String(item.url || ''),
            content: String(item.content || ''),
            score: typeof item.score === 'number' ? item.score : 0,
        });
    }
    return {
        query: String(data.query || ''),
        results,
        answer: typeof data.answer === 'string' ? data.answer : undefined,
    };
}

/** Strip HTML tags and decode common entities from a string. */
export function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&hellip;/g, '…')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&ldquo;|&rdquo;/g, '"')
        .replace(/&lsquo;|&rsquo;/g, "'");
}

/** Parse Brave Search API response into common format. */
export function parseBraveResponse(raw: unknown): WebSearchResponse {
    const data = raw as Record<string, unknown>;
    const results: WebSearchResult[] = [];
    const web = data.web as Record<string, unknown> | undefined;
    const rawResults = Array.isArray(web?.results) ? web.results : [];
    for (const r of rawResults) {
        if (!r || typeof r !== 'object') continue;
        const item = r as Record<string, unknown>;
        results.push({
            title: stripHtml(String(item.title || '')),
            url: String(item.url || ''),
            content: stripHtml(String(item.description || '')),
            score: 0, // Brave doesn't provide relevance scores
        });
    }
    const query = (data.query as Record<string, unknown>)?.original_query;
    return {
        query: typeof query === 'string' ? query : '',
        results,
    };
}

/** Build Google Custom Search API request (GET with query params). */
export function buildGoogleSearchRequest(
    apiKey: string,
    cxId: string,
    query: string,
    maxResults = 5,
): { url: string; headers: Record<string, string> } {
    const q = sanitizeQuery(query);
    const count = clampMaxResults(maxResults);
    const params = new URLSearchParams({
        key: apiKey,
        cx: cxId,
        q,
        num: String(count),
    });
    return {
        url: `https://customsearch.googleapis.com/customsearch/v1?${params}`,
        headers: { 'Accept': 'application/json' },
    };
}

/** Parse Google Custom Search API response into common format. */
export function parseGoogleResponse(raw: unknown): WebSearchResponse {
    const data = raw as Record<string, unknown>;
    const results: WebSearchResult[] = [];
    const rawItems = Array.isArray(data.items) ? data.items : [];
    for (const r of rawItems) {
        if (!r || typeof r !== 'object') continue;
        const item = r as Record<string, unknown>;
        results.push({
            title: stripHtml(String(item.title || '')),
            url: String(item.link || ''),
            content: stripHtml(String(item.snippet || '')),
            score: 0, // Google doesn't provide relevance scores
        });
    }
    const correctedQuery = (data.spelling as Record<string, unknown> | undefined)?.correctedQuery;
    return {
        query: typeof correctedQuery === 'string' ? correctedQuery : '',
        results,
    };
}

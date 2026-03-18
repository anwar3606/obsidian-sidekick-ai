/**
 * Smart search engine for Obsidian vault.
 *
 * Uses BM25 scoring with field weighting, metadata boosting (titles, headings,
 * tags, aliases via metadataCache), recency boost, graph boost (via resolvedLinks),
 * and fuzzy title matching. Zero external dependencies.
 */

import type { App, TFile, CachedMetadata } from 'obsidian';

// ── Re-export pure search algorithms from lib/ (single source of truth) ──
export { tokenize, bm25Score, fuzzyScore } from '../lib/search';
export type { CorpusStats } from '../lib/search';

import { tokenize, bm25Score, fuzzyScore } from '../lib/search';
import type { CorpusStats } from '../lib/search';

// ── Types (src-only, Obsidian-dependent) ────────────────────────────

export interface SearchResult {
    path: string;
    basename: string;
    /** Relevance score (higher = better) */
    score: number;
    /** Short content snippet around best match */
    snippet: string;
    /** Which fields matched */
    matchedFields: string[];
}

export interface SearchOptions {
    maxResults?: number;
    /** Include content body in scoring (slower). Default: true */
    searchContent?: boolean;
    /** Max snippet length */
    snippetLength?: number;
}

interface DocFields {
    title: string;
    headings: string[];
    tags: string[];
    aliases: string[];
    content: string;
    /** Token count for BM25 */
    tokenCount: number;
}

// ── Constants ───────────────────────────────────────────────────────

/** Field weight multipliers */
const WEIGHT_TITLE = 5.0;
const WEIGHT_ALIAS = 4.0;
const WEIGHT_HEADING = 2.5;
const WEIGHT_TAG = 2.0;
const WEIGHT_CONTENT = 1.0;

/** Recency boost: max multiplier for very recent files */
const RECENCY_MAX_BOOST = 1.3;
/** Recency half-life in days — files this old get half the recency boost */
const RECENCY_HALF_LIFE_DAYS = 30;

/** Graph boost: multiplier per inbound link (capped) */
const GRAPH_BOOST_PER_LINK = 0.05;
const GRAPH_BOOST_MAX = 1.5;

/** Fuzzy title match score threshold (lower = better match) */
const FUZZY_TITLE_THRESHOLD = 10;

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;

// ── Term frequency (local helper) ───────────────────────────────────

/**
 * Count occurrences of a term in a token array.
 */
function termFrequency(term: string, tokens: string[]): number {
    let count = 0;
    for (const t of tokens) {
        if (t === term || t.startsWith(term)) count++;
    }
    return count;
}

// ── Extract document fields from metadataCache ──────────────────────

function extractFields(
    file: TFile,
    cache: CachedMetadata | null,
    content: string,
): DocFields {
    const headings: string[] = [];
    const tags: string[] = [];
    const aliases: string[] = [];

    if (cache) {
        if (cache.headings) {
            for (const h of cache.headings) {
                headings.push(h.heading);
            }
        }
        if (cache.tags) {
            for (const t of cache.tags) {
                // Tags include the # prefix — strip it for matching
                tags.push(t.tag.replace(/^#/, ''));
            }
        }
        if (cache.frontmatter) {
            const fm = cache.frontmatter;
            // Aliases can be string or array
            if (fm.aliases) {
                const raw = fm.aliases;
                if (Array.isArray(raw)) {
                    for (const a of raw) aliases.push(String(a));
                } else if (typeof raw === 'string') {
                    aliases.push(raw);
                }
            }
            // Also check frontmatter tags
            if (fm.tags) {
                const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
                for (const t of fmTags) {
                    const s = String(t).replace(/^#/, '');
                    if (s && !tags.includes(s)) tags.push(s);
                }
            }
        }
    }

    const tokens = tokenize(content);

    return {
        title: file.basename,
        headings,
        tags,
        aliases,
        content,
        tokenCount: tokens.length,
    };
}

// ── Graph boost ─────────────────────────────────────────────────────

/**
 * Count how many other notes link TO this file (inbound link count).
 */
function getInboundLinkCount(app: App, filePath: string): number {
    const resolved = app.metadataCache.resolvedLinks;
    let count = 0;
    for (const sourcePath in resolved) {
        if (sourcePath === filePath) continue;
        const targets = resolved[sourcePath];
        if (targets && targets[filePath]) {
            count += targets[filePath];
        }
    }
    return count;
}

// ── Recency boost ───────────────────────────────────────────────────

/**
 * Compute recency multiplier based on file modification time.
 * Returns a value between 1.0 and RECENCY_MAX_BOOST.
 */
function recencyBoost(file: TFile): number {
    const now = Date.now();
    const mtime = file.stat?.mtime ?? now;
    const daysSinceModified = (now - mtime) / (1000 * 60 * 60 * 24);
    // Exponential decay: boost = 1 + maxExtra * e^(-ln(2) * days / halfLife)
    const extra = (RECENCY_MAX_BOOST - 1) * Math.exp(-Math.LN2 * daysSinceModified / RECENCY_HALF_LIFE_DAYS);
    return 1 + extra;
}

// ── Snippet extraction ──────────────────────────────────────────────

/**
 * Extract a snippet around the best match position in content.
 */
function extractSnippet(content: string, queryTerms: string[], maxLen: number): string {
    const lower = content.toLowerCase();

    // Find the position of the first matching term
    let bestPos = -1;
    for (const term of queryTerms) {
        const idx = lower.indexOf(term);
        if (idx !== -1 && (bestPos === -1 || idx < bestPos)) {
            bestPos = idx;
        }
    }

    if (bestPos === -1) {
        // No exact match in content — return start of document
        return content.substring(0, maxLen).replace(/\n/g, ' ').trim();
    }

    const start = Math.max(0, bestPos - SNIPPET_BEFORE);
    const end = Math.min(content.length, bestPos + SNIPPET_AFTER);
    let snippet = content.substring(start, end).replace(/\n/g, ' ').trim();

    if (snippet.length > maxLen) {
        snippet = snippet.substring(0, maxLen);
    }
    return (start > 0 ? '…' : '') + snippet + (end < content.length ? '…' : '');
}

// ── Main search function ────────────────────────────────────────────

/**
 * Search the vault using BM25 + metadata + graph/recency boosting.
 *
 * For ~2.5K notes this completes in <100ms since we use:
 *   1. metadataCache (no disk I/O) for headings, tags, aliases
 *   2. cachedRead (memory-cached) for content
 *   3. resolvedLinks (already indexed) for graph boost
 */
export async function searchVault(
    app: App,
    query: string,
    options: SearchOptions = {},
): Promise<SearchResult[]> {
    const {
        maxResults = 10,
        searchContent = true,
        snippetLength = SNIPPET_BEFORE + SNIPPET_AFTER,
    } = options;

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const files = app.vault.getMarkdownFiles();
    if (files.length === 0) return [];

    // ── Pass 1: Build corpus stats (fast — metadata only) ───────────
    // For BM25 we need doc frequency and avg doc length.
    // We approximate doc lengths using metadataCache when possible,
    // and do full content reads only for scoring.

    const docData: Array<{
        file: TFile;
        fields: DocFields;
        content: string;
    }> = [];

    let totalTokens = 0;
    let totalTitleTokens = 0;
    let totalAliasTokens = 0;
    let totalHeadingTokens = 0;
    let totalTagTokens = 0;
    const dfMap = new Map<string, number>();

    for (const file of files) {
        const cache = app.metadataCache.getFileCache(file);
        let content = '';
        if (searchContent) {
            try {
                content = await app.vault.cachedRead(file);
            } catch (err: unknown) {
                console.warn(`[Sidekick] Vault read failed for ${file.path}:`, err);
            }
        }

        const fields = extractFields(file, cache, content);
        totalTokens += fields.tokenCount;
        totalTitleTokens += tokenize(fields.title).length;
        totalAliasTokens += fields.aliases.reduce((s, a) => s + tokenize(a).length, 0) / (fields.aliases.length || 1);
        for (const h of fields.headings) totalHeadingTokens += tokenize(h).length;
        totalTagTokens += fields.tags.length;

        // Build doc-frequency: which terms appear in this doc?
        const allText = [
            fields.title,
            ...fields.headings,
            ...fields.tags,
            ...fields.aliases,
            content,
        ].join(' ').toLowerCase();

        const seenTerms = new Set<string>();
        for (const term of queryTerms) {
            if (allText.includes(term) && !seenTerms.has(term)) {
                seenTerms.add(term);
                dfMap.set(term, (dfMap.get(term) || 0) + 1);
            }
        }

        docData.push({ file, fields, content });
    }

    const stats: CorpusStats = {
        N: files.length,
        avgDl: totalTokens / files.length || 1,
        df: dfMap,
    };

    // Per-field stats for accurate BM25 length normalization.
    // Using content-based avgDl for short metadata fields would give them
    // an implicit ~1.7x TF boost due to the docLen/avgDl ratio mismatch.
    const titleStats: CorpusStats = { ...stats, avgDl: totalTitleTokens / files.length || 1 };
    const aliasStats: CorpusStats = { ...stats, avgDl: totalAliasTokens / files.length || 1 };
    const headingCount = docData.reduce((s, d) => s + d.fields.headings.length, 0);
    const headingStats: CorpusStats = { ...stats, avgDl: totalHeadingTokens / (headingCount || 1) || 1 };
    const tagStats: CorpusStats = { ...stats, avgDl: totalTagTokens / files.length || 1 };

    // ── Pass 2: Score each document ─────────────────────────────────

    const scored: SearchResult[] = [];

    for (const { file, fields, content } of docData) {
        let totalScore = 0;
        const matchedFields: string[] = [];
        const titleTokens = tokenize(fields.title);
        const contentTokens = (searchContent && content) ? tokenize(content) : [];

        for (const term of queryTerms) {
            // Title scoring
            const titleLower = fields.title.toLowerCase();
            if (titleLower.includes(term)) {
                const tf = termFrequency(term, titleTokens);
                totalScore += bm25Score(tf, titleTokens.length, titleStats, term) * WEIGHT_TITLE;
                if (!matchedFields.includes('title')) matchedFields.push('title');
            }

            // Alias scoring
            for (const alias of fields.aliases) {
                if (alias.toLowerCase().includes(term)) {
                    totalScore += bm25Score(1, tokenize(alias).length || 1, aliasStats, term) * WEIGHT_ALIAS;
                    if (!matchedFields.includes('alias')) matchedFields.push('alias');
                    break;
                }
            }

            // Heading scoring
            for (const heading of fields.headings) {
                if (heading.toLowerCase().includes(term)) {
                    totalScore += bm25Score(1, tokenize(heading).length, headingStats, term) * WEIGHT_HEADING;
                    if (!matchedFields.includes('heading')) matchedFields.push('heading');
                    break; // count once per term per field
                }
            }

            // Tag scoring
            for (const tag of fields.tags) {
                if (tag.toLowerCase().includes(term)) {
                    totalScore += bm25Score(1, 1, tagStats, term) * WEIGHT_TAG;
                    if (!matchedFields.includes('tag')) matchedFields.push('tag');
                    break;
                }
            }

            // Content scoring (BM25)
            if (searchContent && contentTokens.length > 0) {
                const tf = termFrequency(term, contentTokens);
                if (tf > 0) {
                    totalScore += bm25Score(tf, fields.tokenCount, stats, term) * WEIGHT_CONTENT;
                    if (!matchedFields.includes('content')) matchedFields.push('content');
                }
            }
        }

        // Fuzzy title bonus — only if no exact title match
        if (!matchedFields.includes('title') && query.length >= 3) {
            const fScore = fuzzyScore(query, fields.title);
            if (fScore >= 0 && fScore <= FUZZY_TITLE_THRESHOLD) {
                // Convert fuzzy score to a bonus (lower fScore = better match)
                totalScore += (FUZZY_TITLE_THRESHOLD - fScore) * 0.5;
                matchedFields.push('fuzzy-title');
            }
        }

        if (totalScore <= 0) continue;

        // Apply recency boost
        totalScore *= recencyBoost(file);

        // Apply graph boost
        const inlinks = getInboundLinkCount(app, file.path);
        const graphMult = Math.min(1 + inlinks * GRAPH_BOOST_PER_LINK, GRAPH_BOOST_MAX);
        totalScore *= graphMult;

        // Extract snippet
        const snippet = searchContent && content
            ? extractSnippet(content, queryTerms, snippetLength)
            : fields.title;

        scored.push({
            path: file.path,
            basename: file.basename,
            score: totalScore,
            snippet,
            matchedFields,
        });
    }

    // Sort by score descending, return top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
}

// ── Lightweight file search (for @ mentions) ────────────────────────

export interface FileSearchResult {
    file: TFile;
    score: number;
    matchType: 'exact' | 'fuzzy' | 'alias' | 'heading';
}

/**
 * Fast file search for @ mention autocomplete.
 * Searches titles, aliases, and headings. No content scanning.
 * Returns results sorted best-match-first.
 */
export function searchFiles(
    app: App,
    query: string,
    maxResults = 8,
): FileSearchResult[] {
    if (!query || query.length === 0) return [];

    const qLow = query.toLowerCase();
    const files = app.vault.getMarkdownFiles();
    const results: FileSearchResult[] = [];

    for (const file of files) {
        const titleLow = file.basename.toLowerCase();

        // Exact title substring match
        if (titleLow.includes(qLow)) {
            // Score: prefer earlier matches and shorter titles
            const idx = titleLow.indexOf(qLow);
            const lenPenalty = file.basename.length / 100;
            results.push({
                file,
                score: 100 - idx - lenPenalty,
                matchType: 'exact',
            });
            continue;
        }

        // Check aliases
        const cache = app.metadataCache.getFileCache(file);
        let matched = false;

        if (cache?.frontmatter?.aliases) {
            const raw = cache.frontmatter.aliases;
            const aliases = Array.isArray(raw) ? raw : [raw];
            for (const alias of aliases) {
                if (String(alias).toLowerCase().includes(qLow)) {
                    results.push({
                        file,
                        score: 80,
                        matchType: 'alias',
                    });
                    matched = true;
                    break;
                }
            }
        }
        if (matched) continue;

        // Check headings
        if (cache?.headings) {
            for (const h of cache.headings) {
                if (h.heading.toLowerCase().includes(qLow)) {
                    // Weight by heading level (h1 > h2 > ...)
                    results.push({
                        file,
                        score: 70 - (h.level - 1) * 5,
                        matchType: 'heading',
                    });
                    matched = true;
                    break;
                }
            }
        }
        if (matched) continue;

        // Fuzzy title match
        if (query.length >= 2) {
            const fScore = fuzzyScore(query, file.basename);
            if (fScore >= 0 && fScore <= FUZZY_TITLE_THRESHOLD) {
                results.push({
                    file,
                    score: 50 - fScore,
                    matchType: 'fuzzy',
                });
            }
        }
    }

    // Sort by score desc
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
}

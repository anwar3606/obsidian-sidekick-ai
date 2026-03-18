/**
 * Embeddings & vector search — zero Obsidian dependency.
 *
 * Pure math (cosine similarity), heading-aware text chunking,
 * brute-force vector search, and Float32Array ↔ base64 serialization.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface VectorChunk {
    /** Vault-relative file path. */
    path: string;
    /** 0-based chunk index within the document. */
    chunkIndex: number;
    /** The chunk text (returned in search results). */
    text: string;
    /** Nearest heading above this chunk (if any). */
    heading?: string;
    /** The embedding vector. */
    embedding: Float32Array;
    /** File modification time (epoch ms) for staleness checks. */
    mtime: number;
}

export interface VectorSearchResult {
    path: string;
    chunkIndex: number;
    heading?: string;
    text: string;
    /** Cosine similarity score (0–1). */
    score: number;
}

export interface TextChunk {
    text: string;
    heading?: string;
}

export interface ChunkingOptions {
    /** Max approximate tokens per chunk (default 500). */
    maxTokens?: number;
    /** Overlap tokens between consecutive split chunks (default 50). */
    overlap?: number;
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_OVERLAP = 50;

/**
 * Conservative token estimate: ~3 chars per token.
 * Using chars/3 instead of chars/4 because markdown, code blocks, URLs,
 * and special characters tokenise less efficiently than plain English.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3);
}

/**
 * Maximum total estimated tokens per embedding API request.
 * Copilot proxy enforces 8192 token limit; we leave headroom.
 */
export const MAX_BATCH_TOKENS = 7000;

// ── Cosine Similarity ───────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// ── Text Chunking ───────────────────────────────────────────────────

/** Heading regex: # through ######. */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Split markdown text into chunks respecting heading boundaries.
 *
 * Strategy:
 * 1. Split by headings — each heading starts a new section.
 * 2. If a section exceeds maxTokens, split it into overlapping windows.
 * 3. Frontmatter (---...---) at line 0 is included in the first chunk.
 */
export function chunkText(text: string, options?: ChunkingOptions): TextChunk[] {
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const overlap = options?.overlap ?? DEFAULT_OVERLAP;

    if (!text.trim()) return [];

    const lines = text.split('\n');
    const sections: { heading?: string; lines: string[] }[] = [];
    let current: { heading?: string; lines: string[] } = { lines: [] };

    for (const line of lines) {
        const match = line.match(HEADING_RE);
        if (match) {
            // Save current section if it has content
            if (current.lines.length > 0) {
                sections.push(current);
            }
            current = { heading: match[2].trim(), lines: [line] };
        } else {
            current.lines.push(line);
        }
    }
    if (current.lines.length > 0) {
        sections.push(current);
    }

    // Convert sections into chunks, splitting large sections by token window
    const chunks: TextChunk[] = [];
    for (const section of sections) {
        const sectionText = section.lines.join('\n').trim();
        if (!sectionText) continue;

        const tokens = estimateTokens(sectionText);
        if (tokens <= maxTokens) {
            chunks.push({ text: sectionText, heading: section.heading });
        } else {
            // Split by line-based token windows
            splitByTokenWindow(section.lines, maxTokens, overlap, section.heading, chunks);
        }
    }

    return chunks;
}

/**
 * Split an array of lines into overlapping chunks of ~maxTokens each.
 */
function splitByTokenWindow(
    lines: string[],
    maxTokens: number,
    overlapTokens: number,
    heading: string | undefined,
    out: TextChunk[],
): void {
    // Pre-split any single line that exceeds maxTokens into smaller segments.
    // This handles base64 images, minified files, long data URIs, etc.
    const maxChars = maxTokens * 3; // inverse of estimateTokens (chars/3)
    const processedLines: string[] = [];
    for (const line of lines) {
        if (line.length > maxChars) {
            for (let i = 0; i < line.length; i += maxChars) {
                processedLines.push(line.slice(i, i + maxChars));
            }
        } else {
            processedLines.push(line);
        }
    }

    let startLine = 0;

    while (startLine < processedLines.length) {
        let tokenCount = 0;
        let endLine = startLine;

        // Accumulate lines until maxTokens (check BEFORE adding to prevent overshoot)
        while (endLine < processedLines.length) {
            const nextTokens = estimateTokens(processedLines[endLine]) + 1; // +1 for newline
            if (tokenCount + nextTokens > maxTokens && endLine > startLine) break;
            tokenCount += nextTokens;
            endLine++;
        }

        const chunkLines = processedLines.slice(startLine, endLine);
        const text = chunkLines.join('\n').trim();
        if (text) {
            out.push({ text, heading });
        }

        if (endLine >= processedLines.length) break;

        // Move start back by overlap amount
        let overlapCount = 0;
        let newStart = endLine;
        while (newStart > startLine && overlapCount < overlapTokens) {
            newStart--;
            overlapCount += estimateTokens(processedLines[newStart]) + 1;
        }
        startLine = newStart > startLine ? newStart : endLine;
    }
}

// ── Vector Search ───────────────────────────────────────────────────

/**
 * Brute-force cosine similarity search against all chunks.
 * Returns top-K results sorted by descending score, above minScore.
 */
export function searchVectors(
    queryEmbedding: Float32Array,
    chunks: VectorChunk[],
    topK: number = 10,
    minScore: number = 0.3,
): VectorSearchResult[] {
    const scored: VectorSearchResult[] = [];

    for (const chunk of chunks) {
        const score = cosineSimilarity(queryEmbedding, chunk.embedding);
        if (score >= minScore) {
            scored.push({
                path: chunk.path,
                chunkIndex: chunk.chunkIndex,
                heading: chunk.heading,
                text: chunk.text,
                score,
            });
        }
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
}

// ── Serialization ───────────────────────────────────────────────────

/**
 * Serialize Float32Array to base64 string for compact storage.
 * 4x more compact than JSON array of numbers.
 */
export function serializeEmbedding(f32: Float32Array): string {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Deserialize base64 string back to Float32Array.
 */
export function deserializeEmbedding(b64: string): Float32Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
}

// ── Embedding API Constants ─────────────────────────────────────────

/** Copilot embeddings endpoint. */
export const COPILOT_EMBEDDINGS_URL = 'https://api.githubcopilot.com/embeddings';

/** Default model for embeddings. */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Default dimensions (MRL — 95% quality at 1/6 storage). */
export const DEFAULT_EMBEDDING_DIMENSIONS = 256;

/** Max inputs per API call (Copilot proxy limits total tokens to 8192). */
export const MAX_EMBEDDING_BATCH_SIZE = 20;

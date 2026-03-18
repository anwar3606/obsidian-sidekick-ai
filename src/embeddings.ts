/**
 * Embeddings — Obsidian integration.
 *
 * VectorStore (IndexedDB), embedding API client (Copilot), and VaultIndexer
 * for background indexing with incremental updates and progress callbacks.
 */

import { requestUrl, type App, type TFile } from 'obsidian';
import {
    chunkText,
    searchVectors,
    cosineSimilarity,
    estimateTokens,
    COPILOT_EMBEDDINGS_URL,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_BATCH_SIZE,
    MAX_BATCH_TOKENS,
} from '../lib/embeddings';
import type { VectorChunk, VectorSearchResult, ChunkingOptions } from '../lib/embeddings';
import { copilotTokenManager } from './copilot-auth';
import { PROVIDERS } from '../lib/providers';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';

// ── Types ───────────────────────────────────────────────────────────

export interface EmbeddingSettings {
    enabled: boolean;
    dimensions: number;
    model: string;
    /** Inputs per API call (Copilot proxy limits total to 8192 tokens). */
    batchSize: number;
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
    enabled: false,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    model: DEFAULT_EMBEDDING_MODEL,
    batchSize: MAX_EMBEDDING_BATCH_SIZE,
};

export interface IndexProgress {
    phase: 'scanning' | 'embedding' | 'saving' | 'done' | 'error';
    indexed: number;
    total: number;
    currentFile?: string;
    error?: string;
}

export interface IndexStats {
    fileCount: number;
    chunkCount: number;
    lastIndexedAt: number;
    dimensions: number;
}

// ── IndexedDB Vector Store ──────────────────────────────────────────

const DB_VERSION = 1;
const CHUNKS_STORE = 'chunks';
const META_STORE = 'meta';

/**
 * IndexedDB-backed vector store. Stores embeddings outside the vault
 * directory so they are not committed to git.
 */
export class VectorStore {
    private db: IDBDatabase | null = null;
    private dbName: string = '';

    /**
     * Open (or create) the IndexedDB database for a vault.
     * @param vaultId — unique identifier for this vault (hashed path).
     */
    async open(vaultId: string): Promise<void> {
        this.dbName = `sidekick-vectors-${vaultId}`;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
                    const store = db.createObjectStore(CHUNKS_STORE, { keyPath: ['path', 'chunkIndex'] });
                    store.createIndex('by_path', 'path', { unique: false });
                }
                if (!db.objectStoreNames.contains(META_STORE)) {
                    db.createObjectStore(META_STORE, { keyPath: 'path' });
                }
            };
            request.onsuccess = () => { this.db = request.result; resolve(); };
            request.onerror = () => reject(request.error);
        });
    }

    /** Close the database connection. */
    close(): void {
        this.db?.close();
        this.db = null;
    }

    private ensureOpen(): IDBDatabase {
        if (!this.db) throw new Error('VectorStore not opened');
        return this.db;
    }

    /**
     * Upsert all chunks for a file. Removes old chunks first, then inserts new ones.
     */
    async upsertChunks(path: string, chunks: VectorChunk[]): Promise<void> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();

            // Delete old chunks for this path
            const chunkStore = tx.objectStore(CHUNKS_STORE);
            const idx = chunkStore.index('by_path');
            const range = IDBKeyRange.only(path);
            const cursor = idx.openCursor(range);
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (c) { c.delete(); c.continue(); }
            };

            // Insert new chunks (embedding stored as ArrayBuffer)
            for (const chunk of chunks) {
                chunkStore.put({
                    path: chunk.path,
                    chunkIndex: chunk.chunkIndex,
                    text: chunk.text,
                    heading: chunk.heading,
                    embedding: chunk.embedding.buffer.slice(
                        chunk.embedding.byteOffset,
                        chunk.embedding.byteOffset + chunk.embedding.byteLength,
                    ),
                    mtime: chunk.mtime,
                });
            }

            // Update meta
            const metaStore = tx.objectStore(META_STORE);
            metaStore.put({
                path,
                mtime: chunks[0]?.mtime ?? 0,
                chunkCount: chunks.length,
            });
        });
    }

    /** Delete all chunks and metadata for a file path. */
    async deleteByPath(path: string): Promise<void> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();

            const chunkStore = tx.objectStore(CHUNKS_STORE);
            const idx = chunkStore.index('by_path');
            const cursor = idx.openCursor(IDBKeyRange.only(path));
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (c) { c.delete(); c.continue(); }
            };

            tx.objectStore(META_STORE).delete(path);
        });
    }

    /**
     * Load ALL chunks into memory for search.
     * Converts stored ArrayBuffer back to Float32Array.
     */
    async getAllChunks(): Promise<VectorChunk[]> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CHUNKS_STORE, 'readonly');
            const request = tx.objectStore(CHUNKS_STORE).getAll();
            request.onsuccess = () => {
                const rows = request.result as Array<{
                    path: string; chunkIndex: number; text: string;
                    heading?: string; embedding: ArrayBuffer; mtime: number;
                }>;
                resolve(rows.map(r => ({
                    path: r.path,
                    chunkIndex: r.chunkIndex,
                    text: r.text,
                    heading: r.heading,
                    embedding: new Float32Array(r.embedding),
                    mtime: r.mtime,
                })));
            };
            request.onerror = () => reject(request.error);
        });
    }

    /** Get metadata for a single file. */
    async getFileMeta(path: string): Promise<{ mtime: number; chunkCount: number } | null> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(META_STORE, 'readonly');
            const request = tx.objectStore(META_STORE).get(path);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        });
    }

    /** Get all file metadata (for incremental diff). */
    async getAllMeta(): Promise<Map<string, { mtime: number; chunkCount: number }>> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(META_STORE, 'readonly');
            const request = tx.objectStore(META_STORE).getAll();
            request.onsuccess = () => {
                const map = new Map<string, { mtime: number; chunkCount: number }>();
                for (const row of request.result) {
                    map.set(row.path, { mtime: row.mtime, chunkCount: row.chunkCount });
                }
                resolve(map);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /** Clear the entire database. */
    async clear(): Promise<void> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            tx.objectStore(CHUNKS_STORE).clear();
            tx.objectStore(META_STORE).clear();
        });
    }

    /** Get index statistics. */
    async getStats(): Promise<IndexStats> {
        const db = this.ensureOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readonly');
            const chunkReq = tx.objectStore(CHUNKS_STORE).count();
            const metaReq = tx.objectStore(META_STORE).count();
            tx.oncomplete = () => {
                resolve({
                    fileCount: metaReq.result,
                    chunkCount: chunkReq.result,
                    lastIndexedAt: Date.now(),
                    dimensions: 0, // caller can fill from settings
                });
            };
            tx.onerror = () => reject(tx.error);
        });
    }
}

// ── Embedding API ───────────────────────────────────────────────────

/** Default concurrency for parallel API requests. */
const EMBED_CONCURRENCY = 5;

/**
 * Call the Copilot embeddings endpoint.
 * Splits large input arrays into batches and runs them concurrently
 * (up to EMBED_CONCURRENCY in-flight requests) with retry + backoff.
 */
export async function embedTexts(
    texts: string[],
    sessionToken: string,
    options?: { model?: string; dimensions?: number; batchSize?: number },
): Promise<Float32Array[]> {
    const model = options?.model ?? DEFAULT_EMBEDDING_MODEL;
    const dimensions = options?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

    // Token-aware batching: group texts so each batch stays under MAX_BATCH_TOKENS
    const batches: string[][] = [];
    const batchOffsets: number[] = []; // starting index of each batch in the texts array
    let currentBatch: string[] = [];
    let currentTokens = 0;
    let currentOffset = 0;

    for (let i = 0; i < texts.length; i++) {
        const itemTokens = estimateTokens(texts[i]);
        // If adding this item would exceed token limit and batch isn't empty, start a new batch
        if (currentBatch.length > 0 && currentTokens + itemTokens > MAX_BATCH_TOKENS) {
            batches.push(currentBatch);
            batchOffsets.push(currentOffset);
            currentBatch = [];
            currentTokens = 0;
            currentOffset = i;
        }
        // Also enforce max items per batch
        if (currentBatch.length >= MAX_EMBEDDING_BATCH_SIZE) {
            batches.push(currentBatch);
            batchOffsets.push(currentOffset);
            currentBatch = [];
            currentTokens = 0;
            currentOffset = i;
        }
        // Warn if a single item is very large (shouldn't happen with proper chunking)
        if (itemTokens > MAX_BATCH_TOKENS) {
            debugLog.log('embeddings', 'oversized-item', { index: i, estimatedTokens: itemTokens, chars: texts[i].length });
        }
        currentBatch.push(texts[i]);
        currentTokens += itemTokens;
    }
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
        batchOffsets.push(currentOffset);
    }

    const results: Float32Array[] = new Array(texts.length);

    /** Embed a single batch with retry. */
    async function processBatch(idx: number): Promise<void> {
        const batch = batches[idx];
        const offset = batchOffsets[idx];

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = 1000 * Math.pow(2, attempt);
                    debugLog.log('embeddings', 'batch-retry', { batchIndex: idx, attempt, delayMs: delay });
                    await sleep(delay);
                }

                const res = await requestUrl({
                    url: COPILOT_EMBEDDINGS_URL,
                    method: 'POST',
                    headers: {
                        ...PROVIDERS.copilot.headers(sessionToken),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ model, input: batch, dimensions }),
                    throw: false,
                });

                if (res.status !== 200) {
                    let detail = '';
                    try {
                        const body = res.json;
                        detail = typeof body?.error === 'string' ? body.error
                            : typeof body?.error?.message === 'string' ? body.error.message
                            : res.text?.substring(0, 200) || '';
                    } catch {
                        detail = res.text?.substring(0, 200) || '';
                    }
                    if (res.status === 429) {
                        // Rate limited — use longer backoff
                        const retryAfter = parseInt(res.headers?.['retry-after'] || '10', 10);
                        debugLog.log('embeddings', 'rate-limited', { batchIndex: idx, retryAfterS: retryAfter });
                        await sleep(retryAfter * 1000);
                    }
                    throw new Error(`Embeddings API ${res.status}: ${detail}`.trim());
                }

                const data = res.json;
                for (const item of data.data) {
                    results[offset + item.index] = new Float32Array(item.embedding);
                }
                return; // Success
            } catch (err) {
                const error = err instanceof Error ? err : new Error(getErrorMessage(err));
                debugLog.log('embeddings', 'batch-error', { batchIndex: idx, attempt, error: error.message });
                if (attempt === 2) {
                    debugLog.log('embeddings', 'batch-failed-all-retries', { batchIndex: idx, error: error.message });
                    throw error;
                }
            }
        }
    }

    // Process batches in concurrent waves
    for (let i = 0; i < batches.length; i += EMBED_CONCURRENCY) {
        const wave = [];
        for (let j = i; j < Math.min(i + EMBED_CONCURRENCY, batches.length); j++) {
            wave.push(processBatch(j));
        }
        await Promise.all(wave);
        // Small delay between waves to avoid rate limiting
        if (i + EMBED_CONCURRENCY < batches.length) await sleep(200);
    }

    return results;
}

// ── Vault Indexer ───────────────────────────────────────────────────

/**
 * Crawls vault markdown files, chunks them, embeds via Copilot API,
 * and stores vectors in IndexedDB. Supports incremental updates and
 * graceful cancellation.
 */
export class VaultIndexer {
    private store: VectorStore;
    private settings: EmbeddingSettings;
    private running = false;
    private cancelled = false;
    /** In-memory cache of all chunks for search (loaded once, updated incrementally). */
    private cachedChunks: VectorChunk[] | null = null;

    onProgress?: (progress: IndexProgress) => void;

    constructor(settings: EmbeddingSettings) {
        this.store = new VectorStore();
        this.settings = settings;
    }

    /** Whether the indexer is currently running. */
    isRunning(): boolean { return this.running; }

    /** Whether the index has been loaded and is ready for search. */
    isReady(): boolean { return this.cachedChunks !== null; }

    /** Update settings (e.g. from settings tab). */
    updateSettings(settings: EmbeddingSettings): void {
        this.settings = settings;
    }

    /**
     * Open the IndexedDB store and load chunks into memory.
     * Call this once during plugin startup.
     */
    async initialize(vaultPath: string): Promise<void> {
        // Hash the vault path into a short ID for the DB name
        const vaultId = await hashString(vaultPath);
        await this.store.open(vaultId);
        this.cachedChunks = await this.store.getAllChunks();
    }

    /**
     * Full or incremental vault index.
     * Pipeline: scan → read & chunk ALL → embed concurrently → save to DB.
     *
     * With batch=512 and concurrency=5, embeds ~500+ chunks/sec.
     * A 2500-file vault (~115k chunks) indexing takes ~3-4 minutes.
     */
    async indexVault(app: App): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.cancelled = false;

        let indexed = 0;
        let failed = 0;
        let total = 0;

        try {
            // ── Phase 1: Scan for changes ───────────────────────────
            this.emitProgress({ phase: 'scanning', indexed: 0, total: 0 });

            const allFiles = app.vault.getMarkdownFiles();
            const storedMeta = await this.store.getAllMeta();
            const currentPaths = new Set(allFiles.map(f => f.path));
            debugLog.log('embeddings', 'scan-complete', { totalFiles: allFiles.length, storedFiles: storedMeta.size });

            const toEmbed: TFile[] = [];
            for (const file of allFiles) {
                const meta = storedMeta.get(file.path);
                if (!meta || meta.mtime < file.stat.mtime) {
                    toEmbed.push(file);
                }
            }

            const toDelete: string[] = [];
            for (const [path] of storedMeta) {
                if (!currentPaths.has(path)) toDelete.push(path);
            }

            debugLog.log('embeddings', 'diff-result', { toEmbed: toEmbed.length, toDelete: toDelete.length });

            for (const path of toDelete) await this.store.deleteByPath(path);

            if (toEmbed.length === 0) {
                this.cachedChunks = await this.store.getAllChunks();
                this.emitProgress({ phase: 'done', indexed: 0, total: 0 });
                return;
            }

            total = toEmbed.length;

            // ── Phase 2: Read & chunk ALL files (fast — disk IO only) ──
            type ChunkInfo = { path: string; chunkIndex: number; text: string; heading?: string; mtime: number };
            const allChunkTexts: string[] = [];
            const allChunkMeta: ChunkInfo[] = [];

            for (const file of toEmbed) {
                if (this.cancelled) break;
                try {
                    const content = await app.vault.cachedRead(file);
                    const chunks = chunkText(content, { maxTokens: 500, overlap: 50 });
                    for (let ci = 0; ci < chunks.length; ci++) {
                        allChunkTexts.push(chunks[ci].text);
                        allChunkMeta.push({
                            path: file.path, chunkIndex: ci,
                            text: chunks[ci].text, heading: chunks[ci].heading,
                            mtime: file.stat.mtime,
                        });
                    }
                } catch (err: unknown) {
                    failed++;
                    debugLog.log('embeddings', 'file-read-failed', { path: file.path, error: String(err) });
                }
            }

            if (this.cancelled) { this.emitProgress({ phase: 'done', indexed, total }); return; }

            debugLog.log('embeddings', 'chunking-complete', {
                files: toEmbed.length - failed, chunks: allChunkTexts.length, failedReads: failed,
            });

            // ── Phase 3: Embed in mega-batches of 5000 chunks ──────
            // Each mega-batch → ~10 API calls at batch 512, 5 concurrent.
            // Saves incrementally so progress isn't lost on crash.
            let sessionToken = await copilotTokenManager.getSessionToken();
            const MEGA_BATCH = 5000;

            for (let offset = 0; offset < allChunkTexts.length; offset += MEGA_BATCH) {
                if (this.cancelled) break;

                const end = Math.min(offset + MEGA_BATCH, allChunkTexts.length);
                const sliceTexts = allChunkTexts.slice(offset, end);

                this.emitProgress({
                    phase: 'embedding', indexed, total,
                    currentFile: allChunkMeta[offset]?.path,
                });

                try {
                    if (offset > 0) sessionToken = await copilotTokenManager.getSessionToken();

                    const embeddings = await embedTexts(sliceTexts, sessionToken, {
                        model: this.settings.model,
                        dimensions: this.settings.dimensions,
                        batchSize: this.settings.batchSize,
                    });

                    // ── Phase 4: Save to IndexedDB (grouped by file) ──
                    this.emitProgress({ phase: 'saving', indexed, total });

                    const byFile = new Map<string, VectorChunk[]>();
                    for (let j = 0; j < sliceTexts.length; j++) {
                        const meta = allChunkMeta[offset + j];
                        const chunk: VectorChunk = { ...meta, embedding: embeddings[j] };
                        const arr = byFile.get(meta.path) ?? [];
                        arr.push(chunk);
                        byFile.set(meta.path, arr);
                    }

                    for (const [path, chunks] of byFile) {
                        await this.store.upsertChunks(path, chunks);
                        indexed++;
                    }

                    debugLog.log('embeddings', 'mega-batch-saved', {
                        chunkOffset: offset, chunksInBatch: sliceTexts.length,
                        filesInBatch: byFile.size, indexed, total,
                    });
                } catch (err) {
                    const errMsg = getErrorMessage(err);
                    debugLog.log('embeddings', 'mega-batch-error', { chunkOffset: offset, error: errMsg });

                    const failedPaths = new Set<string>();
                    for (let j = offset; j < end && j < allChunkMeta.length; j++) failedPaths.add(allChunkMeta[j].path);
                    failed += failedPaths.size;

                    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('400')) {
                        debugLog.log('embeddings', 'auth-error-refreshing', { error: errMsg });
                        try {
                            copilotTokenManager.invalidateSession();
                            sessionToken = await copilotTokenManager.getSessionToken();
                        } catch {
                            // Token refresh also failed — auth is broken
                            this.emitProgress({
                                phase: 'error', indexed, total,
                                error: 'Authentication failed. Please re-sign in to GitHub Copilot.',
                            });
                            break;
                        }
                    }
                    await sleep(3000);
                }

                this.emitProgress({ phase: 'embedding', indexed, total });
                await sleep(0); // yield to UI
            }

            // ── Phase 5: Refresh in-memory cache ────────────────────
            this.cachedChunks = await this.store.getAllChunks();
            debugLog.log('embeddings', 'indexing-complete', { indexed, failed, total });

            if (failed > 0) {
                this.emitProgress({
                    phase: 'done', indexed, total,
                    error: `Completed with ${failed} failed files. Re-run to retry.`,
                });
            } else {
                this.emitProgress({ phase: 'done', indexed, total });
            }

        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            debugLog.log('embeddings', 'indexing-fatal-error', { error: msg, indexed, total });
            this.emitProgress({ phase: 'error', indexed, total, error: msg });
        } finally {
            this.running = false;
        }
    }

    /**
     * Index a single file (for incremental updates on file modify).
     */
    async indexFile(app: App, file: TFile): Promise<void> {
        if (!this.settings.enabled) return;

        try {
            const sessionToken = await copilotTokenManager.getSessionToken();
            const content = await app.vault.cachedRead(file);
            const chunks = chunkText(content, { maxTokens: 500, overlap: 50 });

            if (chunks.length === 0) {
                await this.store.deleteByPath(file.path);
                this.removeCachedChunks(file.path);
                return;
            }

            const texts = chunks.map(c => c.text);
            const embeddings = await embedTexts(texts, sessionToken, {
                model: this.settings.model,
                dimensions: this.settings.dimensions,
            });

            const vectorChunks: VectorChunk[] = chunks.map((c, i) => ({
                path: file.path,
                chunkIndex: i,
                text: c.text,
                heading: c.heading,
                embedding: embeddings[i],
                mtime: file.stat.mtime,
            }));

            await this.store.upsertChunks(file.path, vectorChunks);
            this.updateCachedChunks(file.path, vectorChunks);
        } catch (err: unknown) {
            // Single-file re-index failure (rate limit, auth, etc.) — skip but log
            debugLog.log('embeddings', 'single-file-reindex-failed', { path: file.path, error: getErrorMessage(err) });
        }
    }

    /**
     * Remove a file from the index (on file delete).
     */
    async removeFile(path: string): Promise<void> {
        await this.store.deleteByPath(path);
        this.removeCachedChunks(path);
    }

    /**
     * Handle file rename — move chunks from old path to new path.
     */
    async renameFile(oldPath: string, newPath: string): Promise<void> {
        if (!this.cachedChunks) return;

        // Get existing chunks for old path
        const oldChunks = this.cachedChunks.filter(c => c.path === oldPath);
        if (oldChunks.length === 0) return;

        // Create new chunks with updated path
        const newChunks = oldChunks.map(c => ({ ...c, path: newPath }));

        // Update cache atomically BEFORE async store operations so that
        // concurrent search() calls see the new path immediately instead
        // of hitting a stale or missing state mid-operation.
        this.removeCachedChunks(oldPath);
        this.cachedChunks.push(...newChunks);

        // Update persistent store (safe to be async — cache is already consistent)
        await this.store.deleteByPath(oldPath);
        await this.store.upsertChunks(newPath, newChunks);
    }

    /**
     * Semantic search across the indexed vault.
     */
    async search(query: string, topK: number = 10, minScore: number = 0.3): Promise<VectorSearchResult[]> {
        if (!this.cachedChunks || this.cachedChunks.length === 0) {
            return [];
        }

        const sessionToken = await copilotTokenManager.getSessionToken();
        const [queryEmbedding] = await embedTexts([query], sessionToken, {
            model: this.settings.model,
            dimensions: this.settings.dimensions,
        });

        return searchVectors(queryEmbedding, this.cachedChunks, topK, minScore);
    }

    /** Cancel a running index operation. */
    cancel(): void {
        this.cancelled = true;
    }

    /** Get index statistics. */
    async getStats(): Promise<IndexStats> {
        const stats = await this.store.getStats();
        stats.dimensions = this.settings.dimensions;
        return stats;
    }

    /** Clear the entire index. */
    async clearIndex(): Promise<void> {
        await this.store.clear();
        this.cachedChunks = [];
    }

    /** Tear down — close DB connection. */
    destroy(): void {
        this.cancel();
        this.store.close();
        this.cachedChunks = null;
    }

    // ── Private helpers ─────────────────────────────────────────────

    private emitProgress(progress: IndexProgress): void {
        this.onProgress?.(progress);
    }

    private removeCachedChunks(path: string): void {
        if (this.cachedChunks) {
            this.cachedChunks = this.cachedChunks.filter(c => c.path !== path);
        }
    }

    private updateCachedChunks(path: string, newChunks: VectorChunk[]): void {
        this.removeCachedChunks(path);
        if (this.cachedChunks) {
            this.cachedChunks.push(...newChunks);
        }
    }
}

// ── Utilities ───────────────────────────────────────────────────────

/** Simple hash for vault path → DB name suffix. */
async function hashString(str: string): Promise<string> {
    // Use a simple DJB2 hash (no crypto needed for a DB name)
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

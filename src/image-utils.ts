import { TFile } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Image utility functions for vault-based image storage and resolution.
 *
 * All functions take `app` as a parameter rather than relying on class
 * instance state, making them independently testable.
 */

// ── Re-export pure helpers from lib/ (single source of truth) ─────
export { arrayBufferToBase64, extensionToMime } from '../lib/image-utils';
import { arrayBufferToBase64, extensionToMime } from '../lib/image-utils';

// ── Image compression ───────────────────────────────────────────────

/** Maximum dimension (width or height) for images sent to the API. */
const MAX_IMAGE_DIM = 1568;

/** JPEG quality for compressed images (0.0–1.0). */
const JPEG_QUALITY = 0.82;

/**
 * Compress / resize a data-URL image using an OffscreenCanvas (or <canvas>).
 * - Scales down to fit within maxDim × maxDim (preserving aspect ratio).
 * - Converts to JPEG at the given quality.
 * - Returns original if the image is SVG, GIF, or already small enough.
 */
export async function compressImageDataUrl(
    dataUrl: string,
    maxDim = MAX_IMAGE_DIM,
    quality = JPEG_QUALITY,
): Promise<string> {
    // Skip non-data URLs
    if (!dataUrl.startsWith('data:image/')) return dataUrl;

    // Don't compress SVG or GIF (lossy conversion would break them)
    if (dataUrl.startsWith('data:image/svg') || dataUrl.startsWith('data:image/gif')) {
        return dataUrl;
    }

    // Guard: browser APIs required (not available in Node.js test env)
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
        return dataUrl;
    }

    return new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;

            // If already within bounds and < 512KB, skip compression
            const base64Len = dataUrl.length - dataUrl.indexOf(',') - 1;
            const approxBytes = base64Len * 0.75;
            if (width <= maxDim && height <= maxDim && approxBytes < 512 * 1024) {
                resolve(dataUrl);
                return;
            }

            // Scale down proportionally
            if (width > maxDim || height > maxDim) {
                const scale = maxDim / Math.max(width, height);
                width = Math.round(width * scale);
                height = Math.round(height * scale);
            }

            try {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) { resolve(dataUrl); return; }
                ctx.drawImage(img, 0, 0, width, height);
                const compressed = canvas.toDataURL('image/jpeg', quality);
                // Only use the compressed version if it's actually smaller
                resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
            } catch {
                resolve(dataUrl); // canvas failure → return original
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

// ── Vault image operations ──────────────────────────────────────────

/**
 * Resolve an image reference for API consumption.
 * - Data URLs and remote URLs pass through unchanged.
 * - Vault paths are read as binary and converted to base64 data URLs.
 * - Large images are compressed/resized to reduce payload size.
 */
export async function resolveImageForApi(app: App, img: string): Promise<string> {
    if (img.startsWith('http')) return img;
    if (img.startsWith('data:')) return compressImageDataUrl(img);

    try {
        const file = app.vault.getAbstractFileByPath(img);
        if (file && file instanceof TFile) {
            const buf = await app.vault.readBinary(file);
            const mime = extensionToMime(file.extension);
            const b64 = arrayBufferToBase64(buf);
            const dataUrl = `data:${mime};base64,${b64}`;
            return compressImageDataUrl(dataUrl);
        }
    } catch { /* fallback to raw path */ }
    return img;
}

/**
 * Get a renderable URL for an image.
 * - Data URLs and remote URLs pass through unchanged.
 * - Vault paths are converted to Obsidian resource URLs.
 */
export function getResourceUrl(app: App, img: string): string {
    if (img.startsWith('data:') || img.startsWith('http')) return img;

    const file = app.vault.getAbstractFileByPath(img);
    if (file && file instanceof TFile) {
        return app.vault.getResourcePath(file);
    }
    return img;
}

/**
 * Save an image (base64 data URL or remote URL) to the vault.
 * Compresses PNG/WEBP data URLs to JPEG before saving to reduce vault size.
 * Returns the vault path of the saved file.
 */
export async function saveImageToVault(
    app: App,
    chatFolder: string,
    imageData: string,
    prefix = 'img',
): Promise<string> {
    const folder = `${chatFolder}/images`;

    // Ensure folder exists
    if (!app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
    }

    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 6);

    if (imageData.startsWith('data:')) {
        // Compress PNG/WEBP to JPEG before saving (skip SVG/GIF)
        const compressed = await compressImageDataUrl(imageData, MAX_IMAGE_DIM, JPEG_QUALITY);

        const match = compressed.match(/^data:image\/([\w+.-]+);base64,(.+)$/);
        if (!match) throw new Error('Invalid data URL');
        const mimeSubtype = match[1];
        // Derive extension: svg+xml → svg, jpeg → jpg, otherwise use subtype as-is
        const ext = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype.split('+')[0];
        const binary = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
        const path = `${folder}/${prefix}-${ts}-${rand}.${ext}`;
        await app.vault.createBinary(path, binary.buffer);
        return path;
    }

    // Remote URL → download and save
    try {
        const res = await fetch(imageData);
        const blob = await res.blob();

        // Map blob MIME type to file extension
        let ext = 'jpg';
        const t = blob.type.toLowerCase();
        if (t.includes('png')) ext = 'png';
        else if (t.includes('webp')) ext = 'webp';
        else if (t.includes('gif')) ext = 'gif';
        else if (t.includes('svg')) ext = 'svg';
        else if (t.includes('bmp')) ext = 'bmp';

        const buffer = await blob.arrayBuffer();
        const path = `${folder}/${prefix}-${ts}-${rand}.${ext}`;
        await app.vault.createBinary(path, buffer);
        return path;
    } catch {
        return imageData; // download failure → return original URL
    }
}

/**
 * Extract image references from note content (wiki `![[img.png]]` and
 * markdown `![alt](img.png)` syntax) and resolve them to base64 data URLs.
 */
export async function extractNoteImages(app: App, content: string, notePath: string): Promise<string[]> {
    const images: string[] = [];
    const imagePaths = new Set<string>();

    // Obsidian wiki-style: ![[image.png]] or ![[image.png|100]]
    const wikiPattern = /!\[\[([^|\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))[^\]]*\]\]/gi;
    // Standard markdown: ![alt](path.png) or ![alt](<space path.png>) or ![alt](path.png "title")
    const mdPattern = /!\[.*?\]\(\s*(?:<([^>]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))>|([^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)))(?:\s+[^)]*)?\)/gi;

    let match;
    while ((match = wikiPattern.exec(content)) !== null) {
        imagePaths.add(match[1]);
    }
    while ((match = mdPattern.exec(content)) !== null) {
        imagePaths.add(match[1] || match[2]);
    }

    for (const imgPath of imagePaths) {
        try {
            const resolved = app.metadataCache.getFirstLinkpathDest(imgPath, notePath);
            if (!resolved) continue;

            const binary = await app.vault.readBinary(resolved);
            const base64 = arrayBufferToBase64(binary);
            const ext = imgPath.split('.').pop()?.toLowerCase() || 'png';
            const mimeType = extensionToMime(ext);
            const dataUrl = `data:${mimeType};base64,${base64}`;
            images.push(await compressImageDataUrl(dataUrl));
        } catch { /* skip unresolvable images */ }
    }

    return images;
}

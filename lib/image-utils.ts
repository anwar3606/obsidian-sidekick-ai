/**
 * Pure image utility functions — zero Obsidian dependency.
 * Used by both lib/ (tests) and src/ (Obsidian plugin).
 */

// ── Pure helpers ────────────────────────────────────────────────────

/** Convert an ArrayBuffer to a base64-encoded string. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/** Map file extension to MIME type. */
export function extensionToMime(ext: string): string {
    switch (ext.toLowerCase()) {
        case 'png': return 'image/png';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'svg': return 'image/svg+xml';
        case 'bmp': return 'image/bmp';
        case 'jpg': case 'jpeg': default: return 'image/jpeg';
    }
}

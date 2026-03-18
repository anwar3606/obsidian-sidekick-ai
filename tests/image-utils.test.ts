import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockApp } from './mocks/obsidian';
import {
    arrayBufferToBase64,
    extensionToMime,
    resolveImageForApi,
    getResourceUrl,
    saveImageToVault,
    extractNoteImages,
    compressImageDataUrl,
} from '../src/image-utils';

// ── arrayBufferToBase64 ─────────────────────────────────────────────

describe('arrayBufferToBase64', () => {
    it('converts empty buffer', () => {
        const buf = new ArrayBuffer(0);
        expect(arrayBufferToBase64(buf)).toBe('');
    });

    it('converts simple ASCII', () => {
        const encoder = new TextEncoder();
        const buf = encoder.encode('Hello').buffer;
        expect(arrayBufferToBase64(buf)).toBe(btoa('Hello'));
    });

    it('returns valid base64 for binary data', () => {
        const arr = new Uint8Array([0, 128, 255]);
        const result = arrayBufferToBase64(arr.buffer);
        expect(result).toBeTruthy();
        // Decode should round-trip
        const decoded = Uint8Array.from(atob(result), c => c.charCodeAt(0));
        expect(Array.from(decoded)).toEqual([0, 128, 255]);
    });
});

// ── extensionToMime ─────────────────────────────────────────────────

describe('extensionToMime', () => {
    it('maps png', () => expect(extensionToMime('png')).toBe('image/png'));
    it('maps webp', () => expect(extensionToMime('webp')).toBe('image/webp'));
    it('maps gif', () => expect(extensionToMime('gif')).toBe('image/gif'));
    it('maps svg', () => expect(extensionToMime('svg')).toBe('image/svg+xml'));
    it('maps bmp', () => expect(extensionToMime('bmp')).toBe('image/bmp'));
    it('maps jpg', () => expect(extensionToMime('jpg')).toBe('image/jpeg'));
    it('maps jpeg', () => expect(extensionToMime('jpeg')).toBe('image/jpeg'));
    it('is case-insensitive', () => expect(extensionToMime('PNG')).toBe('image/png'));
    it('defaults to jpeg for unknown', () => expect(extensionToMime('xyz')).toBe('image/jpeg'));
});

// ── resolveImageForApi ──────────────────────────────────────────────

describe('resolveImageForApi', () => {
    it('passes through data URLs unchanged', async () => {
        const app = createMockApp();
        const dataUrl = 'data:image/png;base64,abc123';
        expect(await resolveImageForApi(app, dataUrl)).toBe(dataUrl);
    });

    it('passes through http URLs unchanged', async () => {
        const app = createMockApp();
        const url = 'https://example.com/image.png';
        expect(await resolveImageForApi(app, url)).toBe(url);
    });

    it('converts vault path to data URL', async () => {
        const app = createMockApp({ 'images/photo.png': 'binary-content' });
        const result = await resolveImageForApi(app, 'images/photo.png');
        expect(result).toMatch(/^data:image\/png;base64,/);
    });

    it('falls back to raw path for missing files', async () => {
        const app = createMockApp();
        const result = await resolveImageForApi(app, 'missing/image.png');
        expect(result).toBe('missing/image.png');
    });
});

// ── getResourceUrl ──────────────────────────────────────────────────

describe('getResourceUrl', () => {
    it('passes through data URLs', () => {
        const app = createMockApp();
        const url = 'data:image/png;base64,abc';
        expect(getResourceUrl(app, url)).toBe(url);
    });

    it('passes through http URLs', () => {
        const app = createMockApp();
        expect(getResourceUrl(app, 'https://x.com/img.png')).toBe('https://x.com/img.png');
    });

    it('converts vault path to resource URL', () => {
        const app = createMockApp({ 'images/test.png': 'data' });
        const result = getResourceUrl(app, 'images/test.png');
        expect(result).toContain('images/test.png');
    });

    it('returns raw path for missing files', () => {
        const app = createMockApp();
        expect(getResourceUrl(app, 'nope.png')).toBe('nope.png');
    });
});

// ── saveImageToVault ────────────────────────────────────────────────

describe('saveImageToVault', () => {
    it('saves base64 data URL to vault', async () => {
        const app = createMockApp();
        const dataUrl = 'data:image/png;base64,' + btoa('test-image-data');
        const path = await saveImageToVault(app, 'copilot/conversations', dataUrl, 'test');
        expect(path).toMatch(/^copilot\/conversations\/images\/test-\d+-\w+\.png$/);
    });

    it('creates the images folder if missing', async () => {
        const app = createMockApp();
        const dataUrl = 'data:image/jpeg;base64,' + btoa('jpg-data');
        await saveImageToVault(app, 'Chats', dataUrl, 'img');
        // Folder should now exist
        expect(app.vault.getAbstractFileByPath('Chats/images')).toBeTruthy();
    });

    it('throws on invalid data URL', async () => {
        const app = createMockApp();
        await expect(saveImageToVault(app, 'X', 'data:invalid', 'img')).rejects.toThrow('Invalid data URL');
    });

    it('uses jpg extension for jpeg mime type', async () => {
        const app = createMockApp();
        const dataUrl = 'data:image/jpeg;base64,' + btoa('jpegdata');
        const path = await saveImageToVault(app, 'Chats', dataUrl);
        expect(path).toMatch(/\.jpg$/);
    });

    it('saves SVG data URL (image/svg+xml MIME type)', async () => {
        const app = createMockApp();
        const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="50"/></svg>';
        const dataUrl = 'data:image/svg+xml;base64,' + btoa(svgContent);
        const path = await saveImageToVault(app, 'Chats', dataUrl, 'icon');
        expect(path).toMatch(/\.svg$/);
    });

    it('downloads remote SVG and saves with .svg extension', async () => {
        const app = createMockApp();
        globalThis.fetch = vi.fn().mockResolvedValue({
            blob: () => Promise.resolve({
                type: 'image/svg+xml',
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(10))
            })
        } as any);

        const path = await saveImageToVault(app, 'Chats', 'https://example.com/icon.svg', 'img');
        expect(path).toMatch(/\.svg$/);
    });

    it('downloads remote GIF and saves with .gif extension', async () => {
        const app = createMockApp();
        globalThis.fetch = vi.fn().mockResolvedValue({
            blob: () => Promise.resolve({
                type: 'image/gif',
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(10))
            })
        } as any);

        const path = await saveImageToVault(app, 'Chats', 'https://example.com/anim.gif', 'img');
        expect(path).toMatch(/\.gif$/);
    });
});

// ── extractNoteImages ───────────────────────────────────────────────

describe('extractNoteImages', () => {
    it('returns empty array for text without images', async () => {
        const app = createMockApp();
        const result = await extractNoteImages(app, 'Just text content', 'note.md');
        expect(result).toEqual([]);
    });

    it('extracts wiki-style image embeds', async () => {
        const app = createMockApp({ 'photo.png': 'imgdata' });
        const content = 'Some text ![[photo.png]] more text';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(1);
        expect(result[0]).toMatch(/^data:image\/png;base64,/);
    });

    it('extracts markdown-style image embeds', async () => {
        const app = createMockApp({ 'pic.jpg': 'jpgdata' });
        const content = 'Text ![alt text](pic.jpg) end';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(1);
        expect(result[0]).toMatch(/^data:image\/jpeg;base64,/);
    });


    it('extracts images with aliases in wiki links', async () => {
        const app = createMockApp({ 'photo.png': 'imgdata' });
        const content = '![[photo.png|100x100]]';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(1);
    });

    it('extracts markdown images with titles', async () => {
        const app = createMockApp({ 'pic.jpg': 'jpgdata' });
        const content = '![alt text](pic.jpg "Image Title")';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(1);
    });

    it('extracts markdown images with angle brackets', async () => {
        const app = createMockApp({ 'my image.png': 'pngdata' });
        const content = '![alt text](<my image.png>)';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(1);
    });

    it('deduplicates repeated references', async () => {
        const app = createMockApp({ 'same.png': 'data' });
        const content = '![[same.png]] text ![[same.png]]';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(1);
    });

    it('skips unresolvable images', async () => {
        const app = createMockApp(); // no files
        const content = '![[missing.png]]';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result).toEqual([]);
    });

    it('handles multiple image formats', async () => {
        const app = createMockApp({
            'a.png': 'd1',
            'b.gif': 'd2',
            'c.webp': 'd3',
        });
        const content = '![[a.png]] ![[b.gif]] ![[c.webp]]';
        const result = await extractNoteImages(app, content, 'note.md');
        expect(result.length).toBe(3);
    });
});

// ── compressImageDataUrl ────────────────────────────────────────────

describe('compressImageDataUrl', () => {
    it('returns non-data URLs unchanged', async () => {
        expect(await compressImageDataUrl('http://example.com/img.png')).toBe('http://example.com/img.png');
        expect(await compressImageDataUrl('https://example.com/img.png')).toBe('https://example.com/img.png');
        expect(await compressImageDataUrl('/local/path.png')).toBe('/local/path.png');
    });

    it('returns SVG data URLs unchanged', async () => {
        const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
        expect(await compressImageDataUrl(svg)).toBe(svg);
    });

    it('returns GIF data URLs unchanged', async () => {
        const gif = 'data:image/gif;base64,R0lGODlhAQABAA==';
        expect(await compressImageDataUrl(gif)).toBe(gif);
    });

    it('returns small images unchanged', async () => {
        // In Node test env, browser APIs are unavailable so it returns original
        const small = 'data:image/png;base64,' + btoa('x'.repeat(100));
        const result = await compressImageDataUrl(small);
        expect(result).toBe(small);
    });
});

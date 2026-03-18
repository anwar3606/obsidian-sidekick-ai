import { describe, it, expect } from 'vitest';
import {
    normalizeOpenRouterModel,
    buildOpenRouterImageRequest,
    buildOpenRouterImageHeaders,
    parseOpenRouterImageResponse,
} from '../lib/image-gen';

describe('lib/image-gen', () => {
    describe('normalizeOpenRouterModel', () => {
        it('returns model as-is when it already has a slash', () => {
            expect(normalizeOpenRouterModel('black-forest-labs/flux.2-pro')).toBe('black-forest-labs/flux.2-pro');
        });

        it('prepends openai/ when model has no slash', () => {
            expect(normalizeOpenRouterModel('gpt-5-image')).toBe('openai/gpt-5-image');
        });

        it('does not double-prefix openai/', () => {
            expect(normalizeOpenRouterModel('openai/gpt-5-image')).toBe('openai/gpt-5-image');
        });
    });

    describe('buildOpenRouterImageRequest', () => {
        it('builds request for a Flux model (image-only)', () => {
            const req = buildOpenRouterImageRequest('black-forest-labs/flux.2-pro', 'a cat');
            expect(req.model).toBe('black-forest-labs/flux.2-pro');
            expect(req.stream).toBe(false);
            expect(req.messages).toEqual([{ role: 'user', content: 'a cat' }]);
            expect(req.modalities).toEqual(['image']);
            expect(req.image_config).toBeUndefined();
        });

        it('builds request for a Gemini model (multimodal)', () => {
            const req = buildOpenRouterImageRequest('google/gemini-2.5-flash-image', 'a dog');
            expect(req.modalities).toEqual(['image', 'text']);
        });

        it('builds request for a GPT model (multimodal)', () => {
            const req = buildOpenRouterImageRequest('openai/gpt-5-image', 'mountains');
            expect(req.modalities).toEqual(['image', 'text']);
        });

        it('builds request for Riverflow model (image-only)', () => {
            const req = buildOpenRouterImageRequest('sourceful/riverflow-v2-pro', 'sunset');
            expect(req.modalities).toEqual(['image']);
        });

        it('includes image_config when aspectRatio is provided', () => {
            const req = buildOpenRouterImageRequest('black-forest-labs/flux.2-pro', 'a cat', '16:9');
            expect(req.image_config).toEqual({ aspect_ratio: '16:9' });
        });

        it('omits image_config when aspectRatio is undefined', () => {
            const req = buildOpenRouterImageRequest('black-forest-labs/flux.2-pro', 'a cat');
            expect(req.image_config).toBeUndefined();
        });

        it('omits image_config when aspectRatio is empty string', () => {
            const req = buildOpenRouterImageRequest('black-forest-labs/flux.2-pro', 'a cat', '');
            expect(req.image_config).toBeUndefined();
        });

        it('normalizes model without slash to openai/ prefix', () => {
            const req = buildOpenRouterImageRequest('gpt-5-image', 'hello');
            expect(req.model).toBe('openai/gpt-5-image');
            expect(req.modalities).toEqual(['image', 'text']);
        });
    });

    describe('buildOpenRouterImageHeaders', () => {
        it('builds correct headers with API key', () => {
            const headers = buildOpenRouterImageHeaders('sk-test-key');
            expect(headers).toEqual({
                'Content-Type': 'application/json',
                Authorization: 'Bearer sk-test-key',
                'HTTP-Referer': 'https://obsidian.md',
                'X-Title': 'Sidekick',
            });
        });
    });

    describe('parseOpenRouterImageResponse', () => {
        it('extracts image URL from valid response', () => {
            const json = {
                choices: [{
                    message: {
                        images: [{
                            image_url: { url: 'https://example.com/image.png' },
                        }],
                    },
                }],
            };
            const result = parseOpenRouterImageResponse(json);
            expect(result.imageUrl).toBe('https://example.com/image.png');
            expect(result.raw).toBe(json);
        });

        it('returns null imageUrl when no choices', () => {
            expect(parseOpenRouterImageResponse({ choices: [] }).imageUrl).toBeNull();
        });

        it('returns null imageUrl when message has no images', () => {
            const json = { choices: [{ message: {} }] };
            expect(parseOpenRouterImageResponse(json).imageUrl).toBeNull();
        });

        it('returns null imageUrl when images array is empty', () => {
            const json = { choices: [{ message: { images: [] } }] };
            expect(parseOpenRouterImageResponse(json).imageUrl).toBeNull();
        });

        it('returns null imageUrl when response is null', () => {
            expect(parseOpenRouterImageResponse(null).imageUrl).toBeNull();
        });

        it('returns null imageUrl when response is undefined', () => {
            expect(parseOpenRouterImageResponse(undefined).imageUrl).toBeNull();
        });

        it('returns null imageUrl when image_url has no url field', () => {
            const json = { choices: [{ message: { images: [{ image_url: {} }] } }] };
            expect(parseOpenRouterImageResponse(json).imageUrl).toBeNull();
        });

        it('preserves raw response for debugging', () => {
            const json = { choices: [], error: 'something' };
            const result = parseOpenRouterImageResponse(json);
            expect(result.raw).toBe(json);
        });
    });
});

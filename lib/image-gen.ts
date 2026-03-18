// Zero Obsidian dependency — pure image generation request helpers.
// All HTTP calls remain in src/tools.ts; this module only builds request bodies
// and parses responses so they can be unit- and integration-tested independently.

import { getImageModalities } from './providers';

/** Shape of an OpenRouter image generation request body. */
export interface OpenRouterImageRequest {
    model: string;
    stream: false;
    messages: { role: 'user'; content: string }[];
    modalities: string[];
    image_config?: Record<string, string>;
}

/** Result of parsing an OpenRouter image generation response. */
export interface OpenRouterImageResult {
    /** The generated image URL, or null if no image was found. */
    imageUrl: string | null;
    /** Raw response JSON (for debugging / logging). */
    raw: unknown;
}

/**
 * Normalise the model identifier to an OpenRouter-style `org/name` prefix.
 * If the model already contains a `/`, it's returned as-is.
 * Otherwise `openai/` is prepended as a sensible default.
 */
export function normalizeOpenRouterModel(model: string): string {
    return model.includes('/') ? model : `openai/${model}`;
}

/**
 * Build the JSON body for an OpenRouter image generation request.
 *
 * This is a pure function — no network calls, no Obsidian dependency.
 * Use it in src/tools.ts like:
 *   const body = buildOpenRouterImageRequest(model, prompt, aspectRatio);
 *   const res = await requestUrl({ ... body: JSON.stringify(body) });
 */
export function buildOpenRouterImageRequest(
    model: string,
    prompt: string,
    aspectRatio?: string,
): OpenRouterImageRequest {
    const orModel = normalizeOpenRouterModel(model);
    const modalities = getImageModalities(orModel);

    const body: OpenRouterImageRequest = {
        model: orModel,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        modalities,
    };

    if (aspectRatio) {
        body.image_config = { aspect_ratio: aspectRatio };
    }

    return body;
}

/**
 * Build the HTTP headers for an OpenRouter image generation request.
 */
export function buildOpenRouterImageHeaders(apiKey: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://obsidian.md',
        'X-Title': 'Sidekick',
    };
}

/**
 * Parse an OpenRouter chat/completions response to extract the generated image URL.
 *
 * The OpenRouter API nests the image under:
 *   response.choices[0].message.images[0].image_url.url
 *
 * Returns { imageUrl, raw } — imageUrl is null when no image was found.
 */
export function parseOpenRouterImageResponse(json: unknown): OpenRouterImageResult {
    const obj = json as Record<string, unknown> | undefined;
    const choices = (obj?.choices as unknown[]) ?? [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const images = (message?.images as unknown[]) ?? [];
    const firstImage = images[0] as Record<string, unknown> | undefined;
    const imgUrlObj = firstImage?.image_url as Record<string, unknown> | undefined;
    const url = imgUrlObj?.url as string | undefined;
    return { imageUrl: url ?? null, raw: json };
}

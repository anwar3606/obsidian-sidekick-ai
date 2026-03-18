/**
 * SSE streaming — re-exported from lib/ (single source of truth).
 *
 * src/ consumers import streamSSE and streamResponsesAPI from this file;
 * the actual implementation lives in lib/streaming.ts with zero Obsidian dependency.
 */
export { streamChatCompletions as streamSSE, streamResponsesAPI, streamMessagesAPI, formatApiError } from '../lib/streaming';

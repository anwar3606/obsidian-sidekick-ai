import { describe, it, expect } from 'vitest';
import {
    buildFollowUpPromptMessages,
    parseFollowUpResponse,
    shouldGenerateSuggestions,
    buildThinkingSummaryPromptMessages,
    parseThinkingSummaryResponse,
    extractThinkingCallouts,
    replaceThinkingSummary,
} from '../lib/suggestions';

// ── shouldGenerateSuggestions ────────────────────────────────────────

describe('shouldGenerateSuggestions', () => {
    it('returns false for short assistant responses', () => {
        expect(shouldGenerateSuggestions('OK', 'hello')).toBe(false);
        expect(shouldGenerateSuggestions('Done.', 'do it')).toBe(false);
    });

    it('returns true for reasonably long responses', () => {
        const response = 'Here is a detailed explanation of how the feature works. '.repeat(3);
        expect(shouldGenerateSuggestions(response, 'explain the feature')).toBe(true);
    });

    it('returns false when user message is a slash command', () => {
        const response = 'A'.repeat(100);
        expect(shouldGenerateSuggestions(response, '/help')).toBe(false);
        expect(shouldGenerateSuggestions(response, '/clear')).toBe(false);
    });

    it('returns true for non-slash user messages with long response', () => {
        const response = 'A'.repeat(100);
        expect(shouldGenerateSuggestions(response, 'how does this work?')).toBe(true);
    });
});

// ── buildFollowUpPromptMessages ─────────────────────────────────────

describe('buildFollowUpPromptMessages', () => {
    it('returns system and user messages', () => {
        const msgs = buildFollowUpPromptMessages('Here is the answer...', 'What is X?');
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe('system');
        expect(msgs[1].role).toBe('user');
    });

    it('system message instructs JSON array output', () => {
        const msgs = buildFollowUpPromptMessages('response text', 'user text');
        expect(msgs[0].content).toContain('JSON array');
    });

    it('user message includes both user question and assistant reply', () => {
        const msgs = buildFollowUpPromptMessages('my detailed answer', 'my question');
        expect(msgs[1].content).toContain('my question');
        expect(msgs[1].content).toContain('my detailed answer');
    });

    it('truncates long inputs in the context message', () => {
        const longUser = 'A'.repeat(1000);
        const longAssistant = 'B'.repeat(1000);
        const msgs = buildFollowUpPromptMessages(longAssistant, longUser);
        // Should be truncated to 300 + 500
        expect(msgs[1].content.length).toBeLessThan(1000);
    });
});

// ── parseFollowUpResponse ───────────────────────────────────────────

describe('parseFollowUpResponse', () => {
    it('parses a clean JSON array', () => {
        const input = '["How does this work?", "What are the alternatives?", "Show an example"]';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(3);
        expect(result[0].text).toBe('How does this work?');
        expect(result[0].label).toBe('How does this work?');
        expect(result[2].text).toBe('Show an example');
    });

    it('parses JSON array wrapped in markdown code fence', () => {
        const input = '```json\n["Question 1?", "Question 2?"]\n```';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('Question 1?');
    });

    it('limits to MAX_SUGGESTIONS (3)', () => {
        const input = '["Q1", "Q2", "Q3", "Q4", "Q5"]';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(3);
    });

    it('filters out non-string and empty items', () => {
        const input = '["Valid?", 42, "", null, "Also valid?"]';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('Valid?');
        expect(result[1].text).toBe('Also valid?');
    });

    it('falls back to line-based parsing on non-JSON input', () => {
        const input = '1. How can I improve this?\n2. What are the trade-offs?\n3. Any alternatives?';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(3);
        expect(result[0].text).toBe('How can I improve this?');
        expect(result[1].text).toBe('What are the trade-offs?');
    });

    it('handles bullet points in fallback', () => {
        const input = '- What about performance?\n- How does it scale?\n• Any security concerns?';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(3);
        expect(result[0].text).toBe('What about performance?');
    });

    it('strips surrounding quotes in fallback', () => {
        const input = '"How does this affect testing?"\n"Can you explain further?"';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('How does this affect testing?');
    });

    it('truncates long labels with ellipsis', () => {
        const longQuestion = 'How does this very long and complicated question that goes on and on actually work in practice?';
        const input = JSON.stringify([longQuestion]);
        const result = parseFollowUpResponse(input);
        expect(result[0].label.length).toBeLessThanOrEqual(50);
        expect(result[0].label).toMatch(/…$/);
        // Text stays full length
        expect(result[0].text).toBe(longQuestion);
    });

    it('returns empty array for empty/whitespace input', () => {
        expect(parseFollowUpResponse('')).toEqual([]);
        expect(parseFollowUpResponse('   ')).toEqual([]);
    });

    it('handles JSON with extra whitespace', () => {
        const input = '  \n  [ "Q1?" , "Q2?" ]  \n  ';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(2);
    });

    it('filters out very short lines in fallback', () => {
        const input = 'OK\nThis is a valid follow-up question?\nNo\nAnother good question here?';
        const result = parseFollowUpResponse(input);
        // "OK" and "No" should be filtered (< 6 chars)
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('This is a valid follow-up question?');
    });

    it('deduplicates suggestions (case-insensitive)', () => {
        const input = '["How does this work?", "how does this work?", "What else?"]';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('How does this work?');
        expect(result[1].text).toBe('What else?');
    });

    it('deduplicates in line-based fallback', () => {
        const input = '1. How does this work?\n2. How does this work?\n3. What are the alternatives?';
        const result = parseFollowUpResponse(input);
        expect(result).toHaveLength(2);
    });
});

// ── buildThinkingSummaryPromptMessages ──────────────────────────────

describe('buildThinkingSummaryPromptMessages', () => {
    it('returns system + user messages', () => {
        const msgs = buildThinkingSummaryPromptMessages('Let me analyze the code structure here...');
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe('system');
        expect(msgs[1].role).toBe('user');
    });

    it('truncates reasoning to 800 chars', () => {
        const longText = 'x'.repeat(2000);
        const msgs = buildThinkingSummaryPromptMessages(longText);
        expect(msgs[1].content).toHaveLength(800);
    });

    it('system prompt asks for short phrase', () => {
        const msgs = buildThinkingSummaryPromptMessages('thinking...');
        expect(msgs[0].content).toContain('3-8 words');
    });
});

// ── parseThinkingSummaryResponse ────────────────────────────────────

describe('parseThinkingSummaryResponse', () => {
    it('returns clean summary', () => {
        expect(parseThinkingSummaryResponse('Analyzing code structure')).toBe('Analyzing code structure');
    });

    it('strips surrounding quotes', () => {
        expect(parseThinkingSummaryResponse('"Reviewing API design"')).toBe('Reviewing API design');
        expect(parseThinkingSummaryResponse("'Debugging token issue'")).toBe('Debugging token issue');
    });

    it('strips trailing period', () => {
        expect(parseThinkingSummaryResponse('Checking user input.')).toBe('Checking user input');
    });

    it('takes first line only', () => {
        expect(parseThinkingSummaryResponse('First line\nSecond line')).toBe('First line');
    });

    it('truncates to 80 chars', () => {
        const long = 'A'.repeat(100);
        const result = parseThinkingSummaryResponse(long);
        expect(result.length).toBeLessThanOrEqual(80);
        expect(result.endsWith('…')).toBe(true);
    });

    it('returns Thinking for empty input', () => {
        expect(parseThinkingSummaryResponse('')).toBe('Thinking');
        expect(parseThinkingSummaryResponse('   ')).toBe('Thinking');
    });
});

// ── extractThinkingCallouts ─────────────────────────────────────────

describe('extractThinkingCallouts', () => {
    it('extracts a single expanded callout', () => {
        const content = '> [!abstract]+ 💭 Analyzing code\n> The code does XYZ\n> More reasoning\n\nHere is my answer.';
        const result = extractThinkingCallouts(content);
        expect(result).toHaveLength(1);
        expect(result[0].summary).toBe('Analyzing code');
        expect(result[0].reasoning).toContain('The code does XYZ');
    });

    it('extracts a collapsed callout', () => {
        const content = '> [!abstract]- 💭 Old thinking\n> Some reasoning here\n\nText.';
        const result = extractThinkingCallouts(content);
        expect(result).toHaveLength(1);
        expect(result[0].summary).toBe('Old thinking');
    });

    it('extracts multiple callouts', () => {
        const content = '> [!abstract]- 💭 First round\n> Reasoning 1\n\nSome text\n\n> [!abstract]+ 💭 Second round\n> Reasoning 2\n\nFinal answer.';
        const result = extractThinkingCallouts(content);
        expect(result).toHaveLength(2);
        expect(result[0].summary).toBe('First round');
        expect(result[1].summary).toBe('Second round');
    });

    it('returns empty array when no callouts', () => {
        expect(extractThinkingCallouts('Just plain text.')).toEqual([]);
    });

    it('handles blank lines within reasoning', () => {
        const content = '> [!abstract]+ 💭 Analysis\n> Line one\n> \n> Line three\n\nAnswer.';
        const result = extractThinkingCallouts(content);
        expect(result).toHaveLength(1);
        expect(result[0].summary).toBe('Analysis');
        expect(result[0].reasoning).toContain('Line one');
        expect(result[0].reasoning).toContain('Line three');
    });
});

// ── replaceThinkingSummary ──────────────────────────────────────────

describe('replaceThinkingSummary', () => {
    it('replaces summary in content', () => {
        const fullMatch = '> [!abstract]+ 💭 Thinking\n> Some reasoning\n';
        const content = `Before\n\n${fullMatch}\nAfter`;
        const result = replaceThinkingSummary(content, fullMatch, 'Thinking', 'Analyzing dependencies');
        expect(result).toContain('💭 Analyzing dependencies');
        expect(result).not.toContain('💭 Thinking');
    });

    it('replaces only the targeted callout when multiple exist', () => {
        const match1 = '> [!abstract]- 💭 Thinking\n> First reasoning\n';
        const match2 = '> [!abstract]+ 💭 Thinking\n> Second reasoning\n';
        const content = `${match1}\nText\n\n${match2}`;
        // Replace only the first one
        const result = replaceThinkingSummary(content, match1, 'Thinking', 'Checking imports');
        expect(result).toContain('💭 Checking imports');
        // Second one should remain
        expect(result).toContain('> [!abstract]+ 💭 Thinking');
    });
});

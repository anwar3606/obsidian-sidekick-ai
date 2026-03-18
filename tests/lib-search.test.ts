import { describe, it, expect } from 'vitest';
import { tokenize, bm25Score, fuzzyScore, BM25_K1, BM25_B, buildTavilySearchRequest, buildBraveSearchRequest, buildGoogleSearchRequest, parseTavilyResponse, parseBraveResponse, parseGoogleResponse, stripHtml } from '../lib/search';
import type { CorpusStats } from '../lib/search';

describe('lib/search', () => {
    describe('tokenize', () => {
        it('lowercases and splits on whitespace', () => {
            expect(tokenize('Hello World')).toEqual(['hello', 'world']);
        });

        it('strips punctuation except #/-', () => {
            expect(tokenize('tag: #todo, path/to/file')).toEqual(['tag', '#todo', 'path/to/file']);
        });

        it('filters single-character tokens', () => {
            expect(tokenize('a bc d ef')).toEqual(['bc', 'ef']);
        });

        it('returns empty array for empty string', () => {
            expect(tokenize('')).toEqual([]);
        });

        it('handles multiple spaces', () => {
            expect(tokenize('hello   world')).toEqual(['hello', 'world']);
        });
    });

    describe('bm25Score', () => {
        const stats: CorpusStats = {
            N: 100,
            avgDl: 200,
            df: new Map([['test', 10], ['rare', 1]]),
        };

        it('returns 0 when term frequency is 0', () => {
            expect(bm25Score(0, 200, stats, 'test')).toBe(0);
        });

        it('returns 0 when document frequency is 0', () => {
            expect(bm25Score(5, 200, stats, 'unknown')).toBe(0);
        });

        it('scores rare terms higher than common terms', () => {
            const common = bm25Score(1, 200, stats, 'test');
            const rare = bm25Score(1, 200, stats, 'rare');
            expect(rare).toBeGreaterThan(common);
        });

        it('higher term frequency gives higher score', () => {
            const low = bm25Score(1, 200, stats, 'test');
            const high = bm25Score(5, 200, stats, 'test');
            expect(high).toBeGreaterThan(low);
        });

        it('shorter docs get a boost', () => {
            const short = bm25Score(1, 50, stats, 'test');
            const long = bm25Score(1, 500, stats, 'test');
            expect(short).toBeGreaterThan(long);
        });

        it('returns positive score for valid input', () => {
            expect(bm25Score(3, 100, stats, 'test')).toBeGreaterThan(0);
        });

        it('field-specific avgDl normalizes short-field boost correctly', () => {
            // When avgDl matches docLen, BM25 length normalization factor = 1.0
            const titleStats: CorpusStats = { N: 100, avgDl: 3, df: new Map([['test', 10]]) };
            const contentStats: CorpusStats = { N: 100, avgDl: 200, df: new Map([['test', 10]]) };

            // Title: docLen=3, avgDl=3 → no length-based boost
            const titleScore = bm25Score(1, 3, titleStats, 'test');
            // Content: docLen=200, avgDl=200 → no length-based boost
            const contentScore = bm25Score(1, 200, contentStats, 'test');

            // Both should give the same TF component since docLen/avgDl = 1.0 in both cases
            expect(titleScore).toBeCloseTo(contentScore, 5);
        });
    });

    describe('fuzzyScore', () => {
        it('returns 0 for empty pattern', () => {
            expect(fuzzyScore('', 'anything')).toBe(0);
        });

        it('returns 0 for exact prefix match', () => {
            expect(fuzzyScore('hel', 'hello')).toBe(0);
        });

        it('returns position for substring match', () => {
            expect(fuzzyScore('llo', 'hello')).toBe(2);
        });

        it('returns -1 for no match', () => {
            expect(fuzzyScore('xyz', 'hello')).toBe(-1);
        });

        it('case-insensitive matching', () => {
            expect(fuzzyScore('HEL', 'hello')).toBe(0);
        });

        it('fuzzy character sequence match', () => {
            const score = fuzzyScore('hlo', 'hello');
            expect(score).toBeGreaterThanOrEqual(0);
        });

        it('penalizes non-start-of-word matches', () => {
            const startScore = fuzzyScore('my', 'my-file');
            const midScore = fuzzyScore('fi', 'my-file');
            // 'fi' starts at position 3 (after 'my-')
            expect(midScore).toBeGreaterThan(startScore);
        });

        it('prefers exact substring over fuzzy', () => {
            // 'ell' is a substring at position 1
            const exact = fuzzyScore('ell', 'hello world');
            expect(exact).toBe(1); // position of substring
        });
    });

    describe('constants', () => {
        it('exports BM25 tuning parameters', () => {
            expect(BM25_K1).toBe(1.2);
            expect(BM25_B).toBe(0.75);
        });
    });

    // ── Web Search ──────────────────────────────────────────────────

    describe('buildTavilySearchRequest', () => {
        it('builds POST request with correct body', () => {
            const req = buildTavilySearchRequest('key123', 'obsidian plugins');
            expect(req.url).toBe('https://api.tavily.com/search');
            expect(req.headers['Content-Type']).toBe('application/json');
            const body = JSON.parse(req.body);
            expect(body.api_key).toBe('key123');
            expect(body.query).toBe('obsidian plugins');
            expect(body.max_results).toBe(5);
            expect(body.topic).toBe('general');
            expect(body.include_answer).toBe(true);
        });

        it('clamps max_results to [1, 10]', () => {
            expect(JSON.parse(buildTavilySearchRequest('k', 'q', 0).body).max_results).toBe(1);
            expect(JSON.parse(buildTavilySearchRequest('k', 'q', 20).body).max_results).toBe(10);
        });

        it('supports news topic', () => {
            const body = JSON.parse(buildTavilySearchRequest('k', 'q', 5, 'news').body);
            expect(body.topic).toBe('news');
        });

        it('truncates long queries', () => {
            const longQuery = 'a'.repeat(500);
            const body = JSON.parse(buildTavilySearchRequest('k', longQuery).body);
            expect(body.query.length).toBe(400);
        });

        it('throws on empty query', () => {
            expect(() => buildTavilySearchRequest('k', '')).toThrow('Search query cannot be empty');
            expect(() => buildTavilySearchRequest('k', '   ')).toThrow('Search query cannot be empty');
        });
    });

    describe('buildBraveSearchRequest', () => {
        it('builds GET request with correct URL and headers', () => {
            const req = buildBraveSearchRequest('bravekey', 'test query');
            expect(req.url).toContain('https://api.search.brave.com/res/v1/web/search?');
            expect(req.url).toContain('q=test+query');
            expect(req.url).toContain('count=5');
            expect(req.headers['X-Subscription-Token']).toBe('bravekey');
            expect(req.headers['Accept']).toBe('application/json');
        });

        it('clamps max_results to [1, 10]', () => {
            expect(buildBraveSearchRequest('k', 'q', 0).url).toContain('count=1');
            expect(buildBraveSearchRequest('k', 'q', 20).url).toContain('count=10');
        });

        it('throws on empty query', () => {
            expect(() => buildBraveSearchRequest('k', '')).toThrow('Search query cannot be empty');
        });
    });

    describe('parseTavilyResponse', () => {
        it('parses full response', () => {
            const raw = {
                query: 'obsidian',
                answer: 'Obsidian is a note-taking app.',
                results: [
                    { title: 'Obsidian', url: 'https://obsidian.md', content: 'Knowledge base app', score: 0.95 },
                    { title: 'Plugins', url: 'https://obsidian.md/plugins', content: 'Community plugins', score: 0.8 },
                ],
            };
            const parsed = parseTavilyResponse(raw);
            expect(parsed.query).toBe('obsidian');
            expect(parsed.answer).toBe('Obsidian is a note-taking app.');
            expect(parsed.results).toHaveLength(2);
            expect(parsed.results[0].title).toBe('Obsidian');
            expect(parsed.results[0].score).toBe(0.95);
        });

        it('handles empty results', () => {
            const parsed = parseTavilyResponse({ query: 'nothing', results: [] });
            expect(parsed.results).toEqual([]);
            expect(parsed.answer).toBeUndefined();
        });

        it('handles missing fields gracefully', () => {
            const parsed = parseTavilyResponse({});
            expect(parsed.query).toBe('');
            expect(parsed.results).toEqual([]);
        });

        it('skips malformed result entries', () => {
            const parsed = parseTavilyResponse({ results: [null, undefined, 'bad', { title: 'ok', url: 'u', content: 'c', score: 1 }] });
            expect(parsed.results).toHaveLength(1);
            expect(parsed.results[0].title).toBe('ok');
        });
    });

    describe('parseBraveResponse', () => {
        it('parses full response with HTML stripping', () => {
            const raw = {
                query: { original_query: 'test' },
                web: {
                    results: [
                        { title: '<b>Bold</b> Title', url: 'https://example.com', description: 'desc &amp; more' },
                    ],
                },
            };
            const parsed = parseBraveResponse(raw);
            expect(parsed.query).toBe('test');
            expect(parsed.results).toHaveLength(1);
            expect(parsed.results[0].title).toBe('Bold Title');
            expect(parsed.results[0].content).toBe('desc & more');
            expect(parsed.results[0].score).toBe(0);
        });

        it('handles missing web results', () => {
            const parsed = parseBraveResponse({});
            expect(parsed.results).toEqual([]);
            expect(parsed.query).toBe('');
        });

        it('handles empty web.results', () => {
            const parsed = parseBraveResponse({ web: { results: [] } });
            expect(parsed.results).toEqual([]);
        });
    });

    describe('buildGoogleSearchRequest', () => {
        it('builds a GET request with all required params', () => {
            const req = buildGoogleSearchRequest('gkey', 'cx123', 'test query');
            expect(req.url).toContain('customsearch.googleapis.com/customsearch/v1');
            expect(req.url).toContain('key=gkey');
            expect(req.url).toContain('cx=cx123');
            expect(req.url).toContain('q=test+query');
            expect(req.url).toContain('num=5');
            expect(req.headers['Accept']).toBe('application/json');
        });

        it('clamps max results to 1-10', () => {
            const low = buildGoogleSearchRequest('k', 'cx', 'q', 0);
            expect(low.url).toContain('num=1');
            const high = buildGoogleSearchRequest('k', 'cx', 'q', 20);
            expect(high.url).toContain('num=10');
        });

        it('throws on empty query', () => {
            expect(() => buildGoogleSearchRequest('k', 'cx', '')).toThrow('empty');
        });
    });

    describe('parseGoogleResponse', () => {
        it('parses items array', () => {
            const res = parseGoogleResponse({
                items: [
                    { title: 'Result 1', link: 'https://a.com', snippet: 'Snippet 1' },
                    { title: '<b>Result 2</b>', link: 'https://b.com', snippet: 'Snippet &amp; 2' },
                ],
                searchInformation: { searchTime: 0.5 },
            });
            expect(res.results).toHaveLength(2);
            expect(res.results[0].title).toBe('Result 1');
            expect(res.results[0].url).toBe('https://a.com');
            expect(res.results[0].content).toBe('Snippet 1');
            expect(res.results[1].title).toBe('Result 2');
            expect(res.results[1].content).toBe('Snippet & 2');
            expect(res.query).toBe('');
        });

        it('handles empty response', () => {
            const res = parseGoogleResponse({});
            expect(res.results).toEqual([]);
            expect(res.query).toBe('');
        });

        it('uses corrected query from spelling', () => {
            const res = parseGoogleResponse({
                items: [],
                spelling: { correctedQuery: 'corrected' },
            });
            expect(res.query).toBe('corrected');
        });

        it('strips HTML from titles and snippets', () => {
            const res = parseGoogleResponse({
                items: [{ title: '<b>bold</b>', link: 'https://x.com', snippet: 'a &lt; b' }],
            });
            expect(res.results[0].title).toBe('bold');
            expect(res.results[0].content).toBe('a < b');
        });

        it('skips malformed items', () => {
            const res = parseGoogleResponse({
                items: [null, undefined, 'string', { title: 'Valid', link: 'https://v.com', snippet: 'ok' }],
            });
            expect(res.results).toHaveLength(1);
            expect(res.results[0].title).toBe('Valid');
        });

        it('handles missing optional fields gracefully', () => {
            const res = parseGoogleResponse({
                items: [{ link: 'https://x.com' }],
            });
            expect(res.results).toHaveLength(1);
            expect(res.results[0].title).toBe('');
            expect(res.results[0].content).toBe('');
            expect(res.results[0].score).toBe(0);
        });
    });

    describe('stripHtml', () => {
        it('removes HTML tags', () => {
            expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
        });

        it('decodes common named entities', () => {
            expect(stripHtml('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
            expect(stripHtml('&quot;hello&quot;')).toBe('"hello"');
            expect(stripHtml('it&#039;s &apos;fine&apos;')).toBe("it's 'fine'");
        });

        it('decodes typographic entities', () => {
            expect(stripHtml('word&mdash;word')).toBe('word—word');
            expect(stripHtml('word&ndash;word')).toBe('word–word');
            expect(stripHtml('&ldquo;quoted&rdquo;')).toBe('"quoted"');
            expect(stripHtml('&lsquo;single&rsquo;')).toBe("'single'");
            expect(stripHtml('wait&hellip;')).toBe('wait…');
            expect(stripHtml('non&nbsp;breaking')).toBe('non breaking');
        });

        it('decodes numeric character references', () => {
            expect(stripHtml('&#8364;')).toBe('€');
            expect(stripHtml('&#169;')).toBe('©');
        });

        it('decodes hex character references', () => {
            expect(stripHtml('&#x20AC;')).toBe('€');
            expect(stripHtml('&#xA9;')).toBe('©');
        });

        it('handles plain text unchanged', () => {
            expect(stripHtml('no entities here')).toBe('no entities here');
        });
    });
});

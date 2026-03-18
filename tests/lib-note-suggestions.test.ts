import { describe, it, expect } from 'vitest';
import {
    displayNameFromPath,
    buildWikilinkSuggestions,
    appendRelatedNotesSection,
    suggestTags,
    addFrontmatterTags,
    generateConflictSummary,
    enhanceNoteContent,
} from '../lib/note-suggestions';
import type { RelatedNote, WikilinkSuggestion } from '../lib/note-suggestions';

describe('lib/note-suggestions', () => {
    describe('displayNameFromPath', () => {
        it('extracts filename without extension', () => {
            expect(displayNameFromPath('Notes/my-note.md')).toBe('my-note');
        });

        it('handles root-level files', () => {
            expect(displayNameFromPath('readme.md')).toBe('readme');
        });

        it('handles paths without .md extension', () => {
            expect(displayNameFromPath('Notes/file.txt')).toBe('file.txt');
        });

        it('handles deeply nested paths', () => {
            expect(displayNameFromPath('a/b/c/deep-note.md')).toBe('deep-note');
        });
    });

    describe('buildWikilinkSuggestions', () => {
        const related: RelatedNote[] = [
            { path: 'Notes/note-a.md', score: 0.8 },
            { path: 'Notes/note-b.md', heading: 'Section', score: 0.6 },
            { path: 'Notes/note-c.md', score: 0.3 }, // below threshold
            { path: 'Notes/target.md', score: 0.9 }, // self-reference
        ];

        it('filters out self-references and low scores', () => {
            const result = buildWikilinkSuggestions(related, 'Notes/target.md');
            const paths = result.map(r => r.path);
            expect(paths).not.toContain('Notes/target.md');
            expect(paths).not.toContain('Notes/note-c.md');
            expect(paths).toContain('Notes/note-a.md');
            expect(paths).toContain('Notes/note-b.md');
        });

        it('generates valid wikilinks', () => {
            const result = buildWikilinkSuggestions(related, 'Notes/target.md');
            expect(result[0].wikilink).toBe('[[Notes/note-a|note-a]]');
        });

        it('respects custom minScore', () => {
            const result = buildWikilinkSuggestions(related, 'Notes/target.md', 0.7);
            expect(result).toHaveLength(1);
            expect(result[0].path).toBe('Notes/note-a.md');
        });

        it('respects maxResults', () => {
            const many: RelatedNote[] = Array.from({ length: 10 }, (_, i) => ({
                path: `Notes/note-${i}.md`,
                score: 0.9 - i * 0.01,
            }));
            const result = buildWikilinkSuggestions(many, 'other.md', 0.45, 3);
            expect(result).toHaveLength(3);
        });

        it('self-reference check is case-insensitive', () => {
            const result = buildWikilinkSuggestions(
                [{ path: 'Notes/Target.md', score: 0.9 }],
                'notes/target.md',
            );
            expect(result).toHaveLength(0);
        });

        it('returns empty for no qualifying notes', () => {
            const result = buildWikilinkSuggestions(
                [{ path: 'Notes/low.md', score: 0.1 }],
                'other.md',
            );
            expect(result).toEqual([]);
        });

        it('handles paths with special characters', () => {
            const result = buildWikilinkSuggestions(
                [{ path: 'Notes/[draft] my note.md', score: 0.8 }],
                'other.md',
            );
            expect(result[0].wikilink).toBe('[[Notes/[draft] my note|[draft] my note]]');
        });
    });

    describe('appendRelatedNotesSection', () => {
        it('appends section with links', () => {
            const links: WikilinkSuggestion[] = [
                { name: 'note-a', wikilink: '[[note-a]]', path: 'note-a.md', score: 0.8 },
            ];
            const result = appendRelatedNotesSection('# Title\n\nContent', links);
            expect(result).toContain('## Related Notes');
            expect(result).toContain('- [[note-a]]');
        });

        it('returns content unchanged when no links', () => {
            const content = '# Title\n\nContent';
            expect(appendRelatedNotesSection(content, [])).toBe(content);
        });

        it('includes separator', () => {
            const links: WikilinkSuggestion[] = [
                { name: 'x', wikilink: '[[x]]', path: 'x.md', score: 0.5 },
            ];
            const result = appendRelatedNotesSection('Content', links);
            expect(result).toContain('---');
        });
    });

    describe('suggestTags', () => {
        it('extracts frequent words as tags', () => {
            const content = 'JavaScript is great. JavaScript frameworks like React and Vue use JavaScript.';
            const tags = suggestTags(content);
            expect(tags).toContain('javascript');
        });

        it('boosts heading words', () => {
            const content = '# Machine Learning\n\nThis note is about coding patterns and best practices for software development.';
            const tags = suggestTags(content);
            expect(tags[0]).toBe('machine');
        });

        it('excludes stop words', () => {
            const content = 'The quick brown fox jumps over the lazy dog. The fox was very fast.';
            const tags = suggestTags(content);
            expect(tags).not.toContain('the');
            expect(tags).not.toContain('over');
        });

        it('excludes short words', () => {
            const content = 'Go is a language by Google. It has no classes.';
            const tags = suggestTags(content);
            expect(tags).not.toContain('go');
            expect(tags).not.toContain('is');
        });

        it('handles contractions without creating fragments', () => {
            const content = "Don't stop learning. It's important for everyone's growth. Don't give up.";
            const tags = suggestTags(content);
            // Should not contain single-char fragments like 't' or 's'
            for (const tag of tags) {
                expect(tag.length).toBeGreaterThanOrEqual(3);
            }
        });

        it('respects maxTags', () => {
            const content = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
            const tags = suggestTags(content, 3);
            expect(tags).toHaveLength(3);
        });

        it('returns empty for content without meaningful words', () => {
            const tags = suggestTags('the and or but');
            expect(tags).toEqual([]);
        });
    });

    describe('addFrontmatterTags', () => {
        it('adds new frontmatter block when none exists', () => {
            const result = addFrontmatterTags('# Title\n\nContent', ['tag1', 'tag2']);
            expect(result).toMatch(/^---\ntags: \[tag1, tag2\]\n---\n/);
            expect(result).toContain('# Title');
        });

        it('adds tags to existing frontmatter', () => {
            const content = '---\ntitle: My Note\n---\n\n# Title';
            const result = addFrontmatterTags(content, ['newtag']);
            expect(result).toContain('tags: [newtag]');
            expect(result).toContain('title: My Note');
        });

        it('merges with existing tags (inline format)', () => {
            const content = '---\ntags: [existing]\n---\n\n# Title';
            const result = addFrontmatterTags(content, ['newtag']);
            expect(result).toContain('existing');
            expect(result).toContain('newtag');
        });

        it('returns unchanged content when no tags', () => {
            const content = '# Title';
            expect(addFrontmatterTags(content, [])).toBe(content);
        });

        it('deduplicates tags', () => {
            const content = '---\ntags: [alpha]\n---\n\nContent';
            const result = addFrontmatterTags(content, ['alpha', 'beta']);
            // Count occurrences of 'alpha'
            const matches = result.match(/alpha/g);
            expect(matches?.length).toBe(1);
        });

        it('deduplicates case-insensitively', () => {
            const content = '---\ntags: [JavaScript]\n---\n\nContent';
            const result = addFrontmatterTags(content, ['javascript']);
            // Should keep original casing, not add lowercase dupe
            expect(result).toContain('JavaScript');
            expect(result).not.toMatch(/javascript,|, javascript/);
        });

        it('handles case-insensitive tags: key', () => {
            const content = '---\nTags: [existing]\n---\n\nContent';
            const result = addFrontmatterTags(content, ['newtag']);
            expect(result).toContain('existing');
            expect(result).toContain('newtag');
        });

        it('handles quoted tags', () => {
            const content = '---\ntags: ["tag-1", "tag-2"]\n---\n\nContent';
            const result = addFrontmatterTags(content, ['tag-3']);
            expect(result).toContain('tag-1');
            expect(result).toContain('tag-3');
        });
    });

    describe('generateConflictSummary', () => {
        it('returns null for identical content', () => {
            expect(generateConflictSummary('same', 'same')).toBeNull();
        });

        it('returns summary for different content', () => {
            const result = generateConflictSummary('old\ncontent', 'new\ncontent\nwith more');
            expect(result).toContain('Existing file:');
            expect(result).toContain('New content:');
            expect(result).toContain('Size change:');
        });

        it('shows positive size change for larger new content', () => {
            const result = generateConflictSummary('short', 'much longer content here');
            expect(result).toContain('+');
        });
    });

    describe('enhanceNoteContent', () => {
        const related: RelatedNote[] = [
            { path: 'Notes/related.md', score: 0.7 },
            { path: 'Notes/low.md', score: 0.2 },
        ];

        it('adds both tags and links by default', () => {
            const content = '# JavaScript Patterns\n\nJavaScript design patterns for web development.';
            const result = enhanceNoteContent(content, related, 'Notes/new.md');
            expect(result.suggestedTags.length).toBeGreaterThan(0);
            expect(result.addedLinks.length).toBeGreaterThan(0);
            expect(result.enhancedContent).toContain('tags:');
            expect(result.enhancedContent).toContain('Related Notes');
        });

        it('skips tags when autoTags is false', () => {
            const result = enhanceNoteContent('Content', related, 'x.md', { autoTags: false });
            expect(result.suggestedTags).toEqual([]);
            expect(result.enhancedContent).not.toContain('tags:');
        });

        it('skips links when autoLinks is false', () => {
            const result = enhanceNoteContent('Content', related, 'x.md', { autoLinks: false });
            expect(result.addedLinks).toEqual([]);
            expect(result.enhancedContent).not.toContain('Related Notes');
        });

        it('handles empty related notes', () => {
            const result = enhanceNoteContent('# Title\n\nSome content about topics.', [], 'x.md');
            expect(result.addedLinks).toEqual([]);
            expect(result.enhancedContent).not.toContain('Related Notes');
        });

        it('preserves original content when no enhancements apply', () => {
            const content = 'the and or but'; // only stop words
            const result = enhanceNoteContent(content, [], 'x.md');
            // No tags generated, no links — but frontmatter block won't be added for empty tags
            expect(result.suggestedTags).toEqual([]);
            expect(result.addedLinks).toEqual([]);
        });
    });
});

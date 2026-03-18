/**
 * Smart Note Creation — Pure logic, zero Obsidian dependency.
 *
 * Provides auto-wikilink suggestion, frontmatter tag generation,
 * and conflict diff generation for the create_note tool.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface RelatedNote {
    path: string;
    heading?: string;
    score: number;
}

export interface WikilinkSuggestion {
    /** Display name for the link (from filename or heading) */
    name: string;
    /** Full wikilink syntax, e.g. [[Notes/my-note|my-note]] */
    wikilink: string;
    /** Source path */
    path: string;
    /** Similarity score */
    score: number;
}

export interface SmartNoteEnhancements {
    /** Content with wikilinks appended as a "Related Notes" section */
    enhancedContent: string;
    /** Suggested frontmatter tags */
    suggestedTags: string[];
    /** Wikilinks that were added */
    addedLinks: WikilinkSuggestion[];
}

// ── Constants ───────────────────────────────────────────────────────

/** Minimum similarity score for a note to be considered related */
const MIN_RELATED_SCORE = 0.45;

/** Maximum number of related notes to suggest */
const MAX_RELATED_NOTES = 5;

/** Common stop words to exclude from tag generation */
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'this', 'that', 'these',
    'those', 'it', 'its', 'not', 'no', 'so', 'if', 'then', 'than',
    'as', 'about', 'up', 'out', 'into', 'over', 'after', 'before',
    'between', 'under', 'each', 'every', 'all', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'only', 'same', 'also', 'just',
    'because', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'new', 'one', 'two', 'any', 'many', 'well', 'very', 'much',
]);

// ── Wikilink Suggestions ────────────────────────────────────────────

/** Extract display name from a vault path (without extension). */
export function displayNameFromPath(path: string): string {
    const filename = path.split('/').pop() || path;
    return filename.replace(/\.md$/i, '');
}

/**
 * Build wikilink suggestions from related search results.
 * Filters out self-references and low-score matches.
 */
export function buildWikilinkSuggestions(
    relatedNotes: RelatedNote[],
    targetPath: string,
    minScore = MIN_RELATED_SCORE,
    maxResults = MAX_RELATED_NOTES,
): WikilinkSuggestion[] {
    const targetNorm = targetPath.toLowerCase().replace(/\.md$/i, '');

    return relatedNotes
        .filter(n => {
            const noteNorm = n.path.toLowerCase().replace(/\.md$/i, '');
            return noteNorm !== targetNorm && n.score >= minScore;
        })
        .slice(0, maxResults)
        .map(n => {
            const name = displayNameFromPath(n.path);
            // Obsidian wikilinks use path without .md extension
            const linkPath = n.path.replace(/\.md$/i, '');
            return {
                name,
                wikilink: `[[${linkPath}|${name}]]`,
                path: n.path,
                score: n.score,
            };
        });
}

/**
 * Append a "Related Notes" section with wikilinks to the note content.
 * Only appends if there are wikilinks to add.
 */
export function appendRelatedNotesSection(
    content: string,
    links: WikilinkSuggestion[],
): string {
    if (links.length === 0) return content;

    const section = [
        '',
        '---',
        '',
        '## Related Notes',
        '',
        ...links.map(l => `- ${l.wikilink}`),
        '',
    ].join('\n');

    return content.trimEnd() + '\n' + section;
}

// ── Tag Generation ──────────────────────────────────────────────────

/**
 * Extract potential tags from note content by analyzing headings and
 * frequently occurring meaningful words. Returns lowercase tags.
 */
export function suggestTags(content: string, maxTags = 5): string[] {
    // Extract headings
    const headings = (content.match(/^#{1,3}\s+(.+)$/gm) || [])
        .map(h => h.replace(/^#+\s+/, '').trim().toLowerCase());

    // Extract words from full content (preserve hyphens, strip apostrophes)
    const words = content
        .toLowerCase()
        .replace(/'/g, '')  // don't → dont, it's → its
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

    // Count word frequency
    const freq = new Map<string, number>();
    for (const word of words) {
        freq.set(word, (freq.get(word) || 0) + 1);
    }

    // Heading words get a boost
    for (const heading of headings) {
        const hwords = heading
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
        for (const w of hwords) {
            freq.set(w, (freq.get(w) || 0) + 3);
        }
    }

    // Sort by frequency, take top N
    return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxTags)
        .map(([word]) => word);
}

/**
 * Generate YAML frontmatter block with tags.
 * If content already has frontmatter, merges tags into it.
 */
export function addFrontmatterTags(content: string, tags: string[]): string {
    if (tags.length === 0) return content;

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);

    if (fmMatch) {
        // Parse existing frontmatter for tags (case-insensitive key)
        const fm = fmMatch[1];
        const existingTagMatch = fm.match(/^tags:\s*\[([^\]]*)\]/im)
            || fm.match(/^tags:\s*\n((?:\s+-\s+.+\n)*)/im);

        if (existingTagMatch) {
            // Tags already exist — merge without duplicates
            const existingRaw = existingTagMatch[1] || '';
            const existingTags = existingRaw
                .split(/[,\n]/)
                .map(t => t.replace(/^\s*-?\s*/, '').replace(/["']/g, '').trim())
                .filter(Boolean);
            // Case-insensitive dedup: keep first occurrence's casing
            const seen = new Set<string>();
            const merged: string[] = [];
            for (const t of [...existingTags, ...tags]) {
                const lower = t.toLowerCase();
                if (!seen.has(lower)) {
                    seen.add(lower);
                    merged.push(t);
                }
            }
            const tagLine = `tags: [${merged.join(', ')}]`;
            const newFm = fm.replace(/^tags:.*(?:\n(?:\s+-\s+.+)*)*/im, tagLine);
            return content.replace(fmMatch[0], `---\n${newFm}\n---\n`);
        } else {
            // Add tags line to existing frontmatter
            const tagLine = `tags: [${tags.join(', ')}]`;
            return content.replace(fmMatch[0], `---\n${fm}\n${tagLine}\n---\n`);
        }
    } else {
        // No frontmatter — add new block
        const tagLine = `tags: [${tags.join(', ')}]`;
        return `---\n${tagLine}\n---\n\n${content}`;
    }
}

// ── Conflict Diff ───────────────────────────────────────────────────

/**
 * Generate a simple unified diff summary for conflict detection.
 * Returns null if the content is identical.
 */
export function generateConflictSummary(
    existingContent: string,
    newContent: string,
): string | null {
    if (existingContent === newContent) return null;

    const existingLines = existingContent.split('\n').length;
    const newLines = newContent.split('\n').length;
    const existingSize = existingContent.length;
    const newSize = newContent.length;

    return [
        `Existing file: ${existingLines} lines, ${existingSize} chars`,
        `New content: ${newLines} lines, ${newSize} chars`,
        `Size change: ${newSize > existingSize ? '+' : ''}${newSize - existingSize} chars`,
    ].join('\n');
}

// ── Main Enhancement Function ───────────────────────────────────────

/**
 * Enhance note content with wikilinks and tags.
 * This is the main function called by the create_note executor.
 */
export function enhanceNoteContent(
    content: string,
    relatedNotes: RelatedNote[],
    targetPath: string,
    options?: {
        autoTags?: boolean;
        autoLinks?: boolean;
        maxTags?: number;
        minScore?: number;
    },
): SmartNoteEnhancements {
    const autoTags = options?.autoTags ?? true;
    const autoLinks = options?.autoLinks ?? true;

    let suggestedTags: string[] = [];
    let addedLinks: WikilinkSuggestion[] = [];
    let enhancedContent = content;

    // Generate tags
    if (autoTags) {
        suggestedTags = suggestTags(content, options?.maxTags);
        enhancedContent = addFrontmatterTags(enhancedContent, suggestedTags);
    }

    // Add related note links
    if (autoLinks) {
        addedLinks = buildWikilinkSuggestions(
            relatedNotes,
            targetPath,
            options?.minScore,
        );
        enhancedContent = appendRelatedNotesSection(enhancedContent, addedLinks);
    }

    return { enhancedContent, suggestedTags, addedLinks };
}

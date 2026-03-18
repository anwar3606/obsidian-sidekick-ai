// Zero Obsidian dependency — pure profile logic.
// Obsidian-specific I/O lives in src/profile.ts.

// ── Types ────────────────────────────────────────────────────────────

export type FactCategory =
    | 'preference'
    | 'knowledge_level'
    | 'interest'
    | 'identity'
    | 'communication'
    | 'workflow'
    | 'context'
    | 'personality'
    | 'custom';

export const FACT_CATEGORIES: FactCategory[] = [
    'preference', 'knowledge_level', 'interest', 'identity',
    'communication', 'workflow', 'context', 'personality', 'custom',
];

export interface ProfileFact {
    id: string;
    category: FactCategory;
    content: string;
    confidence: number;
    source: 'chat' | 'vault' | 'explicit';
    sourceId?: string;
    createdAt: number;
    lastReinforced: number;
    reinforceCount: number;
}

export interface UserProfile {
    version: 1;
    lastUpdated: number;
    facts: ProfileFact[];
}

// ── Helpers ──────────────────────────────────────────────────────────

let idCounter = 0;

/** Generate a unique fact ID. */
export function generateFactId(): string {
    return `f_${Date.now()}_${++idCounter}`;
}

/** Create a new empty profile. */
export function createEmptyProfile(): UserProfile {
    return { version: 1, lastUpdated: Date.now(), facts: [] };
}

/** Validate and migrate a loaded profile JSON. Returns a valid profile. */
export function parseProfile(raw: unknown): UserProfile {
    if (raw && typeof raw === 'object' && 'version' in raw && 'facts' in raw) {
        const p = raw as UserProfile;
        if (Array.isArray(p.facts)) {
            // Validate each fact has required fields
            const validFacts = p.facts.filter(f =>
                f && typeof f.id === 'string' && typeof f.content === 'string' &&
                typeof f.category === 'string' && typeof f.confidence === 'number',
            );
            return { version: 1, lastUpdated: p.lastUpdated || Date.now(), facts: validFacts };
        }
    }
    return createEmptyProfile();
}

// ── Fact management ──────────────────────────────────────────────────

/**
 * Normalize text for deduplication comparison.
 * Lowercases, strips punctuation, collapses whitespace.
 */
function normalizeForComparison(text: string): string {
    return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find an existing fact that is similar enough to be a duplicate.
 * Uses normalized substring matching — if one contains the other, it's a match.
 */
export function findSimilarFact(profile: UserProfile, content: string, category: FactCategory): ProfileFact | undefined {
    const norm = normalizeForComparison(content);
    if (!norm) return undefined;
    return profile.facts.find(f => {
        if (f.category !== category) return false;
        const existing = normalizeForComparison(f.content);
        return existing === norm || existing.includes(norm) || norm.includes(existing);
    });
}

/**
 * Reinforce an existing fact — bump its reinforceCount and confidence.
 */
export function reinforceFact(profile: UserProfile, factId: string): UserProfile {
    const now = Date.now();
    return {
        ...profile,
        lastUpdated: now,
        facts: profile.facts.map(f =>
            f.id === factId
                ? { ...f, lastReinforced: now, reinforceCount: f.reinforceCount + 1, confidence: Math.min(1, f.confidence + 0.05) }
                : f,
        ),
    };
}

/**
 * Add a new fact to the profile. If a similar fact already exists in the same
 * category, reinforces it instead of creating a duplicate.
 * Returns { profile, action } where action is 'added' | 'reinforced' | 'skipped'.
 */
export function addFact(
    profile: UserProfile,
    content: string,
    category: FactCategory = 'custom',
    source: ProfileFact['source'] = 'explicit',
    confidence = 0.9,
): UserProfile {
    const trimmed = content.trim();
    if (!trimmed) return profile;

    // Check for duplicate
    const existing = findSimilarFact(profile, trimmed, category);
    if (existing) {
        return reinforceFact(profile, existing.id);
    }

    const now = Date.now();
    const newFact: ProfileFact = {
        id: generateFactId(),
        category,
        content: trimmed,
        confidence: Math.max(0, Math.min(1, confidence)),
        source,
        createdAt: now,
        lastReinforced: now,
        reinforceCount: 1,
    };
    const updated: UserProfile = {
        ...profile,
        lastUpdated: now,
        facts: [...profile.facts, newFact],
    };

    // Prune if over limit
    return pruneProfile(updated);
}

/** Maximum number of facts to store. */
export const MAX_FACTS = 50;

/**
 * Prune the profile to stay under MAX_FACTS.
 * Removes the lowest-scoring facts (score = confidence × recency).
 */
export function pruneProfile(profile: UserProfile): UserProfile {
    if (profile.facts.length <= MAX_FACTS) return profile;

    // Score each fact: higher confidence + more recent + more reinforced = higher score
    const now = Date.now();
    const scored = profile.facts.map(f => {
        const ageHours = Math.max(1, (now - f.lastReinforced) / 3600000);
        const recencyScore = 1 / Math.log2(ageHours + 1); // decays logarithmically
        const score = f.confidence * 0.5 + recencyScore * 0.3 + Math.min(f.reinforceCount / 10, 1) * 0.2;
        return { fact: f, score };
    });
    scored.sort((a, b) => b.score - a.score);

    return {
        ...profile,
        lastUpdated: Date.now(),
        facts: scored.slice(0, MAX_FACTS).map(s => s.fact),
    };
}

/** Remove a fact by ID. Returns the updated profile. */
export function removeFact(profile: UserProfile, factId: string): UserProfile {
    return {
        ...profile,
        lastUpdated: Date.now(),
        facts: profile.facts.filter(f => f.id !== factId),
    };
}

/** Update a fact's content. Returns the updated profile. */
export function updateFact(profile: UserProfile, factId: string, newContent: string): UserProfile {
    return {
        ...profile,
        lastUpdated: Date.now(),
        facts: profile.facts.map(f =>
            f.id === factId ? { ...f, content: newContent.trim(), lastReinforced: Date.now() } : f,
        ),
    };
}

// ── Profile context injection ────────────────────────────────────────

/** Maximum tokens (estimated) of profile context to inject into system prompt. */
const MAX_PROFILE_TOKENS = 500;

/**
 * Build a profile context string to append to the system prompt.
 * Selects the most relevant and high-confidence facts, respecting a token budget.
 */
export function buildProfileContext(profile: UserProfile): string {
    if (!profile.facts.length) return '';

    // Sort by confidence (desc), then recency (desc)
    const sorted = [...profile.facts].sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return b.lastReinforced - a.lastReinforced;
    });

    // Build context lines, respecting token budget (~4 chars per token estimate)
    const lines: string[] = [];
    let estimatedTokens = 20; // header overhead
    for (const fact of sorted) {
        const line = `- [${fact.category}] ${fact.content}`;
        const lineTokens = Math.ceil(line.length / 4);
        if (estimatedTokens + lineTokens > MAX_PROFILE_TOKENS) break;
        lines.push(line);
        estimatedTokens += lineTokens;
    }

    if (!lines.length) return '';

    return `\n\n## About This User\nThe following facts were previously learned about the user. Use them to personalize your responses.\n${lines.join('\n')}`;
}

/**
 * Build learning instructions to append to the system prompt.
 * Tells the LLM to proactively learn about the user.
 */
export function buildLearningInstructions(): string {
    return `\n\n## User Profiling
You have a \`remember_user_fact\` tool. Use it to save notable facts about the user as you chat. Examples:
- Explicit statements: "I'm a backend developer" → save as identity
- Preferences: "I prefer concise answers" → save as preference/communication
- Knowledge signals: user asks advanced Kubernetes questions → save as knowledge_level
Do NOT save trivial, sensitive, or one-off facts. Only save things useful for personalizing future conversations. Save at most 1-2 facts per conversation — quality over quantity.`;
}

// ── Extraction prompt (Phase 2, but schema defined here) ─────────────

/** Categories the LLM can assign when extracting facts. */
export const EXTRACTION_CATEGORIES_PROMPT = FACT_CATEGORIES.map(c => `"${c}"`).join(', ');

/**
 * Build the extraction prompt for post-conversation fact extraction.
 * Returns the prompt string to send to the LLM.
 */
export function buildExtractionPrompt(conversationSummary: string): string {
    return `You are a user profiling system. Given a conversation between a user and an AI assistant, extract facts about the user that would help personalize future interactions.

Extract facts in these categories: ${EXTRACTION_CATEGORIES_PROMPT}

Rules:
- Only extract facts clearly supported by the conversation
- Use concise, third-person statements ("User prefers...", "User is...")
- Assign confidence 0.0-1.0 based on how clearly the fact was stated
- Explicit statements ("I am a developer") = high confidence (0.9+)
- Implied signals (asks many Python questions) = medium confidence (0.5-0.7)
- Do NOT infer sensitive information (health, finances, relationships)
- Return an empty array if no useful facts can be extracted

Output ONLY a JSON array of objects with keys: "category", "content", "confidence"
Example: [{"category": "preference", "content": "User prefers bullet-point formatting", "confidence": 0.85}]

Conversation:
${conversationSummary}`;
}

/**
 * Parse extraction results from LLM response.
 * Returns an array of partial facts (without id, timestamps, etc.)
 */
export function parseExtractionResults(
    llmResponse: string,
): Array<{ category: FactCategory; content: string; confidence: number }> {
    try {
        // Find JSON array in response (may have surrounding text)
        const match = llmResponse.match(/\[[\s\S]*\]/);
        if (!match) return [];
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item: unknown) => {
                if (!item || typeof item !== 'object') return false;
                const obj = item as Record<string, unknown>;
                return typeof obj.content === 'string' && typeof obj.confidence === 'number';
            })
            .map((item: Record<string, unknown>) => ({
                category: (FACT_CATEGORIES.includes(item.category as FactCategory)
                    ? item.category : 'custom') as FactCategory,
                content: String(item.content),
                confidence: Math.max(0, Math.min(1, item.confidence as number)),
            }));
    } catch {
        return [];
    }
}

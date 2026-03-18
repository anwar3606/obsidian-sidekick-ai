// Obsidian-specific profile manager.
// Re-exports pure logic from lib/profile.ts, adds Obsidian I/O.
export {
    type FactCategory,
    type ProfileFact,
    type UserProfile,
    FACT_CATEGORIES,
    createEmptyProfile,
    parseProfile,
    addFact,
    removeFact,
    updateFact,
    buildProfileContext,
    buildExtractionPrompt,
    parseExtractionResults,
    generateFactId,
} from '../lib/profile';

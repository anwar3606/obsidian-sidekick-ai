/**
 * Tool schemas and format conversion — zero Obsidian dependency.
 *
 * Defines tool schemas in Chat Completions format (the canonical format)
 * and provides converters for the Responses API flat format.
 */

import type { ChatCompletionTool, ResponsesApiTool, ApiSettings } from './types';

// ── Tool schemas (Chat Completions / OpenAI function-calling format) ──

export const TOOL_SCHEMAS: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'search_vault',
            description: 'Search for notes in the Obsidian vault. Uses BM25 ranking with multi-term matching. Searches titles, headings, tags, aliases, and content. Results are ranked by relevance with recency and link-graph boosting. Returns file paths, snippets, relevance scores, and matched fields.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search keyword or phrase' },
                    max_results: { type: 'integer', description: 'Max results to return (default 10, max 50)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_note',
            description: 'Read the content of a note by its file path. Supports partial reading with start_line/end_line (1-indexed). Returns content, total_lines count, and whether the content was truncated.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note file relative to the vault root (e.g. "Daily Notes/2024-01-01.md")' },
                    start_line: { type: 'integer', description: 'First line to read (1-indexed, inclusive). Omit to start from the beginning.' },
                    end_line: { type: 'integer', description: 'Last line to read (1-indexed, inclusive). Omit to read to the end.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_note',
            description: 'Create a NEW note. To modify existing files, use edit_note instead. If the file already exists and append is true, content is appended at the end. Never use create_note with append=false to overwrite existing notes. When smart_enhance is true (default), the note is automatically enhanced with frontmatter tags and a Related Notes section with wikilinks to similar vault notes (requires embeddings enabled).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path for the new note (e.g. "Notes/my-note.md")' },
                    content: { type: 'string', description: 'Markdown content for the note' },
                    append: { type: 'boolean', description: 'If true, append to existing file instead of overwriting (default: false)' },
                    smart_enhance: { type: 'boolean', description: 'If true (default), auto-add frontmatter tags and Related Notes wikilinks. Set false to skip enhancements.' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fetch_url',
            description: 'Fetch a URL and return its content. Returns status and body text (max 15,000 chars).',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Absolute URL to fetch' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Generate an image from a text prompt using OpenAI DALL-E. Returns the image URL. Use detailed, descriptive prompts.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Detailed description of the image to generate' },
                    size: { type: 'string', description: 'Image size: 1024x1024 (default), 1024x1536, or 1536x1024', enum: ['1024x1024', '1024x1536', '1536x1024'] },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ask_user',
            description: 'Ask the user a question to clarify requirements or request feedback. Use this to iterate on the current turn instead of guessing or ending the conversation when you are unsure.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'The question to ask the user' },
                },
                required: ['question'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ask_user_choice',
            description: 'Ask the user to select from a list of choices. Use this when you have multiple options and need the user to pick one before proceeding.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'The question to ask the user' },
                    choices: { type: 'array', items: { type: 'string' }, description: 'Array of string choices for the user to select from' },
                    allow_custom_answer: { type: 'boolean', description: 'Whether to allow the user to provide a custom answer instead of just the choices (default: false)' },
                },
                required: ['question', 'choices'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'view_image',
            description: 'View an image file from the vault. Reads the image and sends it for visual analysis. Supports PNG, JPG, GIF, WebP, SVG, and BMP. Use this when you need to see or describe an image referenced in a note. Max file size 10 MB.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the image file relative to the vault root (e.g. "attachments/photo.png")' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files and folders in a vault directory. Returns names, types (file/folder), and sizes. Use to explore the vault structure. Pass "/" or "" for the root directory.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path relative to the vault root (e.g. "Daily Notes", "attachments"). Use "/" or "" for root.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Search for a text pattern across notes in the vault. Returns matching lines with file paths, line numbers, and context. Case-insensitive. Use this for exact text search, code patterns, or finding specific content across notes. Optionally restrict to a folder.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text or pattern to search for (case-insensitive)' },
                    folder: { type: 'string', description: 'Optional folder to restrict search to (e.g. "Projects", "Daily Notes"). Only files inside this folder will be searched.' },
                    max_results: { type: 'integer', description: 'Max matching lines to return (default 20, max 100)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'open_note',
            description: 'Open a note in the Obsidian editor for the user to view or edit. Use after creating or modifying a note so the user can see the result. Opens in a new tab.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note file relative to the vault root (e.g. "Notes/my-note.md")' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_note',
            description: 'Edit an existing note. Supports two operations: "replace" finds and replaces text, "insert" inserts content at a specific line number (1-indexed). Use read_note first to see the current content.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note file relative to the vault root (e.g. "Notes/my-note.md")' },
                    operation: { type: 'string', description: 'Edit operation: "replace" or "insert"', enum: ['replace', 'insert'] },
                    search: { type: 'string', description: 'Text to find in the file (required for replace operation)' },
                    replace: { type: 'string', description: 'Replacement text (required for replace operation)' },
                    line_number: { type: 'integer', description: 'Line number to insert at, 1-indexed (required for insert operation). Content is inserted before this line.' },
                    content: { type: 'string', description: 'Content to insert (required for insert operation)' },
                },
                required: ['path', 'operation'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_note_outline',
            description: 'Get the outline (heading structure) of a markdown note. Returns each heading with its level and line number so you can understand the document structure before reading specific sections. Use this on large notes to decide which part to read.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note file relative to the vault root (e.g. "Notes/project.md")' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_note_section',
            description: 'Read a specific section of a markdown note by heading text. Returns the content from the matched heading until the next heading of the same or higher level. If multiple sections match, returns the first match. Use read_note_outline first to see available sections.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note file relative to the vault root (e.g. "Notes/project.md")' },
                    heading: { type: 'string', description: 'Heading text to find (case-insensitive, without the # prefix). E.g. "Architecture" matches "## Architecture".' },
                    include_children: { type: 'boolean', description: 'If true (default), includes all content until the next heading of the same or higher level. If false, stops at any child heading.' },
                },
                required: ['path', 'heading'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_backlinks',
            description: 'Find all notes that link TO a given note (inbound links / backlinks). Returns file paths, link text, and line numbers for each backlink. Use this to discover relationships and trace how ideas connect across your vault.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the target note (e.g. "Notes/my-note.md"). Notes linking to this file will be returned.' },
                    max_results: { type: 'integer', description: 'Max backlinks to return (default 20, max 100)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_note_metadata',
            description: 'Get structured metadata for a note without reading its full content. Returns frontmatter properties, tags (including inline), aliases, outgoing links, heading count, and word count. Use this to quickly understand a note before deciding to read it.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note file relative to the vault root (e.g. "Notes/my-note.md")' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_by_tag',
            description: 'Find all notes with a specific tag. Searches both frontmatter tags and inline #tags. Supports tag hierarchy matching (e.g. "project" matches #project, #project/active, #project/done).',
            parameters: {
                type: 'object',
                properties: {
                    tag: { type: 'string', description: 'Tag to search for (without # prefix). E.g. "project" to find all notes tagged #project or #project/subtag.' },
                    exact: { type: 'boolean', description: 'If true, only match the exact tag (not subtags). Default: false (matches subtags too).' },
                    max_results: { type: 'integer', description: 'Max results to return (default 50, max 200)' },
                },
                required: ['tag'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_recent_notes',
            description: 'List recently modified notes in the vault, sorted by modification time (newest first). Useful for understanding recent activity and finding notes you were working on.',
            parameters: {
                type: 'object',
                properties: {
                    max_results: { type: 'integer', description: 'Max results to return (default 10, max 50)' },
                    folder: { type: 'string', description: 'Optional folder to filter by (e.g. "Projects"). Only notes inside this folder will be returned.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_open_notes',
            description: 'List all notes currently open in Obsidian editor tabs. Returns file paths and which tab is active. Use this to understand what the user is currently working on.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'move_note',
            description: 'Move or rename a note in the vault. Obsidian automatically updates all wiki-links and backlinks pointing to this note. Use this for vault organization and cleanup.',
            parameters: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Current path of the note (e.g. "Inbox/draft.md")' },
                    to: { type: 'string', description: 'New path for the note (e.g. "Projects/my-project.md")' },
                },
                required: ['from', 'to'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_note',
            description: 'Delete a note by moving it to the trash. The file can be recovered from the trash if needed. Use with caution.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the note to delete (e.g. "Notes/old-note.md")' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'semantic_search_vault',
            description: 'Semantic search across the vault using AI embeddings. Finds notes by meaning rather than exact keywords. Best for conceptual queries like "notes about productivity systems" or "my thoughts on habit formation". Returns matching text chunks with file paths, headings, and similarity scores. Requires embeddings to be enabled in settings.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Natural language search query describing what you are looking for' },
                    max_results: { type: 'integer', description: 'Max results to return (default 10, max 30)' },
                    min_score: { type: 'number', description: 'Minimum similarity score between 0 and 1 (default 0.3)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the internet for current information. Returns relevant web results with titles, URLs, and content snippets. Use when you need up-to-date information, facts that may have changed, or topics not in the vault.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query — be specific and include key terms' },
                    max_results: { type: 'integer', description: 'Max results to return (default 5, max 10)' },
                    topic: { type: 'string', description: 'Search category: "general" (default) or "news" for current events. Only applies to Tavily provider.', enum: ['general', 'news'] },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delegate_to_agent',
            description: 'Delegate a subtask to a specialized sub-agent with role-restricted tools. The sub-agent runs independently and returns its result. Use for focused research, analysis, writing, or summarization tasks that can be done in isolation.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Clear, specific task description for the sub-agent' },
                    role: { type: 'string', description: 'Sub-agent role determining which tools it can use', enum: ['researcher', 'analyst', 'writer', 'summarizer'] },
                    context: { type: 'string', description: 'Optional context or background information to pass to the sub-agent' },
                },
                required: ['task', 'role'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'spawn_parallel_agents',
            description: 'Spawn up to 5 sub-agents in parallel for independent subtasks. Each agent has a role and task. Results are returned when all agents complete. More efficient than multiple delegate_to_agent calls for independent tasks.',
            parameters: {
                type: 'object',
                properties: {
                    agents: {
                        type: 'array',
                        description: 'Array of sub-agent definitions (max 5)',
                        items: {
                            type: 'object',
                            properties: {
                                task: { type: 'string', description: 'Task for this sub-agent' },
                                role: { type: 'string', description: 'Role for this sub-agent', enum: ['researcher', 'analyst', 'writer', 'summarizer'] },
                                context: { type: 'string', description: 'Optional context for this sub-agent' },
                            },
                            required: ['task', 'role'],
                        },
                    },
                },
                required: ['agents'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_reddit',
            description: 'Search Reddit for discussions, questions, and answers. Returns post titles, scores, comment counts, and content snippets. Great for finding community opinions, troubleshooting advice, and discussions on any topic.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query — be specific' },
                    subreddit: { type: 'string', description: 'Optional: limit search to a specific subreddit (e.g. "programming", "AskReddit")' },
                    max_results: { type: 'integer', description: 'Max results to return (default 5, max 20)' },
                    sort: { type: 'string', description: 'Sort order', enum: ['relevance', 'hot', 'new', 'top'] },
                    time_filter: { type: 'string', description: 'Time filter', enum: ['hour', 'day', 'week', 'month', 'year', 'all'] },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_reddit_post',
            description: 'Read a Reddit post and its top comments. Provide the full Reddit URL. Returns the post content, score, and top-level comments with their scores.',
            parameters: {
                type: 'object',
                properties: {
                    post_url: { type: 'string', description: 'Full Reddit post URL (e.g. https://www.reddit.com/r/...)' },
                    max_comments: { type: 'integer', description: 'Max comments to return (default 10, max 50)' },
                },
                required: ['post_url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'jira_search',
            description: 'Search Jira issues using JQL (Jira Query Language). Returns issue keys, summaries, statuses, assignees, and priorities. Use for finding tasks, bugs, stories, and project tracking.',
            parameters: {
                type: 'object',
                properties: {
                    jql: { type: 'string', description: 'JQL query (e.g. "project = PROJ AND status = Open", "assignee = currentUser() ORDER BY priority DESC")' },
                    max_results: { type: 'integer', description: 'Max results to return (default 10, max 50)' },
                },
                required: ['jql'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'jira_get_issue',
            description: 'Get detailed information about a specific Jira issue by its key (e.g. PROJ-123). Returns summary, description, status, assignee, priority, comments, and linked issues.',
            parameters: {
                type: 'object',
                properties: {
                    issue_key: { type: 'string', description: 'Jira issue key (e.g. "PROJ-123")' },
                },
                required: ['issue_key'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'jira_create_issue',
            description: 'Create a new Jira issue. Returns the created issue key and URL. Requires project key and summary at minimum.',
            parameters: {
                type: 'object',
                properties: {
                    project_key: { type: 'string', description: 'Project key (e.g. "PROJ")' },
                    summary: { type: 'string', description: 'Issue title/summary' },
                    description: { type: 'string', description: 'Issue description (plain text)' },
                    issue_type: { type: 'string', description: 'Issue type: Task, Bug, Story, Epic, Sub-task (default: Task)' },
                    priority: { type: 'string', description: 'Priority: Highest, High, Medium, Low, Lowest' },
                    assignee_id: { type: 'string', description: 'Assignee account ID (use jira_search to find)' },
                    labels: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
                },
                required: ['project_key', 'summary'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'jira_add_comment',
            description: 'Add a comment to a Jira issue. Use this to post updates, notes, or feedback on existing issues.',
            parameters: {
                type: 'object',
                properties: {
                    issue_key: { type: 'string', description: 'Jira issue key (e.g. "PROJ-123")' },
                    comment: { type: 'string', description: 'Comment text to add' },
                },
                required: ['issue_key', 'comment'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'jira_update_issue',
            description: 'Update fields on a Jira issue. Can change summary, description, priority, labels, or transition to a new status.',
            parameters: {
                type: 'object',
                properties: {
                    issue_key: { type: 'string', description: 'Jira issue key (e.g. "PROJ-123")' },
                    summary: { type: 'string', description: 'New summary/title' },
                    description: { type: 'string', description: 'New description (plain text)' },
                    priority: { type: 'string', description: 'New priority: Highest, High, Medium, Low, Lowest' },
                    labels: { type: 'array', items: { type: 'string' }, description: 'Replace labels with this list' },
                    status: { type: 'string', description: 'Transition to this status (e.g. "In Progress", "Done")' },
                    assignee_id: { type: 'string', description: 'New assignee account ID (use jira_search to find)' },
                },
                required: ['issue_key'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'remember_user_fact',
            description: 'Store a fact about the user for future personalization. Call this when the user says "remember that...", shares a personal preference, or reveals something about themselves they\'d want you to know in future conversations. Facts are stored locally and never shared.',
            parameters: {
                type: 'object',
                properties: {
                    fact: { type: 'string', description: 'The fact to remember about the user (e.g. "User prefers bullet points", "User is a senior frontend developer")' },
                    category: {
                        type: 'string',
                        enum: ['preference', 'knowledge_level', 'interest', 'identity', 'communication', 'workflow', 'context', 'personality', 'custom'],
                        description: 'Category of the fact (default: "custom")',
                    },
                },
                required: ['fact'],
            },
        },
    },
];

// ── Risk classification & labels ────────────────────────────────────

export const RISKY_TOOLS = new Set(['fetch_url', 'create_note', 'edit_note', 'generate_image', 'move_note', 'delete_note', 'web_search', 'delegate_to_agent', 'spawn_parallel_agents', 'search_reddit', 'read_reddit_post', 'jira_search', 'jira_get_issue', 'jira_create_issue', 'jira_add_comment', 'jira_update_issue']);

export const TOOL_LABELS: Record<string, string> = {
    search_vault: '🔍 Search Vault',
    read_note: '📖 Read Note',
    create_note: '📝 Create Note',
    fetch_url: '🌐 Fetch URL',
    generate_image: '🎨 Generate Image',
    ask_user: '🗣️ Ask User',
    ask_user_choice: '📋 Ask Choice',
    view_image: '🖼️ View Image',
    list_files: '📁 List Files',
    grep_search: '🔎 Grep Search',
    open_note: '📄 Open Note',
    edit_note: '✏️ Edit Note',
    read_note_outline: '🗂️ Note Outline',
    read_note_section: '📑 Read Section',
    get_backlinks: '🔗 Get Backlinks',
    get_note_metadata: '📊 Note Metadata',
    search_by_tag: '🏷️ Search by Tag',
    get_recent_notes: '🕐 Recent Notes',
    get_open_notes: '📂 Open Notes',
    move_note: '📦 Move Note',
    delete_note: '🗑️ Delete Note',
    semantic_search_vault: '🧠 Semantic Search',
    web_search: '🌐 Web Search',
    search_reddit: '📱 Reddit Search',
    read_reddit_post: '📱 Read Reddit Post',
    jira_search: '🎫 Jira Search',
    jira_get_issue: '🎫 Jira Issue',
    jira_create_issue: '🎫 Create Jira Issue',
    jira_add_comment: '💬 Jira Comment',
    jira_update_issue: '✏️ Update Jira Issue',
    remember_user_fact: '🧠 Remember Fact',
    delegate_to_agent: '🤖 Delegate to Agent',
    spawn_parallel_agents: '🤖 Spawn Parallel Agents',
};

// ── Format conversion ───────────────────────────────────────────────

/**
 * Convert Chat Completions nested tool schemas to Responses API flat format.
 *
 * Chat Completions: `{ type: 'function', function: { name, description, parameters } }`
 * Responses API:    `{ type: 'function', name, description, parameters }`
 */
export function toResponsesFormat(tools: ChatCompletionTool[]): ResponsesApiTool[] {
    return tools.map(t => ({
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
}

/**
 * Get the enabled tool schemas based on settings.
 * Includes dynamically discovered MCP tools from settings.mcpTools.
 * Returns Chat Completions format (nested).
 */
export function getEnabledTools(settings: ApiSettings): ChatCompletionTool[] | undefined {
    let enabled: ChatCompletionTool[] = [];

    if (settings.toolsEnabled) {
        const disabled = settings.disabledTools || [];
        enabled = TOOL_SCHEMAS.filter(t => !disabled.includes(t.function.name));
        // Remove web_search if not enabled (requires separate API key)
        if (!settings.webSearchEnabled) {
            enabled = enabled.filter(t => t.function.name !== 'web_search');
        }
        // Remove Reddit tools if not configured
        const REDDIT_TOOLS = ['search_reddit', 'read_reddit_post'];
        if (!settings.redditClientId || !settings.redditClientSecret) {
            enabled = enabled.filter(t => !REDDIT_TOOLS.includes(t.function.name));
        }
        // Remove Jira tools if not configured
        const JIRA_TOOLS = ['jira_search', 'jira_get_issue', 'jira_create_issue', 'jira_add_comment', 'jira_update_issue'];
        if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraApiToken) {
            enabled = enabled.filter(t => !JIRA_TOOLS.includes(t.function.name));
        }
        // Remove remember_user_fact if user profiling is disabled
        if (!settings.enableUserProfile) {
            enabled = enabled.filter(t => t.function.name !== 'remember_user_fact');
        }
        // Merge MCP tools (already in Chat Completions format)
        if (settings.mcpTools && settings.mcpTools.length > 0) {
            enabled.push(...settings.mcpTools.filter(t => !disabled.includes(t.function.name)));
        }
    }

    // Iterate Mode needs ask_user — force it on
    if (settings.iterateMode && !enabled.some(t => t.function.name === 'ask_user')) {
        const askUserSchema = TOOL_SCHEMAS.find(t => t.function.name === 'ask_user');
        if (askUserSchema) enabled.push(askUserSchema);
    }

    return enabled.length > 0 ? enabled : undefined;
}

/**
 * Get enabled tools in Responses API flat format.
 */
export function getEnabledToolsForResponses(settings: ApiSettings): ResponsesApiTool[] | undefined {
    const tools = getEnabledTools(settings);
    return tools ? toResponsesFormat(tools) : undefined;
}

// ── Markdown outline parsing (pure logic, no Obsidian deps) ─────────

export interface HeadingEntry {
    heading: string;
    level: number;
    line: number; // 1-indexed
}

/**
 * Parse markdown content and extract all headings with their levels and line numbers.
 * Only recognizes ATX headings (# style), not Setext (underline style).
 * Ignores headings inside fenced code blocks.
 */
export function parseMarkdownOutline(content: string): HeadingEntry[] {
    const lines = content.split('\n');
    const headings: HeadingEntry[] = [];
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```') || line.startsWith('~~~')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;

        const match = line.match(/^(#{1,6})\s+(.+)/);
        if (match) {
            headings.push({
                heading: match[2].trim(),
                level: match[1].length,
                line: i + 1, // 1-indexed
            });
        }
    }

    return headings;
}

/**
 * Extract a section from markdown content by heading text.
 * Returns the content from the matched heading to the next heading of the same or
 * higher level (or end of file). If includeChildren is false, stops at any heading.
 *
 * Returns null if no matching heading is found.
 */
export function extractMarkdownSection(
    content: string,
    heading: string,
    includeChildren = true,
): { content: string; startLine: number; endLine: number; heading: string; level: number } | null {
    const lines = content.split('\n');
    const headings = parseMarkdownOutline(content);

    // Find matching heading (case-insensitive)
    const target = heading.toLowerCase();
    const matchIdx = headings.findIndex(h => h.heading.toLowerCase() === target);
    if (matchIdx === -1) return null;

    const matched = headings[matchIdx];
    const startLine = matched.line; // 1-indexed

    // Find the end: next heading of same or higher level (lower number)
    let endLine = lines.length; // default: end of file
    for (let i = matchIdx + 1; i < headings.length; i++) {
        if (includeChildren) {
            // Stop at same or higher level (e.g. ## stops at ## or #)
            if (headings[i].level <= matched.level) {
                endLine = headings[i].line - 1;
                break;
            }
        } else {
            // Stop at any heading
            endLine = headings[i].line - 1;
            break;
        }
    }

    const sliced = lines.slice(startLine - 1, endLine).join('\n');
    return {
        content: sliced,
        startLine,
        endLine,
        heading: matched.heading,
        level: matched.level,
    };
}

# Sidekick — AI Assistant for Obsidian

A multi-provider AI chat assistant that lives in your Obsidian sidebar. It can search your vault, read and create notes, fetch URLs, generate images, and more — all through natural conversation.

## Features

- **Multi-provider** — OpenAI, OpenRouter, and GitHub Copilot
- **30 tools** — Vault search, note read/create, web fetch, image generation, Reddit, Jira, and more
- **Agent presets** — Code Expert, Writing Coach, Research Assistant, Socratic Tutor, and others
- **Inline autocomplete** — AI-powered ghost text suggestions as you type (Tab to accept)
- **Streaming** — Real-time responses with thinking/reasoning display
- **Custom slash commands** — Define your own `/commands` with custom system prompts
- **Chat persistence** — Conversations saved as markdown files in your vault
- **User profiling** — Learns your preferences over time for better responses
- **Auto-RAG** — Automatically finds relevant notes using embeddings
- **Cost tracking** — Token usage and cost display for OpenRouter

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/anwar3606/obsidian-sidekick-ai/releases/latest)
2. Create a folder `<your-vault>/.obsidian/plugins/sidekick/`
3. Copy the three files into that folder
4. Restart Obsidian → Settings → Community plugins → Enable "Sidekick"

### BRAT (Beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add `anwar3606/obsidian-sidekick-ai` as a beta plugin

## Setup

1. Open Settings → Sidekick
2. Choose a provider (OpenAI, OpenRouter, or GitHub Copilot)
3. Enter your API key
4. Click the chat icon in the ribbon or use the command palette → "Open Sidekick"

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show command list |
| `/note` | Add active note as context |
| `/selection` | Add selected text as context |
| `/regen` | Regenerate last response |
| `/clear` | Clear current chat |
| `/export` | Export chat to a note |
| `/new` | Start a new conversation |
| `/agent` | Switch agent preset |
| `/profile` | Show learned user profile |

## Tools

The AI can use these tools during conversation:

| Tool | Description |
|------|-------------|
| `search_vault` | Search notes by keyword |
| `read_note` | Read a note's content |
| `create_note` | Create or append to a note |
| `fetch_url` | Fetch any URL |
| `generate_image` | Generate images (DALL-E) |
| `search_reddit` | Search Reddit |
| `read_reddit_post` | Read Reddit post with comments |
| `jira_search` | Search Jira issues |
| `jira_get_issue` | Get Jira issue details |

...and 20+ more. The AI decides which tools to use based on your request.

## Development

Requires **Node.js >= 25** and [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm dev          # watch mode
pnpm build        # production build
pnpm test         # run tests
pnpm test:watch   # watch mode
```

## Architecture

The codebase is split into two layers:

- **`lib/`** — Pure logic with zero Obsidian dependencies (independently testable)
- **`src/`** — Obsidian UI layer that imports from `lib/`

## License

[MIT](LICENSE)

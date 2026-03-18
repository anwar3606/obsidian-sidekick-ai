import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type SidekickPlugin from './main';
import { PROVIDERS, PROVIDER_IDS, DEFAULT_SYSTEM_PROMPT, DEFAULT_AUTOCOMPLETE_SETTINGS, DEFAULT_SETTINGS, AUTOCOMPLETE_SYSTEM_PROMPT, ITERATE_FEEDBACK_INSTRUCTION, ITERATE_REPROMPT, DEFAULT_AUTO_TITLE_PROMPT, DEFAULT_FOLLOW_UP_PROMPT } from './constants';
import { fetchProviderModels, categorizeModels } from './providers';
import { resolveModelForProvider, OPENROUTER_IMAGE_GEN_MODELS, OPENAI_IMAGE_GEN_MODELS } from '../lib/providers';
import { TOOL_SCHEMAS, TOOL_LABELS } from './tools';
import { MAX_RETRIES, RETRY_DELAY_MS, MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_ITERATE, MAX_CONTENT_LENGTH, THINKING_BUDGET } from './api-helpers';
import { startDeviceFlow, pollForToken, copilotTokenManager } from './copilot-auth';
import { debugLog } from './debug-log';
import { getErrorMessage } from '../lib/utils';
import { MAX_EMBEDDING_BATCH_SIZE } from '../lib/embeddings';
import type { ModelInfo, CustomCommand, CopilotAccount } from './types';
import { clearMCPToolCache } from './mcp';
import { BUILT_IN_PRESETS, getPreset } from '../lib/agents';

/** Tab identifiers for the settings page. */
export type SettingsTab = 'provider' | 'chat' | 'tools' | 'imagegen' | 'mcp' | 'autocomplete' | 'commands' | 'appearance' | 'embeddings' | 'profile' | 'advanced' | 'updates';

/** Tab configuration: id → display label + icon. */
const TABS: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'provider',     label: 'Provider',     icon: '🔌' },
    { id: 'chat',         label: 'Chat',         icon: '💬' },
    { id: 'tools',        label: 'Tools',        icon: '🔧' },
    { id: 'imagegen',     label: 'Image Gen',    icon: '🎨' },
    { id: 'mcp',          label: 'MCP',          icon: '🔗' },
    { id: 'autocomplete', label: 'Autocomplete', icon: '✨' },
    { id: 'commands',     label: 'Commands',     icon: '⚡' },
    { id: 'appearance',   label: 'Appearance',   icon: '🎭' },
    { id: 'embeddings',  label: 'Embeddings',   icon: '🧠' },
    { id: 'profile',      label: 'Profile',      icon: '👤' },
    { id: 'advanced',     label: 'Advanced',     icon: '⚙️' },
    { id: 'updates',      label: 'Updates',      icon: '⬇️' },
];

/**
 * Settings tab — organized into 8 tabs with helper methods to reduce
 * the repetitive onChange → mutate → save pattern.
 */
export class SidekickSettingTab extends PluginSettingTab {
    plugin: SidekickPlugin;
    private fetchedModels: Record<string, ModelInfo[]> = {};
    private activeTab: SettingsTab = 'provider';

    constructor(app: App, plugin: SidekickPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // ── Setting helpers (DRY the onChange → save pattern) ────────────

    /** Create a setting and auto-save on change. */
    private addTextSetting(
        container: HTMLElement,
        name: string,
        desc: string,
        opts: {
            value: string;
            placeholder?: string;
            password?: boolean;
            onSave: (value: string) => void;
            fullWidth?: boolean;
        },
    ): Setting {
        return new Setting(container)
            .setName(name)
            .setDesc(desc)
            .addText(text => {
                if (opts.password) text.inputEl.type = 'password';
                if (opts.fullWidth) text.inputEl.style.width = '100%';
                text.setPlaceholder(opts.placeholder ?? '')
                    .setValue(opts.value)
                    .onChange(async (value) => {
                        opts.onSave(value);
                        await this.plugin.saveSettings();
                    });
            });
    }

    private addToggleSetting(
        container: HTMLElement,
        name: string,
        desc: string,
        value: boolean,
        onSave: (value: boolean) => void,
        refresh = false,
    ): Setting {
        return new Setting(container)
            .setName(name)
            .setDesc(desc)
            .addToggle(toggle => {
                toggle.setValue(value)
                    .onChange(async (v) => {
                        onSave(v);
                        await this.plugin.saveSettings();
                        if (refresh) this.display();
                    });
            });
    }

    // ── Main display ────────────────────────────────────────────────

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('sidekick-settings');

        const hero = containerEl.createDiv({ cls: 'sidekick-settings-hero' });
        hero.createEl('h2', { text: 'Sidekick Settings' });
        hero.createEl('p', {
            text: 'Tune provider behavior, chat UX, tools, and memory to match your workflow.',
            cls: 'sidekick-settings-hero-sub',
        });

        // ── Version badge ────────────────────────────────────────
        containerEl.createEl('div', {
            cls: 'sidekick-settings-version',
            text: `Sidekick v${this.plugin.manifest.version}`,
        });

        // ── Tab bar ──────────────────────────────────────────────
        const tabBar = containerEl.createDiv({ cls: 'sidekick-settings-tabs' });
        for (const tab of TABS) {
            const btn = tabBar.createEl('button', {
                cls: `sidekick-settings-tab${this.activeTab === tab.id ? ' is-active' : ''}`,
                text: `${tab.icon} ${tab.label}`,
            });
            btn.dataset.tab = tab.id;
            btn.addEventListener('click', () => {
                this.activeTab = tab.id;
                this.display();
            });
        }

        // ── Tab content ──────────────────────────────────────────
        const content = containerEl.createDiv({ cls: `sidekick-settings-content sidekick-settings-content-${this.activeTab}` });
        switch (this.activeTab) {
            case 'provider':     this.renderProviderTab(content); break;
            case 'chat':         this.renderChatTab(content); break;
            case 'tools':        this.renderToolsTab(content); break;
            case 'imagegen':     this.renderImageGenTab(content); break;
            case 'mcp':          this.renderMCPTab(content); break;
            case 'autocomplete': this.renderAutocompleteTab(content); break;
            case 'commands':     this.renderCommandsTab(content); break;
            case 'appearance':   this.renderAppearanceTab(content); break;
            case 'embeddings':  this.renderEmbeddingsTab(content); break;
            case 'profile':     this.renderProfileTab(content); break;
            case 'advanced':     this.renderAdvancedTab(content); break;
            case 'updates':      this.renderUpdatesTab(content); break;
        }
    }

    // ── Tab: Provider ─────────────────────────────────────────────

    private renderProviderTab(containerEl: HTMLElement): void {
        const s = this.plugin.settings;
        const pid = s.selectedProvider;
        const activeAccount = s.copilotAccounts.find(a => a.id === s.activeCopilotAccountId);
        const apiKey = pid === 'openai' ? s.openaiApiKey
            : pid === 'openrouter' ? s.openrouterApiKey
                : pid === 'copilot' ? (activeAccount?.oauthToken ?? s.copilotToken) : '';

        // ── Provider & Model ─────────────────────────────────────
        containerEl.createEl('h2', { text: 'Provider & Model' });

        new Setting(containerEl)
            .setName('Provider')
            .setDesc('Select the AI provider')
            .addDropdown(dd => {
                for (const id of PROVIDER_IDS) dd.addOption(id, PROVIDERS[id].label);
                dd.setValue(pid);
                dd.onChange(async (value) => {
                    s.selectedProvider = value;
                    s.selectedModel = resolveModelForProvider(value, s.selectedModel);
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        let models = this.fetchedModels[pid] || PROVIDERS[pid].fallbackModels;
        if (!this.fetchedModels[pid]) {
            fetchProviderModels(pid, apiKey).then(fetched => {
                this.fetchedModels[pid] = fetched;
                this.display();
            }).catch(err => { debugLog.log('settings', 'model-fetch-failed', { provider: pid, error: getErrorMessage(err) }); });
        }

        const grouped = categorizeModels(pid, models);

        new Setting(containerEl)
            .setName('Model')
            .setDesc(`${models.length} models available`)
            .addDropdown(dd => {
                for (const [category, catModels] of Object.entries(grouped)) {
                    for (const m of catModels) {
                        let label = `[${category}] ${m.label}`;
                        const caps: string[] = [];
                        if (m.supportsVision) caps.push('📷');
                        if (m.supportsThinking) caps.push('🧠');
                        if (m.supportsTools) caps.push('🔧');
                        if (m.supportsImageGen) caps.push('🎨');
                        if (caps.length) label += ` ${caps.join('')}`;
                        if (m.multiplier !== undefined) {
                            label += m.included ? ' ✅Included' : ` ${m.multiplier}×`;
                        }
                        dd.addOption(m.id, label);
                    }
                }
                dd.setValue(s.selectedModel);
                dd.onChange(async (value) => {
                    s.selectedModel = value;
                    await this.plugin.saveSettings();
                });
            });

        if (pid !== 'copilot') {
            new Setting(containerEl)
                .setName('Refresh models')
                .setDesc('Re-fetch the model list from the provider API')
                .addButton(btn => {
                    btn.setButtonText('Refresh')
                        .onClick(async () => {
                            btn.setButtonText('Loading...').setDisabled(true);
                            try {
                                this.fetchedModels[pid] = await fetchProviderModels(pid, apiKey);
                            } catch (err: unknown) {
                                debugLog.log('settings', 'Model fetch error', { error: String(err) });
                            }
                            this.display();
                        });
                });
        }

        // ── API Keys ─────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'API Keys' });

        this.addTextSetting(containerEl, 'OpenAI API Key', 'Your OpenAI API key (sk-...)', {
            value: s.openaiApiKey,
            placeholder: 'sk-...',
            password: true,
            fullWidth: true,
            onSave: (v) => { s.openaiApiKey = v.trim(); },
        });

        this.addTextSetting(containerEl, 'OpenRouter API Key', 'Your OpenRouter API key (sk-or-...)', {
            value: s.openrouterApiKey,
            placeholder: 'sk-or-...',
            password: true,
            fullWidth: true,
            onSave: (v) => { s.openrouterApiKey = v.trim(); },
        });

        // ── GitHub Copilot OAuth ─────────────────────────────────
        containerEl.createEl('h3', { text: 'GitHub Copilot' });

        const accounts = s.copilotAccounts;

        if (accounts.length > 0) {
            for (const account of accounts) {
                const isActive = account.id === s.activeCopilotAccountId;
                const setting = new Setting(containerEl)
                    .setName(account.label)
                    .setDesc(isActive ? '✅ Active' : '');

                if (!isActive) {
                    setting.addButton(btn => {
                        btn.setButtonText('Activate')
                            .onClick(async () => {
                                s.activeCopilotAccountId = account.id;
                                copilotTokenManager.setOAuthToken(account.oauthToken);
                                await this.plugin.saveSettings();
                                this.display();
                            });
                    });
                }

                setting.addText(text => {
                    text.setPlaceholder('Account label')
                        .setValue(account.label)
                        .onChange(async (value) => {
                            account.label = value.trim() || account.label;
                            await this.plugin.saveSettings();
                        });
                });

                setting.addButton(btn => {
                    btn.setButtonText('Remove')
                        .setWarning()
                        .onClick(async () => {
                            s.copilotAccounts = s.copilotAccounts.filter(a => a.id !== account.id);
                            if (isActive) {
                                if (s.copilotAccounts.length > 0) {
                                    s.activeCopilotAccountId = s.copilotAccounts[0].id;
                                    copilotTokenManager.setOAuthToken(s.copilotAccounts[0].oauthToken);
                                } else {
                                    s.activeCopilotAccountId = '';
                                    copilotTokenManager.clear();
                                }
                            }
                            await this.plugin.saveSettings();
                            new Notice(`Removed Copilot account: ${account.label}`);
                            this.display();
                        });
                });
            }
        } else {
            new Setting(containerEl)
                .setName('No accounts')
                .setDesc('Sign in with GitHub to add a Copilot account');
        }

        // Add Account button
        new Setting(containerEl)
            .setName('Add Account')
            .setDesc('Sign in with a GitHub account')
            .addButton(btn => {
                btn.setButtonText('Sign in with GitHub')
                    .setCta()
                    .onClick(async () => {
                        btn.setButtonText('Starting...').setDisabled(true);
                        try {
                            const flow = await startDeviceFlow();
                            await navigator.clipboard.writeText(flow.user_code);
                            btn.setButtonText(`Code: ${flow.user_code}`).setDisabled(true);
                            new Notice(
                                `Code copied: ${flow.user_code}\nPaste at ${flow.verification_uri}`,
                                30000,
                            );
                            window.open(flow.verification_uri);
                            const oauthToken = await pollForToken(flow.device_code, flow.interval);
                            const id = crypto.randomUUID();
                            const label = `Account ${s.copilotAccounts.length + 1}`;
                            s.copilotAccounts.push({ id, label, oauthToken });
                            if (s.copilotAccounts.length === 1) {
                                s.activeCopilotAccountId = id;
                            }
                            const activeAccount = s.copilotAccounts.find(a => a.id === s.activeCopilotAccountId);
                            if (activeAccount) {
                                copilotTokenManager.setOAuthToken(activeAccount.oauthToken);
                            }
                            await this.plugin.saveSettings();
                            new Notice(`Added Copilot account: ${label}`);
                            this.display();
                        } catch (err: unknown) {
                            debugLog.log('settings', 'Copilot auth error', { error: getErrorMessage(err) });
                            new Notice(`Sign in failed: ${getErrorMessage(err)}`);
                            this.display();
                        }
                    });
            });
    }

    // ── Tab: Chat ───────────────────────────────────────────────

    private renderChatTab(containerEl: HTMLElement): void {
        const s = this.plugin.settings;

        // ── System Prompt ────────────────────────────────────────
        containerEl.createEl('h2', { text: 'System Prompt' });

        new Setting(containerEl)
            .setName('System prompt')
            .setDesc('Custom instructions for the AI')
            .addTextArea(text => {
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('Enter system prompt...')
                    .setValue(s.systemPrompt)
                    .onChange(async (value) => {
                        s.systemPrompt = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Reset')
                    .onClick(async () => {
                        s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        // ── Iterate Mode Prompts ─────────────────────────────────
        containerEl.createEl('h2', { text: 'Iterate Mode Prompts' });

        new Setting(containerEl)
            .setName('Iterate instruction')
            .setDesc('Appended to the system prompt when iterate mode is active')
            .addTextArea(text => {
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('Iterate instruction...')
                    .setValue(s.iterateInstruction)
                    .onChange(async (value) => {
                        s.iterateInstruction = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Reset')
                    .onClick(async () => {
                        s.iterateInstruction = ITERATE_FEEDBACK_INSTRUCTION;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        new Setting(containerEl)
            .setName('Iterate reprompt')
            .setDesc('Sent when the model forgets to call ask_user in iterate mode')
            .addTextArea(text => {
                text.inputEl.rows = 2;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('Iterate reprompt...')
                    .setValue(s.iterateReprompt)
                    .onChange(async (value) => {
                        s.iterateReprompt = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Reset')
                    .onClick(async () => {
                        s.iterateReprompt = ITERATE_REPROMPT;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        // ── Auto-title & Follow-up Prompts ──────────────────────
        containerEl.createEl('h2', { text: 'Auto-title & Suggestions' });

        new Setting(containerEl)
            .setName('Auto-title prompt')
            .setDesc('Prompt used to generate conversation titles')
            .addTextArea(text => {
                text.inputEl.rows = 2;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('Auto-title prompt...')
                    .setValue(s.autoTitlePrompt)
                    .onChange(async (value) => {
                        s.autoTitlePrompt = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Reset')
                    .onClick(async () => {
                        s.autoTitlePrompt = DEFAULT_AUTO_TITLE_PROMPT;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        new Setting(containerEl)
            .setName('Follow-up suggestions prompt')
            .setDesc('Prompt used to generate follow-up question chips')
            .addTextArea(text => {
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('Follow-up prompt...')
                    .setValue(s.followUpSuggestionsPrompt)
                    .onChange(async (value) => {
                        s.followUpSuggestionsPrompt = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Reset')
                    .onClick(async () => {
                        s.followUpSuggestionsPrompt = DEFAULT_FOLLOW_UP_PROMPT;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        // ── Generation ─────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Generation' });

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc(`Current: ${s.temperature}`)
            .addSlider(slider => {
                slider.setLimits(0, 2, 0.05)
                    .setValue(s.temperature)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.temperature = value;
                        await this.plugin.saveSettings();
                    });
            });

        this.addToggleSetting(containerEl, 'Iterate mode',
            'Ask for explicit feedback after each response using ask_user tool calls.',
            s.iterateMode, (v) => { s.iterateMode = v; });

        this.addToggleSetting(containerEl, 'Follow-up suggestions',
            'Show quick follow-up question chips after assistant responses.',
            s.followUpSuggestions, (v) => { s.followUpSuggestions = v; });

        this.addToggleSetting(containerEl, 'Thinking mode',
            'Enable extended thinking/reasoning for supported models',
            s.thinkingEnabled, (v) => { s.thinkingEnabled = v; });

        this.addToggleSetting(containerEl, 'Auto-generate titles',
            'Use AI to generate descriptive conversation titles after the first exchange',
            s.autoTitle, (v) => { s.autoTitle = v; });

        // ── Storage ──────────────────────────────────────────────
        containerEl.createEl('h2', { text: 'Storage' });

        this.addTextSetting(containerEl, 'Chat folder',
            'Folder name where chat conversations are stored as .md files', {
            value: s.chatFolder,
            placeholder: 'copilot/conversations',
            onSave: (v) => { s.chatFolder = v.trim() || 'copilot/conversations'; },
        });
    }

    // ── Tab: Tools ──────────────────────────────────────────────

    private renderToolsTab(containerEl: HTMLElement): void {
        const s = this.plugin.settings;

        containerEl.createEl('h2', { text: 'Tool Calling' });

        this.addToggleSetting(containerEl, 'Tool calling',
            'Allow the AI to use tools (search vault, read/create notes, fetch URLs, generate images)',
            s.toolsEnabled, (v) => { s.toolsEnabled = v; }, true);

        if (s.toolsEnabled) {
            containerEl.createEl('h3', { text: 'Individual Tools' });
            this.renderToolToggles(containerEl);

            containerEl.createEl('h3', { text: 'Web Search' });
            this.addToggleSetting(containerEl, 'Enable web search',
                'Let the AI search the internet for current information (requires an API key below)',
                s.webSearchEnabled, (v) => { s.webSearchEnabled = v; }, true);

            if (s.webSearchEnabled) {
                new Setting(containerEl)
                    .setName('Search provider')
                    .setDesc('Which web search API to use')
                    .addDropdown(dd => {
                        dd.addOption('tavily', 'Tavily (recommended)');
                        dd.addOption('brave', 'Brave Search');
                        dd.addOption('google', 'Google Custom Search');
                        dd.setValue(s.webSearchProvider);
                        dd.onChange(async (v) => {
                            s.webSearchProvider = v as 'tavily' | 'brave' | 'google';
                            await this.plugin.saveSettings();
                            this.display();
                        });
                    });

                new Setting(containerEl)
                    .setName('API key')
                    .setDesc(s.webSearchProvider === 'tavily'
                        ? 'Get a free key at tavily.com (1,000 searches/month)'
                        : s.webSearchProvider === 'brave'
                        ? 'Get a key at brave.com/search/api'
                        : 'Get a key from Google Cloud Console (Custom Search JSON API)')
                    .addText(txt => {
                        txt.inputEl.type = 'password';
                        txt.setPlaceholder('Enter API key…')
                            .setValue(s.webSearchApiKey)
                            .onChange(async (v) => {
                                s.webSearchApiKey = v.trim();
                                await this.plugin.saveSettings();
                            });
                    });

                if (s.webSearchProvider === 'google') {
                    new Setting(containerEl)
                        .setName('Search Engine ID (cx)')
                        .setDesc('Create a Programmable Search Engine at programmablesearchengine.google.com and copy the cx ID')
                        .addText(txt => {
                            txt.setPlaceholder('Enter cx ID…')
                                .setValue(s.googleSearchCxId)
                                .onChange(async (v) => {
                                    s.googleSearchCxId = v.trim();
                                    await this.plugin.saveSettings();
                                });
                        });
                }
            }

            containerEl.createEl('h3', { text: 'Reddit' });
            containerEl.createEl('p', {
                text: 'Search Reddit discussions and read posts. Free API — go to reddit.com/prefs/apps, click "create an app", select "script" type, and copy the Client ID (under the app name) and Secret.',
                cls: 'setting-item-description',
            });

            new Setting(containerEl)
                .setName('Client ID')
                .setDesc('The short alphanumeric string under your Reddit app name')
                .addText(txt => {
                    txt.setPlaceholder('Enter Reddit Client ID…')
                        .setValue(s.redditClientId)
                        .onChange(async (v) => {
                            s.redditClientId = v.trim();
                            await this.plugin.saveSettings();
                        });
                });

            new Setting(containerEl)
                .setName('Client secret')
                .setDesc('The secret string from your Reddit app')
                .addText(txt => {
                    txt.inputEl.type = 'password';
                    txt.setPlaceholder('Enter Reddit Client Secret…')
                        .setValue(s.redditClientSecret)
                        .onChange(async (v) => {
                            s.redditClientSecret = v.trim();
                            await this.plugin.saveSettings();
                        });
                });

            containerEl.createEl('h3', { text: 'Jira' });
            containerEl.createEl('p', {
                text: 'Search and read Jira issues. Get an API token from id.atlassian.com/manage-profile/security/api-tokens',
                cls: 'setting-item-description',
            });

            new Setting(containerEl)
                .setName('Base URL')
                .setDesc('Your Jira instance URL (e.g. https://yourorg.atlassian.net)')
                .addText(txt => {
                    txt.setPlaceholder('https://yourorg.atlassian.net')
                        .setValue(s.jiraBaseUrl)
                        .onChange(async (v) => {
                            s.jiraBaseUrl = v.trim();
                            await this.plugin.saveSettings();
                        });
                });

            new Setting(containerEl)
                .setName('Email')
                .setDesc('Your Atlassian account email')
                .addText(txt => {
                    txt.setPlaceholder('you@company.com')
                        .setValue(s.jiraEmail)
                        .onChange(async (v) => {
                            s.jiraEmail = v.trim();
                            await this.plugin.saveSettings();
                        });
                });

            new Setting(containerEl)
                .setName('API Token')
                .setDesc('Generate at id.atlassian.com → Security → API tokens')
                .addText(txt => {
                    txt.inputEl.type = 'password';
                    txt.setPlaceholder('Enter Jira API token…')
                        .setValue(s.jiraApiToken)
                        .onChange(async (v) => {
                            s.jiraApiToken = v.trim();
                            await this.plugin.saveSettings();
                        });
                });
        }
    }

    private renderToolToggles(containerEl: HTMLElement): void {
        const disabled = this.plugin.settings.disabledTools || [];

        for (const schema of TOOL_SCHEMAS) {
            const toolName = schema.function.name;
            const toolLabel = TOOL_LABELS[toolName] || toolName;

            this.addToggleSetting(containerEl, toolLabel, schema.function.description,
                !disabled.includes(toolName),
                (v) => {
                    if (v) {
                        this.plugin.settings.disabledTools =
                            this.plugin.settings.disabledTools.filter(t => t !== toolName);
                    } else if (!this.plugin.settings.disabledTools.includes(toolName)) {
                        this.plugin.settings.disabledTools.push(toolName);
                    }
                });
        }
    }

    // ── Tab: Image Gen ────────────────────────────────────────────

    private renderImageGenTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Image Generation' });
        const s = this.plugin.settings;

        // ── Provider ────────────────────────────────────────────────
        new Setting(containerEl)
            .setName('Provider')
            .setDesc('Which provider to use for image generation (independent of chat)')
            .addDropdown(dd => {
                dd.addOption('same', 'Same as chat');
                dd.addOption('openai', 'OpenAI');
                dd.addOption('openrouter', 'OpenRouter');
                dd.setValue(s.imageGenProvider);
                dd.onChange(async (v) => {
                    s.imageGenProvider = v as 'same' | 'openai' | 'openrouter';
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        // ── Model (text field + preset buttons) ─────────────────────
        const effectiveProvider = s.imageGenProvider === 'same' ? s.selectedProvider : s.imageGenProvider;
        const presets = effectiveProvider === 'openrouter'
            ? OPENROUTER_IMAGE_GEN_MODELS
            : OPENAI_IMAGE_GEN_MODELS;

        const modelSetting = new Setting(containerEl)
            .setName('Model')
            .setDesc('Image generation model ID')
            .addText(text => {
                text.setPlaceholder('dall-e-3')
                    .setValue(s.imageGenModel)
                    .onChange(async (v) => {
                        s.imageGenModel = v || 'dall-e-3';
                        await this.plugin.saveSettings();
                    });
                text.inputEl.addClass('sidekick-settings-model-input');
            });

        // Add preset buttons below the model input
        const presetRow = modelSetting.controlEl.createDiv({ cls: 'sidekick-img-presets' });
        for (const preset of presets) {
            const btn = presetRow.createEl('button', {
                text: preset.label,
                cls: 'sidekick-img-preset-btn',
            });
            if (preset.id === s.imageGenModel) btn.addClass('sidekick-img-preset-active');
            btn.addEventListener('click', async () => {
                s.imageGenModel = preset.id;
                await this.plugin.saveSettings();
                this.display();
            });
        }

        // ── Size (OpenAI only) ──────────────────────────────────────
        if (effectiveProvider !== 'openrouter') {
            new Setting(containerEl)
                .setName('Default size')
                .setDesc('Default image dimensions')
                .addDropdown(dd => {
                    dd.addOption('1024x1024', '1024\u00d71024');
                    dd.addOption('1024x1792', '1024\u00d71792 (portrait)');
                    dd.addOption('1792x1024', '1792\u00d71024 (landscape)');
                    dd.addOption('256x256', '256\u00d7256');
                    dd.addOption('512x512', '512\u00d7512');
                    dd.setValue(s.imageGenSize);
                    dd.onChange(async (v) => {
                        s.imageGenSize = v;
                        await this.plugin.saveSettings();
                    });
                });

            new Setting(containerEl)
                .setName('Quality')
                .setDesc('Image quality level')
                .addDropdown(dd => {
                    dd.addOption('standard', 'Standard');
                    dd.addOption('hd', 'HD');
                    dd.setValue(s.imageGenQuality);
                    dd.onChange(async (v) => {
                        s.imageGenQuality = v;
                        await this.plugin.saveSettings();
                    });
                });
        }

        // ── Aspect Ratio (OpenRouter only) ──────────────────────────
        if (effectiveProvider === 'openrouter') {
            new Setting(containerEl)
                .setName('Aspect ratio')
                .setDesc('Image aspect ratio (OpenRouter image_config)')
                .addDropdown(dd => {
                    dd.addOption('1:1', '1:1 (1024\u00d71024)');
                    dd.addOption('2:3', '2:3 (832\u00d71248)');
                    dd.addOption('3:2', '3:2 (1248\u00d7832)');
                    dd.addOption('3:4', '3:4 (864\u00d71184)');
                    dd.addOption('4:3', '4:3 (1184\u00d7864)');
                    dd.addOption('4:5', '4:5 (896\u00d71152)');
                    dd.addOption('5:4', '5:4 (1152\u00d7896)');
                    dd.addOption('9:16', '9:16 (768\u00d71344)');
                    dd.addOption('16:9', '16:9 (1344\u00d7768)');
                    dd.addOption('21:9', '21:9 (1536\u00d7672)');
                    dd.setValue(s.imageGenAspectRatio || '1:1');
                    dd.onChange(async (v) => {
                        s.imageGenAspectRatio = v;
                        await this.plugin.saveSettings();
                    });
                });
        }
    }

    // ── Tab: MCP Servers ────────────────────────────────────────

    private renderMCPTab(containerEl: HTMLElement): void {
        const s = this.plugin.settings;

        containerEl.createEl('h2', { text: 'MCP Servers' });
        containerEl.createEl('p', {
            text: 'Connect to external MCP (Model Context Protocol) servers to add tools from any compatible service.',
            cls: 'setting-item-description',
        });

        // List existing servers
        if (s.mcpServers.length > 0) {
            containerEl.createEl('h3', { text: 'Configured Servers' });
            for (let i = 0; i < s.mcpServers.length; i++) {
                const server = s.mcpServers[i];
                new Setting(containerEl)
                    .setName(server.name || `Server ${i + 1}`)
                    .setDesc(server.url)
                    .addToggle(t => {
                        t.setValue(server.enabled);
                        t.onChange(async (v) => {
                            server.enabled = v;
                            clearMCPToolCache(server.id);
                            await this.plugin.saveSettings();
                        });
                    })
                    .addExtraButton(btn => {
                        btn.setIcon('trash')
                            .setTooltip('Remove server')
                            .onClick(async () => {
                                clearMCPToolCache(server.id);
                                s.mcpServers.splice(i, 1);
                                await this.plugin.saveSettings();
                                this.display();
                            });
                    });
            }
        }

        // Add new server form
        containerEl.createEl('h3', { text: 'Add Server' });

        let newName = '';
        let newUrl = '';
        let newApiKey = '';

        new Setting(containerEl)
            .setName('Server name')
            .setDesc('A label for this server (e.g. "GitHub Tools")')
            .addText(txt => {
                txt.setPlaceholder('My MCP Server')
                    .onChange(v => { newName = v.trim(); });
            });

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('The MCP server endpoint (must be HTTPS for remote servers)')
            .addText(txt => {
                txt.setPlaceholder('https://mcp.example.com')
                    .onChange(v => { newUrl = v.trim(); });
            });

        new Setting(containerEl)
            .setName('API key (optional)')
            .setDesc('Authentication key for the MCP server')
            .addText(txt => {
                txt.inputEl.type = 'password';
                txt.setPlaceholder('Enter API key…')
                    .onChange(v => { newApiKey = v.trim(); });
            });

        new Setting(containerEl)
            .addButton(btn => {
                btn.setButtonText('Add Server')
                    .setCta()
                    .onClick(async () => {
                        if (!newName || !newUrl) {
                            new Notice('Server name and URL are required.');
                            return;
                        }
                        // Basic URL validation
                        try { new URL(newUrl); } catch {
                            new Notice('Invalid URL format.');
                            return;
                        }
                        // Warn about non-HTTPS URLs for remote servers
                        if (!newUrl.startsWith('https://') && !newUrl.startsWith('http://localhost') && !newUrl.startsWith('http://127.0.0.1')) {
                            new Notice('Warning: Non-HTTPS URLs are insecure for remote servers.');
                        }
                        const id = newName.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                        s.mcpServers.push({
                            id,
                            name: newName,
                            url: newUrl,
                            apiKey: newApiKey,
                            enabled: true,
                        });
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        // Cache TTL
        containerEl.createEl('h3', { text: 'Advanced' });
        new Setting(containerEl)
            .setName('Tool cache TTL')
            .setDesc('How long to cache discovered tools (in seconds). Set to 0 to always refresh.')
            .addText(txt => {
                txt.setValue(String(s.mcpCacheTTL))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (!isNaN(n) && n >= 0) {
                            s.mcpCacheTTL = n;
                            await this.plugin.saveSettings();
                        }
                    });
            });
    }

    // ── Tab: Autocomplete ───────────────────────────────────────

    private renderAutocompleteTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Auto-Completion' });
        const s = this.plugin.settings;

        if (!s.autocomplete) {
            s.autocomplete = { ...DEFAULT_AUTOCOMPLETE_SETTINGS };
        }
        const ac = s.autocomplete;

        this.addToggleSetting(
            containerEl,
            'Enable auto-completion',
            'Show AI-powered inline text suggestions as you type. Uses a separate model from chat. Disabled by default to avoid unexpected API costs.',
            ac.enabled,
            (v) => { ac.enabled = v; },
            true,
        );

        if (!ac.enabled) return;

        new Setting(containerEl)
            .setName('Completion provider')
            .setDesc('API provider for auto-completion (uses your existing API keys)')
            .addDropdown(dd => {
                for (const id of PROVIDER_IDS) dd.addOption(id, PROVIDERS[id].label);
                dd.setValue(ac.provider);
                dd.onChange(async (value) => {
                    ac.provider = value;
                    await this.plugin.saveSettings();
                });
            });

        this.addTextSetting(
            containerEl,
            'Completion model',
            'Model ID for completions. Recommended: gpt-4o-mini, gpt-4.1-nano, google/gemini-flash-1.5 (via OpenRouter)',
            {
                value: ac.model,
                placeholder: 'gpt-4o-mini',
                onSave: (v) => { ac.model = v.trim() || 'gpt-4o-mini'; },
            },
        );

        new Setting(containerEl)
            .setName('Trigger mode')
            .setDesc('Auto: suggestions appear as you type (you can still trigger manually). Manual: only via Alt+\\ hotkey or command palette.')
            .addDropdown(dd => {
                dd.addOption('auto', 'Automatic');
                dd.addOption('manual', 'Manual (hotkey)');
                dd.setValue(ac.triggerMode);
                dd.onChange(async (value) => {
                    ac.triggerMode = value as 'auto' | 'manual';
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Trigger delay')
            .setDesc(`Wait ${ac.debounceMs}ms after typing before requesting a suggestion`)
            .addSlider(slider => {
                slider.setLimits(200, 2000, 100)
                    .setValue(ac.debounceMs)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        ac.debounceMs = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Max completion length')
            .setDesc(`Generate up to ${ac.maxTokens} tokens per suggestion`)
            .addSlider(slider => {
                slider.setLimits(16, 256, 8)
                    .setValue(ac.maxTokens)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        ac.maxTokens = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc(`Creativity: ${ac.temperature} (lower = more predictable)`)
            .addSlider(slider => {
                slider.setLimits(0, 1, 0.05)
                    .setValue(ac.temperature)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        ac.temperature = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Accept key')
            .setDesc('Key to accept a suggestion')
            .addDropdown(dd => {
                dd.addOption('Tab', 'Tab');
                dd.addOption('Enter', 'Enter');
                dd.setValue(ac.acceptKey);
                dd.onChange(async (value) => {
                    ac.acceptKey = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('System prompt')
            .setDesc('System prompt for autocomplete suggestions')
            .addTextArea(text => {
                text.inputEl.rows = 6;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('Autocomplete system prompt...')
                    .setValue(ac.systemPrompt)
                    .onChange(async (value) => {
                        ac.systemPrompt = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('Reset')
                    .onClick(async () => {
                        ac.systemPrompt = AUTOCOMPLETE_SYSTEM_PROMPT;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        containerEl.createEl('p', {
            text: 'Suggestions use your existing API key for the selected provider.',
            cls: 'setting-item-description',
        });
    }

    // ── Tab: Commands ───────────────────────────────────────────

    private renderCommandsTab(containerEl: HTMLElement): void {
        const s = this.plugin.settings;

        // ── Custom Slash Commands ────────────────────────────────
        containerEl.createEl('h2', { text: 'Custom Slash Commands' });
        containerEl.createEl('p', {
            text: 'Create custom /commands that override the system prompt. Type "/command <message>" in chat to use.',
            cls: 'setting-item-description',
        });

        const cmds = s.customCommands || [];
        for (const cmd of cmds) {
            new Setting(containerEl)
                .setName(`/${cmd.name}`)
                .setDesc(cmd.description || (cmd.systemPrompt.length > 60 ? cmd.systemPrompt.substring(0, 60) + '…' : cmd.systemPrompt))
                .addButton(btn => btn.setButtonText('Edit').onClick(() => this.editCommand(cmd)))
                .addButton(btn => {
                    btn.setButtonText('Delete')
                        .setWarning()
                        .onClick(async () => {
                            s.customCommands = s.customCommands.filter(c => c.id !== cmd.id);
                            await this.plugin.saveSettings();
                            this.display();
                        });
                });
        }

        new Setting(containerEl)
            .addButton(btn => btn.setButtonText('+ Add Command').setCta().onClick(() => this.editCommand(null)));

        // ── Note-based Prompts ───────────────────────────────────
        containerEl.createEl('h2', { text: 'Note-based Prompts' });

        this.addTextSetting(containerEl, 'Custom prompts folder',
            'Folder containing .md files for custom slash commands. Each file = one /command. Filename = command name.', {
            value: s.customPromptsFolder,
            placeholder: 'copilot/custom-prompts',
            onSave: (v) => { s.customPromptsFolder = v.trim() || 'copilot/custom-prompts'; },
        });

        const notePrompts = this.plugin.promptManager?.getCommands() || [];
        containerEl.createEl('p', {
            text: notePrompts.length > 0
                ? `${notePrompts.length} note-based command(s) loaded: ${notePrompts.map(c => '/' + c.name).join(', ')}`
                : 'No note-based commands found. Create .md files in the prompts folder to add commands.',
            cls: 'setting-item-description',
        });

        this.renderTemplateSyntaxHelp(containerEl);
    }

    // ── Tab: Appearance ─────────────────────────────────────────

    private renderAppearanceTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Typography' });
        const s = this.plugin.settings;

        this.addToggleSetting(containerEl, 'Custom typography',
            'Override Obsidian\'s font size and line height for the chat view. When disabled, global Obsidian settings are used.',
            s.customTypography, (v) => { s.customTypography = v; }, true);

        if (s.customTypography) {
            this.addTextSetting(containerEl, 'Font size (rem)',
                'Custom font size for the chat view', {
                value: String(s.fontSize),
                onSave: (v) => { const p = parseFloat(v); s.fontSize = (isNaN(p) || p < 0.5 || p > 3.0) ? 1.0 : p; },
            });

            this.addTextSetting(containerEl, 'Line height',
                'Custom line height for the chat view', {
                value: String(s.lineHeight),
                onSave: (v) => { const p = parseFloat(v); s.lineHeight = (isNaN(p) || p < 1.0 || p > 3.0) ? 1.6 : p; },
            });
        }

        this.addToggleSetting(containerEl, 'Compact mode',
            'Reduce padding and spacing for a denser layout — fits more content on screen.',
            s.compactMode, (v) => { s.compactMode = v; }, true);
    }

    // ── Tab: Embeddings ─────────────────────────────────────────

    private renderEmbeddingsTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Embeddings & Vector Search' });
        containerEl.createEl('p', {
            text: 'Use AI embeddings to enable semantic search across your vault. Finds notes by meaning rather than exact keywords. Requires GitHub Copilot (included with Pro).',
            cls: 'setting-item-description',
        });
        const s = this.plugin.settings;

        // ── Enable toggle ────────────────────────────────────────
        this.addToggleSetting(containerEl, 'Enable vector search',
            'When enabled, your vault will be indexed in the background using AI embeddings. The LLM can then use semantic search to find relevant notes by meaning.',
            s.embeddingsEnabled, async (v) => {
                s.embeddingsEnabled = v;
                this.plugin.vaultIndexer.updateSettings({
                    enabled: v,
                    dimensions: s.embeddingDimensions ?? 256,
                    model: s.embeddingModel ?? 'text-embedding-3-small',
                    batchSize: MAX_EMBEDDING_BATCH_SIZE,
                });
                if (v) {
                    // Start indexing if just enabled
                    this.plugin.vaultIndexer.indexVault(this.app);
                }
            }, true);

        if (!s.embeddingsEnabled) return;

        // ── Auto-RAG toggle ──────────────────────────────────────
        this.addToggleSetting(containerEl, 'Auto-attach relevant notes',
            'When starting a new conversation, automatically search your vault and attach the most relevant notes as context. Adds ~200ms to first message.',
            s.enableAutoRAG, async (v) => {
                s.enableAutoRAG = v;
            }, true);

        // ── Dimensions ───────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Configuration' });

        new Setting(containerEl)
            .setName('Embedding dimensions')
            .setDesc('Lower = smaller storage + faster search. Higher = more precision. Changing this requires a full re-index.')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('256', '256 (compact — recommended)')
                    .addOption('512', '512 (balanced)')
                    .addOption('1536', '1536 (full)')
                    .setValue(String(s.embeddingDimensions ?? 256))
                    .onChange(async (value) => {
                        s.embeddingDimensions = parseInt(value);
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Embedding model')
            .setDesc('Model used to generate vectors. Changing this requires rebuilding the index.')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('text-embedding-3-small', 'text-embedding-3-small (recommended)')
                    .addOption('text-embedding-3-large', 'text-embedding-3-large (higher quality)')
                    .setValue(s.embeddingModel ?? 'text-embedding-3-small')
                    .onChange(async (value) => {
                        s.embeddingModel = value;
                        await this.plugin.saveSettings();
                    });
            });

        // ── Index status ─────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Index Status' });

        const statusEl = containerEl.createDiv({ cls: 'sidekick-embedding-status' });
        this.renderIndexStatus(statusEl);

        // ── Actions ──────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Actions' });

        new Setting(containerEl)
            .setName('Rebuild index')
            .setDesc('Clear the entire vector index and re-embed all notes. Use this after changing dimensions or if the index seems outdated.')
            .addButton(btn => {
                btn.setButtonText('Rebuild Index')
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.vaultIndexer.clearIndex();
                        this.plugin.vaultIndexer.indexVault(this.app);
                        new Notice('Rebuilding vector index...');
                        this.display();
                    });
            });

        new Setting(containerEl)
            .setName('Clear index')
            .setDesc('Delete all stored embeddings. Semantic search will not work until the vault is re-indexed.')
            .addButton(btn => {
                btn.setButtonText('Clear Index')
                    .onClick(async () => {
                        await this.plugin.vaultIndexer.clearIndex();
                        new Notice('Vector index cleared.');
                        this.display();
                    });
            });
    }

    /** Render index stats or progress into the status element. */
    private async renderIndexStatus(statusEl: HTMLElement): Promise<void> {
        try {
            if (this.plugin.vaultIndexer.isRunning()) {
                statusEl.createEl('p', { text: '⏳ Indexing in progress...', cls: 'mod-warning' });
                return;
            }

            const stats = await this.plugin.vaultIndexer.getStats();
            const info = statusEl.createDiv();
            info.createEl('p', { text: `📄 Files indexed: ${stats.fileCount.toLocaleString()}` });
            info.createEl('p', { text: `📦 Chunks stored: ${stats.chunkCount.toLocaleString()}` });
            info.createEl('p', { text: `📐 Dimensions: ${stats.dimensions}` });

            if (!stats.fileCount) {
                statusEl.createEl('p', {
                    text: 'No files indexed yet. Click "Rebuild Index" to start.',
                    cls: 'setting-item-description',
                });
            }
        } catch {
            statusEl.createEl('p', { text: '⚠️ Could not read index status.', cls: 'mod-warning' });
        }
    }

    // ── Tab: Profile ────────────────────────────────────────────

    private renderProfileTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'User Profile' });
        containerEl.createEl('p', {
            text: 'When enabled, the AI learns about you from conversations to personalize responses. Facts are stored locally in your plugin settings.',
            cls: 'setting-item-description',
        });
        const s = this.plugin.settings;

        new Setting(containerEl)
            .setName('Default agent preset')
            .setDesc('Choose the persona Sidekick starts with for new chats.')
            .addDropdown(dropdown => {
                for (const preset of BUILT_IN_PRESETS) {
                    dropdown.addOption(preset.id, `${preset.icon} ${preset.name}`);
                }
                dropdown.setValue(s.activeAgentPreset || 'default')
                    .onChange(async (value) => {
                        s.activeAgentPreset = value;
                        await this.plugin.saveSettings();
                    });
            });

        const activePreset = getPreset(s.activeAgentPreset || 'default');
        if (activePreset) {
            containerEl.createEl('p', {
                text: `${activePreset.icon} ${activePreset.name}: ${activePreset.description}`,
                cls: 'setting-item-description',
            });
        }

        this.addToggleSetting(containerEl, 'Enable user profiling',
            'Allow the AI to remember facts about you (preferences, expertise, communication style). A "remember_user_fact" tool becomes available to the LLM.',
            s.enableUserProfile, (v) => { s.enableUserProfile = v; }, true);

        if (s.enableUserProfile) {
            // Show current profile facts
            const profile = s.userProfile;
            const factCount = profile?.facts?.length ?? 0;

            containerEl.createEl('h3', { text: `Stored Facts (${factCount})` });

            if (factCount === 0) {
                containerEl.createEl('p', {
                    text: 'No facts stored yet. The AI will learn about you as you chat.',
                    cls: 'setting-item-description',
                });
            } else {
                const factsContainer = containerEl.createDiv({ cls: 'sidekick-profile-facts' });
                for (const fact of profile.facts) {
                    const factEl = factsContainer.createDiv({ cls: 'sidekick-profile-fact' });
                    const badge = factEl.createEl('span', {
                        text: fact.category,
                        cls: 'sidekick-profile-fact-badge',
                    });
                    badge.style.cssText = 'font-size: 0.7rem; padding: 1px 6px; border-radius: 8px; background: var(--background-modifier-hover); margin-right: 6px;';
                    factEl.createEl('span', { text: fact.content });
                    const deleteBtn = factEl.createEl('button', {
                        text: '×',
                        cls: 'sidekick-profile-fact-delete',
                        attr: { title: 'Remove this fact' },
                    });
                    deleteBtn.style.cssText = 'margin-left: auto; background: none; border: none; cursor: pointer; color: var(--text-error); font-size: 1rem; padding: 0 4px;';
                    deleteBtn.addEventListener('click', async () => {
                        const { removeFact } = await import('../lib/profile');
                        s.userProfile = removeFact(s.userProfile, fact.id);
                        await this.plugin.saveSettings();
                        this.display(); // Re-render
                    });
                    factEl.style.cssText = 'display: flex; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--background-modifier-border);';
                }
            }

            // Clear all facts button
            if (factCount > 0) {
                new Setting(containerEl)
                    .setName('Clear all facts')
                    .setDesc('Remove all stored profile facts')
                    .addButton(btn => btn.setButtonText('Clear All').setWarning().onClick(async () => {
                        const { createEmptyProfile } = await import('../lib/profile');
                        s.userProfile = createEmptyProfile();
                        await this.plugin.saveSettings();
                        this.display();
                    }));
            }
        }
    }

    // ── Tab: Advanced ───────────────────────────────────────────

    private renderAdvancedTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Advanced Settings' });
        containerEl.createEl('p', {
            text: 'These settings control internal limits. Change them only if you know what you\'re doing.',
            cls: 'setting-item-description',
        });
        const s = this.plugin.settings;

        // ── Retry settings ───────────────────────────────────────
        containerEl.createEl('h3', { text: 'Retries' });

        new Setting(containerEl)
            .setName('Max retries')
            .setDesc(`Number of retry attempts on API failure (default: ${MAX_RETRIES})`)
            .addSlider(slider => {
                slider.setLimits(1, 10, 1)
                    .setValue(s.maxRetries ?? MAX_RETRIES)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.maxRetries = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Retry delay')
            .setDesc(`Milliseconds to wait between retries (default: ${RETRY_DELAY_MS}ms)`)
            .addSlider(slider => {
                slider.setLimits(500, 10000, 500)
                    .setValue(s.retryDelayMs ?? RETRY_DELAY_MS)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.retryDelayMs = value;
                        await this.plugin.saveSettings();
                    });
            });

        // ── Tool limits ──────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Tool Limits' });

        new Setting(containerEl)
            .setName('Max tool rounds')
            .setDesc(`Maximum tool-calling rounds per request (default: ${MAX_TOOL_ROUNDS})`)
            .addSlider(slider => {
                slider.setLimits(1, 50, 1)
                    .setValue(s.maxToolRounds ?? MAX_TOOL_ROUNDS)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.maxToolRounds = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Max tool rounds (iterate)')
            .setDesc(`Maximum tool-calling rounds in iterate mode (default: ${MAX_TOOL_ROUNDS_ITERATE})`)
            .addSlider(slider => {
                slider.setLimits(10, 200, 10)
                    .setValue(s.maxToolRoundsIterate ?? MAX_TOOL_ROUNDS_ITERATE)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.maxToolRoundsIterate = value;
                        await this.plugin.saveSettings();
                    });
            });

        // ── Content limits ───────────────────────────────────────
        containerEl.createEl('h3', { text: 'Content Limits' });

        new Setting(containerEl)
            .setName('Max content length')
            .setDesc(`Maximum characters to read from notes/URLs before truncating (default: ${MAX_CONTENT_LENGTH.toLocaleString()})`)
            .addSlider(slider => {
                slider.setLimits(5000, 100000, 5000)
                    .setValue(s.maxContentLength ?? MAX_CONTENT_LENGTH)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.maxContentLength = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Thinking budget')
            .setDesc(`Max output tokens for thinking/reasoning models (default: ${THINKING_BUDGET.toLocaleString()})`)
            .addSlider(slider => {
                slider.setLimits(4096, 65536, 4096)
                    .setValue(s.thinkingBudget ?? THINKING_BUDGET)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        s.thinkingBudget = value;
                        await this.plugin.saveSettings();
                    });
            });

        // ── Debug logging ─────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Debug Logging' });

        new Setting(containerEl)
            .setName('Enable debug logging')
            .setDesc('Write verbose logs (API requests, responses, tool calls, timing) to copilot/debug-logs/ in your vault. Useful for troubleshooting.')
            .addToggle(toggle => {
                toggle.setValue(s.debugLogging ?? false)
                    .onChange(async (value) => {
                        s.debugLogging = value;
                        await this.plugin.saveSettings();
                        // Dynamically enable/disable the logger
                        const { debugLog } = await import('./debug-log');
                        debugLog.setEnabled(value);
                    });
            });

        // ── Reset all ────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Reset' });

        new Setting(containerEl)
            .setName('Reset advanced settings')
            .setDesc('Restore all advanced settings to their default values')
            .addButton(btn => {
                btn.setButtonText('Reset to Defaults')
                    .setWarning()
                    .onClick(async () => {
                        s.maxToolRounds = DEFAULT_SETTINGS.maxToolRounds;
                        s.maxToolRoundsIterate = DEFAULT_SETTINGS.maxToolRoundsIterate;
                        s.maxRetries = DEFAULT_SETTINGS.maxRetries;
                        s.retryDelayMs = DEFAULT_SETTINGS.retryDelayMs;
                        s.maxContentLength = DEFAULT_SETTINGS.maxContentLength;
                        s.thinkingBudget = DEFAULT_SETTINGS.thinkingBudget;
                        s.debugLogging = DEFAULT_SETTINGS.debugLogging;
                        await this.plugin.saveSettings();
                        new Notice('Advanced settings reset to defaults');
                        this.display();
                    });
            });
    }

    // ── Shared helpers ──────────────────────────────────────────

    private renderTemplateSyntaxHelp(containerEl: HTMLElement): void {
        const syntaxHelp = containerEl.createEl('details', { cls: 'sidekick-template-help' });
        syntaxHelp.createEl('summary', { text: 'Template syntax reference' });
        const syntaxList = syntaxHelp.createEl('ul');
        syntaxList.createEl('li', { text: '{} \u2014 replaced with user\'s message text' });
        syntaxList.createEl('li', { text: '{activeNote} \u2014 content of the currently open note' });
        syntaxList.createEl('li', { text: '{[[Note Title]]} \u2014 content of a specific note' });
        const fmHelp = syntaxHelp.createEl('p');
        fmHelp.innerHTML = '<strong>Frontmatter:</strong> <code>description</code> (shown in autocomplete), <code>enabled: false</code> (disable command)';
    }

    // ── Command editor ──────────────────────────────────────────

    private editCommand(existing: CustomCommand | null): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: existing ? 'Edit Command' : 'New Command' });

        let name = existing?.name || '';
        let description = existing?.description || '';
        let systemPrompt = existing?.systemPrompt || '';
        const errorEl = containerEl.createEl('p', { cls: 'sidekick-error' });
        errorEl.style.display = 'none';

        new Setting(containerEl)
            .setName('Command name')
            .setDesc('lowercase, no spaces (e.g. translate, coder)')
            .addText(text => text.setPlaceholder('e.g. translate').setValue(name).onChange(v => { name = v; }));

        new Setting(containerEl)
            .setName('Description')
            .setDesc('Shown in autocomplete')
            .addText(text => text.setPlaceholder('e.g. Translate text to English').setValue(description).onChange(v => { description = v; }));

        new Setting(containerEl)
            .setName('System prompt')
            .addTextArea(text => {
                text.inputEl.rows = 6;
                text.inputEl.style.width = '100%';
                text.setPlaceholder('e.g. You are a professional translator...')
                    .setValue(systemPrompt)
                    .onChange(v => { systemPrompt = v; });
            });

        const RESERVED = new Set(['help', 'note', 'selection', 'regen', 'iterate', 'clear', 'export', 'new']);

        new Setting(containerEl)
            .addButton(btn => {
                btn.setButtonText(existing ? 'Update' : 'Add Command')
                    .setCta()
                    .onClick(async () => {
                        const error = this.validateCommand(name, systemPrompt, existing, RESERVED);
                        if (error) {
                            errorEl.textContent = error;
                            errorEl.style.display = 'block';
                            return;
                        }

                        const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-');
                        this.saveCommand(existing, cleanName, description.trim(), systemPrompt.trim());
                        await this.plugin.saveSettings();
                        this.display();
                    });
            })
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.display()));
    }

    private validateCommand(
        name: string,
        systemPrompt: string,
        existing: CustomCommand | null,
        reserved: Set<string>,
    ): string | null {
        const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-');
        if (!cleanName) return 'Name is required.';
        if (!/^[a-z0-9][\w-]*$/.test(cleanName)) {
            return 'Name must start with a letter/digit and contain only a-z, 0-9, - or _.';
        }
        if (reserved.has(cleanName)) return `"${cleanName}" is a built-in command.`;
        if (!systemPrompt.trim()) return 'System prompt is required.';

        const dup = this.plugin.settings.customCommands.find(
            c => c.name.toLowerCase() === cleanName && c.id !== existing?.id,
        );
        if (dup) return `Command "/${cleanName}" already exists.`;

        return null;
    }

    private saveCommand(
        existing: CustomCommand | null,
        name: string,
        description: string,
        systemPrompt: string,
    ): void {
        if (existing) {
            const idx = this.plugin.settings.customCommands.findIndex(c => c.id === existing.id);
            if (idx >= 0) {
                this.plugin.settings.customCommands[idx] = { ...existing, name, description, systemPrompt };
            }
        } else {
            this.plugin.settings.customCommands.push({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                name,
                description,
                systemPrompt,
            });
        }
    }

    // ── Tab: Updates ────────────────────────────────────────────

    private renderUpdatesTab(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Plugin Updates' });
        containerEl.createEl('p', {
            text: 'Configure an S3-compatible backend to host your own plugin updates securely.',
            cls: 'setting-item-description',
        });
        const s = this.plugin.settings;

        this.addToggleSetting(containerEl, 'Check for S3 updates',
            'When enabled, the plugin will securely check your S3 bucket for updates on startup.',
            s.s3UpdateEnabled, (v) => { s.s3UpdateEnabled = v; }, true);

        if (!s.s3UpdateEnabled) return;

        containerEl.createEl('h3', { text: 'S3 Connection Details' });

        this.addTextSetting(containerEl, 'Endpoint URL',
            'Full URL of the S3-compatible endpoint (e.g. https://s3.us-east-1.amazonaws.com)', {
            value: s.s3Endpoint,
            placeholder: 'https://...',
            onSave: (v) => { s.s3Endpoint = v.trim(); },
        });

        this.addTextSetting(containerEl, 'Bucket Name',
            'Name of the S3 bucket containing the updates', {
            value: s.s3Bucket,
            placeholder: 'token-meter',
            onSave: (v) => { s.s3Bucket = v.trim(); },
        });

        this.addTextSetting(containerEl, 'Prefix',
            'Folder path where updates are stored (e.g. obsidian-sidekick/)', {
            value: s.s3Prefix,
            placeholder: 'obsidian-sidekick/',
            onSave: (v) => {
                let prefix = v.trim();
                if (prefix && !prefix.endsWith('/')) prefix += '/';
                s.s3Prefix = prefix;
            },
        });

        containerEl.createEl('h3', { text: 'S3 Credentials' });
        containerEl.createEl('p', {
            text: 'These credentials stay on your device and are used to sign secure requests to directly fetch updates.',
            cls: 'setting-item-description',
        });

        this.addTextSetting(containerEl, 'Access Key ID',
            'AWS Access Key ID', {
            value: s.s3AccessKeyId,
            placeholder: '...',
            onSave: (v) => { s.s3AccessKeyId = v.trim(); },
        });

        this.addTextSetting(containerEl, 'Secret Access Key',
            'AWS Secret Access Key', {
            value: s.s3SecretAccessKey,
            placeholder: '...',
            password: true,
            onSave: (v) => { s.s3SecretAccessKey = v.trim(); },
        });
    }
}

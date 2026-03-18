import { App, Modal, Notice, Setting } from 'obsidian';
import { S3Client } from './s3-client';
import { debugLog } from './debug-log';
import type SidekickPlugin from './main';

interface LatestJson {
  version: string;
  files: Record<string, string>;
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

class UpdateModal extends Modal {
    latestVersion: string;
    currentVersion: string;
    onAccept: () => void;

    constructor(app: App, latestVersion: string, currentVersion: string, onAccept: () => void) {
        super(app);
        this.latestVersion = latestVersion;
        this.currentVersion = currentVersion;
        this.onAccept = onAccept;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Sidekick Update Available" });
        contentEl.createEl("p", { text: `A newer version of Sidekick (v${this.latestVersion}) is available!` });
        contentEl.createEl("p", { 
            text: `You are currently running v${this.currentVersion}. Would you like to install the update from your S3 bucket now?`,
            cls: 'setting-item-description'
        });
        
        new Setting(contentEl)
            .addButton((btn) => 
                btn
                .setButtonText("Install & Reload Prompt")
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onAccept();
                })
            )
            .addButton((btn) => 
                btn
                .setButtonText("Not now")
                .onClick(() => {
                    this.close();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export async function checkForUpdates(app: App, plugin: SidekickPlugin, userTriggered = false): Promise<void> {
    if (!plugin.settings.s3UpdateEnabled) {
        if (userTriggered) {
             new Notice("S3 updates are disabled in settings.");
        }
        return;
    }
    
    if (!plugin.settings.s3Endpoint || !plugin.settings.s3Bucket || !plugin.settings.s3AccessKeyId || !plugin.settings.s3SecretAccessKey) {
        if (userTriggered) {
            new Notice("S3 configuration is incomplete. Check settings.");
        }
        return;
    }

    const s3Client = new S3Client(plugin.settings);
    
    try {
        if (userTriggered) new Notice("Checking for updates...");
        debugLog.log('auto-update', 'Checking for updates', { endpoint: plugin.settings.s3Endpoint });
        
        const response = await s3Client.fetchObject('latest.json');
        const latest = response.json as LatestJson;
        
        if (!latest || !latest.version || !latest.files) {
            throw new Error("Invalid latest.json format or missing from S3.");
        }
        
        const currentVersion = plugin.manifest.version;
        
        if (!isNewer(latest.version, currentVersion)) {
            if (userTriggered) {
                 new Notice(`Sidekick is up to date (v${currentVersion}).`);
            }
            return;
        }
        
        const modal = new UpdateModal(app, latest.version, currentVersion, async () => {
            try {
                new Notice(`Downloading v${latest.version}...`, 0);
                
                for (const [filename, s3Path] of Object.entries(latest.files)) {
                    const fileRes = await s3Client.fetchObject(s3Path as string);
                    const arrayBuf = fileRes.arrayBuffer;
                    if (!arrayBuf) throw new Error(`Missing content for ${filename}`);
                    
                    const localPath = `${plugin.manifest.dir}/${filename}`;
                    await app.vault.adapter.writeBinary(localPath, arrayBuf);
                }
                
                new Notice(`Successfully updated to v${latest.version}!\n\nPlease reload the app (View -> Force Reload) to apply changes.`, 15000);
                debugLog.log('auto-update', 'Successfully updated', { version: latest.version });
            } catch (err) {
                console.error("Sidekick Update failed", err);
                debugLog.log('auto-update', 'Update installation failed', { error: err instanceof Error ? err.message : String(err) });
                new Notice(`Update failed: ${err instanceof Error ? err.message : String(err)}`, 10000);
            }
        });
        
        modal.open();
        
    } catch (err) {
        debugLog.log('auto-update', 'Update check failed', { error: err instanceof Error ? err.message : String(err) });
        if (userTriggered) {
            console.error("Sidekick Update Check failed", err);
            new Notice(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

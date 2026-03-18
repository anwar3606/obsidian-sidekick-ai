/**
 * Minimal Obsidian API mocks for unit testing.
 * Only stubs the classes and functions our code imports.
 */

export class ItemView {
    app: any;
    containerEl: any = { children: [document.createElement('div')] };
    getViewType() { return ''; }
    getDisplayText() { return ''; }
    getIcon() { return ''; }
    async onOpen() {}
    async onClose() {}
}

export class WorkspaceLeaf {
    view: any;
}

export class Plugin {
    app: any;
    manifest: any = { version: '0.0.0' };
    async loadData() { return {}; }
    async saveData(_data: any) {}
    addCommand(_cmd: any) {}
    addRibbonIcon(_icon: string, _title: string, _cb: () => void) {}
    addSettingTab(_tab: any) {}
    registerView(_type: string, _factory: any) {}
}

export class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl: any = document.createElement('div');
    constructor(_app: any, _plugin: any) {}
    display() {}
}

export class Setting {
    constructor(_containerEl: any) {}
    setName(_name: string) { return this; }
    setDesc(_desc: string) { return this; }
    addDropdown(_cb: any) { return this; }
    addText(_cb: any) { return this; }
    addTextArea(_cb: any) { return this; }
    addButton(_cb: any) { return this; }
    addToggle(_cb: any) { return this; }
    addSlider(_cb: any) { return this; }
}

export class TFile {
    path: string;
    basename: string;
    extension: string;
    stat: { ctime: number; mtime: number; size: number };

    constructor(path: string) {
        this.path = path;
        this.basename = path.replace(/.*\//, '').replace(/\.[^.]+$/, '');
        this.extension = path.replace(/.*\./, '');
        this.stat = { ctime: 0, mtime: 0, size: 0 };
    }
}

export class TFolder {
    path: string;
    children: any[] = [];
    constructor(path: string) {
        this.path = path;
    }
}

export class TAbstractFile {
    path = '';
}

export class MarkdownView {
    editor: any;
    file: TFile | null = null;
}

export class Notice {
    constructor(_message: string, _timeout?: number) {}
}

export class Modal {
    app: any;
    modalEl: any = document.createElement('div');
    contentEl: any = document.createElement('div');
    constructor(_app: any) { this.app = _app; }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
}

export function setIcon(_el: HTMLElement, _icon: string) {}

export class MarkdownRenderer {
    static async render(_app: any, _md: string, _el: HTMLElement, _path: string, _component: any) {}
}

export function requestUrl(_opts: any) {
    return Promise.resolve({ status: 200, text: '' });
}

export type App = any;

/** Helper to create a mock Obsidian App with vault */
export function createMockApp(files: Record<string, string> = {}): any {
    const fileMap: Record<string, TFile> = {};
    const folderMap: Record<string, TFolder> = {};
    const contentMap: Record<string, string> = { ...files };

    for (const path of Object.keys(files)) {
        fileMap[path] = new TFile(path);
    }

    const listeners: Record<string, Function[]> = {};

    return {
        vault: {
            getAbstractFileByPath(path: string) {
                return fileMap[path] || folderMap[path] || null;
            },
            getMarkdownFiles() {
                return Object.values(fileMap).filter(f => f.extension === 'md');
            },
            getFiles() {
                return Object.values(fileMap);
            },
            async read(file: TFile) {
                return contentMap[file.path] || '';
            },
            async readBinary(file: TFile) {
                const content = contentMap[file.path] || '';
                const encoder = new TextEncoder();
                return encoder.encode(content).buffer;
            },
            async create(path: string, content: string) {
                const file = new TFile(path);
                fileMap[path] = file;
                contentMap[path] = content;
                listeners['create']?.forEach(cb => cb(file));
                return file;
            },
            async createBinary(path: string, _data: ArrayBuffer) {
                const file = new TFile(path);
                fileMap[path] = file;
                return file;
            },
            async createFolder(path: string) {
                const folder = new TFolder(path);
                folderMap[path] = folder;
                return folder;
            },
            async modify(file: TFile, content: string) {
                contentMap[file.path] = content;
                listeners['modify']?.forEach(cb => cb(file));
            },
            async trash(file: TFile, _system: boolean) {
                delete fileMap[file.path];
                delete contentMap[file.path];
                listeners['delete']?.forEach(cb => cb(file));
            },
            async delete(file: TFile) {
                delete fileMap[file.path];
                delete contentMap[file.path];
                listeners['delete']?.forEach(cb => cb(file));
            },
            getResourcePath(file: TFile) {
                return `app://local/${file.path}`;
            },
            on(event: string, callback: Function) {
                if (!listeners[event]) listeners[event] = [];
                listeners[event].push(callback);
            },
            off(event: string, callback: Function) {
                if (listeners[event]) {
                    listeners[event] = listeners[event].filter(cb => cb !== callback);
                }
            },
            adapter: {
                getResourcePath(path: string) {
                    return `app://local/${path}`;
                },
            },
        },
        workspace: {
            getLeavesOfType(_type: string) { return []; },
            getActiveFile() { return null; },
            getMostRecentLeaf() { return null; },
            async openLinkText(_linktext: string, _sourcePath: string, _newLeaf?: any) {},
        },
        metadataCache: {
            getFileCache(_file: TFile) { return null; },
            getFirstLinkpathDest(linkpath: string, _sourcePath: string) {
                return fileMap[linkpath] || null;
            },
            resolvedLinks: {} as Record<string, Record<string, number>>,
        },
        fileManager: {
            async renameFile(file: TFile, newPath: string) {
                const oldPath = file.path;
                const content = contentMap[oldPath] || '';
                delete fileMap[oldPath];
                delete contentMap[oldPath];
                file.path = newPath;
                file.basename = newPath.replace(/.*\//, '').replace(/\.[^.]+$/, '');
                fileMap[newPath] = file;
                contentMap[newPath] = content;
            },
        },
    };
}

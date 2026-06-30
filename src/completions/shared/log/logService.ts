import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../di/services';

export const ILogService = createServiceIdentifier<ILogService>('ILogService');

export interface ILogService {
    readonly _serviceBrand: undefined;
    /** Whether logging is currently enabled. Defaults to false. */
    enabled: boolean;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
    show(): void;
    /** Clear the output channel. Call on activation to avoid stale log clutter. */
    clear(): void;
}

export class LogService implements ILogService {
    readonly _serviceBrand: undefined;
    private _channel: vscode.OutputChannel;
    private _enabled = false;
    private readonly _configKey = 'cc-completion.logging.enabled';
    private _configListener: vscode.Disposable | undefined;

    constructor() {
        this._channel = vscode.window.createOutputChannel('CC Completion');
        this._enabled = vscode.workspace.getConfiguration().get<boolean>(this._configKey, false);
        // Watch for setting changes (e.g. via quick pick or settings.json edit)
        this._configListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(this._configKey)) {
                this._enabled = vscode.workspace.getConfiguration().get<boolean>(this._configKey, false);
            }
        });
    }

    get enabled(): boolean { return this._enabled; }
    set enabled(value: boolean) {
        // Persist to VS Code settings (survives reloads)
        vscode.workspace.getConfiguration().update(this._configKey, value, true);
        this._enabled = value;
        if (value) {
            this._channel.show(true);
            this._channel.appendLine('[CC Completion] Logging enabled');
        } else {
            this._channel.appendLine('[CC Completion] Logging disabled');
        }
    }

    info(message: string): void {
        if (!this._enabled) return;
        this._channel.appendLine(`[info] ${message}`);
    }
    warn(message: string): void {
        if (!this._enabled) return;
        this._channel.appendLine(`[warn] ${message}`);
    }
    error(message: string): void {
        if (!this._enabled) return;
        this._channel.appendLine(`[error] ${message}`);
    }
    debug(message: string): void {
        if (!this._enabled) return;
        this._channel.appendLine(`[debug] ${message}`);
    }
    show(): void { this._channel.show(); }

    clear(): void {
        this._channel.clear();
        if (this._enabled) {
            this._channel.appendLine('[CC Completion] ===== session start =====');
        }
    }

    dispose(): void {
        this._configListener?.dispose();
    }
}

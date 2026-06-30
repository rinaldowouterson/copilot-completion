import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../di/services';

export const ILogService = createServiceIdentifier<ILogService>('ILogService');

export interface ILogService {
    readonly _serviceBrand: undefined;
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

    constructor() {
        this._channel = vscode.window.createOutputChannel('CC Completion');
    }

    info(message: string): void { this._channel.appendLine(`[info] ${message}`); }
    warn(message: string): void { this._channel.appendLine(`[warn] ${message}`); }
    error(message: string): void { this._channel.appendLine(`[error] ${message}`); }
    debug(message: string): void { this._channel.appendLine(`[debug] ${message}`); }
    show(): void { this._channel.show(); }

    clear(): void {
        this._channel.clear();
        this._channel.appendLine('[CC Completion] ===== session start =====');
    }
}

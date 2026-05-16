import * as vscode from 'vscode';
import { createServiceIdentifier } from '../di/services';
import { IGhostConfigProvider } from '../config/ghostConfig';
import { INesConfigProvider } from '../config/nesConfig';
import { ILogService } from '../completions/shared/log/logService';

export const IStatusBarPanel = createServiceIdentifier<IStatusBarPanel>('IStatusBarPanel');

export interface IStatusBarPanel {
    readonly _serviceBrand: undefined;
    register(): vscode.Disposable;
}

export class StatusBarPanel implements IStatusBarPanel {
    readonly _serviceBrand: undefined;
    private _statusBarItem: vscode.StatusBarItem;
    private _panel: vscode.WebviewPanel | undefined;

    constructor(
        @IGhostConfigProvider private readonly _ghostConfig: IGhostConfigProvider,
        @INesConfigProvider private readonly _nesConfig: INesConfigProvider,
        @ILogService private readonly _log: ILogService,
    ) {
        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this._updateStatusBar();
    }

    register(): vscode.Disposable {
        this._statusBarItem.show();
        this._statusBarItem.command = 'cc-completion.togglePanel';

        const commandDisposable = vscode.commands.registerCommand(
            'cc-completion.togglePanel',
            () => this._showPanel(),
        );

        const ghostChange = this._ghostConfig.onDidChangeEnabled(() => this._updateStatusBar());
        const nesChange = this._nesConfig.onDidChangeEnabled(() => this._updateStatusBar());

        return {
            dispose: () => {
                this._statusBarItem.dispose();
                this._panel?.dispose();
                commandDisposable.dispose();
                ghostChange.dispose();
                nesChange.dispose();
            },
        };
    }

    private _updateStatusBar(): void {
        const ghostOn = this._ghostConfig.enabled;
        const nesOn = this._nesConfig.enabled;
        const active = [ghostOn && 'G', nesOn && 'N'].filter(Boolean).join('/');
        if (active) {
            this._statusBarItem.text = `$(sparkle) CC [${active}]`;
            this._statusBarItem.tooltip = `GHOST: ${ghostOn ? 'ON' : 'OFF'}, NES: ${nesOn ? 'ON' : 'OFF'}`;
        } else {
            this._statusBarItem.text = `$(circle-slash) CC [OFF]`;
            this._statusBarItem.tooltip = 'CC Completion disabled';
        }
    }

    private _showPanel(): void {
        if (this._panel) {
            this._panel.reveal();
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'ccCompletion',
            'CC Completion',
            vscode.ViewColumn.Beside,
            { enableScripts: true },
        );

        this._panel.onDidDispose(() => { this._panel = undefined; });

        this._panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'toggleGhost') {
                await vscode.workspace.getConfiguration().update(
                    'cc-completion.ghost.enabled',
                    !this._ghostConfig.enabled,
                    vscode.ConfigurationTarget.Global,
                );
                this._updateStatusBar();
                this._updateWebviewContent();
            } else if (message.command === 'toggleNes') {
                await vscode.workspace.getConfiguration().update(
                    'cc-completion.nes.enabled',
                    !this._nesConfig.enabled,
                    vscode.ConfigurationTarget.Global,
                );
                this._updateStatusBar();
                this._updateWebviewContent();
            }
        });

        this._updateWebviewContent();
    }

    private _updateWebviewContent(): void {
        if (!this._panel) return;

        const ghostOn = this._ghostConfig.enabled;
        const nesOn = this._nesConfig.enabled;

        this._panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: var(--vscode-editor-font-family); padding: 20px; color: var(--vscode-foreground); }
        h2 { margin-top: 0; }
        .section {
            padding: 16px; margin-bottom: 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
        }
        .section-header { display: flex; justify-content: space-between; align-items: center; }
        .section-title { font-size: 14px; font-weight: 600; }
        .section-desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 12px; }
        .toggle {
            padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer;
            font-size: 13px; font-weight: 600;
        }
        .toggle.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .toggle.off { background: var(--vscode-input-background); color: var(--vscode-foreground); }
    </style>
</head>
<body>
    <h2>CC Completion</h2>
    <div class="section">
        <div class="section-header">
            <div>
                <div class="section-title">Ghost Inline Completion (GHOST)</div>
            </div>
            <button class="toggle ${ghostOn ? 'on' : 'off'}"
                    onclick="toggle('toggleGhost')">
                ${ghostOn ? 'ON' : 'OFF'}
            </button>
        </div>
        <div class="section-desc">FIM template-based code completion</div>
    </div>
    <div class="section">
        <div class="section-header">
            <div>
                <div class="section-title">Next Edit Suggestion (NES)</div>
            </div>
            <button class="toggle ${nesOn ? 'on' : 'off'}"
                    onclick="toggle('toggleNes')">
                ${nesOn ? 'ON' : 'OFF'}
            </button>
        </div>
        <div class="section-desc">Predicts the next edit location with smart suggestions</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function toggle(command) { vscode.postMessage({ command }); }
    </script>
</body>
</html>`;
    }
}

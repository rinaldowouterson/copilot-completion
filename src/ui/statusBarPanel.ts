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
            () => this._showQuickPick(),
        );

        const ghostChange = this._ghostConfig.onDidChangeEnabled(() => this._updateStatusBar());
        const nesChange = this._nesConfig.onDidChangeEnabled(() => this._updateStatusBar());

        return {
            dispose: () => {
                this._statusBarItem.dispose();
                commandDisposable.dispose();
                ghostChange.dispose();
                nesChange.dispose();
            },
        };
    }

    private _updateStatusBar(): void {
        const ghostOn = this._ghostConfig.enabled;
        const nesOn = this._nesConfig.enabled;
        const ncpOn = this._nesConfig.nextCursorPredictionEnabled;
        const active = [ghostOn && 'G', nesOn && 'N', ncpOn && 'C'].filter(Boolean).join('/');
        if (active) {
            this._statusBarItem.text = `$(sparkle) CC [${active}]`;
            this._statusBarItem.tooltip = [
                ` ${ghostOn ? '✅' : '❌'} Ghost Inline Suggetion `,
                ` ${nesOn ? '✅' : '❌'} Next Edit Suggestion `,
                ` ${ncpOn ? '✅' : '❌'} Next Cursor Prediction `,
            ].join('\n');
        } else {
            this._statusBarItem.text = `$(circle-slash) CC [OFF]`;
            this._statusBarItem.tooltip = 'CC Completion disabled';
        }
    }

    private async _showQuickPick(): Promise<void> {
        const ghostOn = this._ghostConfig.enabled;
        const nesOn = this._nesConfig.enabled;
        const ncpOn = this._nesConfig.nextCursorPredictionEnabled;

        const ghostItem: vscode.QuickPickItem = { label: 'Ghost Inline Completion (GHOST)', picked: ghostOn };
        const nesItem: vscode.QuickPickItem = { label: 'Next Edit Suggestion (NES)', picked: nesOn };
        const ncpItem: vscode.QuickPickItem = {
            label: 'Next Cursor Prediction (NCP)',
            description: nesOn ? 'Requires NES enabled' : 'Disabled (requires NES)',
            picked: ncpOn && nesOn,
        };

        const picks = await vscode.window.showQuickPick(
            [ghostItem, nesItem, ncpItem],
            {
                canPickMany: true,
                placeHolder: 'Toggle GHOST / NES / NCP completion features',
                title: 'CC Completion',
            },
        );

        if (!picks) return;

        const pickedSet = new Set(picks);
        const newGhost = pickedSet.has(ghostItem);
        const newNes = pickedSet.has(nesItem);
        // NCP only active when NES is also picked
        const newNcp = newNes && pickedSet.has(ncpItem);

        if (newGhost !== ghostOn) {
            this._ghostConfig.enabled = newGhost;
            this._log.info(`GHOST: ${newGhost ? 'enabled' : 'disabled'}`);
        }
        if (newNes !== nesOn) {
            this._nesConfig.enabled = newNes;
            this._log.info(`NES: ${newNes ? 'enabled' : 'disabled'}`);
        }
        if (newNes && newNcp !== ncpOn) {
            this._nesConfig.nextCursorPredictionEnabled = newNcp;
            this._log.info(`NCP: ${newNcp ? 'enabled' : 'disabled'}`);
        }
        if (!newNes && nesOn) {
            this._log.info(`NCP: disabled (NES turned off)`);
        }

        this._updateStatusBar();
    }
}

import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { INesConfigProvider } from '../../config/nesConfig';
import { ILogService } from '../shared/log/logService';
import { NextEditResult } from './types';
import { createServiceIdentifier } from '../../di/services';
import { NesWorkflow } from './core/nesWorkflow';
import { NextCursorPredictor } from './nextCursorPredictor';
import { InlineSuggestionResolver } from './core/inlineSuggestionResolver';

export const INesProvider = createServiceIdentifier<INesProvider>('INesProvider');

export interface INesProvider {
    readonly _serviceBrand: undefined;
    register(): vscode.Disposable;
}

export class NextEditProvider implements INesProvider, vscode.InlineCompletionItemProvider {
    readonly _serviceBrand: undefined;
    private _disposable: vscode.Disposable | undefined;
    private _workflow: NesWorkflow;
    private _cursorPredictor: NextCursorPredictor;
    private readonly _inlineSuggestionResolver = new InlineSuggestionResolver();

    constructor(
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        @INesConfigProvider private readonly _config: INesConfigProvider,
        @ILogService private readonly _log: ILogService,
    ) {
        this._workflow = this._instantiationService.createInstance(NesWorkflow);
        this._cursorPredictor = this._instantiationService.createInstance(NextCursorPredictor);
    }

    register(): vscode.Disposable {
        this._disposable = (vscode.languages as any).registerInlineCompletionItemProvider(
            { pattern: '**' },
            this,
            { groupId: 'nes', debounceDelayMs: 0 },
        );

        const configDisposable = this._config.onDidChangeEnabled(() => {
            this._log.info(`NES enabled changed to: ${this._config.enabled}`);
            if (this._disposable) { this._disposable.dispose(); }
            if (this._config.enabled) {
                this._disposable = (vscode.languages as any).registerInlineCompletionItemProvider(
                    { pattern: '**' },
                    this,
                    { groupId: 'nes', debounceDelayMs: 0 },
                );
            }
        });

        return {
            dispose: () => {
                this._disposable?.dispose();
                configDisposable.dispose();
            },
        };
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        if (!this._config.enabled) {
            this._log.debug(`[NES]  DISABLED`);
            return undefined;
        }

        // Primary NES request
        const { editResult, promptPieces } = await this._workflow.execute(document, position, token);

        if (editResult) {
            return this._toInlineItems(editResult, document, position);
        }

        // Retry via cursor prediction
        if (!this._cursorPredictor.isEnabled()) {
            this._log.debug(`[NES]  NO_RESULT — cursor prediction disabled`);
            return undefined;
        }

        if (token.isCancellationRequested) {
            this._log.debug(`[NES]  NO_RESULT — cancelled before cursor prediction`);
            return undefined;
        }

        this._log.debug(`[NES]  NO_RESULT — attempting cursor prediction retry`);

        const predictionR = await this._cursorPredictor.predict(promptPieces, token);

        if (token.isCancellationRequested) {
            this._log.debug(`[NES]  NO_RESULT — cancelled after cursor prediction`);
            return undefined;
        }

        if (predictionR.isError()) {
            this._log.debug(`[NES]  cursor prediction error: ${predictionR.err}`);
            return undefined;
        }

        const prediction = predictionR.val;

        if (prediction.kind === 'differentFile') {
            this._log.debug(`[NES]  cross-file prediction not supported: ${prediction.filePath}`);
            return undefined;
        }

        // sameFile: retry NES at predicted position
        this._log.debug(`[NES]  retry NES at predicted line ${prediction.lineNumber}`);

        const predictedPos = new vscode.Position(
            Math.min(prediction.lineNumber, document.lineCount - 1),
            0,
        );

        const { editResult: retryResult } = await this._workflow.execute(
            document, position, token, predictedPos,
        );

        if (retryResult) {
            retryResult.cursorPrediction = prediction;
            return this._toInlineItems(retryResult, document, position);
        }

        this._log.debug(`[NES]  NO_RESULT — retry also failed`);
        return undefined;
    }

    private _toInlineItems(
        result: NextEditResult,
        document: vscode.TextDocument,
        cursorPosition: vscode.Position,
    ): vscode.InlineCompletionList {
        // 1. Cursor jump: create jump-to-position item (no insertText)
        if (result.jumpToPosition) {
            const item = new vscode.InlineCompletionItem('', result.range);
            (item as any).jumpToPosition = result.jumpToPosition;
            (item as any).isInlineEdit = true;
            (item as any).isInlineCompletion = false;
            return new (vscode.InlineCompletionList as any)([item], { enableForwardStability: true });
        }

        // 2. Try to convert to inline (ghost text) suggestion
        const inline = this._inlineSuggestionResolver.resolve(
            cursorPosition,
            document,
            result.range,
            result.edit,
        );

        const isInlineCompletion = !!inline;

        // 3. Gate: suppress if was previously shown as inline but now can't be
        if (
            this._config.mimicGhostTextBehavior
            && result.cacheEntry?.wasRenderedAsInlineSuggestion
            && !isInlineCompletion
        ) {
            this._log.debug(`[NES]  suppressing cached suggestion — was inline, now not`);
            return new (vscode.InlineCompletionList as any)([], { enableForwardStability: true });
        }

        // 4. Mark cache entry as rendered inline
        if (isInlineCompletion && result.cacheEntry) {
            result.cacheEntry.wasRenderedAsInlineSuggestion = true;
        }

        // 5. Use adjusted range/text if inline, otherwise full edit window
        const range = inline?.range ?? result.range;
        const insertText = inline?.newText ?? result.edit;

        // 6. Build item
        const item = new vscode.InlineCompletionItem(insertText, range);

        if (result.displayLocation) {
            (item as any).displayLocation = result.displayLocation;
        }

        if (result.cursorPrediction) {
            item.command = {
                title: 'NES cursor jump',
                command: 'cc-completion.nes.cursorJump',
                arguments: [result.cursorPrediction],
            };
        }

        (item as any).isInlineEdit = !isInlineCompletion;
        (item as any).isInlineCompletion = isInlineCompletion;
        (item as any).showInlineEditMenu = !isInlineCompletion || undefined;

        return new (vscode.InlineCompletionList as any)([item], { enableForwardStability: true });
    }
}

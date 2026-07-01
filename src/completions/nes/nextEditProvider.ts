import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { INesConfigProvider } from '../../config/nesConfig';
import { ILogService } from '../shared/log/logService';
import { NesCompletionItem, NesCompletionList, NesCompletionInfo, NextEditResult } from './types';
import { createServiceIdentifier } from '../../di/services';
import { NesWorkflow } from './core/nesWorkflow';
import { NextCursorPredictor } from './nextCursorPredictor';
import { InlineSuggestionResolver } from './core/inlineSuggestionResolver';
import { IContextBuilderService, AutoImportFix } from '../context/contextBuilderService';
import { containsChatMarkup } from '../../common/chatMarkup';

export const INesProvider = createServiceIdentifier<INesProvider>('INesProvider');

export interface INesProvider {
    readonly _serviceBrand: undefined;
    register(): vscode.Disposable;
}

let _requestSeq = 0;

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
        @IContextBuilderService private readonly _contextBuilder: IContextBuilderService,
    ) {
        this._workflow = this._instantiationService.createInstance(NesWorkflow);
        this._cursorPredictor = this._instantiationService.createInstance(NextCursorPredictor);
    }

    register(): vscode.Disposable {
        this._disposable = vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            this,
        );

        const configDisposable = this._config.onDidChangeEnabled(() => {
            this._log.info(`NES enabled changed to: ${this._config.enabled}`);
            if (this._disposable) { this._disposable.dispose(); }
            if (this._config.enabled) {
                this._disposable = vscode.languages.registerInlineCompletionItemProvider(
                    { pattern: '**' },
                    this,
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

        const requestUuid = `nes-${Date.now()}-${++_requestSeq}`;

        // Phase H: in parallel with the workflow, detect missing imports.
        // If found and no NES edit is produced, surface the auto-import suggestion.
        const autoImportPromise = this._tryAutoImportSuggestion(document, position, requestUuid, token);

        // Primary NES request
        const { editResult, promptPieces } = await this._workflow.execute(document, position, false, token);

        if (editResult) {
            return this._toInlineItems(editResult, document, position, requestUuid);
        }

        // Retry via cursor prediction
        if (!promptPieces || !this._cursorPredictor.isEnabled()) {
            this._log.debug(`[NES]  NO_RESULT — cursor prediction disabled or no prompt`);
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
        // sameFile: retry NES at predicted position
        this._log.debug(`[NES]  retry NES at predicted line ${predictionR.val}`);

        const predictedPos = new vscode.Position(
            Math.min(predictionR.val, document.lineCount - 1),
            0,
        );

        const { editResult: retryResult } = await this._workflow.execute(
            document, predictedPos, true, token
        );

        if (retryResult) {
            retryResult.cursorPrediction = {
                kind: 'sameFile',
                lineNumber: predictionR.val
            };
            return this._toInlineItems(retryResult, document, position, requestUuid);
        }

        this._log.debug(`[NES]  NO_RESULT — retry also failed`);

        // Phase H fallback: if no NES edit, but missing imports were detected,
        // surface the auto-import suggestion (still zero model tokens).
        if (token.isCancellationRequested) return undefined;
        const autoImport = await autoImportPromise;
        if (autoImport) {
            const info = new NesCompletionInfo(
                {
                    range: new vscode.Range(position, position),
                    edit: '',
                    documentBeforeEdits: '',
                    fullEditText: '',
                    edits: [],
                },
                document.uri.toString(),
                document,
                requestUuid,
            );
            autoImport.info = info;
            return new NesCompletionList(requestUuid, [autoImport]);
        }

        return undefined;
    }

    private _toInlineItems(
        result: NextEditResult,
        document: vscode.TextDocument,
        cursorPosition: vscode.Position,
        requestUuid: string,
    ): NesCompletionList {
        const info = new NesCompletionInfo(
            result,
            document.uri.toString(),
            document,
            requestUuid,
        );

        // 1. Cursor jump: create jump-to-position item (no insertText)
        if (result.jumpToPosition) {
            const item: NesCompletionItem = {
                insertText: '',
                range: result.range,
                jumpToPosition: result.jumpToPosition,
                isInlineEdit: true,
                isInlineCompletion: false,
                showInlineEditMenu: true,
                showInlinedDiff: false,
                shouldBeInlineEdit: true,
                info,
            };
            return new NesCompletionList(requestUuid, [item]);
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
            return new NesCompletionList(requestUuid, []);
        }

        // 4. Mark cache entry as rendered inline
        if (isInlineCompletion && result.cacheEntry) {
            result.cacheEntry.wasRenderedAsInlineSuggestion = true;
        }

        // 5. Use adjusted range/text if inline, otherwise precise diff range/text
        const range = inline?.range ?? result.range;
        const insertText = inline?.newText ?? result.edit;

        // 6. Build item
        const item: NesCompletionItem = {
            insertText,
            range,
            isInlineEdit: !isInlineCompletion,
            isInlineCompletion,
            showInlineEditMenu: !isInlineCompletion,
            showInlinedDiff: !isInlineCompletion,
            shouldBeInlineEdit: true,
            info,
        };

        if (result.displayLocation) {
            item.displayLocation = result.displayLocation;
        }

        if (result.cursorPrediction) {
            item.command = {
                title: 'NES cursor jump',
                command: 'cc-completion.nes.cursorJump',
                arguments: [result.cursorPrediction],
            };
        }

        return new NesCompletionList(requestUuid, [item]);
    }

    /**
     * Phase H: Build an NES inline completion that adds missing imports via
     * the LSP's quickfix code actions. Returns `undefined` when there are
     * no missing imports, when chat markup is detected in the document,
     * or when the LSP returned no actionable fix.
     *
     * Zero model tokens consumed — pure LSP.
     */
    private async _tryAutoImportSuggestion(
        document: vscode.TextDocument,
        position: vscode.Position,
        requestUuid: string,
        token: vscode.CancellationToken,
    ): Promise<NesCompletionItem | undefined> {
        // Bail if the document has chat editing markup (leaked session tags)
        if (containsChatMarkup(document.getText())) return undefined;

        const fixes: AutoImportFix[] = await this._contextBuilder.detectMissingImports(document, token);
        if (fixes.length === 0) return undefined;

        // Flatten all edits from all fixes into one additionalTextEdits array
        const additionalTextEdits: vscode.TextEdit[] = [];
        for (const fix of fixes) {
            for (const edit of fix.edits) additionalTextEdits.push(edit);
        }
        if (additionalTextEdits.length === 0) return undefined;

        this._log.debug(`[NES]  PHASE_H — ${fixes.length} missing import fix(es), ${additionalTextEdits.length} edit(s)`);

        const label = `✨ Add ${fixes.length} missing import${fixes.length > 1 ? 's' : ''}`;
        return {
            insertText: '',
            range: new vscode.Range(position, position),
            additionalTextEdits,
            isInlineEdit: true,
            isInlineCompletion: false,
            showInlineEditMenu: true,
            showInlinedDiff: false,
            shouldBeInlineEdit: true,
            displayLocation: {
                range: new vscode.Range(position, position),
                label,
            },
        };
    }
}

// TODO(phase-I): Beyond auto-imports, surface other LSP code actions as NES suggestions:
//   - Quick fixes (e.g., "Add missing return statement")
//   - Refactoring (e.g., "Extract function", "Rename symbol")
//   - Source actions (e.g., "Organize imports", "Remove unused")
// Use the same additionalTextEdits mechanism proven in Phase H.
// Group by CodeActionKind so similar fixes can be surfaced together.

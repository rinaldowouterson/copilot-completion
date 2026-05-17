import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { INesConfigProvider } from '../../config/nesConfig';
import { ILLMAdapterManager } from '../shared/llm/llmAdapter';
import { ILogService } from '../shared/log/logService';
import { PromptingStrategy, NextEditResult } from './types';
import { pickSystemPrompt } from './systemMessages';
import { handleEditWindowOnly } from './responseFormatHandlers';
import { TrimNESResponseSuffixOverlap } from './suffixOverlapTrim';
import { INextEditCache } from './nextEditCache';
import { CurrentDocument } from './xtabCurrentDocument';
import { StringText } from './stubs/abstractText';
import { Position } from './stubs/position';
import { OffsetRange } from './stubs/offsetRange';
import { DocumentId, StatelessNextEditDocument, PromptOptions, IncludeLineNumbersOption, AggressivenessLevel, LintOptionWarning, LintOptionShowCode } from './stubs/types';
import { constructTaggedFile, getUserPrompt, PromptPieces, N_LINES_ABOVE, N_LINES_BELOW, N_LINES_AS_CONTEXT } from './promptCrafting';
import { LintErrors } from './lintErrors';
import { PromptTags } from './tags';
import { toUniquePath } from './promptCraftingUtils';

export class NesProvider {
    constructor(
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        @INesConfigProvider private readonly _config: INesConfigProvider,
        @ILLMAdapterManager private readonly _llmManager: ILLMAdapterManager,
        @ILogService private readonly _log: ILogService,
        @INextEditCache private readonly _cache: INextEditCache,
    ) {}

    async provideNextEdit(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<NextEditResult | undefined> {
        const t0 = Date.now();
        this._log.info(`[NES]  ===== START =====`);

        if (token?.isCancellationRequested) {
            this._log.info(`[NES]  CANCEL before_start`);
            return undefined;
        }

        // Step 1: Config check
        if (!this._config.enabled) {
            this._log.info(`[NES]  SKIP — disabled by config`);
            return undefined;
        }

        // Step 2: Cache lookup
        const t1 = Date.now();
        const docText = document.getText();
        const cached = this._cache.lookupNextEdit(document.uri.toString(), document);
        if (cached) {
            this._log.info(`[NES]  CACHE_HIT edit=${cached.edit.length}ch age=${Date.now() - cached.cacheTime}ms total=${Date.now() - t0}ms`);
            this._log.debug(`[NES]  cached_edit="${this._trunc(cached.edit, 100)}"`);

            if (token?.isCancellationRequested) {
                this._log.info(`[NES]  CANCEL after_cache_hit`);
                return undefined;
            }
            return this._buildResult(cached.edit, document, position);
        }
        this._log.debug(`[NES]  cache_miss [${Date.now() - t1}ms]`);

        if (token?.isCancellationRequested) {
            this._log.info(`[NES]  CANCEL after_cache_miss`);
            return undefined;
        }

        // Step 3: Build prompt via getUserPrompt() pipeline
        const t2 = Date.now();
        const normalizedText = docText.replace(/\r\n/g, '\n');
        const cursorPos = new Position(position.line + 1, position.character + 1);
        const currentDocument = new CurrentDocument(new StringText(normalizedText), cursorPos);

        const ewStart = Math.max(0, position.line - N_LINES_ABOVE);
        const ewEndExcl = Math.min(document.lineCount, position.line + N_LINES_BELOW + 1);
        const editWindowLinesRange = new OffsetRange(ewStart, ewEndExcl);

        const aaStart = Math.max(0, position.line - N_LINES_AS_CONTEXT);
        const aaEndExcl = Math.min(document.lineCount, position.line + N_LINES_AS_CONTEXT + 1);
        const areaAroundEditWindowLinesRange = new OffsetRange(aaStart, aaEndExcl);

        const computeTokens = (s: string) => Math.floor(s.length / 4);
        const promptOptions: PromptOptions = {
            promptingStrategy: PromptingStrategy.Xtab275,
            includePostScript: true,
            recentlyViewedDocuments: { maxTokens: 2000, nDocuments: 10, includeViewedFiles: true, clippingStrategy: 'TopToBottom' as any, includeLineNumbers: IncludeLineNumbersOption.None },
            currentFile: { includeCursorTag: true, includeLineNumbers: IncludeLineNumbersOption.None, maxTokens: 4000, prioritizeAboveCursor: true, includeTags: true },
            languageContext: { maxTokens: 2000, traitPosition: 'before' },
            lintOptions: { tagName: 'diagnostics', warnings: LintOptionWarning.NO, showCode: LintOptionShowCode.NO, maxLints: 10, maxLineDistance: 50, nRecentFiles: 3 },
            neighborFiles: { enabled: false, maxTokens: 2000 },
            pagedClipping: { pageSize: 50 },
            diffHistory: { onlyForDocsInPrompt: true, maxTokens: 2000, nEntries: 10, useRelativePaths: true },
        };

        const taggedR = constructTaggedFile(currentDocument, editWindowLinesRange, areaAroundEditWindowLinesRange, promptOptions, computeTokens, {
            includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None },
        });
        if (taggedR.isError()) {
            this._log.info(`[NES]  SKIP — prompt too large total=${Date.now() - t0}ms`);
            return undefined;
        }
        const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = taggedR.val;

        const activeDoc: StatelessNextEditDocument = { id: DocumentId.create(document.uri.toString()) };
        const lintErrors = new LintErrors(activeDoc.id, currentDocument);

        const promptPieces = new PromptPieces(
            currentDocument, editWindowLinesRange, areaAroundEditWindowLinesRange,
            activeDoc, [], clippedTaggedCurrentDoc.lines, areaAroundCodeToEdit,
            undefined, AggressivenessLevel.Medium, lintErrors, computeTokens, promptOptions,
        );

        const { prompt: baseUserPrompt } = getUserPrompt(promptPieces);

        const getPredictedOutput = (): string => {
            const editWindowLines = this._getEditWindowLines(document, position);
            if (editWindowLines.length === 0) return '';
            return editWindowLines.join('\n');
        };
        const prediction = getPredictedOutput();

        let userPrompt = baseUserPrompt + `current document is ${document.languageId}. **Just can improve \`code_to_eidt\` section and output modifying result. Don't return other content.**`;
        if (prediction.length > 0) {
            userPrompt += `\n\nThe output example is as follows:\n\n\`\`\`\n###remain edit start boundary line###\n${prediction}\n###remain edit end boundary line###\n\`\`\`\n`;
        }

        const systemPrompt = pickSystemPrompt(PromptingStrategy.Xtab275);
        this._log.debug(`[NES]  edit_window L${ewStart + 1}-L${ewEndExcl} area_around L${aaStart + 1}-L${aaEndExcl} lang=${document.languageId}`);
        this._log.debug(`[NES]  system_prompt=${systemPrompt.length}ch user_prompt=${userPrompt.length}ch [${Date.now() - t2}ms]`);

        if (token?.isCancellationRequested) {
            this._log.info(`[NES]  CANCEL after_prompt_build`);
            return undefined;
        }

        // Step 5: Network request with AbortController
        const t4 = Date.now();
        const endpoint = this._config.supportedEndpoint;
        const adapter = this._llmManager.getAdapter(endpoint);
        const abortController = new AbortController();
        const cancelListener = token?.onCancellationRequested(() => {
            this._log.info(`[NES]  ABORT — CancellationToken triggered`);
            abortController.abort();
        });

        this._log.debug(`[NES]  endpoint=${endpoint} model=${this._config.model} max_tokens=${this._config.maxOutputTokens}`);

        try {
            const response = await adapter.send(
                {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    max_tokens: this._config.maxOutputTokens,
                    temperature: 0,
                    capabilities: {
                        thinking: this._config.capabilities.supports.thinking,
                    },
                },
                abortController.signal,
            );
            const networkMs = Date.now() - t4;
            this._log.info(`[NES]  NETWORK finish=${response.finishReason} text=${response.text.length}ch usage=${JSON.stringify(response.usage)} [${networkMs}ms]`);
            this._log.debug(`[NES]  raw_response="${this._trunc(response.text, 200)}"`);

            // Step 6: Parse response
            const parsed = handleEditWindowOnly(response.text);
            const editText = parsed.lines.join('\n');
            this._log.debug(`[NES]  parsed lines=${parsed.lines.length} edit=${editText.length}ch`);

            if (!editText.trim()) {
                this._log.info(`[NES]  EMPTY_EDIT — model returned no content total=${Date.now() - t0}ms`);
                return undefined;
            }

            // Step 7: Diff model output against edit window lines (to extract actual edits)
            const editWindowLines = this._getEditWindowLines(document, position);
            this._log.debug(`[NES]  edit_window_lines=${editWindowLines.length}`);

            // Step 8: Apply suffix overlap trimming (line-level)
            const trimmer = new TrimNESResponseSuffixOverlap(
                this._config.suffixOverlapThreshold,
                this._config.suffixOverlapType,
            );
            const suffixLines = document.getText(
                new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end)
            ).replace(/\r\n/g, '\n').split('\n');
            const overlapCount = trimmer.calculateOverlap(parsed.lines, suffixLines);
            const finalLines = overlapCount > 0
                ? parsed.lines.slice(0, parsed.lines.length - overlapCount)
                : parsed.lines;
            if (overlapCount > 0) {
                this._log.info(`[NES]  suffix_trim overlap=${overlapCount} lines threshold=${this._config.suffixOverlapThreshold} type=${this._config.suffixOverlapType}`);
            }
            const finalEdit = finalLines.join('\n');

            // Step 9: Filter edit (reject empty/noop/comment-only/whitespace-only edits)
            if (this._shouldRejectEdit(finalEdit, editWindowLines)) {
                this._log.info(`[NES]  FILTERED — edit rejected by filter total=${Date.now() - t0}ms`);
                return undefined;
            }

            // Step 10: Cache result
            this._cache.setKthNextEdit(document.uri.toString(), {
                docId: document.uri.toString(),
                docContentHash: this._hash(docText),
                editWindow: {
                    startLine: Math.max(0, position.line - 2),
                    endLineExclusive: position.line + 5,
                },
                edit: finalEdit,
                cacheTime: Date.now(),
            });

            const totalMs = Date.now() - t0;
            this._log.info(`[NES]  RESULT edit=${finalEdit.length}ch preview="${this._trunc(finalEdit, 100)}" total=${totalMs}ms`);

            return this._buildResult(finalEdit, document, position);
        } catch (err) {
            if ((err as {name?: string})?.name === 'AbortError') {
                this._log.info(`[NES]  ABORTED after ${Date.now() - t0}ms`);
                return undefined;
            }
            this._log.error(`[NES]  ERROR after ${Date.now() - t0}ms: ${err}`);
            return undefined;
        } finally {
            cancelListener?.dispose();
        }
    }

    private _getEditWindowLines(document: vscode.TextDocument, position: vscode.Position): string[] {
        const startLine = Math.max(0, position.line - 2);
        const endLine = Math.min(document.lineCount, position.line + 6);
        const lines: string[] = [];
        for (let i = startLine; i < endLine; i++) {
            lines.push(document.lineAt(i).text);
        }
        return lines;
    }

    private _shouldRejectEdit(editText: string, editWindowLines: string[]): boolean {
        if (!editText.trim()) return true; // Empty edit

        // Diff: if the edit matches the original edit window exactly, it's a noop
        const editLines = editText.split('\n');
        if (editLines.length === editWindowLines.length &&
            editLines.every((l, i) => l === editWindowLines[i])) {
            return true; // No-op edit
        }

        // Reject whitespace-only changes
        const nonWhitespaceEdit = editLines.filter(l => l.trim()).join('\n');
        const nonWhitespaceOrig = editWindowLines.filter(l => l.trim()).join('\n');
        if (nonWhitespaceEdit === nonWhitespaceOrig) return true;

        // Reject comment-only edits (lines that are all comments)
        const hasNonComment = editLines.some(l => {
            const trimmed = l.trim();
            return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('/*');
        });
        if (!hasNonComment) return true;

        return false;
    }

    private _buildResult(edit: string, document: vscode.TextDocument, position: vscode.Position): NextEditResult {
        const editStartLine = Math.max(0, position.line - 2);
        const nextLine = Math.min(position.line + 1, document.lineCount - 1);
        return {
            edit,
            range: new vscode.Range(
                new vscode.Position(editStartLine, 0),
                new vscode.Position(Math.min(position.line + 5, document.lineCount - 1), 0),
            ),
            cursorAfterEdit: new vscode.Position(nextLine, 0),
        };
    }

    private _hash(text: string): string {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return hash.toString(36);
    }

    private _trunc(s: string, max: number): string {
        const escaped = s.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return escaped.length <= max ? escaped : escaped.substring(0, max) + '…';
    }
}

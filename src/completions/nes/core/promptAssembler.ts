import * as vscode from 'vscode';
import { INesConfigProvider } from '../../../config/nesConfig';
import { PromptingStrategy, PromptOptions, IncludeLineNumbersOption, AggressivenessLevel, LintOptionWarning, LintOptionShowCode, DocumentId, StatelessNextEditDocument } from '../stubs/types';
import { IXtabHistoryEntry } from '../stubs/types';
import { constructTaggedFile, getUserPrompt, PromptPieces, N_LINES_AS_CONTEXT } from '../promptCrafting';
import { LintErrors } from '../lintErrors';
import { CurrentDocument } from '../xtabCurrentDocument';
import { StringText } from '../stubs/abstractText';
import { Position } from '../stubs/position';
import { OffsetRange } from '../stubs/offsetRange';
import { EditWindowResolver } from './editWindowResolver';
import { ContextBundle } from '../../../common/contextBundle';

export interface PromptAssembly {
    promptPieces: PromptPieces;
    userPrompt: string;
    systemPrompt: string;
    editWindowLines: string[];
    editWindowRange: OffsetRange;
}

export class PromptAssembler {
    constructor(
        @INesConfigProvider private readonly _config: INesConfigProvider,
        private readonly _editWindowResolver: EditWindowResolver,
    ) {}

    assemble(
        document: vscode.TextDocument,
        position: vscode.Position,
        lintEnable: boolean,
        xtabHistory?: readonly IXtabHistoryEntry[],
        context?: ContextBundle,
    ): PromptAssembly {
        const normalizedText = document.getText().replace(/\r\n/g, '\n');
        const effectivePosition = position;
        const cursorPos = new Position(effectivePosition.line + 1, effectivePosition.character + 1);
        const currentDocument = new CurrentDocument(new StringText(normalizedText), cursorPos);

        // Resolve edit window range (shrunken by statement end if available)
        const normalizedLines = normalizedText.split('\n');
        const ewRange = this._editWindowResolver.resolve(normalizedLines, effectivePosition.line, context?.statementEndLine);

        // Area around edit window range — use effectivePosition so NCP retry centers on the predicted position
        const aaStart = Math.max(0, effectivePosition.line - N_LINES_AS_CONTEXT);
        const aaEndExcl = Math.min(document.lineCount, effectivePosition.line + N_LINES_AS_CONTEXT + 1);
        const areaAroundEditWindowLinesRange = new OffsetRange(aaStart, aaEndExcl);

        const computeTokens = (s: string) => Math.floor(s.length / 4);
        const promptOptions: PromptOptions = {
            promptingStrategy: PromptingStrategy.Xtab275,
            includePostScript: true,
            includeEditCode: true,
            recentlyViewedDocuments: { maxTokens: 2000, nDocuments: 10, includeViewedFiles: true, clippingStrategy: 'TopToBottom' as any, includeLineNumbers: IncludeLineNumbersOption.None },
            currentFile: { includeCursorTag: true, includeLineNumbers: IncludeLineNumbersOption.None, maxTokens: 4000, prioritizeAboveCursor: true, includeTags: false },
            languageContext: { maxTokens: 2000, traitPosition: 'before' },
            lintOptions: { enable: lintEnable, tagName: 'diagnostics', warnings: LintOptionWarning.NO, showCode: LintOptionShowCode.NO, maxLints: 10, maxLineDistance: 50, nRecentFiles: 3 },
            neighborFiles: { enabled: false, maxTokens: 2000 },
            pagedClipping: { pageSize: 50 },
            diffHistory: { onlyForDocsInPrompt: true, maxTokens: 2000, nEntries: 10, useRelativePaths: true },
        };

        const taggedR = constructTaggedFile(currentDocument, ewRange, areaAroundEditWindowLinesRange, promptOptions, computeTokens, {
            includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None },
        });
        if (taggedR.isError()) {
            throw new Error('Prompt too large');
        }
        const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = taggedR.val;

        const activeDoc: StatelessNextEditDocument = {
            id: DocumentId.create(document.uri.toString()),
            documentAfterEditsLines: normalizedLines,
            languageId: document.languageId,
        };
        const lintErrors = new LintErrors(document.uri, currentDocument);

        const promptPieces = new PromptPieces(
            currentDocument, ewRange, areaAroundEditWindowLinesRange,
            activeDoc, xtabHistory ?? [], clippedTaggedCurrentDoc.lines, areaAroundCodeToEdit,
            undefined, AggressivenessLevel.Medium, lintErrors, computeTokens, promptOptions,
        );

        const { prompt: baseUserPrompt } = getUserPrompt(promptPieces);

        const editWindowLines = normalizedLines.slice(ewRange.start, ewRange.endExclusive);
        const prediction = editWindowLines.join('\n');

        const systemPrompt = "Predict the next code edit based on user context.";

        // Context bundle additions (only when LSP data is available)
        let contextNote = '';
        if (context) {
            if (context.fileExports.length > 0) {
                const exportsList = context.fileExports.map(e => `${e.name} (${e.kind})`).join(', ');
                contextNote += `<|file_exports|>\n${exportsList}\n<|/file_exports|>\n`;
            }
            if (context.enclosingScope) {
                contextNote += `<|scope|>\n${context.enclosingScope.kind} ${context.enclosingScope.name} (line ${context.enclosingScope.startLine}–${context.enclosingScope.endLine})\n<|/scope|>\n`;
            }
            if (context.importResolutions && context.importResolutions.length > 0) {
                const lines = context.importResolutions.slice(0, 5).map(imp => {
                    const pathLabel = imp.uri.split('/').pop() || imp.uri;
                    const names = imp.exports.map(e => e.name).join(', ');
                    return `${pathLabel} → ${names}`;
                });
                contextNote += `<|imports|>\n${lines.join('\n')}\n<|/imports|>\n`;
            }
        }

        const userPrompt = baseUserPrompt 
                + contextNote
                + `current document is ${document.languageId}. **Just can improve \`code_to_edit\` section and output modifying result. Don't return other content.**`
                + `\n\nThe output example is as follows:\n\n\`\`\`\n###remain edit start boundary line###\n${prediction}\n###remain edit end boundary line###\n\`\`\`\n`;

        return { promptPieces, userPrompt, systemPrompt, editWindowLines, editWindowRange: ewRange };
    }
}

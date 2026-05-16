import { DocumentId, PromptOptions, IncludeLineNumbersOption, StatelessNextEditDocument, IXtabHistoryEntry } from './stubs/types';
import { LanguageContextResponse } from './stubs/languageContext';
import { INeighborFileSnippet } from './similarFilesContextService';

/**
 * Result of appending neighbor-file snippets, used for telemetry.
 */
export interface AppendNeighborFileSnippetsResult {
    readonly nComputed: number;
    readonly nIncluded: number;
    readonly includedIndices: readonly number[];
}

export function getRecentCodeSnippets(
    _activeDoc: StatelessNextEditDocument,
    _xtabHistory: readonly IXtabHistoryEntry[],
    _langCtx: LanguageContextResponse | undefined,
    _computeTokens: (code: string) => number,
    _opts: PromptOptions,
    _neighborSnippets?: readonly INeighborFileSnippet[],
): { codeSnippets: string; documents: Set<DocumentId>; neighborSnippetsResult: AppendNeighborFileSnippetsResult | undefined } {
    // Stub: return empty code snippets
    return {
        codeSnippets: '',
        documents: new Set<DocumentId>(),
        neighborSnippetsResult: undefined,
    };
}

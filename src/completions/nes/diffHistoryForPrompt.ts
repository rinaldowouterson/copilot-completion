import { DocumentId, DiffHistoryOptions, StatelessNextEditDocument, IXtabHistoryEntry } from './stubs/types';

export interface EditDiffHistoryResult {
    readonly promptPiece: string;
    readonly nDiffs: number;
    readonly totalTokens: number;
}

export function getEditDiffHistory(
    _activeDoc: StatelessNextEditDocument,
    _xtabHistory: readonly IXtabHistoryEntry[],
    _docsInPrompt: Set<DocumentId>,
    _computeTokens: (s: string) => number,
    _opts: DiffHistoryOptions,
): EditDiffHistoryResult {
    // Stub: return empty diff history
    return {
        promptPiece: '',
        nDiffs: 0,
        totalTokens: 0,
    };
}

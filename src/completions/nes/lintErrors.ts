import { LintOptions, DocumentId, IXtabHistoryEntry } from './stubs/types';
import { CurrentDocument } from './xtabCurrentDocument';

export class LintErrors {
    constructor(
        private readonly _documentId: DocumentId,
        private readonly _document: CurrentDocument,
        private readonly _langDiagService?: unknown,
        private readonly _xtabHistory?: readonly IXtabHistoryEntry[],
    ) { }

    getFormattedLintErrors(_options: LintOptions): string {
        return '';
    }

    getData(): string {
        return '[]';
    }
}

import * as vscode from 'vscode';
import { DocumentId, IXtabHistoryEntry } from '../stubs/types';
import { StringText } from '../stubs/abstractText';
import { StringEdit, StringReplacement } from '../stubs/stringEdit';
import { OffsetRange } from '../stubs/offsetRange';

/**
 * Tracks document edits and visible ranges to build xtabHistory
 * for getRecentCodeSnippets and getEditDiffHistory.
 */
export class NesHistoryTracker implements vscode.Disposable {
    private _disposable: vscode.Disposable;
    /** Most-recent-first */
    private _editEntries: IXtabHistoryEntry[] = [];
    private _prevContents = new Map<string, string>();
    private readonly _maxEditEntries = 50;

    constructor() {
        // Seed cache for already-open documents so the first edit is tracked
        for (const editor of vscode.window.visibleTextEditors) {
            const doc = editor.document;
            if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
                this._prevContents.set(doc.uri.toString(), doc.getText());
            }
        }

        const docOpenListener = vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
                this._prevContents.set(doc.uri.toString(), doc.getText());
            }
        });

        const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
            this._onDocumentChanged(e);
        });

        this._disposable = vscode.Disposable.from(docOpenListener, changeListener);
    }

    dispose(): void {
        this._disposable.dispose();
    }

    /**
     * Returns the current xtabHistory: visible ranges from open editors
     * plus tracked edit entries, ordered most-recent-first.
     */
    getHistory(activeDocId: DocumentId): readonly IXtabHistoryEntry[] {
        const visibleEntries = this._collectVisibleEditors(activeDocId);
        // Edit entries first (more recent), then visible ranges
        return [...this._editEntries, ...visibleEntries];
    }

    private _onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
        const doc = e.document;
        if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
            return;
        }

        const docKey = doc.uri.toString();
        const prevContent = this._prevContents.get(docKey);

        if (prevContent !== undefined && e.contentChanges.length > 0) {
            for (const change of e.contentChanges) {
                const range = new OffsetRange(change.rangeOffset, change.rangeOffset + change.rangeLength);
                const replacement = new StringReplacement(range, change.text);
                const edit = new StringEdit([replacement]);
                const base = new StringText(prevContent);
                const docId = DocumentId.create(doc.uri.toString());

                this._editEntries.unshift({
                    kind: 'edit',
                    docId,
                    edit: { base, edit },
                });
            }

            if (this._editEntries.length > this._maxEditEntries) {
                this._editEntries.length = this._maxEditEntries;
            }
        }

        // Cache current content for next change
        this._prevContents.set(docKey, doc.getText());
    }

    private _collectVisibleEditors(activeDocId: DocumentId): IXtabHistoryEntry[] {
        const entries: IXtabHistoryEntry[] = [];
        const seen = new Set<string>();
        seen.add(activeDocId.uri);

        for (const editor of vscode.window.visibleTextEditors) {
            const doc = editor.document;
            const docKey = doc.uri.toString();
            if (seen.has(docKey)) {
                continue;
            }
            seen.add(docKey);

            const content = new StringText(doc.getText());
            const docId = DocumentId.create(doc.uri.toString());

            // Build visible ranges from visible ranges or the entire document
            const visibleRanges: OffsetRange[] = editor.visibleRanges.map(r => {
                const startOff = doc.offsetAt(r.start);
                const endOff = doc.offsetAt(r.end);
                return new OffsetRange(startOff, endOff);
            });

            entries.push({
                kind: 'visibleRanges',
                docId,
                documentContent: content,
                visibleRanges: visibleRanges.length > 0 ? visibleRanges : [new OffsetRange(0, doc.getText().length)],
            });
        }

        return entries;
    }
}

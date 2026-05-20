import * as vscode from 'vscode';
import { LintOptions, LintOptionShowCode, DocumentId, IXtabHistoryEntry } from './stubs/types';
import { CurrentDocument } from './xtabCurrentDocument';
import { Position } from './stubs/position';
import { PromptTags } from './tags';

export class LintErrors {
    constructor(
        private readonly _documentUri: vscode.Uri,
        private readonly _document: CurrentDocument,
        private readonly _xtabHistory?: readonly IXtabHistoryEntry[],
    ) { }

    getFormattedLintErrors(options: LintOptions): string {
        const diagnostics = this._getFilteredDiagnostics(options);
        if (diagnostics.length === 0) {
            return '';
        }

        const formatted = diagnostics.map(d => formatSingleDiagnostic(d, this._document.lines, options)).join('\n');
        return `${PromptTags.DIAGNOSTICS_EXCEPTION.start}\n${formatted}\n${PromptTags.DIAGNOSTICS_EXCEPTION.end}`;
    }

    getData(): string {
        return '[]';
    }

    /**
     * Collects diagnostics for the current document, filters by distance/severity/limit,
     * and excludes import/include-related diagnostics.
     */
    private _getFilteredDiagnostics(options: LintOptions): DiagnosticInfo[] {
        const allDiagnostics = vscode.languages.getDiagnostics(this._documentUri);

        const relevant: DiagnosticInfo[] = [];
        for (const d of allDiagnostics) {
            if (this._isImportOrIncludeDiagnostic(d)) {
                continue;
            }

            const startLine = d.range.start.line; // 0-based
            const cursorLine = this._document.cursorPosition.lineNumber - 1; // convert 1-based to 0-based
            const lineDistance = Math.abs(startLine - cursorLine);

            if (lineDistance > options.maxLineDistance) {
                continue;
            }

            const severity = d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning
                ? (d.severity === vscode.DiagnosticSeverity.Error ? 'error' as const : 'warning' as const)
                : undefined;

            if (severity === undefined) {
                continue;
            }

            // Filter by severity option
            if (options.warnings === 'NO' && severity === 'warning') {
                continue;
            }

            relevant.push({
                severity,
                message: d.message,
                line: startLine,
                column: d.range.start.character,
                endLine: d.range.end.line,
                endColumn: d.range.end.character,
                code: typeof d.code === 'string' ? d.code : (typeof d.code === 'number' ? String(d.code) : undefined),
                source: d.source,
                lineDistance,
            });
        }

        // Sort by line distance (closest to cursor first)
        relevant.sort((a, b) => a.lineDistance - b.lineDistance);

        return relevant.slice(0, options.maxLints);
    }

    /**
     * Returns true if the diagnostic is related to import/include/package resolution.
     * These are noisy diagnostics that don't help the NES model make better edits.
     */
    private _isImportOrIncludeDiagnostic(d: vscode.Diagnostic): boolean {
        const msg = d.message.toLowerCase();
        const source = (d.source ?? '').toLowerCase();

        // Import-related patterns
        if (/\bcannot find module\b/.test(msg)) return true;
        if (/\bcould not find\b.*\bmodule\b/.test(msg)) return true;
        if (/\bunable to resolve\b.*\bmodule\b/.test(msg)) return true;
        if (/\bmodule.*not found\b/.test(msg)) return true;
        if (/\bmodule.*not resolved\b/.test(msg)) return true;
        if (/\bno declaration found\b/.test(msg)) return true; // .d.ts missing for import
        if (/\bcould not find declaration\b/.test(msg)) return true;
        if (/\bimplicitly has an 'any' type\b/.test(msg) && /\bimport\b/.test(msg)) return true;

        // Include/require patterns
        if (/\binclude\b.*\bnot found\b/.test(msg)) return true;
        if (/\bcannot open include file\b/.test(msg)) return true;
        if (/\bcannot open source file\b/.test(msg)) return true; // C/C++ #include
        if (/\bfile not found\b/.test(msg) && /\binclude\b/.test(msg)) return true;
        if (/\brequire\b.*\bnot found\b/.test(msg)) return true; // Lua require

        // Package/dependency resolution
        if (/\bcannot find package\b/.test(msg)) return true;
        if (/\bpackage.*not found\b/.test(msg)) return true;
        if (/\bcould not resolve\b/.test(msg)) return true;
        if (/\bunresolved\b.*\bimport\b/.test(msg)) return true;

        // Rust use/import
        if (/\bunresolved import\b/.test(msg)) return true;
        if (/\bcould not find\b.*\bin crate\b/.test(msg)) return true;

        // Source-level checks
        if (source === 'ts' && /cannot find module/.test(msg)) return true;
        if (source === 'rustc' && /unresolved import/.test(msg)) return true;

        return false;
    }
}

interface DiagnosticInfo {
    severity: 'error' | 'warning';
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    code: string | undefined;
    source: string | undefined;
    lineDistance: number;
}

function formatSingleDiagnostic(
    d: DiagnosticInfo,
    documentLines: readonly string[],
    options: LintOptions,
): string {
    let codeStr = '';
    if (d.code) {
        const src = d.source ? d.source.toUpperCase() : '';
        codeStr = ` ${src}${d.code}`;
    }

    const header = `${d.line}:${d.column} - ${d.severity}${codeStr}: ${d.message}`;

    if (options.showCode === LintOptionShowCode.NO) {
        return header;
    }

    const codeLines: string[] = [];
    const startLine = Math.max(0, d.line);
    const endLine = Math.min(documentLines.length - 1, d.endLine);

    const contextStart = options.showCode === 'YES_WITH_SURROUNDING' ? Math.max(0, startLine - 1) : startLine;
    const contextEnd = options.showCode === 'YES_WITH_SURROUNDING' ? Math.min(documentLines.length - 1, endLine + 1) : endLine;

    for (let i = contextStart; i <= contextEnd; i++) {
        const line = documentLines[i] ?? '';
        codeLines.push(`${i}|${line}`);
    }

    return header + '\n' + codeLines.join('\n');
}

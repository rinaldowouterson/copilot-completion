/**
 * Phase H: Auto-import detection via LSP diagnostics.
 *
 * Reads `vscode.languages.getDiagnostics(uri)` to find unresolved symbols
 * in the current document, then asks the LSP for a `quickfix`
 * `CodeAction` that adds the missing import. The resulting
 * `WorkspaceEdit` is flattened to an array of `TextEdit`s suitable for
 * `InlineCompletionItem.additionalTextEdits`.
 *
 * Zero model tokens — purely LSP-driven.
 */

import * as vscode from 'vscode';

/** One auto-import fix to surface as an NES suggestion. */
export interface AutoImportFix {
    /** The unresolved symbol (e.g. "debounce"). */
    symbolName: string;
    /** Diagnostic range — where the missing name appears in the document. */
    range: vscode.Range;
    /** All TextEdits the LSP wants to apply (may include edits to other files). */
    edits: vscode.TextEdit[];
}

/** Cap concurrent auto-import fixes per gather. */
const AUTO_IMPORT_LIMIT = 5;

/**
 * Regex patterns that identify "missing name" diagnostics. Different
 * LSPs phrase the message slightly differently — match all variants.
 *
 *   TS: "Cannot find name 'debounce'."
 *   Pylance: "Cannot find name 'debounce'."
 *   Java: "Cannot find symbol"  (covered separately below)
 */
const MISSING_NAME_PATTERNS: RegExp[] = [
    /Cannot find name ['"]([^'"]+)['"]/i,
    /['"]([A-Za-z_$][\w$]*)['"] is not defined/i,
    /Cannot find symbol/i,
    /Use of undeclared identifier ['"]([^'"]+)['"]/i,
];

function extractMissingName(message: string): string | undefined {
    for (const pat of MISSING_NAME_PATTERNS) {
        const m = pat.exec(message);
        if (m && m[1]) return m[1];
    }
    return undefined;
}

/**
 * Detect missing imports and gather the LSP's quickfix edits for each.
 *
 * Returns up to `AUTO_IMPORT_LIMIT` fixes. Filters to quickfix actions
 * that contain import statements.
 */
export async function detectMissingImports(
    document: vscode.TextDocument,
    options: {
        /** Optional cancellation token — kills any pending LSP calls. */
        token?: vscode.CancellationToken;
    } = {},
): Promise<AutoImportFix[]> {
    let diagnostics: vscode.Diagnostic[];
    try {
        diagnostics = vscode.languages.getDiagnostics(document.uri);
    } catch {
        return [];
    }
    const missing = diagnostics
        .filter(d => extractMissingName(d.message) !== undefined)
        .slice(0, AUTO_IMPORT_LIMIT);

    if (missing.length === 0) return [];

    const fixes: AutoImportFix[] = [];
    for (const diag of missing) {
        if (options.token?.isCancellationRequested) break;
        const symbolName = extractMissingName(diag.message);
        if (!symbolName) continue;

        try {
            const actions = await vscode.commands.executeCommand<
                (vscode.Command | vscode.CodeAction)[] | undefined
            >(
                'vscode.executeCodeActionProvider',
                document.uri,
                diag.range,
                'quickfix',
            );
            if (!actions) continue;

            const fix = pickImportFix(actions);
            if (!fix) continue;

            fixes.push({
                symbolName,
                range: diag.range,
                edits: fix,
            });
        } catch {
            continue;
        }
    }

    return fixes;
}

/**
 * Pick the first quickfix CodeAction that adds an import statement.
 * Returns the flattened TextEdit[] (across all files in the edit).
 */
function pickImportFix(
    actions: ReadonlyArray<vscode.Command | vscode.CodeAction>,
): vscode.TextEdit[] | undefined {
    for (const action of actions) {
        if (!isCodeAction(action)) continue;
        if (!action.edit) continue;

        const edits = flattenWorkspaceEdit(action.edit);
        if (edits.length === 0) continue;

        const hasImport = edits.some(e => /\bimport\b/.test(e.newText));
        if (!hasImport) continue;

        return edits;
    }
    return undefined;
}

/** Type guard for `CodeAction` (excludes raw `Command`). */
function isCodeAction(
    action: vscode.Command | vscode.CodeAction,
): action is vscode.CodeAction {
    return (action as vscode.CodeAction).edit !== undefined
        || (action as vscode.CodeAction).kind !== undefined;
}

/**
 * Flatten a `WorkspaceEdit` to a flat `TextEdit[]`. Skips snippet and
 * notebook edits (we only need plain text edits for inline completion).
 *
 * Requires VS Code 1.91+ for the `entries()` method (we target 1.110+).
 */
export function flattenWorkspaceEdit(edit: vscode.WorkspaceEdit): vscode.TextEdit[] {
    const out: vscode.TextEdit[] = [];
    for (const [, edits] of edit.entries()) {
        for (const e of edits) {
            if (isTextEdit(e)) out.push(e);
        }
    }
    return out;
}

function isTextEdit(e: vscode.TextEdit | vscode.SnippetTextEdit | unknown): e is vscode.TextEdit {
    return (
        typeof e === 'object'
        && e !== null
        && 'range' in (e as object)
        && 'newText' in (e as object)
        && !('snippet' in (e as object))
    );
}

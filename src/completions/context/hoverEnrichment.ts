/**
 * Phase C: Hover enrichment for cross-file type signatures.
 *
 * Calls `vscode.executeHoverProvider` and cleans the Markdown output
 * into a single-line type string suitable for prompt formatting:
 *
 *   `formatDate(d: Date): string`
 *
 * The hover response can be:
 *   - `(MarkdownString | MarkedString)[]`
 *   - Markdown with code fences (` ```ts ... ``` `)
 *   - Multi-line output (collapsed to a single line)
 *   - Plain strings (returned as-is)
 *
 * Returns `undefined` when hover is unavailable / empty / fails.
 */

import * as vscode from 'vscode';

/**
 * Maximum length of a hover signature in the prompt. Longer signatures
 * are truncated with an ellipsis. Keeps the prompt bounded even when
 * the LSP returns verbose type information.
 */
export const HOVER_MAX_SIGNATURE_LENGTH = 120;

export async function fetchHoverSignature(
    document: vscode.TextDocument,
    position: vscode.Position,
): Promise<string | undefined> {
    try {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
            'vscode.executeHoverProvider',
            document.uri,
            position,
        );
        if (!hovers || hovers.length === 0) return undefined;
        const contents = hovers[0].contents;
        if (!Array.isArray(contents) || contents.length === 0) return undefined;

        const raw = contents
            .map(c => {
                if (typeof c === 'string') return c;
                // MarkdownString and MarkedString both expose `.value`
                return (c as { value: string }).value ?? '';
            })
            .filter(Boolean)
            .join('\n');

        if (raw.trim().length === 0) return undefined;

        return cleanHoverSignature(raw);
    } catch {
        return undefined;
    }
}

/**
 * Clean hover output for inclusion in the prompt.
 *
 * - Strips triple-backtick code fences (```ts\n…\n```)
 * - Collapses newlines to single spaces
 * - Strips leading language tags (e.g. "ts" after the fence)
 * - Truncates long signatures with an ellipsis
 */
export function cleanHoverSignature(raw: string): string {
    let s = raw;
    // Remove opening code fences (```lang\n or ```\n)
    s = s.replace(/```[a-zA-Z0-9_+-]*\n?/g, '');
    // Remove closing code fences
    s = s.replace(/```/g, '');
    // Collapse all whitespace (including newlines) to single spaces
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length === 0) return '';
    if (s.length > HOVER_MAX_SIGNATURE_LENGTH) {
        return s.slice(0, HOVER_MAX_SIGNATURE_LENGTH - 1) + '…';
    }
    return s;
}
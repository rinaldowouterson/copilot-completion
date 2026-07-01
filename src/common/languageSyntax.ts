import * as vscode from 'vscode';
import { LanguageSyntax } from './contextBundle';

/**
 * Default syntax rules for C-family languages.
 * Covers TypeScript, JavaScript, C, C++, Java, Go, Rust, C#, Kotlin, Swift, Dart, etc.
 * These are the ~80% case — most users need nothing else configured.
 */
const DEFAULT_SYNTAX: LanguageSyntax = {
    semicolons: true,
    indentationSignificant: false,
    brackets: ['()', '[]', '{}'],
    continuationOperators: [
        '.', ',', '+', '-', '*', '/', '%', '|',
        '&', '?', '=>', '->', '::', '||', '&&', '?.', '??',
    ],
    comment: '//',
};

/**
 * Per-language overrides. Unlisted languages inherit DEFAULT_SYNTAX.
 * Only deviations from the default need to be specified here.
 */
const LANGUAGE_SYNTAX: Record<string, Partial<LanguageSyntax>> = {
    // No semicolons
    python: {
        semicolons: false,
        indentationSignificant: true,
        comment: '#',
        continuationOperators: ['\\'],
    },
    ruby: {
        semicolons: false,
        continuationOperators: ['.', '|', ',', '::', '=>'],
    },
    shellscript: {
        semicolons: false,
        continuationOperators: ['|', '&&', '||', '\\'],
        comment: '#',
    },
    yaml: { semicolons: false, comment: '#' },
    toml: { semicolons: false, comment: '#' },
    makefile: { semicolons: false, comment: '#' },
    powershell: { semicolons: false, continuationOperators: ['|', '|%', '$_'], comment: '#' },

    // Semicolons present, language-specific operators
    go: { continuationOperators: ['.', ',', ':', '->'] },
    rust: { continuationOperators: ['.', ',', '|', '::', '->', '=>'] },
    csharp: { continuationOperators: ['.', ',', '?', '::', '=>'] },
    java: { continuationOperators: ['.', ',', '::', '?'] },
    kotlin: { continuationOperators: ['.', ',', '?', '::', '->', '?:'] },
    swift: { continuationOperators: ['.', ',', '?', '->', '?:'] },
    dart: { continuationOperators: ['.', ',', '?', '=>'] },

    // Alternative comment styles
    sql: { comment: '--' },
    haskell: { semicolons: false, indentationSignificant: true, comment: '--' },
    lua: { semicolons: false, comment: '--' },
    elixir: { semicolons: false, comment: '#', continuationOperators: ['|', '.', ',', '->'] },
};

/** Retrieve syntax rules for a given VS Code language ID. */
export function getSyntax(languageId: string): LanguageSyntax {
    const overrides = LANGUAGE_SYNTAX[languageId];
    if (!overrides) {
        return DEFAULT_SYNTAX;
    }
    return { ...DEFAULT_SYNTAX, ...overrides };
}

/**
 * Determine whether a line ends with an operator that suggests
 * the expression continues on the next line.
 */
function endsWithContinuation(line: string, syntax: LanguageSyntax): boolean {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    // Ignore comment-only lines
    if (trimmed.startsWith(syntax.comment)) return false;
    // Remove trailing line comment
    const code = syntax.comment === '//'
        ? trimmed.split('//')[0].trimEnd()
        : trimmed;
    if (code.length === 0) return false;

    // Check line-ending continuation operators
    for (const op of syntax.continuationOperators) {
        if (code.endsWith(op)) return true;
    }
    // Single-line expressions ending with opening bracket
    if (code.endsWith('(') || code.endsWith('[') || code.endsWith('{')) return true;
    return false;
}

/**
 * Phase B (LSP path): Walk the SelectionRange chain to find the smallest
 * containing range that ends within `maxLines` of the cursor line.
 *
 * Returns `undefined` when:
 *   - LSP returns no ranges
 *   - No containing range fits within `maxLines`
 *   - The LSP call throws
 *
 * VS Code's SelectionRange forms a linked list (`parent` walks up to
 * larger ranges). The traversal pattern:
 *
 *   [0] cursor position → [1] expression → [2] statement → [3] block → ... → file
 *
 * We want the **deepest containing range** whose `end` is within budget.
 */
export async function findStatementEndViaLSP(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxLines: number = 30,
): Promise<number | undefined> {
    try {
        const ranges = await vscode.commands.executeCommand<vscode.SelectionRange[] | undefined>(
            'vscode.executeSelectionRangeProvider',
            document.uri,
            [position],
        );
        if (!ranges || ranges.length === 0) return undefined;

        // Walk the chain — smallest range that fits in budget wins.
        // The "smallest that fits" is the deepest containing range whose end
        // is within `maxLines` of the cursor — this gives the tightest
        // statement boundary without overshooting.
        let current: vscode.SelectionRange | undefined = ranges[0];
        let best: vscode.Range | undefined;

        while (current) {
            if (current.range.contains(position)) {
                const distance = current.range.end.line - position.line;
                if (distance >= 0 && distance <= maxLines) {
                    if (!best || current.range.end.line < best.end.line) {
                        best = current.range;
                    }
                }
            }
            current = current.parent;
        }

        return best?.end.line;
    } catch {
        return undefined;
    }
}

/**
 * Heuristic statement-end detection (renamed from `findStatementEnd` so the
 * new async combined `findStatementEnd(document, position)` can use the
 * LSP-first signature).
 *
 * Pure function — no LSP, no VS Code dependency on the document API.
 * Used as the fallback when LSP SelectionRange is unavailable.
 *
 * Walk forward from `startLine` to find the end of the current statement.
 *
 * The heuristic is applied in order:
 * 1. Semicolon scan (if the language uses semicolons)
 * 2. Bracket-depth balancing
 * 3. Continuation-operator scan
 * 4. Indentation reset (for indentation-significant languages)
 * 5. Budget cap at 30 lines
 */
export function findStatementEndHeuristic(
    lines: readonly string[],
    startLine: number,
    syntax: LanguageSyntax,
    maxLines: number = 30,
): number {
    // Defensive: empty document or startLine past end → return what's safe
    if (lines.length === 0) return 0;
    const safeStart = Math.max(0, Math.min(startLine, lines.length - 1));
    const endOfDoc = lines.length - 1;
    const budgetEnd = Math.max(safeStart, Math.min(safeStart + maxLines - 1, endOfDoc));
    const baseIndent = guessIndent(lines[safeStart]);

    let bracketDepth = 0;

    for (let line = safeStart; line <= budgetEnd; line++) {
        const text = lines[line];
        if (text === undefined) continue;
        const trimmed = text.trim();

        // Track bracket depth and count closing brackets on this line.
        // A line that closes a bracket is always part of the statement,
        // even after the bracket depth reaches 0.
        let bracketsClosedThisLine = 0;
        for (const ch of text) {
            if (ch === '(' || ch === '[' || ch === '{') bracketDepth++;
            if (ch === ')' || ch === ']' || ch === '}') {
                bracketDepth--;
                bracketsClosedThisLine++;
            }
        }
        bracketDepth = Math.max(0, bracketDepth);

        // Rule 1: semicolon at depth 0 → statement end
        if (syntax.semicolons && bracketDepth === 0) {
            const codePart = syntax.comment === '//'
                ? trimmed.split('//')[0].trimEnd()
                : trimmed;
            if (codePart.endsWith(';')) return line;
        }

        // Skip the first line — we're looking for the END of the statement,
        // which by definition is past the cursor line.
        if (line === startLine) continue;

        // Rule 2a: bracket depth > 0 → statement continues
        if (bracketDepth > 0) continue;

        // Rule 2b: brackets closed on this line → the closing bracket line
        // is part of the statement, even though depth is now 0.
        if (bracketsClosedThisLine > 0) continue;

        // Rule 3: continuation operator at end of line → statement continues
        if (endsWithContinuation(text, syntax)) continue;

        // Rule 4: for indent-significant languages, check indent reset
        if (syntax.indentationSignificant) {
            const lineIndent = guessIndent(text);
            if (lineIndent > baseIndent) continue;
        }

        // Rule 5: next line starts with continuation operator prefix → belongs to same statement
        if (line < endOfDoc) {
            const nextLine = lines[line + 1].trim();
            if (nextLine.startsWith('.') || nextLine.startsWith('?.') || nextLine.startsWith('[')) continue;
        }

        // Rule 6: this line starts with a dot-chaining prefix → continuation
        // of the previous line (e.g. `obj\n  .method()`).
        const startChars = trimmed;
        if (startChars.startsWith('.') || startChars.startsWith('?.')) continue;

        // All rules passed — this line is NOT part of the same statement.
        // The statement terminated on the PREVIOUS line.
        return line - 1;
    }

    // Budget cap reached, return the last line scanned
    return budgetEnd;
}

/**
 * Phase B (combined): LSP SelectionRange primary + heuristic fallback.
 *
 * Tries the LSP first for exact statement boundaries; falls back to the
 * pure heuristic when the LSP isn't indexed, doesn't support
 * SelectionRange, or returns no useful range.
 *
 * Always resolves — callers never have to handle `undefined`.
 */
export async function findStatementEnd(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxLines: number = 30,
): Promise<number> {
    // 1. LSP path — exact boundaries
    const lspResult = await findStatementEndViaLSP(document, position, maxLines);
    if (lspResult !== undefined) return lspResult;

    // 2. Heuristic fallback — fast, works for any language
    return findStatementEndHeuristic(
        document.getText().split('\n'),
        position.line,
        getSyntax(document.languageId),
        maxLines,
    );
}

/** Guess the indentation level (number of leading spaces) of a line. */
function guessIndent(line: string): number {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
}

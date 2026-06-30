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
 * Walk forward from `startLine` to find the end of the current statement.
 *
 * The heuristic is applied in order:
 * 1. Semicolon scan (if the language uses semicolons)
 * 2. Bracket-depth balancing
 * 3. Continuation-operator scan
 * 4. Indentation reset (for indentation-significant languages)
 * 5. Budget cap at 30 lines
 *
 * Returns the 0-based line number where the statement ends,
 * or `startLine` if no end was found within budget.
 *
 * @param lines — Document lines array (split by '\n')
 * @param startLine — 0-based line of the cursor
 * @param syntax — Language syntax rules
 * @param maxLines — Maximum lines to scan forward (default 30)
 */
export function findStatementEnd(
    lines: readonly string[],
    startLine: number,
    syntax: LanguageSyntax,
    maxLines: number = 30,
): number {
    const endOfDoc = lines.length - 1;
    const budgetEnd = Math.min(startLine + maxLines, endOfDoc);
    const baseIndent = guessIndent(lines[startLine]);

    let bracketDepth = 0;

    for (let line = startLine; line <= budgetEnd; line++) {
        const text = lines[line];
        const trimmed = text.trim();

        // Track bracket depth
        for (const ch of text) {
            if (ch === '(' || ch === '[' || ch === '{') bracketDepth++;
            if (ch === ')' || ch === ']' || ch === '}') bracketDepth--;
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

        // Rule 2: bracket depth > 0 → statement continues
        if (bracketDepth > 0) continue;

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

        // All rules passed — this line terminates the statement
        return line;
    }

    // Budget cap reached, return the last line scanned
    return budgetEnd;
}

/** Guess the indentation level (number of leading spaces) of a line. */
function guessIndent(line: string): number {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
}

/**
 * Shared types for the context building pipeline.
 *
 * A ContextBundle is produced by IContextBuilderService and consumed by
 * both GHOST (FIM) and NES (edit prediction) prompt factories. Each
 * pipeline formats the bundle according to its template format (FIM
 * comment lines for GHOST, <|tags|> for NES).
 */

/** Language-specific syntax rules for heuristic statement-end detection. */
export interface LanguageSyntax {
    /** Whether this language requires semicolons at statement end (TS, JS, C, etc.) */
    semicolons: boolean;
    /** Whether indentation changes signal scope boundaries (Python, YAML, etc.) */
    indentationSignificant: boolean;
    /** Bracket pairs to balance, e.g. ['()', '[]', '{}'] */
    brackets: string[];
    /** Line-ending tokens that indicate the expression continues on the next line. */
    continuationOperators: string[];
    /** Line comment prefix, e.g. '//' or '#' */
    comment: string;
}

/** A symbol exported or defined at top level in a file. */
export interface FileExport {
    name: string;
    kind: string; // 'Function' | 'Class' | 'Interface' | 'Variable' | 'Method' | ...
    line: number;
}

/** A symbol used in the current file but not imported. */
export interface MissingImport {
    symbolName: string;
    /** The module path the language server suggests for the import. */
    sourceModule?: string;
}

/**
 * An import statement resolved to its target file's exported symbols.
 * Produced by the LSP's document link provider — no regex, no AST.
 */
export interface ImportResolution {
    /** The resolved absolute URI of the imported file (string form). */
    uri: string;
    /** Exported symbols from that file. */
    exports: FileExport[];
}

/** The enclosing scope around the cursor position. */
export interface EnclosingScope {
    kind: string;  // 'Function' | 'Class' | 'Interface' | 'Method' | ...
    name: string;
    startLine: number;
    endLine: number;
}

/**
 * Structured context produced by IContextBuilderService.
 *
 * All fields are optional — each consumer (GHOST/NES) should handle
 * missing fields gracefully. A field is missing when the LSP query
 * failed, the heuristic scan timed out, or the file is too large.
 */
export interface ContextBundle {
    /** The enclosing scope around the cursor (deepest containing class or function). */
    enclosingScope?: EnclosingScope;

    /**
     * The line where the current statement/expression ends, as determined
     * by the heuristic combined scan (semicolon → bracket-depth → 
     * continuation-operator → indentation → 30-line budget cap).
     * Used by NES to shrink the edit window, and by GHOST to optionally
     * trim the suffix.
     */
    statementEndLine?: number;

    /** Top-level symbols exported by the current file. */
    fileExports: FileExport[];

    /** Symbols referenced in the current file that are not yet imported. */
    missingImports: MissingImport[];

    /**
     * Resolved import targets with their exported symbols.
     * Each entry corresponds to one unique import statement in the current file,
     * resolved via the LSP document link provider. Limited to the first 5 unique
     * workspace-local imports to keep prompt size bounded.
     */
    importResolutions: ImportResolution[];

    /** The language ID (from VS Code). */
    languageId: string;

    /** The syntax rules used for the statement-end heuristic. */
    languageSyntax: LanguageSyntax;
}

/**
 * Shared types for the context building pipeline.
 *
 * A ContextBundle is produced by IContextBuilderService and consumed by
 * both GHOST (FIM) and NES (edit prediction) prompt factories. Each
 * pipeline formats the bundle according to its template format (FIM
 * comment lines for GHOST, <|tags|> for NES).
 */

import type { FileKind } from './fileKind';

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
    /** LSP `SymbolKind` name, e.g. 'Function' | 'Class' | 'Interface' | 'Variable' | 'Method'. */
    kind: string;
    /** 0-based line of the declaration. */
    line: number;
    /**
     * Optional hover-derived type signature. When present, formatters prefer
     * `name:type` over `name:Kind` (Phase C).
     */
    type?: string;
}

/** A symbol used in the current file but not yet imported. */
export interface MissingImport {
    symbolName: string;
    /** The module path the language server suggests for the import (when known). */
    sourceModule?: string;
}

/**
 * An import statement resolved to its target file's exported symbols.
 *
 * The `relativePath` field is **mandatory** — every import has a path. It
 * is resolved during `ContextBuilderService.gather()` (not in the prompt
 * formatters) so both GHOST and NES read the same canonical path.
 *
 * `typeSignatures` (optional) carries hover-derived signatures for the
 * top exports of the imported file. When present, formatters prefer
 * `name:type` over `name:Kind`.
 */
export interface ImportResolution {
    /** The resolved absolute URI of the imported file (string form). */
    uri: string;
    /**
     * Workspace-relative path with leading `./` and file extension.
     * Always present — resolved during `gather()`.
     * Examples: "./Button.tsx", "../utils/helpers.ts", "./types/User.ts"
     */
    relativePath: string;
    /** Exported symbols from that file. */
    exports: FileExport[];
    /**
     * Optional hover-derived type signatures for the top exports.
     * Keyed by `FileExport.name`. Formatters prefer `name:type` when present.
     */
    typeSignatures?: Record<string, string>;
    /**
     * The kind of file that was imported (code, image, audio, font, etc.).
     * Detected from the file extension during import resolution.
     * `'code'` for known programming languages, `'unknown'` for unrecognised
     * extensions. Consumers (GHOST/NES prompt factories) can use this to
     * skip non-code imports or format them differently.
     */
    fileKind: FileKind;
}

/** The enclosing scope around the cursor position. */
export interface EnclosingScope {
    kind: string;  // 'Function' | 'Class' | 'Interface' | 'Method' | ...
    name: string;
    /** 0-based inclusive start line of the enclosing symbol. */
    startLine: number;
    /** 0-based inclusive end line of the enclosing symbol. */
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
     * by the LSP SelectionRange provider (with heuristic fallback).
     * Used by NES to shrink the edit window, and by GHOST to optionally
     * trim the suffix.
     */
    statementEndLine?: number;

    /** Top-level symbols exported by the current file. */
    fileExports: FileExport[];

    /**
     * Symbols referenced in the current file that are not yet imported.
     * Populated by the Phase H auto-import detection.
     */
    missingImports: MissingImport[];

    /**
     * Resolved import targets with their exported symbols.
     * Each entry corresponds to one unique import statement in the current file,
     * resolved via the LSP document link provider (with file-system fallback).
     * Limited to the first 5 unique workspace-local imports to keep prompt
     * size bounded.
     */
    importResolutions: ImportResolution[];

    /**
     * Phase G: Super-types of the enclosing class/interface (OOP languages).
     * `undefined` for functional languages, languages without type hierarchy
     * support, or when the cursor is not on a class/interface declaration.
     * Capped at 5 super-types.
     */
    superTypes?: EnclosingScope[];

    /** The language ID (from VS Code). */
    languageId: string;

    /** The syntax rules used for the statement-end heuristic. */
    languageSyntax: LanguageSyntax;
}

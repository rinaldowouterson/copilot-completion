import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../di/services';
import { ServiceIdentifier } from '../../di/instantiation';
import { ContextBundle, FileExport, EnclosingScope, ImportResolution } from '../../common/contextBundle';
import { getSyntax, findStatementEnd } from '../../common/languageSyntax';
import { LRUCacheMap } from '../../common/lruCacheMap';
import { ILogService } from '../shared/log/logService';

export const IContextBuilderService: ServiceIdentifier<IContextBuilderService> =
    createServiceIdentifier<IContextBuilderService>('IContextBuilderService');

export interface IContextBuilderService {
    readonly _serviceBrand: undefined;

    /**
     * Gather structured context for the given document at the given position.
     * Returns an empty bundle (all fields default/empty) when:
     *  - contextScoping config is 'basic'
     *  - the document has no LSP symbols available
     */
    gather(document: vscode.TextDocument, position: vscode.Position): Promise<ContextBundle>;
}

/**
 * Configuration shape read from VS Code settings by the builder.
 * Brittle by design — avoids a full DI config dependency for a single setting key.
 * If more settings are needed, switch to proper IGhostConfigProvider/INesConfigProvider injection.
 */
/** Flat symbol shape used for the workspace-wide symbol index. */
interface SimpleSymbol {
    name: string;
    kind: vscode.SymbolKind;
    containerName: string;
    uri: string;
    range: vscode.Range;
}

interface ContextConfig {
    ghostScoping: 'basic' | 'lsp';
    nesScoping: 'basic' | 'lsp';
    cacheMaxEntries: number;
    workspaceIndexMode: 'off' | 'opened-files' | 'workspace';
}

function readConfig(): ContextConfig {
    const cfg = vscode.workspace.getConfiguration('cc-completion');
    return {
        ghostScoping: cfg.get<'basic' | 'lsp'>('ghost.contextScoping', 'lsp'),
        nesScoping: cfg.get<'basic' | 'lsp'>('nes.contextScoping', 'lsp'),
        cacheMaxEntries: cfg.get<number>('context.lspCacheMaxEntries', 500),
        workspaceIndexMode: cfg.get<'off' | 'opened-files' | 'workspace'>('context.workspaceIndexMode', 'workspace'),
    };
}

/** Cache entry: symbol tree + the line count at the time of fetch (cache invalidation hint). */
interface CacheEntry {
    symbols: vscode.DocumentSymbol[];
    lineCount: number;
}

export class ContextBuilderService implements IContextBuilderService {
    readonly _serviceBrand: undefined;

    private readonly _cache = new LRUCacheMap<string, CacheEntry>(readConfig().cacheMaxEntries);

    /** Per-file workspace symbol index keyed by document URI. Seeded on first gather, refreshed on save. */
    private readonly _workspaceCache = new Map<string, SimpleSymbol[]>();
    private _workspaceSeeded = false;

    constructor(
        @ILogService private readonly _log: ILogService,
    ) {
        // Invalidate per-file cache when text changes (next gather re-fetches fresh data).
        vscode.workspace.onDidChangeTextDocument(e => {
            this._cache.delete(e.document.uri.toString());
        });

        // Re-query workspace index on save — all files are up to date at this point.
        vscode.workspace.onDidSaveTextDocument(() => {
            this._workspaceSeeded = false;
            void this._seedWorkspaceCache();
        });
    }

    async gather(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<ContextBundle> {
        const config = readConfig();
        const uri = document.uri.toString();
        const languageId = document.languageId;
        const syntax = getSyntax(languageId);

        // Seed workspace index on first gather (only if mode='workspace')
        if (config.workspaceIndexMode === 'workspace' && !this._workspaceSeeded) {
            this._workspaceSeeded = true;
            void this._seedWorkspaceCache();
        }

        // Per-file LSP symbol lookup (cached, invalidated on edit)
        let symbols = this._cache.get(uri);
        if (!symbols || symbols.lineCount !== document.lineCount) {
            const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri,
            );
            symbols = {
                symbols: rawSymbols ?? [],
                lineCount: document.lineCount,
            };
            this._cache.set(uri, symbols);
        }

        // Merge per-file symbols into workspace cache (keeps current file fresh)
        this._mergeDocumentSymbols(document.uri.toString(), symbols.symbols);

        // Build the bundle
        const fileExports = extractFileExports(symbols.symbols, languageId);
        const enclosingScope = findEnclosingScope(symbols.symbols, position);
        const statementEndLine = findStatementEnd(
            document.getText().split('\n'),
            position.line,
            syntax,
        );

        // Context gathered successfully — log summary
        if (fileExports.length > 0 || enclosingScope) {
            const scopeInfo = enclosingScope
                ? `scope=${enclosingScope.kind} ${enclosingScope.name} (${enclosingScope.startLine}-${enclosingScope.endLine})`
                : 'no_enclosing_scope';
            const exportCount = fileExports.length;
            const wsFiles = this._workspaceCache.size;
            this._log.debug(`[CONTEXT] ${scopeInfo} exports=${exportCount} ws_files=${wsFiles} statement_end=${statementEndLine}`);
        }

        // Resolve import targets via LSP document links (cached per-file)
        const importResolutions = config.ghostScoping === 'lsp' || config.nesScoping === 'lsp'
            ? await this._resolveImportTargets(document.uri, document.getText(), languageId)
            : [];

        return {
            enclosingScope,
            statementEndLine,
            fileExports,
            missingImports: [], // deferred — cross-file import detection in a follow-up
            importResolutions,
            languageId,
            languageSyntax: syntax,
        };
    }

    /**
     * Query the full workspace symbol index from the LSP and store in workspace cache.
     * Called once on first gather and again on each file save.
     */
    private async _seedWorkspaceCache(): Promise<void> {
        try {
            const allSymbols = await vscode.commands.executeCommand<{ name: string; kind: vscode.SymbolKind; containerName: string; location: vscode.Location }[]>(
                'vscode.executeWorkspaceSymbolProvider',
                '',  // empty query returns all symbols
            );
            this._workspaceCache.clear();
            if (allSymbols) {
                for (const sym of allSymbols) {
                    const uri = sym.location.uri.toString();
                    if (!this._workspaceCache.has(uri)) {
                        this._workspaceCache.set(uri, []);
                    }
                    this._workspaceCache.get(uri)!.push({
                        name: sym.name,
                        kind: sym.kind,
                        containerName: sym.containerName,
                        uri,
                        range: sym.location.range,
                    });
                }
            }
        } catch {
            // Workspace provider not available (e.g. LSP not started) — cache stays empty.
        }
    }

    /**
     * Convert a per-file DocumentSymbol tree to flat SimpleSymbol entries and
     * merge into the workspace cache. Keeps the workspace index fresh for the
     * current file without a full re-query.
     */
    private _mergeDocumentSymbols(uri: string, symbols: vscode.DocumentSymbol[]): void {
        const flat: SimpleSymbol[] = [];
        const walk = (list: vscode.DocumentSymbol[], container: string) => {
            for (const sym of list) {
                flat.push({ name: sym.name, kind: sym.kind, containerName: container, uri, range: sym.range });
                if (sym.children) walk(sym.children, sym.name);
            }
        };
        walk(symbols, '');
        this._workspaceCache.set(uri, flat);
    }

    /**
     * Resolve relative import statements to their target files using file-system lookups.
     *
     * Extracts import specifiers from the source text (e.g. `'./Button'`, `'../utils'`,
     * `from .module import X`, `#include "header.h"`), resolves them relative to the
     * source file's directory, tries language-appropriate extensions, and fetches each
     * target's exported symbols via the per-file LRU cache.
     *
     * Only follows relative imports — package imports (`react`, `lodash`) and
     * build-system paths (`java.util.List`) are skipped.
     *
     * Limited to 5 unique targets to keep prompt size bounded.
     */
    private async _resolveImportTargets(
        sourceUri: vscode.Uri,
        sourceText: string,
        languageId: string,
    ): Promise<ImportResolution[]> {
        const startTime = Date.now();
        const resolved: ImportResolution[] = [];
        const seen = new Set<string>();

        const specifiers = extractRelativeImportSpecifiers(sourceText, languageId);
        if (specifiers.length === 0) return [];

        const sourceDir = sourceUri.fsPath ? sourceUri.fsPath.substring(0, sourceUri.fsPath.lastIndexOf('/')) : '';

        for (const specifier of specifiers) {
            if (resolved.length >= 5) break;
            if (seen.has(specifier)) continue;
            seen.add(specifier);

            const targetUri = await resolveSpecifierToUri(specifier, sourceDir, sourceUri.scheme, languageId);
            if (!targetUri) continue;

            const targetUriStr = targetUri.toString();
            if (seen.has(targetUriStr)) continue;
            seen.add(targetUriStr);

            // Skip the source file itself
            if (targetUriStr === sourceUri.toString()) continue;

            try {
                const targetDoc = await vscode.workspace.openTextDocument(targetUri);
                const targetKey = targetDoc.uri.toString();

                let symbols = this._cache.get(targetKey);
                if (!symbols || symbols.lineCount !== targetDoc.lineCount) {
                    const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                        'vscode.executeDocumentSymbolProvider',
                        targetDoc.uri,
                    );
                    symbols = {
                        symbols: rawSymbols ?? [],
                        lineCount: targetDoc.lineCount,
                    };
                    this._cache.set(targetKey, symbols);
                }

                const exports = extractFileExports(symbols.symbols, targetDoc.languageId);
                if (exports.length > 0) {
                    resolved.push({ uri: targetUriStr, exports });
                }
            } catch {
                // File not found or inaccessible — skip
                continue;
            }
        }

        if (resolved.length > 0) {
            this._log.debug(`[CONTEXT] resolved ${resolved.length} imports in ${Date.now() - startTime}ms`);
        }
        return resolved;
    }
}

/**
 * Extract relative import specifiers from source text, language-aware.
 *
 * Supports:
 *   - JS/TS:   import { X } from './foo'    /   require('./foo')
 *   - Python:  from . import X              /   from .module import X
 *   - Ruby:    require './file'             /   require_relative './file'
 *   - Go:      import "./pkg"
 *   - Dart:    import './file.dart'
 *   - PHP:     require './file.php'         /   include './file.php'
 *   - C/C++:   #include "file.h"
 *
 * @internal Exported for unit testing only.
 */
export function extractRelativeImportSpecifiers(text: string, languageId: string): string[] {
    const specifiers: string[] = [];
    const seen = new Set<string>();
    const patterns = buildPatternsForLanguage(languageId);
    if (patterns.length === 0) return [];

    // Single pass: scan line by line. For each line, find ALL keyword occurrences.
    // This avoids O(n²) from calling indexOf() over the full remaining text.
    const lines = text.split('\n');
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (!line) continue;

        // Scan the line for each pattern, then for multiple occurrences of the same
        // pattern (e.g. two `from` imports on one line).
        for (const [keyword, advance] of patterns) {
            let searchPos = 0;
            while (searchPos < line.length) {
                const kwIdx = line.indexOf(keyword, searchPos);
                if (kwIdx < 0) break;

                const result = extractSpecifierFromMatch(line, keyword, advance, kwIdx, languageId);
                if (result) {
                    const { specifier, isQuotedInclude } = result;
                    if (specifier && !seen.has(specifier)) {
                        const isRelativePath = specifier.startsWith('./') || specifier.startsWith('../');
                        const isRelativePython = languageId === 'python' && specifier.startsWith('.');
                        if (isRelativePath || isRelativePython || isQuotedInclude) {
                            seen.add(specifier);
                            specifiers.push(specifier);
                        }
                    }
                }
                // Advance past this keyword to find the next one on the same line
                searchPos = kwIdx + 1;
            }
        }
    }

    return specifiers;
}

/**
 * Extract the import specifier from a line that matched an import keyword.
 * Returns undefined if the specifier is malformed or missing.
 */
function extractSpecifierFromMatch(
    line: string,
    keyword: string,
    advance: number,
    kwIdx: number,
    languageId: string,
): { specifier: string; isQuotedInclude: boolean } | undefined {
    const afterKeyword = kwIdx + advance;

    // Python 'from . import X': specifier is a dot-prefixed module path (no quotes)
    if (languageId === 'python' && keyword === 'from ') {
        let specStart = afterKeyword;
        while (specStart < line.length && (line[specStart] === ' ' || line[specStart] === '\t')) specStart++;
        if (specStart >= line.length || line[specStart] !== '.') return undefined;
        let specEnd = specStart;
        while (specEnd < line.length && /[\w.]/.test(line[specEnd])) specEnd++;
        const specifier = line.slice(specStart, specEnd);
        if (!specifier) return undefined;
        return { specifier, isQuotedInclude: false };
    }

    // Keywords ending with quote: require "...", import "...", #include "..."
    if (keyword.endsWith('"') || keyword.endsWith("'")) {
        const quoteChar = keyword[keyword.length - 1];
        const specStart = afterKeyword;
        const specEnd = line.indexOf(quoteChar, specStart);
        if (specEnd <= specStart) return undefined;
        const specifier = line.slice(specStart, specEnd);
        return { specifier, isQuotedInclude: keyword === '#include "' };
    }

    // Non-Python 'from': from '...' import X
    if (keyword === 'from ') {
        const quote = findQuote(line, afterKeyword);
        if (!quote) return undefined;
        const specStart = quote.idx + 1;
        const specEnd = line.indexOf(quote.char, specStart);
        if (specEnd <= specStart) return undefined;
        return { specifier: line.slice(specStart, specEnd), isQuotedInclude: false };
    }

    // Keywords ending with '(': require('...'), import('...')
    if (keyword.endsWith('(')) {
        const quote = findQuote(line, afterKeyword);
        if (!quote) return undefined;
        const specStart = quote.idx + 1;
        const specEnd = line.indexOf(quote.char, specStart);
        if (specEnd <= specStart) return undefined;
        return { specifier: line.slice(specStart, specEnd), isQuotedInclude: false };
    }

    // General case: keyword followed by whitespace then a quoted string
    const quote = findQuote(line, afterKeyword);
    if (!quote) return undefined;
    const specStart = quote.idx + 1;
    const specEnd = line.indexOf(quote.char, specStart);
    if (specEnd <= specStart) return undefined;
    return { specifier: line.slice(specStart, specEnd), isQuotedInclude: false };
}

/** Build the pattern table once (per language), not every iteration. */
function buildPatternsForLanguage(languageId: string): [keyword: string, advance: number][] {
    const patterns: [string, number][] = [];
    if (languageId.startsWith('typescript') || languageId.startsWith('javascript')) {
        patterns.push(['from ', 5], ['require(', 8], ['require.resolve(', 17], ['import(', 7]);
    }
    if (['ruby'].includes(languageId)) {
        patterns.push(['require "', 9], ["require '", 9], ['require_relative "', 18], ["require_relative '", 18]);
    }
    if (['python'].includes(languageId)) {
        patterns.push(['from ', 5]);
    }
    if (['go', 'dart'].includes(languageId)) {
        patterns.push(['import "', 8], ["import '", 8]);
    }
    if (['php'].includes(languageId)) {
        patterns.push(['require "', 9], ["require '", 9], ['include "', 9], ["include '", 9],
            ['require_once "', 14], ["require_once '", 14], ['include_once "', 14], ["include_once '", 14]);
    }
    if (['c', 'cpp'].includes(languageId)) {
        patterns.push(['#include "', 10]);
    }
    if (['lua'].includes(languageId)) {
        patterns.push(['require "', 9], ["require '", 9]);
    }
    return patterns;
}

/** Find the next single or double quote in `text` starting from `pos`. */
function findQuote(text: string, pos: number): { char: string; idx: number } | undefined {
    for (let j = pos; j < text.length; j++) {
        if (text[j] === '\'') return { char: '\'', idx: j };
        if (text[j] === '"') return { char: '"', idx: j };
    }
    return undefined;
}

/**
 * Resolve a relative import specifier to a file URI, trying language-appropriate extensions.
 *
 * Candidate order:
 *   1. specifier as-is (fast path for fully-specified paths like `#include "header.h"`)
 *   2. specifier + each language extension (e.g. `./foo` → `./foo.ts`)
 *   3. specifier + /index + extension (e.g. `./foo` → `./foo/index.ts`)
 */
/** @internal Exported for unit testing only. */
export async function resolveSpecifierToUri(specifier: string, sourceDir: string, scheme: string, languageId: string = 'typescript'): Promise<vscode.Uri | undefined> {
    // Reject empty specifier or bare `.` / `..` (Python package-relative refs we can't resolve)
    if (!specifier || specifier === '.' || specifier === '..') return undefined;

    const extensions = getExtensionsForLanguage(languageId);
    const indexVariants = extensions.map(e => `/index${e}`);

    // Try as-is first (handles `#include "file.h"` where extension is already present)
    // Then try +extension, then +/index+extension
    const candidates = [
        specifier,
        ...extensions.map(ext => specifier + ext),
        ...indexVariants.map(idx => specifier + idx),
    ];

    for (const candidate of candidates) {
        const resolvedPath = sourceDir + '/' + candidate;
        // Normalize the path (remove ./ and ../)
        const normalized = normalizePath(resolvedPath);
        if (!normalized) continue;
        try {
            const uri = vscode.Uri.file(normalized).with({ scheme });
            await vscode.workspace.fs.stat(uri);
            return uri; // file exists
        } catch {
            continue;
        }
    }
    return undefined;
}

/**
 * Return the file extensions to try for the given language, ordered by likelihood.
 */
function getExtensionsForLanguage(languageId: string): string[] {
    switch (languageId) {
        case 'typescript':
        case 'typescriptreact':
            return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
        case 'javascript':
        case 'javascriptreact':
            return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
        case 'python':
            return ['.py'];
        case 'ruby':
            return ['.rb'];
        case 'go':
            return ['.go'];
        case 'dart':
            return ['.dart'];
        case 'php':
            return ['.php'];
        case 'c':
        case 'cpp':
            return ['.h', '.hpp', '.c', '.cpp'];
        case 'rust':
            // Rust uses :: paths resolved by the build system, not filesystem lookups
            return ['.rs'];
        default:
            return ['.ts', '.js', '.py', '.rb', '.go', '.rs'];
    }
}

/** Normalize a file path: resolve . and .. segments. Preserves leading slash. */
export function normalizePath(p: string): string {
    const isAbsolute = p.startsWith('/');
    const parts = p.split('/');
    const result: string[] = [];
    for (const part of parts) {
        if (part === '.' || part === '') continue;
        if (part === '..') { if (result.length > 0) result.pop(); }
        else result.push(part);
    }
    return (isAbsolute ? '/' : '') + result.join('/');
}

/** Extract top-level symbols exported by the file. */
function extractFileExports(
    symbols: vscode.DocumentSymbol[],
    _languageId: string,
): FileExport[] {
    const exports: FileExport[] = [];
    for (const sym of symbols) {
        if (isExportableKind(sym.kind)) {
            exports.push({
                name: sym.name,
                kind: kindName(sym.kind),
                line: sym.range.start.line,
            });
        }
    }
    return exports;
}

/** Walk the symbol tree to find the deepest symbol enclosing the cursor. */
function findEnclosingScope(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position,
): EnclosingScope | undefined {
    for (const sym of symbols) {
        if (sym.range.contains(position)) {
            // Check children first (deeper scope wins)
            if (sym.children) {
                const child = findEnclosingScope(sym.children, position);
                if (child) return child;
            }
            if (isScopeKind(sym.kind)) {
                return {
                    kind: kindName(sym.kind),
                    name: sym.name,
                    startLine: sym.range.start.line,
                    endLine: sym.range.end.line,
                };
            }
        }
    }
    return undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────

function isExportableKind(kind: vscode.SymbolKind): boolean {
    return [
        vscode.SymbolKind.Function,
        vscode.SymbolKind.Class,
        vscode.SymbolKind.Interface,
        vscode.SymbolKind.Enum,
        vscode.SymbolKind.Variable,
        vscode.SymbolKind.Constant,
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Property,
        vscode.SymbolKind.Object,
        vscode.SymbolKind.Struct,
        vscode.SymbolKind.TypeParameter,
    ].includes(kind);
}

function isScopeKind(kind: vscode.SymbolKind): boolean {
    return [
        vscode.SymbolKind.Function,
        vscode.SymbolKind.Class,
        vscode.SymbolKind.Interface,
        vscode.SymbolKind.Enum,
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Struct,
        vscode.SymbolKind.Module,
        vscode.SymbolKind.Namespace,
    ].includes(kind);
}

function kindName(kind: vscode.SymbolKind): string {
    return vscode.SymbolKind[kind] ?? `Kind(${kind})`;
}

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
            ? await this._resolveImportTargets(document.uri, document.getText())
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
     * Extracts import specifiers from the source text (e.g. `'./Button'`, `'../utils'`),
     * resolves them relative to the source file's directory, tries common extensions,
     * and fetches each target's exported symbols via the per-file LRU cache.
     *
     * Only follows relative imports (`./` and `../`) — package imports (`react`, `lodash`)
     * and absolute imports are skipped.
     *
     * Limited to 5 unique targets to keep prompt size bounded.
     */
    private async _resolveImportTargets(
        sourceUri: vscode.Uri,
        sourceText: string,
    ): Promise<ImportResolution[]> {
        const startTime = Date.now();
        const resolved: ImportResolution[] = [];
        const seen = new Set<string>();

        const specifiers = extractRelativeImportSpecifiers(sourceText);
        if (specifiers.length === 0) return [];

        const sourceDir = sourceUri.fsPath ? sourceUri.fsPath.substring(0, sourceUri.fsPath.lastIndexOf('/')) : '';

        for (const specifier of specifiers) {
            if (resolved.length >= 5) break;
            if (seen.has(specifier)) continue;
            seen.add(specifier);

            const targetUri = await resolveSpecifierToUri(specifier, sourceDir, sourceUri.scheme);
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
 * Extract relative import specifiers from source text.
 *
 * Finds `from '...'` and `require('...')` patterns where the specifier starts
 * with `./` or `../`. This is a simple character-level scan — no regex AST.
 *
 * @internal Exported for unit testing only.
 */
export function extractRelativeImportSpecifiers(text: string): string[] {
    const specifiers: string[] = [];
    const seen = new Set<string>();
    let i = 0;

    while (i < text.length) {
        // Look for `from` or `require` keyword
        const fromIdx = text.indexOf('from', i);
        const requireIdx = text.indexOf('require', i);
        let keywordIdx = -1;

        if (fromIdx >= 0 && (requireIdx < 0 || fromIdx < requireIdx)) {
            keywordIdx = fromIdx + 4; // past 'from'
        } else if (requireIdx >= 0) {
            keywordIdx = requireIdx + 7; // past 'require'
        } else {
            break; // no more imports
        }

        // Find the opening quote after the keyword
        const quoteStart = text.indexOf('\'', keywordIdx);
        const dquoteStart = text.indexOf('"', keywordIdx);
        let quoteChar: string | null = null;
        let specStart = -1;

        if (quoteStart >= 0 && (dquoteStart < 0 || quoteStart < dquoteStart)) {
            quoteChar = '\'';
            specStart = quoteStart + 1;
        } else if (dquoteStart >= 0) {
            quoteChar = '"';
            specStart = dquoteStart + 1;
        }

        if (quoteChar && specStart >= 0) {
            const specEnd = text.indexOf(quoteChar, specStart);
            if (specEnd > specStart) {
                const specifier = text.slice(specStart, specEnd);
                // Only follow relative imports
                if ((specifier.startsWith('./') || specifier.startsWith('../')) && !seen.has(specifier)) {
                    seen.add(specifier);
                    specifiers.push(specifier);
                }
                i = specEnd + 1;
                continue;
            }
        }
        // Move past the keyword to avoid infinite loop
        i = Math.max(fromIdx >= 0 ? fromIdx + 1 : 0, requireIdx >= 0 ? requireIdx + 1 : 0) + 1;
    }

    return specifiers;
}

/**
 * Resolve a relative import specifier to a file URI, trying common extensions.
 *
 * Order: .ts, .tsx, .js, .jsx, .mjs, .cjs, /index.ts, /index.js
 */
/** @internal Exported for unit testing only. */
export async function resolveSpecifierToUri(specifier: string, sourceDir: string, scheme: string): Promise<vscode.Uri | undefined> {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const indexVariants = extensions.map(e => `/index${e}`);

    const candidates = [
        ...extensions.map(ext => specifier + ext),
        ...indexVariants.map(idx => specifier + idx),
        specifier, // also try as-is (might be a directory with its own resolution)
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

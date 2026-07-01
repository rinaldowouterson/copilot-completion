import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../di/services';
import { ServiceIdentifier } from '../../di/instantiation';
import {
    ContextBundle,
    FileExport,
    EnclosingScope,
    ImportResolution,
    MissingImport,
    LanguageSyntax,
} from '../../common/contextBundle';
import { getSyntax, findStatementEnd } from '../../common/languageSyntax';
import { inferFileKind, type FileKind } from '../../common/fileKind';
import { LRUCacheMap } from '../../common/lruCacheMap';
import { ILogService } from '../shared/log/logService';
import { resolveRelativePath } from './relativePath';
import { fetchHoverSignature } from './hoverEnrichment';
import { LspSupportNotifier } from './lspSupport';
import { fetchSuperTypes } from './typeHierarchy';
import { detectMissingImports, AutoImportFix } from './autoImport';

export type { AutoImportFix };

// TODO(phase-I): Explore broader LSP auto-fix integration:
//   - organize imports (executeCodeActionProvider with SourceOrganizeImports)
//   - remove unused (executeCodeActionProvider with quickfix)
//   - lint auto-fixes (ESLint, Pylint, etc.)
//   - formatting (executeDocumentFormattingProvider, executeDocumentRangeFormattingProvider)
//   - refactoring suggestions (executeCodeActionProvider with refactor)
//   - type fixes (add type annotation, infer type, etc.)
// See .plans/2026-06-30-lsp-first-context-pipeline-plan.md (Phase I) for the
// full exploration plan. Deferred until Phase H (auto-import) is proven in
// production — the additionalTextEdits plumbing added here is the foundation.

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

    /**
     * Detect missing imports via LSP diagnostics + quickfix code actions.
     * Returns the flat TextEdits the LSP wants to apply. Pure LSP — no
     * model tokens consumed. Used by Phase H (NES auto-import).
     */
    detectMissingImports(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken,
    ): Promise<AutoImportFix[]>;
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
    autoImportEnabled: boolean;
    hoverEnrichmentEnabled: boolean;
    typeHierarchyEnabled: boolean;
    lspNotifyEnabled: boolean;
}

function readConfig(): ContextConfig {
    const cfg = vscode.workspace.getConfiguration('cc-completion');
    return {
        ghostScoping: cfg.get<'basic' | 'lsp'>('ghost.contextScoping', 'lsp'),
        nesScoping: cfg.get<'basic' | 'lsp'>('nes.contextScoping', 'lsp'),
        cacheMaxEntries: cfg.get<number>('context.lspCacheMaxEntries', 500),
        workspaceIndexMode: cfg.get<'off' | 'opened-files' | 'workspace'>('context.workspaceIndexMode', 'workspace'),
        autoImportEnabled: cfg.get<boolean>('context.autoImportEnabled', true),
        hoverEnrichmentEnabled: cfg.get<boolean>('context.hoverEnrichmentEnabled', true),
        typeHierarchyEnabled: cfg.get<boolean>('context.typeHierarchyEnabled', true),
        lspNotifyEnabled: cfg.get<boolean>('context.lspNotifyEnabled', true),
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

    /** Per-document hover cache — cleared on document change. */
    private readonly _hoverCache = new LRUCacheMap<string, Map<string, string>>(readConfig().cacheMaxEntries);

    /** Notifier singleton — instantiating per-gather would lose cooldown state. */
    private readonly _lspNotifier = new LspSupportNotifier();

    constructor(
        @ILogService private readonly _log: ILogService,
    ) {
        // Invalidate per-file cache when text changes (next gather re-fetches fresh data).
        vscode.workspace.onDidChangeTextDocument(e => {
            this._cache.delete(e.document.uri.toString());
            this._hoverCache.delete(e.document.uri.toString());
        });

        // Incremental workspace cache update on save: re-fetch symbols for only
        // the saved file instead of invalidating the entire cache and re-querying
        // the expensive workspace symbol provider. Cross-file changes are resolved
        // lazily on the next gather() for dependent files.
        vscode.workspace.onDidSaveTextDocument((doc) => {
            void this._updateFileInWorkspaceCache(doc);
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

        // Every phase is independently try/caught so gather() returns
        // whatever partial data is available — never an empty bundle
        // unless everything failed. See _gatherImpl for per-phase isolation.
        return this._gatherImpl(document, position, config, uri, languageId, syntax);
    }

    /**
     * Gather whatever context is available, phase by phase.
     *
     * Each phase is independently try/caught so a failure in one (e.g. LSP
     * symbol provider timed out) doesn't prevent the others from running.
     * The fallback bundle always contains at minimum languageId and syntax.
     */
    private async _gatherImpl(
        document: vscode.TextDocument,
        position: vscode.Position,
        config: ContextConfig,
        uri: string,
        languageId: string,
        syntax: LanguageSyntax,
    ): Promise<ContextBundle> {
        // ── Phase D: LSP notification (fire-and-forget, never blocks) ──
        if (config.lspNotifyEnabled) {
            void this._lspNotifier.checkAndNotify(document);
        }

        // ── Workspace cache seed (fire-and-forget) ──
        if (config.workspaceIndexMode === 'workspace' && !this._workspaceSeeded) {
            this._workspaceSeeded = true;
            void this._seedWorkspaceCache();
        }

        // ── Symbols + exports + enclosing scope ──
        let fileExports: FileExport[] = [];
        let enclosingScope: EnclosingScope | undefined;
        try {
            let symbols = this._cache.get(uri);
            if (!symbols || symbols.lineCount !== document.lineCount) {
                const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri,
                );
                symbols = {
                    symbols: rawSymbols ?? [],
                    lineCount: document.lineCount,
                };
                this._cache.set(uri, symbols);
            }
            this._mergeDocumentSymbols(document.uri.toString(), symbols.symbols);
            fileExports = extractFileExports(symbols.symbols, languageId);
            enclosingScope = findEnclosingScope(symbols.symbols, position);
        } catch (err) {
            this._log.error(`[CONTEXT] symbols failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // ── Phase B: statement end (LSP SelectionRange + heuristic fallback) ──
        let statementEndLine: number | undefined;
        try {
            statementEndLine = await findStatementEnd(document, position);
        } catch (err) {
            this._log.error(`[CONTEXT] statementEnd failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // ── Phase G: super-types ──
        let superTypes: EnclosingScope[] | undefined;
        if (config.typeHierarchyEnabled) {
            try {
                superTypes = await fetchSuperTypes(document, position, enclosingScope);
            } catch (err) {
                this._log.error(`[CONTEXT] superTypes failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // ── Log what we have so far ──
        if (fileExports.length > 0 || enclosingScope) {
            const scopeInfo = enclosingScope
                ? `scope=${enclosingScope.kind} ${enclosingScope.name} (${enclosingScope.startLine}-${enclosingScope.endLine})`
                : 'no_enclosing_scope';
            const wsFiles = this._workspaceCache.size;
            const superInfo = superTypes ? ` superTypes=${superTypes.map(s => s.name).join(',')}` : '';
            this._log.debug(`[CONTEXT] ${scopeInfo} exports=${fileExports.length} ws_files=${wsFiles} statement_end=${statementEndLine}${superInfo}`);
        }

        // ── Phase A: import resolution ──
        let importResolutions: ImportResolution[] = [];
        if (config.ghostScoping === 'lsp' || config.nesScoping === 'lsp') {
            try {
                importResolutions = await this._resolveImportTargets(
                    document.uri, document.getText(), languageId, config.hoverEnrichmentEnabled,
                );
            } catch (err) {
                this._log.error(`[CONTEXT] import resolution failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // ── Phase H: missing imports ──
        let missingImports: MissingImport[] = [];
        if (config.autoImportEnabled) {
            try {
                missingImports = (await this._detectMissingImportSymbols(document)).slice(0, 5);
            } catch (err) {
                this._log.error(`[CONTEXT] missingImports failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        return {
            enclosingScope,
            statementEndLine,
            fileExports,
            missingImports,
            importResolutions,
            superTypes,
            languageId,
            languageSyntax: syntax,
        };
    }

    /**
     * Phase H: Detect missing imports and return the LSP's quickfix edits.
     */
    async detectMissingImports(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken,
    ): Promise<AutoImportFix[]> {
        const config = readConfig();
        if (!config.autoImportEnabled) return [];
        return detectMissingImports(document, { token });
    }

    /**
     * Phase H (lightweight): Just the symbol names — used to populate the
     * informational `missingImports` field in the bundle. Avoids the
     * heavier `executeCodeActionProvider` call which can be slow.
     */
    private async _detectMissingImportSymbols(document: vscode.TextDocument): Promise<MissingImport[]> {
        let diagnostics: vscode.Diagnostic[];
        try {
            diagnostics = vscode.languages.getDiagnostics(document.uri);
        } catch {
            return [];
        }
        const out: MissingImport[] = [];
        for (const d of diagnostics) {
            // Lightweight inline regex — mirrors `extractMissingName` but without
            // requiring the full module import (keeps bundle lean).
            let m = /Cannot find name ['"]([^'"]+)['"]/i.exec(d.message);
            if (!m) m = /['"]([A-Za-z_$][\w$]*)['"] is not defined/i.exec(d.message);
            if (!m) m = /Use of undeclared identifier ['"]([^'"]+)['"]/i.exec(d.message);
            if (!m) continue;
            out.push({ symbolName: m[1] });
            if (out.length >= 5) break;
        }
        return out;
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
     * Incremental workspace cache update: re-fetch document symbols for a single
     * saved file and update its entry in the workspace cache.
     *
     * This is called on every `onDidSaveTextDocument` event. It is intentionally
     * NOT debounced — each per-file `executeDocumentSymbolProvider` call is cheap
     * (~5ms) and the update is immediate, so there is no stale window.
     *
     * Falls back gracefully if the LSP is not available for the file's language
     * (the cache entry keeps its previous value until the next gather() call).
     */
    private async _updateFileInWorkspaceCache(doc: vscode.TextDocument): Promise<void> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
                'vscode.executeDocumentSymbolProvider',
                doc.uri,
            );
            if (symbols) {
                this._mergeDocumentSymbols(doc.uri.toString(), symbols);
            }
        } catch {
            // LSP not available for this language — entry stays stale until
            // the next gather() call refreshes it via _mergeDocumentSymbols.
        }
    }

    /**
     * Phase A: Resolve relative import statements to their target files.
     *
     * LSP path (preferred):
     *   - `vscode.executeLinkProvider` returns resolved URIs for each
     *     import in the source file. Handles aliases (`@/utils`),
     *     re-exports, dynamic imports, monorepo packages — anything the
     *     LSP understands.
     *
     * File-system fallback:
     *   - Regex extracts specifiers, file probing resolves to URIs.
     *   - Kept for languages without an LSP installed.
     *
     * Both paths converge in `_buildImportResolutions` which fetches
     * symbols, hover, and computes the mandatory `relativePath`.
     */
    private async _resolveImportTargets(
        sourceUri: vscode.Uri,
        sourceText: string,
        languageId: string,
        hoverEnabled: boolean,
    ): Promise<ImportResolution[]> {
        const startTime = Date.now();
        const targets: vscode.Uri[] = [];

        // 0. Untitled documents (no fsPath) cannot have import resolution
        if (!sourceUri.fsPath || sourceUri.scheme !== 'file') {
            this._log.debug('[CONTEXT] skipping import resolution for non-file URI: ' + sourceUri.toString());
            return [];
        }

        // 1. LSP path
        const lspTargets = await this._resolveViaLSP(sourceUri);
        if (lspTargets.length > 0) {
            targets.push(...lspTargets);
        } else {
            // 2. File-system fallback
            const specifiers = extractRelativeImportSpecifiers(sourceText, languageId);
            if (specifiers.length === 0) return [];
            const sourceDir = sourceUri.fsPath
                ? sourceUri.fsPath.substring(0, sourceUri.fsPath.lastIndexOf('/'))
                : '';
            for (const specifier of specifiers) {
                if (targets.length >= 5) break;
                const uri = await resolveSpecifierToUri(specifier, sourceDir, sourceUri.scheme, languageId);
                if (uri) targets.push(uri);
            }
        }

        const resolutions = await this._buildImportResolutions(targets, sourceUri, hoverEnabled);

        if (resolutions.length > 0) {
            this._log.debug(`[CONTEXT] resolved ${resolutions.length} imports in ${Date.now() - startTime}ms`);
        }
        return resolutions;
    }

    /**
     * Phase A (LSP): Resolve import targets via the document link provider.
     */
    private async _resolveViaLSP(sourceUri: vscode.Uri): Promise<vscode.Uri[]> {
        try {
            const links = await vscode.commands.executeCommand<vscode.DocumentLink[] | undefined>(
                'vscode.executeLinkProvider',
                sourceUri,
            );
            if (!links || links.length === 0) return [];
            return links
                .map(l => l.target)
                .filter((t): t is vscode.Uri => t !== undefined && t !== null);
        } catch {
            return [];
        }
    }

    /**
     * Phase A + C: Fetch symbols + hover for the top exports of each target,
     * compute the mandatory relativePath, and build `ImportResolution`s.
     *
     * Cycle-safe: `_resolutionChain` tracks the current import chain to
     * detect circular imports (A→B→A). When a cycle is detected, the
     * duplicate target is skipped and a debug log is emitted.
     */
    private async _buildImportResolutions(
        targets: vscode.Uri[],
        sourceUri: vscode.Uri,
        hoverEnabled: boolean,
    ): Promise<ImportResolution[]> {
        const resolved: ImportResolution[] = [];
        const globalSeen = new Set<string>();   // across all imports in this file
        const chainSeen = new Set<string>();    // current resolution chain (cycle detection)
        const sourceUriStr = sourceUri.toString();

        for (const targetUri of targets) {
            if (resolved.length >= 5) break;
            const targetUriStr = targetUri.toString();
            if (globalSeen.has(targetUriStr)) continue;
            if (targetUriStr === sourceUriStr) continue;

            // Circular import check: if we've seen this target in the current
            // resolution chain, skip it and log the cycle.
            if (chainSeen.has(targetUriStr)) {
                this._log.warn(`[CONTEXT] circular import detected: ${targetUriStr} already in resolution chain`);
                continue;
            }
            chainSeen.add(targetUriStr);
            globalSeen.add(targetUriStr);

            // Phase A: relative path is mandatory
            const relativePath = resolveRelativePath(sourceUri, targetUri);

            // Detect file kind from extension BEFORE opening the document.
            // Non-text files (image, audio, video, font, archive, binary) are
            // resolved with just the path and kind — no heavy processing.
            const fileKind = inferFileKind(targetUri);
            const textKinds: ReadonlySet<FileKind> = new Set(['code', 'data', 'document', 'unknown']);

            if (!textKinds.has(fileKind)) {
                // Non-text file — record the import but skip symbol/signature processing
                resolved.push({
                    uri: targetUriStr,
                    relativePath,
                    exports: [],
                    fileKind,
                });
                continue;
            }

            try {
                const targetDoc = await vscode.workspace.openTextDocument(targetUri);
                const targetKey = targetDoc.uri.toString();

                let symbols = this._cache.get(targetKey);
                if (!symbols || symbols.lineCount !== targetDoc.lineCount) {
                    const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
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
                if (exports.length === 0) continue;

                // Phase C: hover enrichment (top 5 exports)
                let typeSignatures: Record<string, string> | undefined;
                if (hoverEnabled) {
                    typeSignatures = await this._fetchTopHoverSignatures(targetDoc, exports);
                }

                resolved.push({
                    uri: targetUriStr,
                    relativePath,
                    exports,
                    fileKind,
                    typeSignatures,
                });
            } catch {
                // File not found or inaccessible — skip
                continue;
            }
        }

        return resolved;
    }

    /**
     * Phase C: Fetch hover signatures for the top 5 exports of a file.
     * Cached per-file to avoid duplicate LSP calls.
     */
    private async _fetchTopHoverSignatures(
        targetDoc: vscode.TextDocument,
        exports: FileExport[],
    ): Promise<Record<string, string> | undefined> {
        const cacheKey = targetDoc.uri.toString();
        let cached = this._hoverCache.get(cacheKey);
        if (cached) {
            // Return only what we have for the requested exports
            const subset: Record<string, string> = {};
            for (const exp of exports.slice(0, 5)) {
                const sig = cached.get(exp.name);
                if (sig) subset[exp.name] = sig;
            }
            return Object.keys(subset).length > 0 ? subset : undefined;
        }

        const sigMap = new Map<string, string>();
        const top5 = exports.slice(0, 5);
        for (const exp of top5) {
            try {
                const sig = await fetchHoverSignature(targetDoc, new vscode.Position(exp.line, 0));
                if (sig) sigMap.set(exp.name, sig);
            } catch {
                continue;
            }
        }
        if (sigMap.size > 0) {
            this._hoverCache.set(cacheKey, sigMap);
            return Object.fromEntries(sigMap);
        }
        return undefined;
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

    // Used by the unquoted path (new languages like Java/C#/Rust/Kotlin/Swift)
    // and the general quoted path for languages that require quotes.
    const keywordIsUnquoted = !keyword.endsWith('"') && !keyword.endsWith("'") && !keyword.endsWith('(');
    const maybeQuote = findQuote(line, afterKeyword);

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

    // Unquoted specifiers: keyword followed by path-like text up to `;` or EOL.
    // Covers Java `import java.util.List;`, C# `using System;`, C# `import X;`,
    // Rust `mod foo;`, and any other language where the import specifier is
    // NOT in quotes. Only triggers when no quote match was possible (keyword
    // doesn't end with quote/paren) and the specifier isn't quoted.
    if (!maybeQuote && keywordIsUnquoted) {
        let specEnd = afterKeyword;
        // Skip leading whitespace after keyword
        while (specEnd < line.length && (line[specEnd] === ' ' || line[specEnd] === '\t')) specEnd++;
        if (specEnd >= line.length) return undefined;
        // Find the end of the specifier: `;`, `,`, or whitespace.
        // These are the only characters that can terminate an unquoted
        // import path in Java, C#, Rust, Kotlin, Swift, etc.
        // Slash `/` is intentionally NOT in the list — it's the path
        // separator (`./foo`, `../bar`).
        // Braces `{}`, parens `()`, and operators `+-*` are NOT in the
        // list either, as they may appear inside generic/specialized
        // imports (`List<String>`, `(str)`).
        const endChars = [';', ','];
        let sEnd = specEnd;
        while (sEnd < line.length && !endChars.includes(line[sEnd]) && line[sEnd] !== '\n' && line[sEnd] !== '\r') {
            sEnd++;
        }
        const specifier = line.slice(specEnd, sEnd).trim();
        return specifier.length > 0 ? { specifier, isQuotedInclude: false } : undefined;
    }

    // General case: keyword followed by whitespace then a quoted string.
    // At this point `maybeQuote` is the result of findQuote() called above.
    if (!maybeQuote) return undefined;
    const specStart = maybeQuote.idx + 1;
    const specEnd = line.indexOf(maybeQuote.char, specStart);
    if (specEnd <= specStart) return undefined;
    return { specifier: line.slice(specStart, specEnd), isQuotedInclude: false };
}

/** Build the pattern table once (per language), not every iteration. */
function buildPatternsForLanguage(languageId: string): [keyword: string, advance: number][] {
    const patterns: [string, number][] = [];
    if (languageId.startsWith('typescript') || languageId.startsWith('javascript')) {
        patterns.push(['from ', 5], ['require(', 8], ['import(', 7]);
        // `require.resolve(` is intentionally omitted — the over-counted
        // advance causes misses on short lines. LSP path handles it.
    }
    if (['ruby'].includes(languageId)) {
        patterns.push(['require "', 9], ["require '", 9], ['require_relative "', 18], ["require_relative '", 18]);
    }
    if (['python'].includes(languageId)) {
        patterns.push(['from ', 5], ['import ', 7]);
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
    // Java, C# (C# also has `using static` for static imports)
    if (['java', 'csharp'].includes(languageId)) {
        patterns.push(['import ', 7]);
    }
    if (languageId === 'csharp') {
        patterns.push(['using ', 6]);
    }
    // Rust — `mod foo;` and `mod "path";` declarations, `use crate::foo;`
    // For `use`, the path doesn't have `./` prefix (uses `::`) — but we
    // detect the path anyway for cross-file visibility. The specifier
    // we capture is the full `use` line; the file-system resolver will
    // not match (Rust uses build-system paths), but the LSP path covers
    // it. Detection here is best-effort.
    if (['rust'].includes(languageId)) {
        patterns.push(['mod ', 4]);
    }
    // Kotlin and Swift use C-family `import X;` syntax (Kotlin also has
    // package-level `package X` which we don't track).
    if (['kotlin', 'swift'].includes(languageId)) {
        patterns.push(['import ', 7]);
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

/** Convert SymbolKind enum to a human-readable name. */
function kindName(kind: vscode.SymbolKind): string {
    switch (kind) {
        case vscode.SymbolKind.File: return 'File';
        case vscode.SymbolKind.Module: return 'Module';
        case vscode.SymbolKind.Namespace: return 'Namespace';
        case vscode.SymbolKind.Package: return 'Package';
        case vscode.SymbolKind.Class: return 'Class';
        case vscode.SymbolKind.Method: return 'Method';
        case vscode.SymbolKind.Property: return 'Property';
        case vscode.SymbolKind.Field: return 'Field';
        case vscode.SymbolKind.Constructor: return 'Constructor';
        case vscode.SymbolKind.Enum: return 'Enum';
        case vscode.SymbolKind.Interface: return 'Interface';
        case vscode.SymbolKind.Function: return 'Function';
        case vscode.SymbolKind.Variable: return 'Variable';
        case vscode.SymbolKind.Constant: return 'Constant';
        case vscode.SymbolKind.String: return 'String';
        case vscode.SymbolKind.Number: return 'Number';
        case vscode.SymbolKind.Boolean: return 'Boolean';
        case vscode.SymbolKind.Array: return 'Array';
        case vscode.SymbolKind.Object: return 'Object';
        case vscode.SymbolKind.Key: return 'Key';
        case vscode.SymbolKind.Null: return 'Null';
        case vscode.SymbolKind.EnumMember: return 'EnumMember';
        case vscode.SymbolKind.Struct: return 'Struct';
        case vscode.SymbolKind.Event: return 'Event';
        case vscode.SymbolKind.Operator: return 'Operator';
        case vscode.SymbolKind.TypeParameter: return 'TypeParameter';
        default: return 'Symbol';
    }
}

/** Whether the symbol kind should appear in the file exports list. */
function isExportableKind(kind: vscode.SymbolKind): boolean {
    switch (kind) {
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Interface:
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Variable:
        case vscode.SymbolKind.Constant:
        case vscode.SymbolKind.Enum:
        case vscode.SymbolKind.Struct:
        case vscode.SymbolKind.Module:
        case vscode.SymbolKind.Namespace:
        case vscode.SymbolKind.TypeParameter:
            return true;
        default:
            return false;
    }
}

/** Whether the symbol kind is a meaningful "enclosing scope" (class, function, etc.). */
function isScopeKind(kind: vscode.SymbolKind): boolean {
    switch (kind) {
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Interface:
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Module:
        case vscode.SymbolKind.Namespace:
        case vscode.SymbolKind.Struct:
        case vscode.SymbolKind.Enum:
            return true;
        default:
            return false;
    }
}
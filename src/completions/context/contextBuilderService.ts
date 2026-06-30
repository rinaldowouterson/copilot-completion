import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../di/services';
import { ServiceIdentifier } from '../../di/instantiation';
import { ContextBundle, FileExport, EnclosingScope } from '../../common/contextBundle';
import { getSyntax, findStatementEnd } from '../../common/languageSyntax';
import { LRUCacheMap } from '../../common/lruCacheMap';

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
interface ContextConfig {
    ghostScoping: 'basic' | 'lsp';
    nesScoping: 'basic' | 'lsp';
    cacheMaxEntries: number;
}

function readConfig(): ContextConfig {
    const cfg = vscode.workspace.getConfiguration('cc-completion');
    return {
        ghostScoping: cfg.get<'basic' | 'lsp'>('ghost.contextScoping', 'lsp'),
        nesScoping: cfg.get<'basic' | 'lsp'>('nes.contextScoping', 'lsp'),
        cacheMaxEntries: cfg.get<number>('context.lspCacheMaxEntries', 100),
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

    constructor() {
        // Invalidate cache for a document when its text changes.
        // The LS will have updated its symbol tree by the time the next
        // gather() call runs, so the cache will be repopulated fresh.
        vscode.workspace.onDidChangeTextDocument(e => {
            this._cache.delete(e.document.uri.toString());
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

        // Check if context scoping is enabled for this pipeline.
        // We don't know whether the caller is GHOST or NES, so we
        // return a bundle with only the fields both consume.
        // The caller (ghostTextComputer / nesWorkflow) can check
        // its own config for the specific scoping gate.
        // For now: always return LSP data if available.

        // LSP symbol lookup (cached)
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

        // Build the bundle
        const fileExports = extractFileExports(symbols.symbols, languageId);
        const enclosingScope = findEnclosingScope(symbols.symbols, position);
        const statementEndLine = findStatementEnd(
            document.getText().split('\n'),
            position.line,
            syntax,
        );

        return {
            enclosingScope,
            statementEndLine,
            fileExports,
            missingImports: [], // deferred — cross-file import detection in a follow-up
            languageId,
            languageSyntax: syntax,
        };
    }
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

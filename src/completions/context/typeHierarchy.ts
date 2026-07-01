/**
 * Phase G: Local type hierarchy for OOP context.
 *
 * When the cursor is on a class or interface declaration, fetch its
 * super-types via `vscode.prepareTypeHierarchy` +
 * `vscode.provideTypeHierarchySupertypes`. The result is added to
 * `ContextBundle.superTypes` for prompt inclusion.
 *
 * Graceful fallback: returns `undefined` for functional languages,
 * languages without type hierarchy support, or when the LSP isn't
 * indexed for the current file.
 *
 * Note: the LSP calls used here are built-in VS Code commands that
 * invoke the registered `TypeHierarchyProvider`. There is no direct
 * `languages.prepareTypeHierarchy` API — providers must be invoked via
 * `executeCommand`.
 */

import * as vscode from 'vscode';
import { EnclosingScope } from '../../common/contextBundle';

/** Cap the number of super-types per gather to keep the prompt bounded. */
const SUPER_TYPE_LIMIT = 5;

/** Only fetch hierarchy for these enclosing-scope kinds. */
const HIERARCHY_KINDS = new Set(['Class', 'Interface']);

export async function fetchSuperTypes(
    document: vscode.TextDocument,
    position: vscode.Position,
    enclosingScope: EnclosingScope | undefined,
): Promise<EnclosingScope[] | undefined> {
    if (!enclosingScope) return undefined;
    if (!HIERARCHY_KINDS.has(enclosingScope.kind)) return undefined;

    // Position on the class/interface name (start of declaration)
    const classNamePos = new vscode.Position(enclosingScope.startLine, 0);

    try {
        const prepared = await vscode.commands.executeCommand<vscode.TypeHierarchyItem | vscode.TypeHierarchyItem[] | undefined>(
            'vscode.prepareTypeHierarchy',
            document.uri,
            classNamePos,
        );
        if (!prepared) return undefined;
        const roots = Array.isArray(prepared) ? prepared : [prepared];
        if (roots.length === 0) return undefined;

        const superTypes: EnclosingScope[] = [];
        for (const root of roots) {
            let supers: vscode.TypeHierarchyItem[] | undefined;
            try {
                supers = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[] | undefined>(
                    'vscode.provideTypeHierarchySupertypes',
                    root,
                );
            } catch {
                continue;
            }
            if (!supers) continue;
            for (const sup of supers) {
                superTypes.push({
                    kind: sup.kind === vscode.SymbolKind.Interface ? 'Interface' : 'Class',
                    name: sup.name,
                    startLine: sup.range?.start.line ?? 0,
                    endLine: sup.range?.end.line ?? 0,
                });
                if (superTypes.length >= SUPER_TYPE_LIMIT) break;
            }
            if (superTypes.length >= SUPER_TYPE_LIMIT) break;
        }

        return superTypes.length > 0 ? superTypes : undefined;
    } catch {
        return undefined;
    }
}
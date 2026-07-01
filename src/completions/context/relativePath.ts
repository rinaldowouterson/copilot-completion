/**
 * Phase A: Compute the workspace-relative path for an import target.
 *
 * The `relativePath` field on `ImportResolution` is **mandatory** —
 * every import has a path. Resolving it once at `gather()` time means
 * GHOST and NES formatters don't recompute, and the value is stable
 * across both consumers.
 *
 * Rules:
 *   - Workspace open: `vscode.workspace.asRelativePath(target, false)`,
 *     then prepend `./` if not already present.
 *   - No workspace: `path.relative(sourceDir, target)`, then prepend
 *     `./` if not already present.
 *   - Cross-platform / cross-drive fallback: use the basename.
 *
 * VS Code API notes:
 *   - `asRelativePath(uri, false)` returns e.g. "src/utils/helpers.ts"
 *     — no leading `./`. We add it.
 *   - `asRelativePath(uri, true)` includes the workspace folder name
 *     (for multi-root workspaces). We pass `false` because we want the
 *     path **relative to the workspace root** — not the folder name.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export function resolveRelativePath(
    sourceUri: vscode.Uri,
    targetUri: vscode.Uri,
): string {
    // 1. Workspace-relative path (preferred — handles multi-root workspaces)
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        try {
            const relPath = vscode.workspace.asRelativePath(targetUri, false);
            return ensureLeadingDotSlash(relPath);
        } catch {
            // Fall through to the no-workspace path
        }
    }

    // 2. No workspace — relative to the source file's directory
    const sourceFs = sourceUri.fsPath;
    const targetFs = targetUri.fsPath;
    if (!sourceFs || !targetFs) {
        // Cannot compute relative — fall back to basename
        const base = targetUri.path.split('/').pop() ?? targetUri.toString();
        return `./${base}`;
    }
    try {
        const sourceDir = path.dirname(sourceFs);
        const rel = path.relative(sourceDir, targetFs);
        return ensureLeadingDotSlash(rel);
    } catch {
        // Cross-drive (Windows) — fall back to basename
        const base = path.basename(targetFs);
        return `./${base}`;
    }
}

/** Ensure the relative path starts with `./` or `../`. */
function ensureLeadingDotSlash(p: string): string {
    if (p.startsWith('./') || p.startsWith('../')) return p;
    if (p.startsWith('/')) return `.${p}`;
    return `./${p}`;
}
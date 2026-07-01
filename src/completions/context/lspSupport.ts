/**
 * Phase D: LSP support detection + hourly notification.
 *
 * Detects when the user's current document lacks LSP support (e.g. they
 * haven't installed Pylance for Python) and shows an informational
 * notification once per hour per language suggesting the matching
 * extension.
 *
 * Pure functions + a `LspSupportNotifier` class. The class is opt-in via
 * the builder's `gather()` and won't spam the user.
 */

import * as vscode from 'vscode';

/** Recommended extension metadata for a single language. */
export interface LspExtensionInfo {
    name: string;
    id: string;
    installCmd: string;
    /**
     * Marketplace URL — used by the notification to open the extension's
     * detail page in the user's browser or the Extensions view via
     * `vscode:extension/<id>` URI.
     */
    marketplaceUrl: string;
    /**
     * Optional prerequisite extension that the LSP depends on. Shown in
     * the notification alongside the LSP install command — installing the
     * LSP without its prerequisite usually fails (e.g. Pylance needs the
     * Python extension for interpreter discovery).
     */
    prerequisite?: LspExtensionInfo;
}

/** Build the marketplace URL from an extension id (`publisher.name`). */
function marketplaceUrlFor(id: string): string {
    return `https://marketplace.visualstudio.com/items?itemName=${id}`;
}

/** Build the `vscode:extension/<id>` URI for opening the extension page in VS Code. */
export function extensionUriFor(id: string): vscode.Uri {
    return vscode.Uri.parse(`vscode:extension/${id}`);
}

/**
 * Best-effort: open the `vscode:extension/<id>` URI in the user's
 * default handler. VS Code handles the URI by showing the extension's
 * detail page in the Extensions view (with an Install button).
 *
 * Returns `true` if VS Code accepted the URI, `false` otherwise. The
 * caller can fall back to opening the marketplace URL in a browser.
 */
export async function openExtensionPage(id: string): Promise<boolean> {
    try {
        return await vscode.env.openExternal(extensionUriFor(id));
    } catch {
        return false;
    }
}

/**
 * Wait for an extension to be installed (visible via
 * `extensions.getExtension(id)`) by listening to `extensions.onDidChange`.
 *
 * Resolves to `true` as soon as the extension appears in the registry,
 * or `false` if `timeoutMs` elapses first. The caller should treat both
 * outcomes defensively: true means the install completed within the
 * timeout, false means we're giving up.
 *
 * This is what makes "Install Directly" feel responsive — without it,
 * the user clicks Install, the command resolves immediately (the install
 * is queued, not complete), and the next gather call still sees no LSP.
 */
export async function waitForExtensionInstalled(
    id: string,
    timeoutMs: number = 30_000,
): Promise<boolean> {
    // Fast path: already installed
    if (vscode.extensions.getExtension(id) !== undefined) return true;

    return new Promise<boolean>((resolve) => {
        let settled = false;
        const cleanup = () => {
            try { subscription.dispose(); } catch { /* ignore */ }
            clearTimeout(timer);
        };
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(ok);
        };
        const subscription = vscode.extensions.onDidChange(() => {
            if (vscode.extensions.getExtension(id) !== undefined) {
                finish(true);
            }
        });
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
}

/**
 * Best-effort direct install via the internal
 * `workbench.extensions.installExtension` command.
 *
 * Behavior in interactive VS Code (the real-world case):
 *   - Shows the "Do you trust the publisher 'X'?" dialog.
 *   - User clicks "Yes, I trust" → install proceeds, returns success.
 *   - User clicks "No" or dismisses → returns false.
 *
 * Behavior in headless/test environments:
 *   - `DialogService: refused to show dialog in tests` → returns false.
 *   - This is the test runner limitation, NOT a code bug. The user
 *     sees the trust dialog in interactive use and can complete the
 *     install.
 *
 * Returns `true` on success, `false` on any failure (cancellation,
 * trust denied, command not registered in this VS Code version, etc.).
 * The caller should fall back to opening the extension page.
 *
 * Command signature: `workbench.extensions.installExtension(idOrUri)`
 * accepts either a plain `publisher.name` id or a `vscode:extension/<id>` URI.
 * Stable since VS Code 1.84.
 */
export async function tryDirectInstall(id: string): Promise<boolean> {
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
        return true;
    } catch {
        return false;
    }
}

/**
 * Map of VS Code languageId → recommended LSP extensions.
 *
 * Picked conservatively — only languages where an LSP gives materially
 * better completions than the file-system fallback. Add new entries
 * here when new LSPs become available.
 */
export const LANG_TO_LSP_EXTENSIONS: Record<string, LspExtensionInfo[]> = {
    python: [
        {
            name: 'Pylance',
            id: 'ms-python.vscode-pylance',
            installCmd: 'code --install-extension ms-python.vscode-pylance',
            marketplaceUrl: marketplaceUrlFor('ms-python.vscode-pylance'),
            // Pylance depends on the Python extension for interpreter discovery.
            // Installing Pylance without it produces a broken experience.
            prerequisite: {
                name: 'Python',
                id: 'ms-python.python',
                installCmd: 'code --install-extension ms-python.python',
                marketplaceUrl: marketplaceUrlFor('ms-python.python'),
            },
        },
    ],
    rust: [
        {
            name: 'rust-analyzer',
            id: 'rust-lang.rust-analyzer',
            installCmd: 'code --install-extension rust-lang.rust-analyzer',
            marketplaceUrl: marketplaceUrlFor('rust-lang.rust-analyzer'),
        },
    ],
    go: [
        {
            name: 'Go',
            id: 'golang.go',
            installCmd: 'code --install-extension golang.go',
            marketplaceUrl: marketplaceUrlFor('golang.go'),
        },
    ],
    java: [
        {
            name: 'Language Support for Java',
            id: 'redhat.java',
            installCmd: 'code --install-extension redhat.java',
            marketplaceUrl: marketplaceUrlFor('redhat.java'),
        },
    ],
    cpp: [
        {
            name: 'C/C++',
            id: 'ms-vscode.cpptools',
            installCmd: 'code --install-extension ms-vscode.cpptools',
            marketplaceUrl: marketplaceUrlFor('ms-vscode.cpptools'),
        },
    ],
    c: [
        {
            name: 'C/C++',
            id: 'ms-vscode.cpptools',
            installCmd: 'code --install-extension ms-vscode.cpptools',
            marketplaceUrl: marketplaceUrlFor('ms-vscode.cpptools'),
        },
    ],
    csharp: [
        {
            // Microsoft-published C# extension — Roslyn LSP is bundled.
            // C# Dev Kit (ms-dotnettools.csdevkit) builds on top of this
            // and auto-installs it as a dependency, but the C# extension
            // alone is sufficient for LSP features (Phase A–H).
            name: 'C#',
            id: 'ms-dotnettools.csharp',
            installCmd: 'code --install-extension ms-dotnettools.csharp',
            marketplaceUrl: marketplaceUrlFor('ms-dotnettools.csharp'),
        },
    ],
    php: [
        {
            name: 'Intelephense',
            id: 'bmewburn.vscode-intelephense-client',
            installCmd: 'code --install-extension bmewburn.vscode-intelephense-client',
            marketplaceUrl: marketplaceUrlFor('bmewburn.vscode-intelephense-client'),
        },
    ],
    ruby: [
        {
            name: 'Ruby LSP',
            id: 'shopify.ruby-lsp',
            installCmd: 'code --install-extension shopify.ruby-lsp',
            marketplaceUrl: marketplaceUrlFor('shopify.ruby-lsp'),
        },
    ],
    dart: [
        {
            name: 'Dart',
            id: 'dart-code.dart-code',
            installCmd: 'code --install-extension dart-code.dart-code',
            marketplaceUrl: marketplaceUrlFor('dart-code.dart-code'),
        },
    ],
    lua: [
        {
            name: 'sumneko.lua',
            id: 'sumneko.lua',
            installCmd: 'code --install-extension sumneko.lua',
            marketplaceUrl: marketplaceUrlFor('sumneko.lua'),
        },
    ],
};

/**
 * Detect whether the document's language has any LSP support by querying
 * `executeDocumentSymbolProvider`. Returns false on errors/empty results.
 *
 * This is a fast smoke test — if any symbol provider responds with a
 * non-empty list, an LSP is installed and indexed.
 */
export async function hasLspSupport(document: vscode.TextDocument): Promise<boolean> {
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
            'vscode.executeDocumentSymbolProvider',
            document.uri,
        );
        return Array.isArray(symbols) && symbols.length > 0;
    } catch {
        return false;
    }
}

/**
 * Notifier that warns the user about missing LSP support, but no more
 * than once per hour per language.
 *
 * Singleton-per-instance lifecycle — instantiated once by the extension
 * and shared across all gathers. The cooldown map is keyed by languageId.
 */
export class LspSupportNotifier {
    private readonly _lastNotified = new Map<string, number>();
    private readonly _cooldownMs = 3_600_000; // 1 hour

    /**
     * If the document's language is in `LANG_TO_LSP_EXTENSIONS` and the LSP
     * isn't responding, show an info message (subject to cooldown).
     *
     * "Copy install command" copies the install command to the clipboard.
     * "Dismiss" or closing the dialog closes without copying.
     */
    async checkAndNotify(document: vscode.TextDocument): Promise<void> {
        const lang = document.languageId;
        const exts = LANG_TO_LSP_EXTENSIONS[lang];
        if (!exts || exts.length === 0) return;

        const last = this._lastNotified.get(lang) ?? 0;
        if (Date.now() - last < this._cooldownMs) return;

        // Confirm the LSP is actually missing before bothering the user.
        if (await hasLspSupport(document)) return;

        this._lastNotified.set(lang, Date.now());
        const ext = exts[0];
        const prereqNote = ext.prerequisite
            ? ` (requires ${ext.prerequisite.name} first)`
            : '';
        const action = await vscode.window.showInformationMessage(
            `cc-completion: No language server detected for ${lang}. Install ${ext.name}${prereqNote} for better context (path aliases, hover types, exact statement boundaries).`,
            'Install Directly',
            'Show in Extensions Marketplace',
            'Copy install command',
            'Dismiss',
        );
        if (action === 'Install Directly') {
            // Preferred path — install in-IDE via the internal command.
            // VS Code shows the trust-publisher dialog; user clicks
            // "Yes, I trust" to complete the install.
            // If a prerequisite exists, install it first so the LSP
            // doesn't end up in a broken state.
            if (ext.prerequisite) {
                const prereqOk = await tryDirectInstall(ext.prerequisite.id);
                if (!prereqOk) {
                    // Prereq install failed (cancelled, denied, or test
                    // env) — open its page so the user can install
                    // manually. Continue with the LSP attempt anyway.
                    await openExtensionPage(ext.prerequisite.id);
                } else {
                    // Wait for the prereq install to actually complete
                    // before triggering the LSP install.
                    await waitForExtensionInstalled(ext.prerequisite.id, 60_000);
                }
            }

            // Show progress while the install runs — this can take 5-30s
            // for large extensions (Go, C++, Rust).
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Installing ${ext.name}…`,
                    cancellable: false,
                },
                async () => {
                    const ok = await tryDirectInstall(ext.id);
                    if (!ok) {
                        // Direct install failed (cancelled, denied, or
                        // test env) — fall back to opening the extension
                        // page so the user can install with one click.
                        await openExtensionPage(ext.id);
                        return;
                    }
                    // Wait for the install to actually complete. Without
                    // this, the user would click Install, see the trust
                    // dialog, click Yes, and the very next keystroke
                    // would still trigger the "no LSP" notification.
                    const installed = await waitForExtensionInstalled(ext.id, 60_000);
                    if (installed) {
                        // Reset cooldown so the user gets a fresh
                        // notification only if the new LSP doesn't
                        // actually serve hover/symbols (Phase D check).
                        this._lastNotified.set(lang, 0);
                        vscode.window.showInformationMessage(
                            `${ext.name} installed. cc-completion will pick it up on the next completion.`,
                        );
                    } else {
                        vscode.window.showWarningMessage(
                            `${ext.name} install timed out. Try the Extensions Marketplace if it didn't complete.`,
                        );
                    }
                },
            );
        } else if (action === 'Show in Extensions Marketplace') {
            // In-IDE Extensions view via internal URI — user reads the
            // description / reviews and clicks Install themselves.
            // Falls back to the marketplace URL in the user's browser
            // if the internal URI is somehow rejected.
            const ok = await openExtensionPage(ext.id);
            if (!ok) {
                await vscode.env.openExternal(vscode.Uri.parse(ext.marketplaceUrl));
            }
        } else if (action === 'Copy install command') {
            // Include prerequisite first if present, so the user can paste
            // the whole sequence into a terminal.
            const cmd = ext.prerequisite
                ? `${ext.prerequisite.installCmd} && ${ext.installCmd}`
                : ext.installCmd;
            await vscode.env.clipboard.writeText(cmd);
        }
    }

    /** Test-only: reset the cooldown so unit tests can re-trigger. */
    resetForTests(): void {
        this._lastNotified.clear();
    }
}
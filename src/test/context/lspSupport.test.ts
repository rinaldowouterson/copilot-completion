import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    LANG_TO_LSP_EXTENSIONS,
    extensionUriFor,
    openExtensionPage,
    tryDirectInstall,
    waitForExtensionInstalled,
    LspExtensionInfo,
} from '../../completions/context/lspSupport';

suite('lspSupport (Phase D)', () => {
    /** Helper: validate the basic shape every entry must satisfy. */
    function assertValidEntry(lang: string, ext: LspExtensionInfo): void {
        assert.ok(typeof ext.name === 'string' && ext.name.length > 0,
            `${lang}: name should be a non-empty string, got ${ext.name}`);
        assert.ok(typeof ext.id === 'string' && ext.id.includes('.'),
            `${lang}: id should be publisher.name, got ${ext.id}`);
        assert.ok(ext.installCmd.startsWith('code --install-extension '),
            `${lang}: installCmd should start with 'code --install-extension', got ${ext.installCmd}`);
        assert.ok(typeof ext.marketplaceUrl === 'string'
            && ext.marketplaceUrl.startsWith('https://marketplace.visualstudio.com/items?itemName='),
            `${lang}: marketplaceUrl should be a marketplace URL, got ${ext.marketplaceUrl}`);
        assert.ok(ext.marketplaceUrl.endsWith(ext.id),
            `${lang}: marketplaceUrl should end with the extension id, got ${ext.marketplaceUrl}`);
    }

    test('every entry has the required fields (id, installCmd, marketplaceUrl, name)', () => {
        for (const lang of Object.keys(LANG_TO_LSP_EXTENSIONS)) {
            const exts = LANG_TO_LSP_EXTENSIONS[lang];
            for (const ext of exts) {
                assertValidEntry(lang, ext);
            }
        }
    });

    test('extension entries are non-empty for languages we care about', () => {
        assert.ok(LANG_TO_LSP_EXTENSIONS.python && LANG_TO_LSP_EXTENSIONS.python.length > 0);
        assert.ok(LANG_TO_LSP_EXTENSIONS.rust && LANG_TO_LSP_EXTENSIONS.rust.length > 0);
        assert.ok(LANG_TO_LSP_EXTENSIONS.go && LANG_TO_LSP_EXTENSIONS.go.length > 0);
    });

    test('TypeScript is not in the LSP map (built-in TS server)', () => {
        assert.strictEqual(LANG_TO_LSP_EXTENSIONS.typescript, undefined,
            'TypeScript uses the built-in TS server, no extension needed');
    });

    test('JavaScript is not in the LSP map (built-in TS server handles JS)', () => {
        assert.strictEqual(LANG_TO_LSP_EXTENSIONS.javascript, undefined,
            'JavaScript is handled by the built-in TS server, no extension needed');
    });

    test('Python prerequisite (Pylance depends on Python extension)', () => {
        const pylance = LANG_TO_LSP_EXTENSIONS.python[0];
        assert.ok(pylance.prerequisite, 'Pylance entry must declare a prerequisite');
        assert.strictEqual(pylance.prerequisite!.id, 'ms-python.python',
            `Expected Python prerequisite, got ${pylance.prerequisite!.id}`);
        assert.strictEqual(pylance.prerequisite!.name, 'Python');
        assert.ok(pylance.prerequisite!.installCmd.startsWith('code --install-extension ms-python.python'));
        assert.ok(pylance.prerequisite!.marketplaceUrl.endsWith('ms-python.python'));
    });

    test('C# uses Microsoft-published Roslyn LSP', () => {
        const csharp = LANG_TO_LSP_EXTENSIONS.csharp?.[0];
        assert.ok(csharp, 'csharp entry missing');
        assert.strictEqual(csharp!.id, 'ms-dotnettools.csharp');
    });

    test('C and C++ share the Microsoft cpptools extension', () => {
        // Same extension id, same name — both should be listed
        const c = LANG_TO_LSP_EXTENSIONS.c?.[0];
        const cpp = LANG_TO_LSP_EXTENSIONS.cpp?.[0];
        assert.ok(c && cpp, 'c/cpp entries missing');
        assert.strictEqual(c!.id, cpp!.id, 'c and cpp should share the same LSP extension');
    });

    test('Non-prerequisite entries have no prerequisite field', () => {
        for (const lang of Object.keys(LANG_TO_LSP_EXTENSIONS)) {
            if (lang === 'python') continue; // python legitimately has a prerequisite
            const exts = LANG_TO_LSP_EXTENSIONS[lang];
            for (const ext of exts) {
                assert.strictEqual(ext.prerequisite, undefined,
                    `${lang} (${ext.id}) unexpectedly declares a prerequisite`);
            }
        }
    });

    test('SQL and PowerShell are NOT in the LSP map (per-file completion only)', () => {
        // SQL files are isolated query batches — no imports, no hover
        // signatures that benefit our context pipeline. PowerShell scripts
        // are similarly file-local. The LSP notification would be noise.
        assert.strictEqual(LANG_TO_LSP_EXTENSIONS.sql, undefined);
        assert.strictEqual(LANG_TO_LSP_EXTENSIONS.powershell, undefined);
    });

    test('extensionUriFor builds a vscode:extension/ URI (preferred internal path)', () => {
        const uri = extensionUriFor('ms-python.vscode-pylance');
        assert.strictEqual(uri.scheme, 'vscode');
        assert.strictEqual(uri.toString(), 'vscode:extension/ms-python.vscode-pylance');
        assert.ok(uri.path.includes('ms-python.vscode-pylance'),
            `Path should contain extension id, got ${uri.path}`);
    });

    test('extensionUriFor preserves publisher-name with hyphens and dots', () => {
        const uri = extensionUriFor('ms-dotnettools.csdevkit');
        assert.strictEqual(uri.toString(), 'vscode:extension/ms-dotnettools.csdevkit');
    });

    test('marketplace URLs round-trip from extension id', () => {
        for (const lang of Object.keys(LANG_TO_LSP_EXTENSIONS)) {
            for (const ext of LANG_TO_LSP_EXTENSIONS[lang]) {
                const uri = extensionUriFor(ext.id);
                assert.strictEqual(uri.scheme, 'vscode');
                assert.ok(uri.toString().endsWith(ext.id),
                    `URI should end with extension id, got ${uri.toString()}`);
            }
        }
    });

    test('openExtensionPage never throws on invalid id', async () => {
        // Should not throw — VS Code's openExternal handles bad URIs gracefully
        const result = await openExtensionPage('not-a-valid-id-format');
        assert.strictEqual(typeof result, 'boolean');
    });

    test('openExtensionPage returns boolean for valid id', async () => {
        // VS Code should accept a well-formed vscode:extension/<id> URI.
        // We don't assert true (depends on whether VS Code is registered
        // as the URI handler in the test environment) — only that the
        // call resolves to a boolean without throwing.
        const result = await openExtensionPage('ms-python.vscode-pylance');
        assert.strictEqual(typeof result, 'boolean');
    });

    test('tryDirectInstall never throws (returns boolean)', async () => {
        // The internal `workbench.extensions.installExtension` command
        // is callable but in test environments the trust-publisher dialog
        // can't be shown, so it returns false. We only assert it
        // doesn't throw and returns a boolean.
        const result = await tryDirectInstall('ms-python.vscode-pylance');
        assert.strictEqual(typeof result, 'boolean');
    });

    test('tryDirectInstall handles empty/invalid ids gracefully', async () => {
        const r1 = await tryDirectInstall('');
        const r2 = await tryDirectInstall('garbage');
        assert.strictEqual(typeof r1, 'boolean');
        assert.strictEqual(typeof r2, 'boolean');
    });

    test('waitForExtensionInstalled returns true for already-installed extension', async function () {
        this.timeout(5000);
        // TypeScript is a built-in extension that should always be present
        const result = await waitForExtensionInstalled('vscode.typescript-language-features', 2_000);
        assert.strictEqual(result, true);
    });

    test('waitForExtensionInstalled returns false on timeout for unknown extension', async function () {
        this.timeout(5_000);
        const result = await waitForExtensionInstalled('definitely-not-installed.xxxxxxxx', 500);
        assert.strictEqual(result, false);
    });

    test('waitForExtensionInstalled cleans up its subscription on timeout', async function () {
        this.timeout(3_000);
        // Smoke test: subscription disposal shouldn't throw even when
        // the timer fires before the extension appears.
        const result = await waitForExtensionInstalled('not.a.real.extension', 200);
        assert.strictEqual(result, false);
    });
});
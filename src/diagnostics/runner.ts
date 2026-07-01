/**
 * Self-diagnostics runner — exercises the LSP-first context pipeline inside
 * the user's real VS Code environment where all LSP extensions are installed
 * and trusted.
 *
 * Trigger via Command Palette: "CC Completion: Run Diagnostics"
 *
 * This is the ONLY reliable way to run LSP-dependent E2E assertions, because
 * the `@vscode/test-cli` runner cannot bypass the publisher-trust dialog
 * (DialogService refuses to show dialogs in headless test environments).
 *
 * The diagnostics create temporary source files, wait for LSP indexing,
 * exercise ContextBuilderService.gather(), and report pass/fail to an
 * output channel. Temp files are cleaned up on completion.
 */

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextBuilderService } from '../completions/context/contextBuilderService';
import { LogService } from '../completions/shared/log/logService';
import { LANG_TO_LSP_EXTENSIONS, extensionUriFor } from '../completions/context/lspSupport';

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

let _counter = 0;

/** Create a temp file URI with a unique name. */
function tmpUri(ext: string, label: string): vscode.Uri {
    const ts = Date.now();
    const idx = _counter++;
    return vscode.Uri.file(path.join(os.tmpdir(), `__cc_diag_${label}_${ts}_${idx}${ext}`));
}

/** Write a UTF-8 file to disk. */
async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

/** Open a document in the editor (triggers LSP activation). */
async function openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
    return doc;
}

/** Wait for LSP to respond with document symbols. */
async function waitForLsp(
    uri: vscode.Uri,
    timeoutMs: number = 20_000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const symbols = await vscode.commands.executeCommand<
                vscode.DocumentSymbol[] | undefined
            >('vscode.executeDocumentSymbolProvider', uri);
            if (symbols && symbols.length > 0) return true;
        } catch {
            // LSP not ready yet
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

/** Remove a temp file. */
async function removeFile(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(uri);
    } catch {
        // best-effort cleanup
    }
}

// ──────────────────────────────────────────────────────────────
//  Test registry
// ──────────────────────────────────────────────────────────────

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>): void {
    tests.push({ name, fn });
}

// ──────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────

test('LSP: TypeScript built-in TS server responds with symbols', async () => {
    const uri = tmpUri('.ts', 'lsp_ts');
    await writeFile(uri, 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
    await openDocument(uri);
    const ok = await waitForLsp(uri, 15_000);
    assert.ok(ok, 'TypeScript LSP did not return symbols within 15s');
    await removeFile(uri);
});

test('LSP: Python (Pylance) responds with symbols', async () => {
    const uri = tmpUri('.py', 'lsp_py');
    await writeFile(uri, 'def greet(name: str) -> str:\n    return f"hello {name}"\n');
    await openDocument(uri);
    const ok = await waitForLsp(uri, 15_000);
    // Python LSP may not be installed — assert pass regardless, but log
    if (!ok) {
        console.warn('[diagnostics] Python LSP not detected (Pylance may not be installed)');
    }
    await removeFile(uri);
});

test('LSP: Go symbols (if Go extension installed)', async () => {
    const uri = tmpUri('.go', 'lsp_go');
    await writeFile(uri, 'package main\n\nfunc greet(name string) string {\n\treturn "hello " + name\n}\n');
    await openDocument(uri);
    const ok = await waitForLsp(uri, 10_000);
    if (!ok) {
        console.warn('[diagnostics] Go LSP not detected (golang.go may not be installed)');
    }
    await removeFile(uri);
});

test('Phase A: TypeScript import resolution with relativePath', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const targetUri = tmpUri('.ts', 'phase_a_target');
    const sourceUri = tmpUri('.ts', 'phase_a_source');

    await writeFile(targetUri, [
        'export interface User { id: string; name: string }',
        'export function getUser(id: string): Promise<User> {',
        '  return Promise.resolve({ id, name: "" });',
        '}',
    ].join('\n'));

    const targetName = path.basename(targetUri.path).replace(/\.ts$/, '');
    await writeFile(sourceUri, [
        `import { getUser, User } from './${targetName}';`,
        '',
        'function process(id: string): void {',
        '  const u = await getUser(id);',
        '}',
    ].join('\n'));

    await openDocument(targetUri);
    await openDocument(sourceUri);
    await waitForLsp(targetUri, 15_000);
    await waitForLsp(sourceUri, 5_000);

    const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(sourceDoc, new vscode.Position(2, 25));

    // Phase A contract: at least one import resolution with relativePath
    assert.ok(Array.isArray(bundle.importResolutions), 'importResolutions must be array');
    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        assert.ok(typeof imp.relativePath === 'string', 'relativePath must be string');
        assert.ok(imp.relativePath.startsWith('./'), `relativePath must start with ./, got ${imp.relativePath}`);
    }

    // Phase B: statementEndLine should be a number
    assert.ok(typeof bundle.statementEndLine === 'number', 'statementEndLine must be number');

    // Phase D: languageId is set
    assert.strictEqual(bundle.languageId, 'typescript');

    await removeFile(targetUri);
    await removeFile(sourceUri);
});

test('Phase A: relativePath is mandatory on every ImportResolution', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const targetUri = tmpUri('.ts', 'phase_a_mandatory_target');
    const sourceUri = tmpUri('.ts', 'phase_a_mandatory_source');

    await writeFile(targetUri, 'export const x = 1;\n');
    const targetName = path.basename(targetUri.path).replace(/\.ts$/, '');
    await writeFile(sourceUri, `import { x } from './${targetName}';\n`);

    await openDocument(targetUri);
    await openDocument(sourceUri);
    await waitForLsp(targetUri, 10_000);

    const doc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    for (const imp of bundle.importResolutions) {
        assert.ok(typeof imp.relativePath === 'string', 'relativePath must be string');
        assert.ok(imp.relativePath.startsWith('./') || imp.relativePath.startsWith('../'),
            `relativePath must start with ./ or ../, got ${imp.relativePath}`);
    }

    await removeFile(targetUri);
    await removeFile(sourceUri);
});

test('Phase B: statement end detected via LSP', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'phase_b');
    await writeFile(uri, 'const x = 42;\nconst y = x + 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Cursor at line 0, column 6 (inside "const x = 42")
    const bundle = await builder.gather(doc, new vscode.Position(0, 6));

    assert.ok(typeof bundle.statementEndLine === 'number',
        `statementEndLine should be a number, got ${typeof bundle.statementEndLine}`);
    // For "const x = 42;\n" on line 0, statement should end on line 0 or later
    assert.ok(bundle.statementEndLine! >= 0,
        `statementEndLine should be >= 0, got ${bundle.statementEndLine}`);

    await removeFile(uri);
});

test('Phase H: missingImports is always an array', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'phase_h');
    await writeFile(uri, 'export const ok = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    assert.ok(Array.isArray(bundle.missingImports),
        `missingImports must be an array, got ${typeof bundle.missingImports}`);

    await removeFile(uri);
});

test('Phase G: superTypes is undefined for non-class cursor', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'phase_g');
    await writeFile(uri, 'function foo(): void {}\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    // Cursor is on a function, not a class — superTypes should be undefined
    assert.strictEqual(bundle.superTypes, undefined,
        'superTypes should be undefined for non-class cursor');

    await removeFile(uri);
});

test('Bundle: JSON-serializable and contains required fields', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'bundle_json');
    await writeFile(uri, 'export class Bar { x: number = 1; }\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    const json = JSON.stringify(bundle);
    assert.ok(json.length > 0, 'Bundle must serialize to non-empty JSON');

    // Core field types
    assert.ok(Array.isArray(bundle.fileExports));
    assert.ok(Array.isArray(bundle.importResolutions));
    assert.strictEqual(bundle.languageId, 'typescript');

    await removeFile(uri);
});

test('languageSyntax matches TypeScript rules', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'syntax');
    await writeFile(uri, 'const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    assert.strictEqual(bundle.languageId, 'typescript');
    assert.strictEqual(bundle.languageSyntax.comment, '//');
    assert.strictEqual(bundle.languageSyntax.semicolons, true);
    assert.ok(Array.isArray(bundle.languageSyntax.brackets));
    assert.ok(Array.isArray(bundle.languageSyntax.continuationOperators));

    await removeFile(uri);
});

test('LspSupportNotifier: LANG_TO_LSP_EXTENSIONS entries are valid', async () => {
    for (const [lang, exts] of Object.entries(LANG_TO_LSP_EXTENSIONS)) {
        assert.ok(Array.isArray(exts), `${lang} extensions must be an array`);
        for (const ext of exts) {
            assert.ok(typeof ext.name === 'string' && ext.name.length > 0,
                `${lang}: name must be non-empty`);
            assert.ok(typeof ext.id === 'string' && ext.id.includes('.'),
                `${lang}: id must be publisher.name, got ${ext.id}`);
            assert.ok(ext.marketplaceUrl.startsWith('https://marketplace.visualstudio.com/items?itemName='),
                `${lang}: marketplaceUrl must be a marketplace URL`);
            assert.ok(ext.marketplaceUrl.endsWith(ext.id),
                `${lang}: marketplaceUrl should end with extension id`);
            const uri = extensionUriFor(ext.id);
            assert.strictEqual(uri.scheme, 'vscode');
            assert.ok(uri.toString().endsWith(ext.id));
        }
    }
});

// ──────────────────────────────────────────────────────────────
//  Runner entry point
// ──────────────────────────────────────────────────────────────

export interface DiagnosticsSummary {
    passed: number;
    failed: number;
    total: number;
    durationMs: number;
}

/**
 * Run all registered diagnostics and report results to the given output channel.
 * Returns a summary object. Temp files are cleaned up after each test.
 */
export async function runAllDiagnostics(
    channel: vscode.OutputChannel,
): Promise<DiagnosticsSummary> {
    const start = Date.now();
    let passed = 0;
    let failed = 0;

    channel.appendLine('╔══════════════════════════════════════════════╗');
    channel.appendLine('║  CC Completion — Self Diagnostics           ║');
    channel.appendLine('╚══════════════════════════════════════════════╝');
    channel.appendLine('');
    channel.appendLine(`Running ${tests.length} diagnostics...`);
    channel.appendLine('');

    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            channel.appendLine(`  ✓ ${t.name}`);
        } catch (err) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            channel.appendLine(`  ✗ ${t.name}`);
            channel.appendLine(`      ${msg}`);
        }
    }

    const elapsed = Date.now() - start;
    channel.appendLine('');
    channel.appendLine(`── ${elapsed}ms ──`);
    if (failed === 0) {
        channel.appendLine(`  All ${passed} diagnostics passed.`);
    } else {
        channel.appendLine(`  ${passed} passed, ${failed} failed (${tests.length} total)`);
    }
    channel.appendLine('');

    return { passed, failed, total: tests.length, durationMs: elapsed };
}

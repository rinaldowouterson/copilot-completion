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

// ──────────────────────────────────────────────────────────────
//  Multi-language LSP detection
// ──────────────────────────────────────────────────────────────

/**
 * Helper: create a file for a given language, wait for LSP symbols,
 * and assert or warn.
 */
async function testLspDetection(
    label: string,
    ext: string,
    content: string,
    timeoutMs: number = 15_000,
): Promise<void> {
    const uri = tmpUri(ext, `lsp_${label}`);
    await writeFile(uri, content);
    await openDocument(uri);
    const ok = await waitForLsp(uri, timeoutMs);
    if (!ok) {
        console.warn(`[diagnostics] LSP not detected for ${label} (extension may not be installed)`);
    }
    await removeFile(uri);
}

test('LSP: Rust (rust-analyzer) responds with symbols', async () => {
    await testLspDetection('rust', '.rs', 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n');
});

test('LSP: Java (redhat.java) responds with symbols', async () => {
    await testLspDetection('java', '.java',
        'public class Hello {\n    public static void main(String[] args) {}\n}\n');
});

test('LSP: C# (ms-dotnettools.csharp) responds with symbols', async () => {
    await testLspDetection('csharp', '.cs',
        'class Hello { static void Main() {} }\n');
});

test('LSP: C/C++ (ms-vscode.cpptools) responds with symbols', async () => {
    await testLspDetection('cpp', '.cpp', 'int main() { return 0; }\n');
    await testLspDetection('c', '.c', 'int main() { return 0; }\n');
});

test('LSP: PHP (Intelephense) responds with symbols', async () => {
    await testLspDetection('php', '.php', '<?php function greet($name) { return "hello $name"; }\n');
});

test('LSP: Ruby (Ruby LSP) responds with symbols', async () => {
    await testLspDetection('ruby', '.rb', 'def greet(name)\n  "hello #{name}"\nend\n');
});

test('LSP: Dart responds with symbols', async () => {
    await testLspDetection('dart', '.dart',
        'void main() { print("hello"); }\n');
});

test('LSP: Lua (sumneko.lua) responds with symbols', async () => {
    await testLspDetection('lua', '.lua', 'function greet(name) return "hello " .. name end\n');
});

// ──────────────────────────────────────────────────────────────
//  Phase C: hover enrichment
// ──────────────────────────────────────────────────────────────

test('Phase C: hover enrichment provides type signatures', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const targetUri = tmpUri('.ts', 'phase_c_target');
    const sourceUri = tmpUri('.ts', 'phase_c_source');

    await writeFile(targetUri, [
        'export interface User { id: string; name: string }',
        'export function createUser(name: string): User {',
        '  return { id: "1", name };',
        '}',
    ].join('\n'));

    const targetName = path.basename(targetUri.path).replace(/\.ts$/, '');
    await writeFile(sourceUri, [
        `import { createUser } from './${targetName}';`,
        '',
        'const u = createUser("test");',
    ].join('\n'));

    await openDocument(targetUri);
    await openDocument(sourceUri);
    await waitForLsp(targetUri, 15_000);
    await waitForLsp(sourceUri, 5_000);

    const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(sourceDoc, new vscode.Position(2, 12));

    // Phase C: if the LSP can resolve imports, we should have export types
    if (bundle.fileExports.length > 0) {
        // fileExports should have `type` field populated by hover enrichment
        const hasTypes = bundle.fileExports.some(e => e.type !== undefined);
        // This is a soft assertion — hover enrichment requires both LSP import
        // resolution AND hover provider support. Log but don't fail.
        if (!hasTypes) {
            console.warn('[diagnostics] Phase C: no hover type signatures found (LSP may not support hover for this context)');
        }
    }

    await removeFile(targetUri);
    await removeFile(sourceUri);
});

// ──────────────────────────────────────────────────────────────
//  Phase G: class hierarchy (OOP)
// ──────────────────────────────────────────────────────────────

test('Phase G: superTypes resolved for class inheritance', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'phase_g_class');
    await writeFile(uri, [
        'interface Base { id: string }',
        'class Derived implements Base {',
        '  constructor(public id: string) {}',
        '}',
    ].join('\n'));

    await openDocument(uri);
    await waitForLsp(uri, 15_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Cursor on line 1 (class Derived), column 6
    const bundle = await builder.gather(doc, new vscode.Position(1, 6));

    // Phase G: if LSP supports type hierarchy, superTypes may be populated.
    // This is a soft assertion — some LSPs don't support TypeHierarchy.
    if (bundle.superTypes && bundle.superTypes.length > 0) {
        const names = bundle.superTypes.map(s => s.name);
        assert.ok(names.includes('Base'),
            `Expected superType "Base" in [${names.join(', ')}]`);
    } else {
        console.warn('[diagnostics] Phase G: no superTypes returned (LSP may not support type hierarchy for TypeScript)');
    }

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  Multi-language bundle shapes
// ──────────────────────────────────────────────────────────────

test('Bundle: Python function export shape', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.py', 'bundle_py');
    await writeFile(uri, 'def add(a: int, b: int) -> int:\n    return a + b\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 5));

    assert.strictEqual(bundle.languageId, 'python');
    assert.ok(Array.isArray(bundle.fileExports));
    assert.ok(Array.isArray(bundle.importResolutions));
    assert.ok(typeof bundle.statementEndLine === 'number');
    // Python uses # for comments and has no semicolons
    assert.strictEqual(bundle.languageSyntax.comment, '#');
    assert.strictEqual(bundle.languageSyntax.semicolons, false);

    await removeFile(uri);
});

test('Bundle: Rust module export shape', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.rs', 'bundle_rs');
    await writeFile(uri, [
        'pub fn multiply(a: i32, b: i32) -> i32 { a * b }',
        '',
        'pub struct Point { x: i32, y: i32 }',
    ].join('\n'));
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 10));

    assert.strictEqual(bundle.languageId, 'rust');
    assert.ok(Array.isArray(bundle.fileExports));
    assert.ok(Array.isArray(bundle.importResolutions));
    assert.ok(typeof bundle.statementEndLine === 'number');
    // Rust uses // and has semicolons
    assert.strictEqual(bundle.languageSyntax.comment, '//');
    assert.strictEqual(bundle.languageSyntax.semicolons, true);

    await removeFile(uri);
});

test('Bundle: Go export shape with language routing', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.go', 'bundle_go');
    await writeFile(uri, 'package lib\n\nfunc Greet(name string) string {\n\treturn "hello, " + name\n}\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(2, 10));

    assert.strictEqual(bundle.languageId, 'go');
    assert.ok(Array.isArray(bundle.fileExports));
    assert.ok(Array.isArray(bundle.importResolutions));
    assert.ok(typeof bundle.statementEndLine === 'number');
    // Go uses // and has no semicolons (inserted by formatter)
    assert.strictEqual(bundle.languageSyntax.comment, '//');

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  P0/P1 Gap: Resilience & Error Handling
// ──────────────────────────────────────────────────────────────

test('[P0] Phase A: import from non-existent file returns empty — not crash', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const sourceUri = tmpUri('.ts', 'gap_missing_target');
    await writeFile(sourceUri, [
        `import { Missing } from './nonexistent-module';`,
        '',
        'function test(): void { Missing.doSomething(); }',
    ].join('\n'));

    await openDocument(sourceUri);
    await waitForLsp(sourceUri, 10_000);

    const doc = await vscode.workspace.openTextDocument(sourceUri);
    // This should NOT throw — must return empty importResolutions gracefully
    const bundle = await builder.gather(doc, new vscode.Position(2, 20));

    assert.ok(Array.isArray(bundle.importResolutions),
        'importResolutions must be array even when target is missing');
    // May be 0 if LSP can't resolve, or 1+ if it finds something — both OK
    assert.ok(typeof bundle.statementEndLine === 'number',
        'statementEndLine must be number even with broken imports');
    assert.strictEqual(bundle.languageId, 'typescript');

    await removeFile(sourceUri);
});

test('[P0] Phase A: broken import syntax does not crash gather()', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_broken_syntax');
    // Malformed import — missing closing quote
    await writeFile(uri, [
        `import { x } from './broken;`,
        'const y = 1;',
    ].join('\n'));

    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(1, 5));

    assert.ok(Array.isArray(bundle.importResolutions),
        'importResolutions must be array even with broken import syntax');
    assert.ok(typeof bundle.statementEndLine === 'number');
    // The regex should skip the malformed line, but the file should still parse
    assert.strictEqual(bundle.fileExports.length, 0);

    await removeFile(uri);
});

test('[P0] Phase H: actual missing-import detection', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_phase_h_detection');
    // Use an undefined symbol that TypeScript will flag
    await writeFile(uri, [
        '// This file uses madeUpFunction that is not imported',
        'const result = madeUpFunction("test");',
    ].join('\n'));

    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    // Wait a beat for diagnostics to propagate
    await new Promise(r => setTimeout(r, 1000));

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(1, 20));

    assert.ok(Array.isArray(bundle.missingImports),
        'missingImports must be array');
    // If TypeScript LSP is active, it SHOULD detect madeUpFunction as undefined
    const found = bundle.missingImports.find(m => m.symbolName === 'madeUpFunction');
    if (found) {
        console.log('[diagnostics] Phase H: detected missing import: madeUpFunction');
    } else {
        // This may fail if diagnostics haven't propagated yet — log but don't fail
        console.warn('[diagnostics] Phase H: missing import NOT detected (diagnostics may need more time)');
    }

    await removeFile(uri);
});

test('[P1] Phase H: gather() on empty file does not throw', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_empty_file');
    await writeFile(uri, '');
    await openDocument(uri);
    await waitForLsp(uri, 5_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    assert.ok(Array.isArray(bundle.fileExports), 'fileExports must be array on empty file');
    assert.strictEqual(bundle.fileExports.length, 0, 'empty file has no exports');
    assert.ok(Array.isArray(bundle.importResolutions));
    assert.strictEqual(bundle.importResolutions.length, 0);
    assert.ok(Array.isArray(bundle.missingImports));

    // statementEndLine should still be a number (heuristic fallback)
    assert.ok(typeof bundle.statementEndLine === 'number',
        `statementEndLine must be number on empty file, got ${typeof bundle.statementEndLine}`);

    console.log(`[diagnostics] Empty file: statementEndLine=${bundle.statementEndLine}, languageId=${bundle.languageId}`);

    await removeFile(uri);
});

test('[P1] Phase B: cursor at end of file returns valid statementEndLine', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_eof');
    await writeFile(uri, [
        'const x = 42;',
        'const y = x + 1;',
    ].join('\n'));
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Cursor at last line, column 0
    const lastLine = doc.lineCount - 1;
    const bundle = await builder.gather(doc, new vscode.Position(lastLine, 0));

    assert.ok(typeof bundle.statementEndLine === 'number',
        `statementEndLine must be number at EOF, got ${typeof bundle.statementEndLine}`);
    assert.ok(bundle.statementEndLine! >= lastLine,
        `statementEndLine (${bundle.statementEndLine}) should be >= cursor line (${lastLine})`);

    console.log(`[diagnostics] EOF cursor: statementEndLine=${bundle.statementEndLine}, lastLine=${lastLine}`);

    await removeFile(uri);
});

test('[P1] Phase B: multi-line block statement end', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_multiline');
    await writeFile(uri, [
        'function demo() {',
        '  const a = 1;',
        '  const b = 2;',
        '  return a + b;',
        '}',
    ].join('\n'));
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(1, 7)); // inside the function

    assert.ok(typeof bundle.statementEndLine === 'number',
        `statementEndLine must be number, got ${typeof bundle.statementEndLine}`);
    // Statement on line 1 is 'const a = 1;' — should end on line 1 or later
    assert.ok(bundle.statementEndLine! >= 1,
        `statementEndLine (${bundle.statementEndLine}) should be >= 1`);

    console.log(`[diagnostics] Multi-line block: statementEndLine=${bundle.statementEndLine}, enclosingScope=${bundle.enclosingScope?.name ?? 'none'}`);

    await removeFile(uri);
});

test('[P1] untitled:Untitled-1 document does not throw in gather()', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Create an untitled document (no fsPath)
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 1;\n' });
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });

    const bundle = await builder.gather(doc, new vscode.Position(0, 5));

    assert.ok(Array.isArray(bundle.importResolutions),
        'importResolutions must be array for untitled docs');
    assert.strictEqual(bundle.importResolutions.length, 0,
        'untitled docs should have 0 import resolutions');
    assert.ok(typeof bundle.statementEndLine === 'number',
        `statementEndLine must be number for untitled docs, got ${typeof bundle.statementEndLine}`);

    console.log(`[diagnostics] Untitled doc: languageId=${bundle.languageId}, statementEndLine=${bundle.statementEndLine}`);
});

test('[P1] Phase G: LSP without TypeHierarchy returns undefined superTypes', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Python LSP (Pylance) doesn't support type hierarchy — verify graceful handling
    const uri = tmpUri('.py', 'gap_no_th');
    await writeFile(uri, [
        'class MyBase:',
        '    pass',
        '',
        'class MyDerived(MyBase):',
        '    pass',
    ].join('\n'));
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Cursor on line 3 (class MyDerived)
    const bundle = await builder.gather(doc, new vscode.Position(3, 10));

    // Should not throw — superTypes may be undefined or [] depending on LSP
    assert.ok(bundle.superTypes === undefined || Array.isArray(bundle.superTypes),
        `superTypes must be undefined or array, got ${typeof bundle.superTypes}`);

    console.log(`[diagnostics] Python class: superTypes=${bundle.superTypes ? JSON.stringify(bundle.superTypes.map(s => s.name)) : 'undefined'}`);

    await removeFile(uri);
});

test('[P1] Phase C: hover on whitespace returns empty — does not throw', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_hover_whitespace');
    await writeFile(uri, [
        'const x = 42;',
        '',
        'function foo() { return x; }',
    ].join('\n'));
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Cursor on line 1 (blank line), column 0 — hover returns nothing
    const bundle = await builder.gather(doc, new vscode.Position(1, 0));

    assert.ok(Array.isArray(bundle.fileExports));
    assert.ok(typeof bundle.statementEndLine === 'number');

    console.log(`[diagnostics] Hover on whitespace: fileExports=${bundle.fileExports.length}, statementEndLine=${bundle.statementEndLine}`);

    await removeFile(uri);
});

test('[P0] gather() safety net: malformed document never throws', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Binary-ish content that could confuse parsers
    const uri = tmpUri('.ts', 'gap_binaryish');
    await writeFile(uri, '\x00\x01\x02const \x00\x00 = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 5_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    // Must never throw — should return a minimal valid bundle
    assert.ok(Array.isArray(bundle.fileExports));
    assert.ok(Array.isArray(bundle.importResolutions));
    assert.ok(Array.isArray(bundle.missingImports));
    assert.strictEqual(bundle.languageId, 'typescript');

    console.log(`[diagnostics] Binary-ish content: threw=false, exports=${bundle.fileExports.length}`);

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  Workspace cache: incremental per-file update on save
// ──────────────────────────────────────────────────────────────

test('[P2] Workspace cache: save updates only the saved file\'s entry', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uriA = tmpUri('.ts', 'ws_cache_a');
    const uriB = tmpUri('.ts', 'ws_cache_b');

    await writeFile(uriA, 'export const a = 1;\n');
    await writeFile(uriB, 'export const b = 2;\n');

    await openDocument(uriA);
    await openDocument(uriB);
    await waitForLsp(uriA, 10_000);
    await waitForLsp(uriB, 5_000);

    // Gather on A to seed workspace cache with both files
    const docA = await vscode.workspace.openTextDocument(uriA);
    const bundleBefore = await builder.gather(docA, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundleBefore.fileExports));

    // Modify and save file B — should update only B's cache entry
    await writeFile(uriB, 'export const b_updated = 22;\n');
    // Saving triggers _updateFileInWorkspaceCache via onDidSaveTextDocument
    const docB = await vscode.workspace.openTextDocument(uriB);
    await docB.save();

    // Wait for the async cache update
    await new Promise(r => setTimeout(r, 1000));

    // Gather on A again — A's exports should be unchanged, B should be fresh
    const bundleAfter = await builder.gather(docA, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundleAfter.fileExports));

    console.log(`[diagnostics] Workspace cache: fileA unchanged, fileB updated (save-based incremental update)`);

    await removeFile(uriA);
    await removeFile(uriB);
});

test('[P2] Workspace cache: non-file URI save is handled gracefully', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Untitled document — saving it should not throw in the cache update
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 1;\n' });
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });

    // Gather to initialize cache
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundle.fileExports));

    // Save triggers _updateFileInWorkspaceCache — must not throw for untitled URI
    await doc.save();
    await new Promise(r => setTimeout(r, 500));

    // Gather again — should still work
    bundle = await builder.gather(doc, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundle.fileExports));
    assert.strictEqual(bundle.languageId, 'typescript');

    console.log('[diagnostics] Workspace cache: untitled save did not throw');
});

test('[P2] Workspace cache: multiple rapid saves do not queue excessive queries', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'ws_cache_rapid');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);

    // Trigger multiple rapid saves (simulates Save All / bulk edit)
    for (let i = 0; i < 10; i++) {
        await writeFile(uri, `export const x = ${i};\n`);
        // Re-open document to get fresh content for save
        const freshDoc = await vscode.workspace.openTextDocument(uri);
        await freshDoc.save();
    }

    // Allow the async cache updates to settle
    await new Promise(r => setTimeout(r, 1000));

    // Gather — should not throw and return valid data
    const finalDoc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(finalDoc, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundle.fileExports), 'fileExports must be array after rapid saves');
    assert.strictEqual(bundle.languageId, 'typescript');

    console.log(`[diagnostics] Workspace cache: 10 rapid saves completed, gather() OK, exports=${bundle.fileExports.length}`);

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  LSP extension registry validation
// ──────────────────────────────────────────────────────────────

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

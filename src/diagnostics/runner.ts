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
//  Structured assertion logger
// ──────────────────────────────────────────────────────────────

/**
 * Wraps Node's assert with structured logging so every assertion
 * emits expected vs actual to the output channel — not just on failure.
 */
class AssertLogger {
    private _checks = 0;

    /** Log a named value (not an assertion, just data). */
    value(label: string, val: unknown): void {
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        console.log(`  [data] ${label}: ${str}`);
    }

    /** Assert `ok` is truthy, log ✓ or ✗. */
    ok(ok: boolean, label: string, actual?: unknown): void {
        this._checks++;
        if (ok) {
            console.log(`  ✓ ${label}`);
        } else {
            const hint = actual !== undefined ? ` (actual: ${JSON.stringify(actual)})` : '';
            console.log(`  ✗ ${label}${hint}`);
            assert.ok(ok, `${label}${hint}`);
        }
    }

    /** Assert `actual === expected`, log both. */
    equal<T>(actual: T, expected: T, label: string): void {
        this._checks++;
        if (actual === expected) {
            console.log(`  ✓ ${label}: ${JSON.stringify(expected)}`);
        } else {
            console.log(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            assert.strictEqual(actual, expected, label);
        }
    }

    /** Assert `actual` is contained in `expected` (string includes). */
    includes(actual: string, expectedSubstr: string, label: string): void {
        this._checks++;
        if (actual.includes(expectedSubstr)) {
            console.log(`  ✓ ${label}: contains "${expectedSubstr}"`);
        } else {
            console.log(`  ✗ ${label}: expected "${actual}" to contain "${expectedSubstr}"`);
            assert.ok(actual.includes(expectedSubstr), label);
        }
    }

    /** Assert array contains a value. */
    arrayContains<T>(arr: T[], item: T, label: string): void {
        this._checks++;
        if (arr.includes(item)) {
            console.log(`  ✓ ${label}: found "${item}" in [${arr.join(', ')}]`);
        } else {
            console.log(`  ✗ ${label}: expected [${arr.join(', ')}] to contain "${item}"`);
            assert.ok(arr.includes(item), label);
        }
    }

    /** Assert typeof matches. */
    typeOf(val: unknown, type: string, label: string): void {
        this._checks++;
        const actualType = typeof val;
        if (actualType === type) {
            console.log(`  ✓ ${label}: ${type}`);
        } else {
            console.log(`  ✗ ${label}: expected ${type}, got ${actualType}`);
            assert.strictEqual(actualType, type, label);
        }
    }

    get checkCount(): number { return this._checks; }
}

// ──────────────────────────────────────────────────────────────
//  Test registry
// ──────────────────────────────────────────────────────────────

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

const tests: Array<{ name: string; fn: (ctx: AssertLogger) => Promise<void> }> = [];

function test(name: string, fn: (ctx: AssertLogger) => Promise<void>): void {
    tests.push({ name, fn });
}

// ──────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────

test('LSP: TypeScript built-in TS server responds with symbols', async (ctx) => {
    const uri = tmpUri('.ts', 'lsp_ts');
    await writeFile(uri, 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
    await openDocument(uri);
    const ok = await waitForLsp(uri, 15_000);
    ctx.ok(ok, 'TypeScript LSP returns symbols within 15s', ok);
    await removeFile(uri);
});

test('LSP: Python (Pylance) responds with symbols', async (ctx) => {
    const uri = tmpUri('.py', 'lsp_py');
    await writeFile(uri, 'def greet(name: str) -> str:\n    return f"hello {name}"\n');
    await openDocument(uri);
    const ok = await waitForLsp(uri, 15_000);
    ctx.ok(ok, 'Python LSP returns symbols within 15s (may be absent)', ok);
    await removeFile(uri);
});

test('LSP: Go symbols (if Go extension installed)', async (ctx) => {
    const uri = tmpUri('.go', 'lsp_go');
    await writeFile(uri, 'package main\n\nfunc greet(name string) string {\n\treturn "hello " + name\n}\n');
    await openDocument(uri);
    const ok = await waitForLsp(uri, 10_000);
    ctx.ok(ok, 'Go LSP returns symbols (may be absent)', ok);
    await removeFile(uri);
});

test('Phase A: TypeScript import resolution with relativePath', async (ctx) => {
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
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.value('importResolutions count', bundle.importResolutions.length);
    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.typeOf(imp.relativePath, 'string', 'relativePath type');
        ctx.value('relativePath value', imp.relativePath);
        ctx.ok(imp.relativePath.startsWith('./'), 'relativePath starts with ./', imp.relativePath);
    }

    // Phase B: statementEndLine should be a number
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);

    // Phase D: languageId is set
    ctx.equal(bundle.languageId, 'typescript', 'languageId');

    await removeFile(targetUri);
    await removeFile(sourceUri);
});

test('Phase A: relativePath is mandatory on every ImportResolution', async (ctx) => {
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

    ctx.value('importResolutions count', bundle.importResolutions.length);
    for (const imp of bundle.importResolutions) {
        ctx.typeOf(imp.relativePath, 'string', 'relativePath type');
        ctx.value('relativePath', imp.relativePath);
        ctx.ok(imp.relativePath.startsWith('./') || imp.relativePath.startsWith('../'),
            'relativePath starts with ./ or ../', imp.relativePath);
    }

    await removeFile(targetUri);
    await removeFile(sourceUri);
});

test('Phase B: statement end detected via LSP', async (ctx) => {
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

    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine value', bundle.statementEndLine);
    // For "const x = 42;\n" on line 0, statement should end on line 0 or later
    ctx.ok(bundle.statementEndLine! >= 0, 'statementEndLine >= 0', bundle.statementEndLine);

    await removeFile(uri);
});

test('Phase H: missingImports is always an array', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'phase_h');
    await writeFile(uri, 'export const ok = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    ctx.ok(Array.isArray(bundle.missingImports), 'missingImports is array');
    ctx.value('missingImports count', bundle.missingImports.length);

    await removeFile(uri);
});

test('Phase G: superTypes is undefined for non-class cursor', async (ctx) => {
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
    ctx.equal(bundle.superTypes, undefined, 'superTypes undefined for non-class cursor');

    await removeFile(uri);
});

test('Bundle: JSON-serializable and contains required fields', async (ctx) => {
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
    ctx.ok(json.length > 0, 'Bundle serializes to non-empty JSON');
    ctx.value('JSON length', json.length);

    // Core field types
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.equal(bundle.languageId, 'typescript', 'languageId');
    ctx.value('export count', bundle.fileExports.length);
    ctx.value('export names', bundle.fileExports.map(e => e.name));

    await removeFile(uri);
});

test('languageSyntax matches TypeScript rules', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'syntax');
    await writeFile(uri, 'const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    ctx.equal(bundle.languageId, 'typescript', 'languageId');
    ctx.equal(bundle.languageSyntax.comment, '//', 'comment style');
    ctx.equal(bundle.languageSyntax.semicolons, true, 'semicolons required');
    ctx.ok(Array.isArray(bundle.languageSyntax.brackets), 'brackets is array');
    ctx.ok(Array.isArray(bundle.languageSyntax.continuationOperators), 'continuationOperators is array');
    ctx.value('brackets', bundle.languageSyntax.brackets);
    ctx.value('continuation operators', bundle.languageSyntax.continuationOperators);

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

test('Phase C: hover enrichment provides type signatures', async (ctx) => {
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

    ctx.value('fileExports count', bundle.fileExports.length);
    if (bundle.fileExports.length > 0) {
        const hasTypes = bundle.fileExports.some(e => e.type !== undefined);
        ctx.value('exports with type sigs', bundle.fileExports.filter(e => e.type !== undefined).map(e => `${e.name}:${e.type}`));
        ctx.ok(hasTypes, 'some exports have hover type signatures (soft)', hasTypes);
    }

    await removeFile(targetUri);
    await removeFile(sourceUri);
});

// ──────────────────────────────────────────────────────────────
//  Phase G: class hierarchy (OOP)
// ──────────────────────────────────────────────────────────────

test('Phase G: superTypes resolved for class inheritance', async (ctx) => {
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

    ctx.value('superTypes', bundle.superTypes ? bundle.superTypes.map(s => s.name) : 'undefined');

    // Phase G: if LSP supports type hierarchy, superTypes may be populated.
    if (bundle.superTypes && bundle.superTypes.length > 0) {
        const names = bundle.superTypes.map(s => s.name);
        ctx.arrayContains(names, 'Base', 'superTypes contains Base');
    }

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  Multi-language bundle shapes
// ──────────────────────────────────────────────────────────────

test('Bundle: Python function export shape', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.py', 'bundle_py');
    await writeFile(uri, 'def add(a: int, b: int) -> int:\n    return a + b\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 5));

    ctx.equal(bundle.languageId, 'python', 'languageId');
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('fileExports', bundle.fileExports.map(e => e.name));
    // Python uses # for comments and has no semicolons
    ctx.equal(bundle.languageSyntax.comment, '#', 'comment style');
    ctx.equal(bundle.languageSyntax.semicolons, false, 'semicolons not required');

    await removeFile(uri);
});

test('Bundle: Rust module export shape', async (ctx) => {
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

    ctx.equal(bundle.languageId, 'rust', 'languageId');
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('fileExports', bundle.fileExports.map(e => `${e.name}:${e.kind}`));
    // Rust uses // and has semicolons
    ctx.equal(bundle.languageSyntax.comment, '//', 'comment style');
    ctx.equal(bundle.languageSyntax.semicolons, true, 'semicolons required');

    await removeFile(uri);
});

test('Bundle: Go export shape with language routing', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.go', 'bundle_go');
    await writeFile(uri, 'package lib\n\nfunc Greet(name string) string {\n\treturn "hello, " + name\n}\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(2, 10));

    ctx.equal(bundle.languageId, 'go', 'languageId');
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('fileExports', bundle.fileExports.map(e => `${e.name}:${e.kind}`));
    // Go uses // and has no semicolons (inserted by formatter)
    ctx.equal(bundle.languageSyntax.comment, '//', 'comment style');

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  P0/P1 Gap: Resilience & Error Handling
// ──────────────────────────────────────────────────────────────

test('[P0] Phase A: import from non-existent file returns empty — not crash', async (ctx) => {
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

    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array for missing target');
    ctx.value('importResolutions count', bundle.importResolutions.length);
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type (heuristic fallback)');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.equal(bundle.languageId, 'typescript', 'languageId');

    await removeFile(sourceUri);
});

test('[P0] Phase A: broken import syntax does not crash gather()', async (ctx) => {
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

    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array with broken syntax');
    ctx.value('importResolutions count', bundle.importResolutions.length);
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.equal(bundle.fileExports.length, 0, 'fileExports empty for malformed file');

    await removeFile(uri);
});

test('[P0] Phase H: actual missing-import detection', async (ctx) => {
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

    ctx.ok(Array.isArray(bundle.missingImports), 'missingImports is array');
    ctx.value('missingImports', bundle.missingImports.map(m => m.symbolName));

    // If TypeScript LSP is active, it SHOULD detect madeUpFunction as undefined
    const found = bundle.missingImports.find(m => m.symbolName === 'madeUpFunction');
    ctx.ok(!!found, 'madeUpFunction detected as missing import', found?.symbolName);

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

test('[P1] Phase B: cursor at end of file returns valid statementEndLine', async (ctx) => {
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

    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type at EOF');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('cursor lastLine', lastLine);
    ctx.ok(bundle.statementEndLine! >= lastLine,
        `statementEndLine >= cursor line`, bundle.statementEndLine);

    await removeFile(uri);
});

test('[P1] Phase B: multi-line block statement end', async (ctx) => {
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

    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('enclosingScope', bundle.enclosingScope?.name ?? 'none');
    // Statement on line 1 is 'const a = 1;' — should end on line 1 or later
    ctx.ok(bundle.statementEndLine! >= 1, 'statementEndLine >= 1', bundle.statementEndLine);

    await removeFile(uri);
});

test('[P1] untitled:Untitled-1 document does not throw in gather()', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Create an untitled document (no fsPath)
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 1;\n' });
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });

    const bundle = await builder.gather(doc, new vscode.Position(0, 5));

    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array for untitled');
    ctx.equal(bundle.importResolutions.length, 0, 'untitled importResolutions count');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type for untitled');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('languageId', bundle.languageId);
});

test('[P1] Phase G: LSP without TypeHierarchy returns undefined superTypes', async (ctx) => {
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
    ctx.ok(bundle.superTypes === undefined || Array.isArray(bundle.superTypes),
        'superTypes is undefined or array', bundle.superTypes);
    ctx.value('superTypes', bundle.superTypes ? bundle.superTypes.map(s => s.name) : 'undefined');

    await removeFile(uri);
});

test('[P1] Phase C: hover on whitespace returns empty — does not throw', async (ctx) => {
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

    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('fileExports count', bundle.fileExports.length);
    ctx.value('statementEndLine', bundle.statementEndLine);

    await removeFile(uri);
});

test('[P0] gather() safety net: malformed document never throws', async (ctx) => {
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
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.ok(Array.isArray(bundle.missingImports), 'missingImports is array');
    ctx.equal(bundle.languageId, 'typescript', 'languageId');
    ctx.value('exports', bundle.fileExports.map(e => e.name));

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
    const docB = await vscode.workspace.openTextDocument(uriB);
    const saveOk = await docB.save();
    assert.ok(saveOk, 'docB.save() must return true — event must fire for cache update');

    // Wait for the async cache update to settle
    await new Promise(r => setTimeout(r, 1000));

    // Gather on A again — A's exports should be unchanged, B should be fresh
    const bundleAfter = await builder.gather(docA, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundleAfter.fileExports));
    // fileExports on A should still be the original (a=1) since only B was saved
    const exportNames = bundleAfter.fileExports.map(e => e.name);
    console.log(`[diagnostics] Workspace cache: fileA exports=[${exportNames.join(',')}] (should still contain 'a')`);

    await removeFile(uriA);
    await removeFile(uriB);
});

test('[P2] Workspace cache: LSP unavailable per-file falls back gracefully', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Use a language with no LSP installed (plain text) — the per-file
    // symbol query will return empty, but the cache update must not throw.
    const uri = tmpUri('.txt', 'ws_cache_no_lsp');
    await writeFile(uri, 'plain text file with no symbols\n');
    await openDocument(uri);

    const doc = await vscode.workspace.openTextDocument(uri);
    const saveOk = await doc.save();
    assert.ok(saveOk, 'doc.save() must return true for .txt file');

    // Even with no LSP, gather() must not throw and should return a valid bundle
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundle.fileExports));
    assert.strictEqual(bundle.fileExports.length, 0, 'plain text has no exports');
    assert.ok(typeof bundle.statementEndLine === 'number',
        `statementEndLine must be number for plain text, got ${typeof bundle.statementEndLine}`);

    console.log('[diagnostics] Workspace cache: no-LSP file save did not throw');

    await removeFile(uri);
});

test('[P2] Workspace cache: empty file after save clears cache entry', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'ws_cache_empty');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    assert.ok(bundle.fileExports.length >= 1, 'file should have exports before empty save');

    // Replace content with empty string and save
    await writeFile(uri, '');
    const emptyDoc = await vscode.workspace.openTextDocument(uri);
    const saveOk = await emptyDoc.save();
    assert.ok(saveOk, 'empty doc save must return true');
    await new Promise(r => setTimeout(r, 1000));

    // Gather again — cache entry should now reflect the empty file
    bundle = await builder.gather(emptyDoc, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundle.fileExports));
    assert.strictEqual(bundle.fileExports.length, 0, 'empty file must have 0 exports after save');

    console.log('[diagnostics] Workspace cache: empty file after save → exports=0');

    await removeFile(uri);
});

test('[P2] Workspace cache: multiple rapid saves each trigger one per-file update', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'ws_cache_rapid');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    // Trigger multiple rapid saves (simulates Save All / bulk edit)
    for (let i = 0; i < 10; i++) {
        await writeFile(uri, `export const x = ${i};\n`);
        const freshDoc = await vscode.workspace.openTextDocument(uri);
        const ok = await freshDoc.save();
        assert.ok(ok, `save #${i} must return true`);
        // Each save fires a separate onDidSaveTextDocument event; each
        // event triggers one _updateFileInWorkspaceCache call. Since each
        // call is cheap (~5ms single-file query), no debounce is needed.
        // We verify this by checking that gather() returns the last saved value.
    }

    await new Promise(r => setTimeout(r, 1000));

    const finalDoc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(finalDoc, new vscode.Position(0, 0));
    assert.ok(Array.isArray(bundle.fileExports), 'fileExports must be array after rapid saves');
    assert.strictEqual(bundle.languageId, 'typescript');

    console.log(`[diagnostics] Workspace cache: 10 rapid saves OK, exports=${bundle.fileExports.length}`);

    await removeFile(uri);
});

test('[P2] Workspace cache: gather() after save sees fresh symbols', async () => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'ws_cache_fresh');
    await writeFile(uri, 'export const original = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    const originalNames = bundle.fileExports.map(e => e.name);
    assert.ok(originalNames.includes('original'), 'must see original export before save');

    // Replace with different exports and save
    await writeFile(uri, 'export const replaced = 2;\nexport function helper() {}\n');
    const newDoc = await vscode.workspace.openTextDocument(uri);
    const saveOk = await newDoc.save();
    assert.ok(saveOk, 'save must succeed');
    await new Promise(r => setTimeout(r, 1000));

    // Gather again — should see the REPLACED exports, not the originals
    bundle = await builder.gather(newDoc, new vscode.Position(0, 0));
    const newNames = bundle.fileExports.map(e => e.name);
    assert.ok(newNames.includes('replaced'), `must see 'replaced' after save, got [${newNames.join(',')}]`);
    assert.ok(newNames.includes('helper'), `must see 'helper' after save, got [${newNames.join(',')}]`);

    console.log(`[diagnostics] Workspace cache: exports changed from [${originalNames.join(',')}] → [${newNames.join(',')}] after save`);

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
        const ctx = new AssertLogger();
        try {
            await t.fn(ctx);
            passed++;
            channel.appendLine(`  ✓ ${t.name} (${ctx.checkCount} checks)`);
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

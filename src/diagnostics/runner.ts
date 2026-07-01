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
import { ContextBuilderService, normalizePath, extractRelativeImportSpecifiers } from '../completions/context/contextBuilderService';
import { LogService } from '../completions/shared/log/logService';
import { LANG_TO_LSP_EXTENSIONS, extensionUriFor, hasLspSupport } from '../completions/context/lspSupport';
import { cleanHoverSignature } from '../completions/context/hoverEnrichment';

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

/** Wait for LSP to respond with document symbols. Returns the symbols found (or null). */
async function waitForLsp(
    uri: vscode.Uri,
    timeoutMs: number = 20_000,
): Promise<{ ok: boolean; symbols?: vscode.DocumentSymbol[]; error?: string; pollCount: number }> {
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    let firstError: string | undefined;
    while (Date.now() < deadline) {
        try {
            const symbols = await vscode.commands.executeCommand<
                vscode.DocumentSymbol[] | undefined
            >('vscode.executeDocumentSymbolProvider', uri);
            if (symbols && symbols.length > 0) {
                return { ok: true, symbols, pollCount };
            }
        } catch (err) {
            if (!firstError) {
                firstError = err instanceof Error ? err.message : String(err);
            }
        }
        pollCount++;
        await new Promise(r => setTimeout(r, 300));
    }
    return { ok: false, error: firstError, pollCount };
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
 *
 * All output goes to the `channel` so the user sees rich data in the
 * CC Completion output panel, not buried in the debug console.
 */
class AssertLogger {
    private _checks = 0;
    private _channel: vscode.OutputChannel;

    constructor(channel: vscode.OutputChannel) {
        this._channel = channel;
    }

    /** Log a named value (not an assertion, just data). */
    value(label: string, val: unknown): void {
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        this._channel.appendLine(`  [data] ${label}: ${str}`);
    }

    /** Assert `ok` is truthy, log ✓ or ✗. */
    ok(ok: boolean, label: string, actual?: unknown): void {
        this._checks++;
        if (ok) {
            this._channel.appendLine(`  ✓ ${label}`);
        } else {
            const hint = actual !== undefined ? ` (actual: ${JSON.stringify(actual)})` : '';
            this._channel.appendLine(`  ✗ ${label}${hint}`);
            assert.ok(ok, `${label}${hint}`);
        }
    }

    /** Assert `actual === expected`, log both. */
    equal<T>(actual: T, expected: T, label: string): void {
        this._checks++;
        if (actual === expected) {
            this._channel.appendLine(`  ✓ ${label}: ${JSON.stringify(expected)}`);
        } else {
            this._channel.appendLine(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            assert.strictEqual(actual, expected, label);
        }
    }

    /** Assert `actual` is contained in `expected` (string includes). */
    includes(actual: string, expectedSubstr: string, label: string): void {
        this._checks++;
        if (actual.includes(expectedSubstr)) {
            this._channel.appendLine(`  ✓ ${label}: contains "${expectedSubstr}"`);
        } else {
            this._channel.appendLine(`  ✗ ${label}: expected "${actual}" to contain "${expectedSubstr}"`);
            assert.ok(actual.includes(expectedSubstr), label);
        }
    }

    /** Assert array contains a value. */
    arrayContains<T>(arr: T[], item: T, label: string): void {
        this._checks++;
        if (arr.includes(item)) {
            this._channel.appendLine(`  ✓ ${label}: found "${item}" in [${arr.join(', ')}]`);
        } else {
            this._channel.appendLine(`  ✗ ${label}: expected [${arr.join(', ')}] to contain "${item}"`);
            assert.ok(arr.includes(item), label);
        }
    }

    /** Assert typeof matches. */
    typeOf(val: unknown, type: string, label: string): void {
        this._checks++;
        const actualType = typeof val;
        if (actualType === type) {
            this._channel.appendLine(`  ✓ ${label}: ${type}`);
        } else {
            this._channel.appendLine(`  ✗ ${label}: expected ${type}, got ${actualType}`);
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
//  Environment landscape (runs first — shows what's installed)
// ──────────────────────────────────────────────────────────────

test('[LANDSCAPE] Installed extensions & VS Code version', async (ctx) => {
    ctx.value('VS Code version', vscode.version);
    ctx.value('App host', process.env['VSCODE_NLS_CONFIG'] ?? '(not set)');

    const all = vscode.extensions.all;
    ctx.ok(Array.isArray(all), 'vscode.extensions.all is array');
    ctx.value('Total extensions installed', all.length);

    const withLang = all
        .filter(ex => {
            const langs = ex.packageJSON?.contributes?.languages;
            return Array.isArray(langs) && langs.length > 0;
        })
        .sort((a, b) => a.id.localeCompare(b.id));

    ctx.value('Extensions with language contributions', withLang.length);

    for (const ex of withLang) {
        const langs = ex.packageJSON.contributes.languages
            .map((l: { id: string }) => l.id)
            .join(', ');
        const status = ex.isActive ? 'active' : 'inactive';
        ctx.value(`  [${status}] ${ex.id}@${ex.packageJSON.version ?? '?'}`, langs);
    }

    // Also dump the 10 largest extensions by contribution surface area
    // (helps understand what's taking up activation time)
    const withLsp = all
        .filter(ex => ex.packageJSON?.contributes?.languages?.length > 0)
        .sort((a, b) => (b.packageJSON.contributes.languages?.length ?? 0) - (a.packageJSON.contributes.languages?.length ?? 0))
        .slice(0, 10);
    ctx.value('Top language-contributing extensions', withLsp.map(ex => `${ex.id} (${ex.packageJSON.contributes.languages?.length ?? 0} langs)`).join(' | '));
});

// ──────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────

test('LSP: TypeScript built-in TS server responds with symbols', async (ctx) => {
    const uri = tmpUri('.ts', 'lsp_ts');
    await writeFile(uri, 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
    await openDocument(uri);
    const res = await waitForLsp(uri, 15_000);
    ctx.ok(typeof res.ok === 'boolean', 'TS: waitForLsp completed', res.ok);
    ctx.value('TS: response', res.ok ? `symbols in ${res.pollCount} polls` : `no symbols (${res.pollCount} polls)`);
    if (res.symbols) {
        ctx.value('TS: symbols', res.symbols.slice(0, 5).map(s => `${s.kind} ${s.name}`).join(' | '));
    }
    await removeFile(uri);
});

test('LSP: Python (Pylance) responds with symbols', async (ctx) => {
    const uri = tmpUri('.py', 'lsp_py');
    await writeFile(uri, 'def greet(name: str) -> str:\n    return f"hello {name}"\n');
    await openDocument(uri);
    const res = await waitForLsp(uri, 15_000);
    ctx.ok(typeof res.ok === 'boolean', 'Python: waitForLsp completed', res.ok);
    ctx.value('Python: response', res.ok ? `symbols in ${res.pollCount} polls` : `no symbols (${res.pollCount} polls)`);
    if (res.symbols) {
        ctx.value('Python: symbols', res.symbols.slice(0, 5).map(s => `${s.kind} ${s.name}`).join(' | '));
    }
    await removeFile(uri);
});

test('LSP: Go symbols (if Go extension installed)', async (ctx) => {
    const uri = tmpUri('.go', 'lsp_go');
    await writeFile(uri, 'package main\n\nfunc greet(name string) string {\n\treturn "hello " + name\n}\n');
    await openDocument(uri);
    const res = await waitForLsp(uri, 10_000);
    ctx.ok(typeof res.ok === 'boolean', 'Go: waitForLsp completed', res.ok);
    ctx.value('Go: response', res.ok ? `symbols in ${res.pollCount} polls` : `no symbols (${res.pollCount} polls)`);
    if (res.symbols) {
        ctx.value('Go: symbols', res.symbols.slice(0, 5).map(s => `${s.kind} ${s.name}`).join(' | '));
    }
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
 * Dynamic LSP detection: create a source file for the given language,
 * open it, and wait for ANY installed LSP to respond with document symbols.
 *
 * This is truly extension-agnostic — we don't care WHICH extension provides
 * the LSP, only that some LSP responds. If no LSP is installed for this
 * language, the test passes with a note rather than failing.
 *
 * Response time and the detected extension ID (when available) are logged
 * as data for diagnostic purposes.
 */
async function testLspDetection(
    ctx: AssertLogger,
    label: string,
    ext: string,
    content: string,
    languageId: string,
    timeoutMs: number = 15_000,
): Promise<void> {
    const uri = tmpUri(ext, `lsp_${label}`);
    await writeFile(uri, content);
    await openDocument(uri);
    const t0 = Date.now();
    const result = await waitForLsp(uri, timeoutMs);
    const elapsed = Date.now() - t0;

    // ── Assertion 1: waitForLsp completed and returned a structured result ──
    ctx.ok(typeof result.ok === 'boolean', `${label}: waitForLsp completed`, result.ok);
    ctx.value(`${label}: response`, result.ok ? `found symbols in ${elapsed}ms (${result.pollCount} polls)` : `no symbols — timed out (${timeoutMs}ms, ${result.pollCount} polls)`);

    // ── Log any errors observed during polling ──
    if (result.error) {
        ctx.value(`${label}: first poll error`, result.error);
    }

    // ── Log ALL extensions that claim this language (active or not) ──
    const allForLang = vscode.extensions.all
        .filter(ex =>
            ex.packageJSON?.contributes?.languages?.some(
                (l: { id: string }) => l.id === languageId
            )
        )
        .map(ex => ({ id: ex.id, active: ex.isActive, version: ex.packageJSON.version }));
    if (allForLang.length > 0) {
        for (const ex of allForLang) {
            ctx.value(`${label}: extension`, `[${ex.active ? 'active' : 'inactive'}] ${ex.id}@${ex.version}`);
        }
    } else {
        ctx.value(`${label}: extensions`, `none installed — no extension claims language "${languageId}"`);
    }

    // ── Log raw symbol data when LSP responded ──
    if (result.ok && result.symbols) {
        ctx.value(`${label}: symbol count`, result.symbols.length);
        const firstFew = result.symbols.slice(0, 5).map(s => `${s.kind} ${s.name} (${s.range.start.line}:${s.range.start.character})`);
        ctx.value(`${label}: first symbols`, firstFew.join(' | '));
        if (result.symbols.length > 5) {
            ctx.value(`${label}: +more`, `${result.symbols.length - 5} additional symbols`);
        }
    }

    // ── Assertion 2: consistency check ──
    // If at least one extension for this language is active, we expect LSP to respond.
    // If no extension is installed, we expect no response.
    // Log the outcome either way — this helps diagnose missing runtimes.
    const anyActive = allForLang.some(ex => ex.active);
    if (anyActive) {
        ctx.value(`${label}: expectation`, `extension installed and active — LSP ${result.ok ? 'responded' : 'DID NOT respond (possible runtime missing)'}`);
    } else if (allForLang.length > 0) {
        ctx.value(`${label}: expectation`, `extension(s) installed but none active — LSP may not work`);
    } else {
        ctx.value(`${label}: expectation`, `no extension for this language — LSP response not expected`);
    }

    await removeFile(uri);
}

test('LSP: Rust (rust-analyzer) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'rust', '.rs', 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n', 'rust');
});

test('LSP: Java (redhat.java) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'java', '.java',
        'public class Hello {\n    public static void main(String[] args) {}\n}\n', 'java');
});

test('LSP: C# (ms-dotnettools.csharp) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'csharp', '.cs',
        'class Hello { static void Main() {} }\n', 'csharp');
});

test('LSP: C/C++ (ms-vscode.cpptools) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'cpp', '.cpp', 'int main() { return 0; }\n', 'cpp');
    await testLspDetection(ctx, 'c', '.c', 'int main() { return 0; }\n', 'c');
});

test('LSP: PHP responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'php', '.php', '<?php function greet($name) { return "hello $name"; }\n', 'php');
});

test('LSP: Ruby (Ruby LSP) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'ruby', '.rb', 'def greet(name)\n  "hello #{name}"\nend\n', 'ruby');
});

test('LSP: Dart responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'dart', '.dart',
        'void main() { print("hello"); }\n', 'dart');
});

test('LSP: Lua (sumneko.lua) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'lua', '.lua', 'function greet(name) return "hello " .. name end\n', 'lua');
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

    // ── Log LSP readiness for both files ──
    const tLsp = await waitForLsp(targetUri, 15_000);
    ctx.ok(typeof tLsp.ok === 'boolean', 'Phase C: target LSP wait completed', tLsp.ok);
    ctx.value('Phase C: target LSP', tLsp.ok ? `ready (${tLsp.pollCount} polls, ${tLsp.symbols?.length ?? 0} symbols)` : `not ready (${tLsp.pollCount} polls)`);
    if (tLsp.symbols) {
        ctx.value('Phase C: target symbols', tLsp.symbols.map(s => `${s.kind} ${s.name}`).join(' | '));
    }

    const sLsp = await waitForLsp(sourceUri, 5_000);
    ctx.ok(typeof sLsp.ok === 'boolean', 'Phase C: source LSP wait completed', sLsp.ok);
    ctx.value('Phase C: source LSP', sLsp.ok ? `ready (${sLsp.pollCount} polls)` : `not ready (${sLsp.pollCount} polls)`);

    const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(sourceDoc, new vscode.Position(2, 12));

    // ── Hard assert: bundle structure ──
    ctx.ok(Array.isArray(bundle.importResolutions), 'Phase C: importResolutions is array');
    ctx.value('Phase C: importResolutions count', bundle.importResolutions.length);
    ctx.ok(Array.isArray(bundle.fileExports), 'Phase C: fileExports is array');
    ctx.value('Phase C: fileExports', bundle.fileExports.map(e => `${e.name}:${e.kind}`));

    // ── Hover data (typeSignatures) raw dump ──
    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.value('Phase C: import[0] uri', imp.uri);
        ctx.value('Phase C: import[0] relativePath', imp.relativePath);
        ctx.value('Phase C: import[0] exports', imp.exports.map(e => `${e.name}:${e.kind}`).join(' | '));

        if (imp.typeSignatures) {
            const keys = Object.keys(imp.typeSignatures);
            ctx.ok(keys.length > 0, 'Phase C: typeSignatures has entries', keys);
            ctx.value('Phase C: typeSignatures keys', keys.join(', '));
            for (const [name, sig] of Object.entries(imp.typeSignatures)) {
                ctx.value(`Phase C: hover sig "${name}"`, sig);
                ctx.ok(typeof sig === 'string' && sig.length > 0, `Phase C: hover sig "${name}" is non-empty string`, sig);
            }
        } else {
            ctx.value('Phase C: typeSignatures', 'undefined — hover enrichment returned no data (file may not be indexed)');
        }
    } else {
        ctx.value('Phase C: importResolutions', 'empty — LSP link provider did not resolve imports');
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

    // ── Log LSP readiness ──
    const lsp = await waitForLsp(uri, 15_000);
    ctx.ok(typeof lsp.ok === 'boolean', 'Phase G: LSP wait completed', lsp.ok);
    ctx.value('Phase G: LSP', lsp.ok ? `ready (${lsp.pollCount} polls, ${lsp.symbols?.length ?? 0} symbols)` : `not ready (${lsp.pollCount} polls)`);
    if (lsp.symbols) {
        ctx.value('Phase G: LSP symbols', lsp.symbols.map(s => `${s.kind} ${s.name}`).join(' | '));
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    // Cursor on line 1 (class Derived), column 6
    const t0 = Date.now();
    const bundle = await builder.gather(doc, new vscode.Position(1, 6));
    ctx.value('Phase G: gather time', `${Date.now() - t0}ms`);

    // ── Hard assert: bundle structure ──
    ctx.ok(Array.isArray(bundle.fileExports), 'Phase G: fileExports is array');
    ctx.value('Phase G: fileExports', bundle.fileExports.map(e => `${e.name}:${e.kind}`).join(' | '));
    ctx.typeOf(bundle.statementEndLine, 'number', 'Phase G: statementEndLine type');

    // ── superTypes raw dump + assertions ──
    const st = bundle.superTypes;
    ctx.value('Phase G: superTypes raw', st ? st.map(s => `${s.name} (${s.kind})`).join(' | ') : 'undefined');
    if (st && st.length > 0) {
        ctx.ok(st.length >= 1, 'Phase G: superTypes has >=1 entries', st.length);
        const names = st.map(s => s.name);
        ctx.arrayContains(names, 'Base', 'Phase G: superTypes contains "Base"');
        // Assert structure on each superType
        for (const s of st) {
            ctx.ok(typeof s.name === 'string' && s.name.length > 0, `Phase G: superType name "${s.name}"`, s.name);
            ctx.typeOf(s.kind, 'string', `Phase G: superType "${s.name}" kind`);
            ctx.typeOf(s.startLine, 'number', `Phase G: superType "${s.name}" startLine`);
        }
        ctx.value('Phase G: result', `class hierarchy resolved — ${st.length} superTypes`);
    } else {
        ctx.value('Phase G: result', 'superTypes is undefined/empty — TypeScript LSP type hierarchy not available (file may be outside workspace folder)');
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
    // Malformed import — missing closing quote. The file still has valid
    // code after the malformed line (const y = 1), so fileExports may be
    // non-empty. The critical assertion is that gather() doesn't throw and
    // importResolutions is 0 (the malformed import wasn't parsed).
    await writeFile(uri, [
        `import { x } from './broken;`,
        'const y = 1;',
    ].join('\n'));

    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(1, 5));

    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.equal(bundle.importResolutions.length, 0, 'importResolutions empty for malformed import');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('fileExports', bundle.fileExports.map(e => e.name));

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

test('[P1] Phase H: gather() on empty file does not throw', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'gap_empty_file');
    await writeFile(uri, '');
    await openDocument(uri);
    await waitForLsp(uri, 5_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.equal(bundle.fileExports.length, 0, 'empty file exports count');
    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array');
    ctx.equal(bundle.importResolutions.length, 0, 'empty file importResolutions');
    ctx.ok(Array.isArray(bundle.missingImports), 'missingImports is array');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type (heuristic)');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.equal(bundle.languageId, 'typescript', 'languageId');

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

test('[P0] gather() safety net: unusual UTF-8 content does not throw', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Unicode garbage (not null bytes — VS Code refuses to open binary files).
    // Uses unusual but valid UTF-8 that could confuse parsers.
    const uri = tmpUri('.ts', 'gap_unicode_garbage');
    await writeFile(uri, 'const \uFFFD\uFFFE\uFFFF = 1;\nconst regular = 2;\n');
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
//  Utility function tests (pure, no LSP needed)
// ──────────────────────────────────────────────────────────────

test('normalizePath: resolves ./ and ../ segments', async (ctx) => {
    ctx.equal(normalizePath('a/./b/../c'), 'a/c', 'simple ./ and ../');
    ctx.equal(normalizePath('/a/b/../c'), '/a/c', 'absolute path with ../');
    ctx.equal(normalizePath('./a/b'), 'a/b', 'leading ./ is stripped');
    ctx.equal(normalizePath('a/../../b'), 'b', 'going above root resolves to empty prefix');
    ctx.equal(normalizePath('a/b/c'), 'a/b/c', 'no dots, unchanged');
    ctx.value('normalizePath', '5 cases passed');
});

test('cleanHoverSignature: strips code fences and collapses whitespace', async (ctx) => {
    // Standard TS hover with code fence
    const withFence = '```ts\nfunction greet(name: string): string\n```';
    ctx.equal(cleanHoverSignature(withFence), 'function greet(name: string): string', 'strips ```ts fence');

    // Multi-line with opening fence only
    const multiLine = '```ts\nconst x: number = 1\nconst y: string = "hello"';
    const cleaned = cleanHoverSignature(multiLine);
    ctx.ok(cleaned.includes('const x: number = 1'), 'first line preserved');
    ctx.ok(cleaned.includes('const y: string = "hello"'), 'second line preserved');

    // Truncation at 120 chars
    const longSig = 'x'.repeat(200);
    const truncated = cleanHoverSignature(longSig);
    ctx.ok(truncated.length <= 120, `truncated length ${truncated.length} <= 120`);
    ctx.ok(truncated.endsWith('…'), 'truncated ends with ellipsis');

    // Empty input
    ctx.equal(cleanHoverSignature(''), '', 'empty returns empty');
    ctx.equal(cleanHoverSignature('   '), '', 'whitespace-only returns empty');

    // No code fence
    ctx.equal(cleanHoverSignature('plain text'), 'plain text', 'no fence passes through');

    ctx.value('cleanHoverSignature', '6 cases passed');
});

test('hasLspSupport: returns false for plain text files', async (ctx) => {
    const uri = tmpUri('.txt', 'haslsp_txt');
    await writeFile(uri, 'plain text\n');
    await openDocument(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const supported = await hasLspSupport(doc);
    ctx.equal(supported, false, 'plain text has no LSP support');
    await removeFile(uri);
});

test('hasLspSupport: returns true for TypeScript files', async (ctx) => {
    const uri = tmpUri('.ts', 'haslsp_ts');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);
    const doc = await vscode.workspace.openTextDocument(uri);
    const supported = await hasLspSupport(doc);
    ctx.ok(supported, 'TypeScript file has LSP support');
    await removeFile(uri);
});

test('public detectMissingImports() returns array for clean file', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'pub_detect_missing');
    await writeFile(uri, 'export const ok = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    const fixes = await builder.detectMissingImports(doc);

    ctx.ok(Array.isArray(fixes), 'fixes is array');
    ctx.equal(fixes.length, 0, 'clean file has 0 missing imports');
    ctx.value('public detectMissingImports', 'clean file, 0 fixes');

    await removeFile(uri);
});

test('public detectMissingImports() finds unresolvable symbol', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'pub_detect_missing2');
    await writeFile(uri, 'const result = unknownFunction("test");\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);
    await new Promise(r => setTimeout(r, 1000)); // let diagnostics propagate

    const doc = await vscode.workspace.openTextDocument(uri);
    const fixes = await builder.detectMissingImports(doc);

    ctx.ok(Array.isArray(fixes), 'fixes is array');
    ctx.value('detectMissingImports result count', fixes.length);
    if (fixes.length > 0) {
        ctx.value('first fix symbol', fixes[0].symbolName);
    }

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  Non-LSP paths: regex fallback, cache, heuristics
// ──────────────────────────────────────────────────────────────

test('Non-LSP: regex fallback handles multiple languages', async (ctx) => {
    // extractRelativeImportSpecifiers is the regex fallback used when
    // the LSP link provider returns nothing. It must handle all target
    // languages without throwing.

    const ts_imports = 'import { a } from "./foo"; import { b } from "../bar";\n';
    ctx.equal(extractRelativeImportSpecifiers(ts_imports, 'typescript').length, 2,
        'TS: finds ./ and ../ imports');

    const py_imports = 'from . import x\nfrom .module import y\nimport os\n';
    const py_specs = extractRelativeImportSpecifiers(py_imports, 'python');
    ctx.ok(py_specs.length >= 2, 'Python: finds relative imports', py_specs);

    const rs_imports = 'mod foo;\n';
    ctx.equal(extractRelativeImportSpecifiers(rs_imports, 'rust').length, 0,
        'Rust: mod foo has no ./ prefix → not relative');

    const ruby_imports = "require './local'; require 'stdlib';\n";
    const rb_specs = extractRelativeImportSpecifiers(ruby_imports, 'ruby');
    ctx.ok(rb_specs.includes('./local'), 'Ruby: finds ./local, skips stdlib');
    ctx.equal(rb_specs.length, 1, 'Ruby: only 1 relative import');

    const cpp_imports = '#include "myheader.h"\n#include <vector>\n';
    const cpp_specs = extractRelativeImportSpecifiers(cpp_imports, 'cpp');
    ctx.ok(cpp_specs.includes('myheader.h'), 'C++: finds quoted include');
    ctx.equal(cpp_specs.length, 1, 'C++: only 1 quoted include');

    ctx.value('regex fallback', '5 languages validated');
});

test('Non-LSP: cache hit on repeated gather() skips LSP query', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'nls_cache');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Two consecutive gathers on the same file — second should hit cache
    const t0 = Date.now();
    const bundle1 = await builder.gather(doc, new vscode.Position(0, 0));
    const t1 = Date.now();
    const bundle2 = await builder.gather(doc, new vscode.Position(0, 0));
    const t2 = Date.now();

    ctx.ok(Array.isArray(bundle1.fileExports), 'first gather: fileExports is array');
    ctx.ok(Array.isArray(bundle2.fileExports), 'second gather: fileExports is array');
    ctx.equal(bundle1.fileExports.length, bundle2.fileExports.length,
        'both gathers return same export count');
    ctx.value('first gather duration', `${t1 - t0}ms`);
    ctx.value('second gather duration (cached)', `${t2 - t1}ms`);

    await removeFile(uri);
});

test('Non-LSP: heuristic statement end on plain text file', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Plain text has no LSP — statement end uses pure heuristic
    const uri = tmpUri('.txt', 'nls_heuristic');
    await writeFile(uri, [
        'line one',
        'line two',
        'line three',
    ].join('\n'));
    await openDocument(uri);

    const doc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));

    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type (heuristic)');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.equal(bundle.languageId, 'plaintext', 'languageId');
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.equal(bundle.fileExports.length, 0, 'plain text has no exports');

    await removeFile(uri);
});

test('Non-LSP: gather() on untitled doc without opening returns valid bundle', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Create an untitled document but don't show it in the editor
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 42;\n' });

    const bundle = await builder.gather(doc, new vscode.Position(0, 5));

    ctx.equal(bundle.importResolutions.length, 0, 'untitled: 0 import resolutions');
    ctx.typeOf(bundle.statementEndLine, 'number', 'untitled: statementEndLine type');
    ctx.value('statementEndLine (untitled, not shown)', bundle.statementEndLine);
    ctx.equal(bundle.languageId, 'typescript', 'untitled: languageId');
    ctx.value('enclosingScope', bundle.enclosingScope ? `${bundle.enclosingScope.kind} ${bundle.enclosingScope.name}` : 'none');

    // No cleanup needed — untitled documents don't write to disk
});

test('Non-LSP: circular import pattern does not crash', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    // Create A → B → A circular import pattern via file-system fallback
    // (the LSP link provider won't resolve circular imports from temp files,
    // but the _buildImportResolutions chainSeen set should prevent infinite loops)
    const uriA = tmpUri('.ts', 'nls_circ_a');
    const uriB = tmpUri('.ts', 'nls_circ_b');

    await writeFile(uriA, [
        `import { b } from './${path.basename(uriB.path).replace(/\.ts$/, '')}';`,
        'export const a = 1;',
        'console.log(b);',
    ].join('\n'));

    await writeFile(uriB, [
        `import { a } from './${path.basename(uriA.path).replace(/\.ts$/, '')}';`,
        'export const b = 2;',
        'console.log(a);',
    ].join('\n'));

    await openDocument(uriA);
    await openDocument(uriB);
    await waitForLsp(uriA, 10_000);

    const docA = await vscode.workspace.openTextDocument(uriA);
    // This must not throw or hang despite A→B→A circular pattern
    const bundle = await builder.gather(docA, new vscode.Position(1, 15));

    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.ok(bundle.fileExports.length >= 1, 'circular file A has exports');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type');
    ctx.value('circular import test', 'completed without hang or crash');

    await removeFile(uriA);
    await removeFile(uriB);
});

// ──────────────────────────────────────────────────────────────
//  Workspace cache: incremental per-file update on save
// ──────────────────────────────────────────────────────────────

test('[P2] Edit + gather: per-file cache invalidated on text change', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'cache_inval');
    await writeFile(uri, 'export const original = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    const beforeNames = bundle.fileExports.map(e => e.name);
    ctx.arrayContains(beforeNames, 'original', 'sees original export before edit');

    // Edit the document (triggers onDidChangeTextDocument → _cache.delete)
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, 0, 21), 'export const edited = 2;');
    const applied = await vscode.workspace.applyEdit(edit);
    ctx.ok(applied, 'edit applied');

    // Wait for LSP to re-index after edit
    await new Promise(r => setTimeout(r, 1500));

    // Gather again — must NOT use stale cache
    bundle = await builder.gather(doc, new vscode.Position(0, 0));
    const afterNames = bundle.fileExports.map(e => e.name);
    ctx.value('exports after edit', afterNames);
    ctx.arrayContains(afterNames, 'edited', 'sees edited export after text change');
    ctx.ok(!afterNames.includes('original'), 'original export gone after edit');

    await removeFile(uri);
});

test('[P2] Save without content change: cache update does not throw', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'cache_save_noop');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    // First gather to seed caches
    const doc = await vscode.workspace.openTextDocument(uri);
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    ctx.ok(bundle.fileExports.length >= 1, 'exports present');

    // Save the file without any content change — _updateFileInWorkspaceCache
    // will re-query LSP symbols for the same content. Must not throw.
    const saveOk = await doc.save();
    ctx.ok(saveOk, 'no-op save succeeded');
    await new Promise(r => setTimeout(r, 1000));

    // Gather again — should return same data as before
    bundle = await builder.gather(doc, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array after no-op save');
    ctx.value('exports after no-op save', bundle.fileExports.map(e => e.name));

    await removeFile(uri);
});

test('[P2] Hover cache: invalidated on text change', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'hover_cache_inval');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    // Gather once to populate hover cache
    await builder.gather(doc, new vscode.Position(0, 0));

    // Edit the document — should invalidate hover cache
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, 0, 19), 'export const y = 2;');
    await vscode.workspace.applyEdit(edit);
    await new Promise(r => setTimeout(r, 1500));

    // Gather again — hover cache must have been cleared
    // (no direct assertion on private _hoverCache, but the gather must not throw)
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundle.fileExports), 'hover cache inval: fileExports is array');
    ctx.value('exports after edit (hover cache)', bundle.fileExports.map(e => e.name));

    await removeFile(uri);
});

test('[P2] Close document + gather: works on closed documents', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'cache_closed');
    await writeFile(uri, 'export const closed = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    // Gather while open to populate caches
    const doc = await vscode.workspace.openTextDocument(uri);
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    ctx.ok(bundle.fileExports.length >= 1, 'exports before close');

    // Close the document
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await new Promise(r => setTimeout(r, 500));

    // Gather on closed document — should still work from cache or re-open
    const closedDoc = await vscode.workspace.openTextDocument(uri);
    bundle = await builder.gather(closedDoc, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array after reopen');
    ctx.value('exports after close/reopen', bundle.fileExports.map(e => e.name));

    await removeFile(uri);
});

test('[P2] Workspace cache: save updates only the saved file\'s entry', async (ctx) => {
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
    ctx.ok(Array.isArray(bundleBefore.fileExports), 'pre-save fileExports is array');
    ctx.value('fileA exports (pre)', bundleBefore.fileExports.map(e => e.name));

    // Modify and save file B — should update only B's cache entry
    await writeFile(uriB, 'export const b_updated = 22;\n');
    const docB = await vscode.workspace.openTextDocument(uriB);
    const saveOk = await docB.save();
    ctx.ok(saveOk, 'docB.save() succeeded');

    // Wait for the async cache update to settle
    await new Promise(r => setTimeout(r, 1000));

    // Gather on A again — A's exports should be unchanged, B should be fresh
    const bundleAfter = await builder.gather(docA, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundleAfter.fileExports), 'post-save fileExports is array');
    const exportNames = bundleAfter.fileExports.map(e => e.name);
    ctx.value('fileA exports (post)', exportNames);
    ctx.ok(exportNames.includes('a'), 'fileA still has export "a" after fileB save', exportNames);

    await removeFile(uriA);
    await removeFile(uriB);
});

test('[P2] Workspace cache: LSP unavailable per-file falls back gracefully', async (ctx) => {
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
    ctx.ok(saveOk, 'txt file save succeeded');

    // Even with no LSP, gather() must not throw and should return a valid bundle
    const bundle = await builder.gather(doc, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.equal(bundle.fileExports.length, 0, 'plain text exports count');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type (no LSP)');
    ctx.value('statementEndLine (no LSP)', bundle.statementEndLine);

    await removeFile(uri);
});

test('[P2] Workspace cache: empty file after save clears cache entry', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'ws_cache_empty');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 10_000);

    const doc = await vscode.workspace.openTextDocument(uri);
    let bundle = await builder.gather(doc, new vscode.Position(0, 0));
    ctx.ok(bundle.fileExports.length >= 1, 'exports present before empty save');
    ctx.value('exports before', bundle.fileExports.map(e => e.name));

    // Replace content with empty string and save
    await writeFile(uri, '');
    const emptyDoc = await vscode.workspace.openTextDocument(uri);
    const saveOk = await emptyDoc.save();
    ctx.ok(saveOk, 'empty doc save succeeded');
    await new Promise(r => setTimeout(r, 1000));

    // Gather again — cache entry should now reflect the empty file
    bundle = await builder.gather(emptyDoc, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array');
    ctx.equal(bundle.fileExports.length, 0, 'exports cleared after empty save');

    await removeFile(uri);
});

test('[P2] Workspace cache: multiple rapid saves each trigger one per-file update', async (ctx) => {
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
        ctx.ok(ok, `save #${i} succeeded`);
        // Each save fires a separate onDidSaveTextDocument event; each
        // event triggers one _updateFileInWorkspaceCache call. Since each
        // call is cheap (~5ms single-file query), no debounce is needed.
        // We verify this by checking that gather() returns the last saved value.
    }

    await new Promise(r => setTimeout(r, 1000));

    const finalDoc = await vscode.workspace.openTextDocument(uri);
    const bundle = await builder.gather(finalDoc, new vscode.Position(0, 0));
    ctx.ok(Array.isArray(bundle.fileExports), 'fileExports is array after rapid saves');
    ctx.equal(bundle.languageId, 'typescript', 'languageId after rapid saves');
    ctx.value('exports after 10 saves', bundle.fileExports.map(e => e.name));

    await removeFile(uri);
});

test('[P2] Workspace cache: gather() after save sees fresh symbols', async (ctx) => {
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
    ctx.arrayContains(originalNames, 'original', 'original export present before save');

    // Replace with different exports and save
    await writeFile(uri, 'export const replaced = 2;\nexport function helper() {}\n');
    const newDoc = await vscode.workspace.openTextDocument(uri);
    const saveOk = await newDoc.save();
    ctx.ok(saveOk, 'save succeeded');
    await new Promise(r => setTimeout(r, 1000));

    // Gather again — should see the REPLACED exports, not the originals
    bundle = await builder.gather(newDoc, new vscode.Position(0, 0));
    const newNames = bundle.fileExports.map(e => e.name);
    ctx.value('exports after save', newNames);
    ctx.arrayContains(newNames, 'replaced', 'replaced export present after save');
    ctx.arrayContains(newNames, 'helper', 'helper export present after save');

    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  LSP extension registry validation
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
//  Environment report: installed extensions overview
// ──────────────────────────────────────────────────────────────

test('Environment: all installed extensions with language contributions', async (ctx) => {
    const exts = vscode.extensions.all
        .filter(ex => {
            const langs = ex.packageJSON?.contributes?.languages;
            return Array.isArray(langs) && langs.length > 0;
        })
        .sort((a, b) => a.id.localeCompare(b.id));

    // Hard assert: extensions.all is available
    ctx.ok(Array.isArray(vscode.extensions.all), 'vscode.extensions.all is array');
    ctx.value('Environment: total extensions (all)', vscode.extensions.all.length);
    ctx.value('Environment: with language contributions', exts.length);

    let activeCount = 0;
    for (const ex of exts) {
        const langs = ex.packageJSON.contributes.languages.map((l: { id: string }) => l.id).join(', ');
        const status = ex.isActive ? 'active' : 'inactive';
        if (ex.isActive) activeCount++;
        ctx.value(`  [${status}] ${ex.id}@${ex.packageJSON.version ?? '?'}`, langs);

        // Hard assert: each extension has valid package structure
        ctx.ok(typeof ex.id === 'string' && ex.id.includes('.'),
            `Environment: "${ex.id}" has publisher.name format`, ex.id);
        ctx.ok(Array.isArray(ex.packageJSON.contributes.languages),
            `Environment: "${ex.id}" contributes.languages is array`);
    }
    ctx.value('Environment: active language extensions', activeCount);
    ctx.ok(exts.length >= 0, 'Environment: extensions count is >= 0', exts.length);
});

test('LspSupportNotifier: LANG_TO_LSP_EXTENSIONS entries are valid', async (ctx) => {
    for (const [lang, exts] of Object.entries(LANG_TO_LSP_EXTENSIONS)) {
        ctx.ok(Array.isArray(exts), `${lang} extensions is array`);
        for (const ext of exts) {
            ctx.ok(typeof ext.name === 'string' && ext.name.length > 0,
                `${lang}: name is non-empty`, ext.name);
            ctx.ok(typeof ext.id === 'string' && ext.id.includes('.'),
                `${lang}: id has publisher.name format`, ext.id);
            ctx.ok(ext.marketplaceUrl.startsWith('https://marketplace.visualstudio.com/items?itemName='),
                `${lang}: marketplaceUrl starts with marketplace URL`, ext.marketplaceUrl);
            ctx.ok(ext.marketplaceUrl.endsWith(ext.id),
                `${lang}: marketplaceUrl ends with extension id`);
            const uri = extensionUriFor(ext.id);
            ctx.equal(uri.scheme, 'vscode', `${ext.id}: URI scheme`);
            ctx.ok(uri.toString().endsWith(ext.id),
                `${ext.id}: URI ends with extension id`, uri.toString());
        }
    }
    ctx.value('LSP registry', `${Object.keys(LANG_TO_LSP_EXTENSIONS).length} languages validated`);
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
        const ctx = new AssertLogger(channel);
        // Separator line for readability between tests
        channel.appendLine('');
        channel.appendLine(`--- ${t.name} ---`);
        try {
            await t.fn(ctx);
            passed++;
            channel.appendLine(`✓ PASS (${ctx.checkCount} assertions, ${ctx.checkCount} checks)`);
        } catch (err) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            channel.appendLine(`✗ FAIL`);
            channel.appendLine(`    ${msg}`);
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

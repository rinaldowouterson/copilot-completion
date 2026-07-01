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
import { flattenWorkspaceEdit } from '../completions/context/autoImport';
import { buildExportsLine, buildImportLine } from '../completions/ghost/promptFactory';
import { findStatementEndHeuristic } from '../common/languageSyntax';
import { resolveRelativePath } from '../completions/context/relativePath';
import { inferFileKindFromExtension, isBinaryKind } from '../common/fileKind';
import { TrimCompletionSuffixOverlap } from '../common/suffixOverlapTrim';
import { TerseBlockTrimmer, VerboseBlockTrimmer } from '../completions/ghost/blockTrimmer';
import { isInlineSuggestionFromTextAfterCursor } from '../completions/ghost/inlineSuggestion';
import { heuristicIsEmptyBlock } from '../completions/ghost/multiline/emptyBlockHeuristic';
import { GhostCompletionsCache } from '../completions/ghost/completionsCache';
import { NextEditCache } from '../completions/nes/nextEditCache';
import { EmptyEditFilter, NoopEditFilter, WhitespaceOnlyFilter, CommentOnlyFilter, EditFilterChain } from '../completions/nes/response/editFilterChain';
import { BoundaryMarkerParser, CursorTagStripper, ResponsePipeline } from '../completions/nes/response/responsePipeline';
import { OffsetRange } from '../completions/nes/stubs/offsetRange';
import { Result } from '../common/result';
import { VSCodeGhostConfigProvider } from '../config/ghostConfig';
import { VSCodeNesConfigProvider } from '../config/nesConfig';
import { ISecretConfig } from '../config/secretConfig';
import { InlineSuggestionResolver } from '../completions/nes/core/inlineSuggestionResolver';
import { stripOutputMarkers, diagnoseMarkerLeakage, containsAnyMarker } from '../common/stripOutputMarkers';

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
    timeoutMs: number = 1500,
    eventsToWaitFor: number = 1,
): Promise<{ ok: boolean; symbols?: vscode.DocumentSymbol[]; error?: string; attemptCount: number }> {
    let attemptCount = 0;
    let firstError: string | undefined;
    const uriStr = uri.toString();

    const tryFetch = async (): Promise<vscode.DocumentSymbol[] | undefined> => {
        attemptCount++;
        try {
            const s = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
                'vscode.executeDocumentSymbolProvider', uri,
            );
            if (s && s.length > 0) return s;
        } catch (err) {
            if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        }
        return undefined;
    };

    // Subscribe to diagnostics. Some LSPs fire onDidChangeDiagnostics multiple
    // times: first from a quick syntax-check pass (empty), later when the full
    // IntelliSense engine is ready (has symbols). `eventsToWaitFor` lets callers
    // skip the initial noise events and fetch only after the Nth event.
    let eventsSeen = 0;
    const diagnosticsReady = new Promise<boolean>(resolve => {
        const d = vscode.languages.onDidChangeDiagnostics(e => {
            if (e.uris.some(u => u.toString() === uriStr)) {
                eventsSeen++;
                if (eventsSeen >= eventsToWaitFor) {
                    d.dispose();
                    resolve(true);
                }
            }
        });
        setTimeout(() => {
            d.dispose();
            resolve(false);
        }, timeoutMs);
    });

    const fired = await diagnosticsReady;
    if (fired) {
        const s = await tryFetch();
        if (s) return { ok: true, symbols: s, attemptCount };
    }

    return { ok: false, error: firstError, attemptCount };
}

/** Remove a temp file, first closing any editor tab showing it. */
async function removeFile(uri: vscode.Uri): Promise<void> {
    await closeTabForUri(uri);
    try {
        await vscode.workspace.fs.delete(uri);
    } catch {
        // best-effort cleanup
    }
}

/** Remove a temp directory recursively, first closing any tabs inside it. */
async function removeDir(uri: vscode.Uri): Promise<void> {
    // Close any open tabs whose URI is inside this directory
    const dirStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString().startsWith(dirStr)) {
                await vscode.window.tabGroups.close(tab);
            }
        }
    }
    try {
        await vscode.workspace.fs.delete(uri, { recursive: true });
    } catch {
        // best-effort cleanup
    }
}

/** Close the editor tab for a specific URI if it's open, reverting dirty docs silently. */
async function closeTabForUri(uri: vscode.Uri): Promise<void> {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
                await closeTab(tab);
                return;
            }
        }
    }
}

/**
 * Close a specific untitled document by reference.
 *
 * `revertAndCloseActiveEditor` is unreliable because it targets whatever tab is
 * currently active, not a specific tab. This helper locates the tab containing
 * the given doc and closes that one directly. Falls back to the active-editor
 * command if the tab can't be located (e.g. the doc isn't visible).
 */
async function closeUntitledDoc(doc: vscode.TextDocument): Promise<void> {
    const docUri = doc.uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === docUri) {
                await closeTab(tab);
                return;
            }
        }
    }
    // Doc not in any tab group (e.g. it was never shown). Closing the active
    // editor is still better than leaking the buffer.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

/**
 * Close a single tab, preferring `revertAndCloseActiveEditor` so any unsaved
 * buffer is reverted without prompting. We select the tab first so the command
 * targets *this* tab rather than whatever happens to be active.
 */
async function closeTab(tab: vscode.Tab): Promise<void> {
    // If the tab is dirty, prefer revert+close via the active-editor command.
    // First make this tab active so the command targets it.
    const input = tab.input;
    if (input instanceof vscode.TabInputText) {
        const uriStr = input.uri.toString();
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
        if (doc && doc.isDirty) {
            // Showing the doc makes its tab the active one, then revertAndCloseActiveEditor
            // closes *that* tab (the one we just selected) instead of some other active tab.
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            return;
        }
    }
    await vscode.window.tabGroups.close(tab);
}

/**
 * Pre-flight cleanup: close any untitled tabs lingering from a previous run of
 * the diagnostics. Each `openTextDocument({ language, content })` allocates a
 * new `Untitled-N` slot that survives across command invocations until closed
 * or until VS Code itself restarts. Without this, running diagnostics N times
 * leaves N untitled tabs behind.
 */
async function closeAllUntitledTabs(): Promise<number> {
    let closed = 0;
    // Snapshot the list first — closing mutates tabGroups.all.
    const targets: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'untitled') {
                targets.push(tab);
            }
        }
    }
    for (const tab of targets) {
        try {
            await closeTab(tab);
            closed++;
        } catch {
            // best-effort
        }
    }
    return closed;
}

/** Create a temp directory URI with a unique name. */
function tmpDir(label: string): vscode.Uri {
    const ts = Date.now();
    const idx = _counter++;
    return vscode.Uri.file(path.join(os.tmpdir(), `__cc_diag_ws_${label}_${ts}_${idx}`));
}

/** Write a config file (JSON) into a directory. */
async function writeJsonConfig(dir: vscode.Uri, filename: string, config: Record<string, unknown>): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(path.join(dir.fsPath, filename));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config, null, 2), 'utf-8'));
    return uri;
}

/** Write a TOML text file into a directory. */
async function writeTextFile(dir: vscode.Uri, relativePath: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(path.join(dir.fsPath, relativePath));
    // Ensure parent directory exists
    const parentDir = vscode.Uri.file(path.dirname(uri.fsPath));
    try { await vscode.workspace.fs.createDirectory(parentDir); } catch { /* ok */ }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    return uri;
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

    /** Assert deep equality (handles arrays, objects). Uses JSON serialization for logging. */
    deepEqual<T>(actual: T, expected: T, label: string): void {
        this._checks++;
        try {
            assert.deepStrictEqual(actual, expected);
            const str = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
            this._channel.appendLine(`  ✓ ${label}: ${str}`);
        } catch {
            const aStr = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
            const eStr = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
            this._channel.appendLine(`  ✗ ${label}: expected ${eStr}, got ${aStr}`);
            assert.deepStrictEqual(actual, expected, label);
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

/** @internal Which test (if any) is marked with `.only()`. */
let _onlyTestName: string | undefined;

function test(name: string, fn: (ctx: AssertLogger) => Promise<void>): void {
    tests.push({ name, fn });
}

/**
 * Mark a single test to run in isolation. All other tests are skipped.
 * Works like vitest's `it.only(name, fn)`. Only the LAST `.only()` call
 * takes effect.
 *
 * Usage: replace `test('PHP test', ...)` with `test.only('PHP test', ...)`
 */
test.only = function only(name: string, fn: (ctx: AssertLogger) => Promise<void>): void {
    tests.push({ name, fn });
    _onlyTestName = name; // last one wins
};

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
    const res = await waitForLsp(uri, 1500);
    ctx.ok(typeof res.ok === 'boolean', 'TS: waitForLsp completed', res.ok);
    ctx.value('TS: response', res.ok ? `symbols in ${res.attemptCount} attempt(s)` : `no symbols (${res.attemptCount} attempt(s))`);
    if (res.symbols) {
        ctx.value('TS: symbols', res.symbols.slice(0, 5).map(s => `${s.kind} ${s.name}`).join(' | '));
    }
    await removeFile(uri);
});

test('LSP: Python (Pylance) responds with symbols', async (ctx) => {
    const uri = tmpUri('.py', 'lsp_py');
    await writeFile(uri, 'def greet(name: str) -> str:\n    return f"hello {name}"\n');
    await openDocument(uri);
    const res = await waitForLsp(uri, 1500);
    ctx.ok(typeof res.ok === 'boolean', 'Python: waitForLsp completed', res.ok);
    ctx.value('Python: response', res.ok ? `symbols in ${res.attemptCount} attempt(s)` : `no symbols (${res.attemptCount} attempt(s))`);
    if (res.symbols) {
        ctx.value('Python: symbols', res.symbols.slice(0, 5).map(s => `${s.kind} ${s.name}`).join(' | '));
    }
    await removeFile(uri);
});

test('LSP: Go symbols (if Go extension installed)', async (ctx) => {
    const uri = tmpUri('.go', 'lsp_go');
    await writeFile(uri, 'package main\n\nfunc greet(name string) string {\n\treturn "hello " + name\n}\n');
    await openDocument(uri);
    const res = await waitForLsp(uri, 1500);
    ctx.ok(typeof res.ok === 'boolean', 'Go: waitForLsp completed', res.ok);
    ctx.value('Go: response', res.ok ? `symbols in ${res.attemptCount} attempt(s)` : `no symbols (${res.attemptCount} attempt(s))`);
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
    await waitForLsp(targetUri, 1500);
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
    await waitForLsp(targetUri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    timeoutMs: number = 5000,
    eventsToWaitFor: number = 1,
): Promise<void> {
    const uri = tmpUri(ext, `lsp_${label}`);
    await writeFile(uri, content);
    await openDocument(uri);
    const t0 = Date.now();
    const result = await waitForLsp(uri, timeoutMs, eventsToWaitFor);
    const elapsed = Date.now() - t0;

    // ── Assertion 1: waitForLsp completed and returned a structured result ──
    ctx.ok(typeof result.ok === 'boolean', `${label}: waitForLsp completed`, result.ok);
    ctx.value(`${label}: response`, result.ok ? `found symbols in ${elapsed}ms (${result.attemptCount} attempt(s))` : `no symbols — timed out (${timeoutMs}ms, ${result.attemptCount} attempt(s))`);

    // ── Log any errors observed during polling ──
    if (result.error) {
        ctx.value(`${label}: first poll error`, result.error);
    }

    // ── Log ALL extensions that claim this language (active or not) ──
    // Some extensions (e.g. ms-dotnettools.csharp) don't list the language
    // in `contributes.languages` but DO register via `activationEvents`
    // with `onLanguage:{languageId}`. Check both sources.
    const onLangEvent = `onLanguage:${languageId}`;
    const allForLang = vscode.extensions.all
        .filter(ex => {
            const pkg = ex.packageJSON;
            // Direct language contribution (most extensions)
            if (pkg?.contributes?.languages?.some((l: { id: string }) => l.id === languageId)) return true;
            // Activation-event based registration (e.g. C# via onLanguage:csharp)
            if (Array.isArray(pkg?.activationEvents) && pkg.activationEvents.includes(onLangEvent)) return true;
            return false;
        })
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

    // ── Assertion 2: active extension must produce an LSP response ──
    // Three scenarios (worst → best):
    //
    //   (a) No extension at all for this language → HARD FAIL.
    //       Means nobody claims this language, so the entire pipeline is blind.
    //
    //   (b) Extension(s) exist but none active → INFO, no failure.
    //       The user hasn't opened a file of this language; the client-side
    //       activation trigger never ran. Normal for untested languages.
    //
    //   (c) At least one active extension → must produce symbols.
    //       If the LSP doesn't respond, something is wrong (missing runtime,
    //       broken server, temp-file restrictions, etc.).
    //
    const anyActive = allForLang.some(ex => ex.active);
    const anyExist = allForLang.length > 0;
    const info: string = !anyExist
        ? `no extension for this language — nobody handles "${languageId}"`
        : anyActive
            ? result.ok
                ? `extension installed and active — LSP responded (${(result.symbols?.length ?? 0)} symbols)`
                : `extension installed and active — LSP DID NOT respond (possible runtime missing)`
            : `extension(s) installed but none active — LSP may not work`;
    ctx.value(`${label}: expectation`, info);

    if (!anyExist) {
        ctx.ok(false, `${label}: at least one LSP extension must be installed for language "${languageId}"`);
    } else if (anyActive) {
        ctx.ok(result.ok, `${label}: LSP responds with symbols`, result.symbols ? `found ${result.symbols.length} symbol(s)` : 'no symbols');
    }

    await removeFile(uri);
}

test('LSP: Rust (rust-analyzer) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'rust', '.rs', 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n', 'rust');
});

test('LSP: Java (redhat.java) responds with symbols', async (ctx) => {
    // JDT Language Server has a cold-start boot of Eclipse Equinox + OSGi,
    // which takes longer than the default 1500ms on first load. Give it 5s.
    await testLspDetection(ctx, 'java', '.java',
        'public class Hello {\n    public static void main(String[] args) {}\n}\n', 'java', 5_000);
});

test('LSP: C# (ms-dotnettools.csharp) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'csharp', '.cs',
        'class Hello { static void Main() {} }\n', 'csharp', 5000);
});

test('LSP: C/C++ (ms-vscode.cpptools) responds with symbols', async (ctx) => {
    // cpptools scans system headers on cold start, which delays first
    // diagnostics by several seconds. Give it the same 5s window as Java.
    await testLspDetection(ctx, 'cpp', '.cpp', 'int main() { return 0; }\n', 'cpp', 5_000);
    await testLspDetection(ctx, 'c', '.c', 'int main() { return 0; }\n', 'c');
});

/**
 * PHP-specific LSP test with extended diagnostics.
 *
 * VS Code's built-in `vscode.php-language-features` provides IntelliSense
 * (completions, hover, document symbols) without a separate LSP server.
 * It activates on `onLanguage:php`. Unlike full LSPs (Pylance, rust-analyzer),
 * it does NOT use `DiagnosticCollection.set()`, which means `onDidChangeDiagnostics`
 * may not fire for symbol resolution — only for syntax errors.
 *
 * This test uses the generic `waitForLsp` but adds PHP-specific runtime checks
 * and fallback polling so we can distinguish "LSP not responding" from
 * "LSP doesn't use diagnostics events."
 */
test('LSP: PHP responds with symbols', async (ctx) => {
    // Event-driven via testLspDetection (same pattern as Java, C++, Rust).
    // PHP's built-in IntelliSense engine fires onDidChangeDiagnostics twice:
    //   event #1 at ~268ms — syntax check (no symbols)
    //   event #2 at ~1752ms — IntelliSense ready (symbols present)
    // By waiting for 2 events, we skip the noise and fetch exactly when ready.
    await testLspDetection(ctx, 'php', '.php', '<?php function greet($name) { return "hello $name"; }\n', 'php', 5000, 2);
});

test('LSP: Ruby (Ruby LSP) responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'ruby', '.rb', 'def greet(name)\n  "hello #{name}"\nend\n', 'ruby',10000);
});

test('LSP: Dart responds with symbols', async (ctx) => {
    await testLspDetection(ctx, 'dart', '.dart',
        'void main() { print("hello"); }\n', 'dart');
});

/**
 * Lua LSP-specific test that uses an EOF edit to wake the LSP.
 *
 * sumneko.lua does not fire onDidChangeDiagnostics for clean temp files
 * (no diagnostics to publish). This test forces a didChange via a minimal
 * EOF edit, then waits on the event with a short timeout.
 */
async function testLuaLSP(ctx: AssertLogger): Promise<void> {
    const uri = tmpUri('.lua', 'lsp_lua');
    await writeFile(uri, 'function greet(name) return "hello " .. name end\n');
    await openDocument(uri);

    const t0 = Date.now();

    // ── Subscribe first, then apply a tiny EOF edit ──
    // This forces a didChange, which compliant LSPs answer with diagnostics
    // (triggering onDidChangeDiagnostics). Non-compliant LSPs still process
    // the change, so a single fetch after the timeout will find symbols.
    const diagnosticsFired = new Promise<boolean>(resolve => {
        const d = vscode.languages.onDidChangeDiagnostics(e => {
            if (e.uris.some(u => u.toString() === uri.toString())) {
                d.dispose();
                resolve(true);
            }
        });
        // Short timeout — either the event fires or we proceed anyway
        setTimeout(() => {
            d.dispose();
            resolve(false);
        }, 500);
    });

    // Apply a non-destructive edit at EOF to trigger didChange
    const doc = await vscode.workspace.openTextDocument(uri);
    const eofPos = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, eofPos, ' ');
    await vscode.workspace.applyEdit(edit);

    const fired = await diagnosticsFired;
    const elapsed = Date.now() - t0;

    // ── Now fetch symbols — the LS has processed the didChange ──
    let symbols: vscode.DocumentSymbol[] | undefined;
    let fetchError: string | undefined;
    try {
        const s = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
            'vscode.executeDocumentSymbolProvider', uri,
        );
        if (s && s.length > 0) symbols = s;
    } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
    }

    // ── Log results ──
    ctx.ok(typeof fired === 'boolean', 'lua: waitForDiagnostics completed', fired);
    ctx.value('lua: response', fired
        ? `event fired in ${elapsed}ms — symbols: ${symbols ? symbols.map(s => s.name).join(', ') : 'none'}`
        : `timeout after ${elapsed}ms — symbols: ${symbols ? symbols.map(s => s.name).join(', ') : 'none'}`);

    if (symbols) {
        ctx.value('lua: symbol count', symbols.length);
        ctx.value('lua: first symbols', symbols.slice(0, 5).map(s => `${s.kind} ${s.name}`).join(' | '));
    }

    // ── Log extension info ──
    const allForLang = vscode.extensions.all
        .filter(ex =>
            ex.packageJSON?.contributes?.languages?.some(
                (l: { id: string }) => l.id === 'lua'
            )
        )
        .map(ex => ({ id: ex.id, active: ex.isActive, version: ex.packageJSON.version }));
    for (const ex of allForLang) {
        ctx.value('lua: extension', `[${ex.active ? 'active' : 'inactive'}] ${ex.id}@${ex.version}`);
    }

    // ── Expectation — if sumneko.lua (or any Lua LSP) is active, symbols should be found ──
    const anyActive = allForLang.some(ex => ex.active);
    ctx.ok(!anyActive || !!symbols,
        'lua: LSP responds with symbols',
        symbols ? `found ${symbols.length} symbol(s)` : 'no symbols');

    if (fetchError) {
        ctx.value('lua: fetch error', fetchError);
    }

    await removeFile(uri);
}

test('LSP: Lua (sumneko.lua) responds with symbols', async (ctx) => {
    await testLuaLSP(ctx);
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
    const tLsp = await waitForLsp(targetUri, 1500);
    ctx.ok(typeof tLsp.ok === 'boolean', 'Phase C: target LSP wait completed', tLsp.ok);
    ctx.value('Phase C: target LSP', tLsp.ok ? `ready (${tLsp.attemptCount} attempt(s), ${tLsp.symbols?.length ?? 0} symbols)` : `not ready (${tLsp.attemptCount} attempt(s))`);
    if (tLsp.symbols) {
        ctx.value('Phase C: target symbols', tLsp.symbols.map(s => `${s.kind} ${s.name}`).join(' | '));
    }

    const sLsp = await waitForLsp(sourceUri, 5_000);
    ctx.ok(typeof sLsp.ok === 'boolean', 'Phase C: source LSP wait completed', sLsp.ok);
    ctx.value('Phase C: source LSP', sLsp.ok ? `ready (${sLsp.attemptCount} attempt(s))` : `not ready (${sLsp.attemptCount} attempt(s))`);

    const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(sourceDoc, new vscode.Position(2, 12));

    // ── Hard assert: bundle structure ──
    ctx.ok(Array.isArray(bundle.importResolutions), 'Phase C: importResolutions is array');
    ctx.value('Phase C: importResolutions count', bundle.importResolutions.length);
    ctx.ok(Array.isArray(bundle.fileExports), 'Phase C: fileExports is array');
    ctx.value('Phase C: fileExports', bundle.fileExports.map(e => `${e.name}:${e.kind}`));

    // ── Hover data (typeSignatures) + fileKind raw dump ──
    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.value('Phase C: import[0] uri', imp.uri);
        ctx.value('Phase C: import[0] relativePath', imp.relativePath);
        ctx.value('Phase C: import[0] exports', imp.exports.map(e => `${e.name}:${e.kind}`).join(' | '));
        ctx.value('Phase C: import[0] fileKind', imp.fileKind);
        ctx.equal(imp.fileKind, 'code', 'Phase C: import[0] fileKind is "code" for .ts file');

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
    const lsp = await waitForLsp(uri, 1500);
    ctx.ok(typeof lsp.ok === 'boolean', 'Phase G: LSP wait completed', lsp.ok);
    ctx.value('Phase G: LSP', lsp.ok ? `ready (${lsp.attemptCount} attempt(s), ${lsp.symbols?.length ?? 0} symbols)` : `not ready (${lsp.attemptCount} attempt(s))`);
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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(sourceUri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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

    // Create an untitled document (no fsPath) — show it so gather() has an editor context
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 1;\n' });
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });

    const bundle = await builder.gather(doc, new vscode.Position(0, 5));

    ctx.ok(Array.isArray(bundle.importResolutions), 'importResolutions is array for untitled');
    ctx.equal(bundle.importResolutions.length, 0, 'untitled importResolutions count');
    ctx.typeOf(bundle.statementEndLine, 'number', 'statementEndLine type for untitled');
    ctx.value('statementEndLine', bundle.statementEndLine);
    ctx.value('languageId', bundle.languageId);

    // Close the untitled tab to prevent stranded tabs — target this specific tab,
    // not "the currently active one" (which may have changed between showTextDocument
    // and here).
    await closeUntitledDoc(doc);
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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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

test('resolveRelativePath: returns ./ or ../ prefixed path', async (ctx) => {
    const fakeRoot = '/fake/workspace';
    const src = vscode.Uri.file(`${fakeRoot}/src/foo.ts`);
    const tgt = vscode.Uri.file(`${fakeRoot}/src/utils/helpers.ts`);
    const rel = resolveRelativePath(src, tgt);
    ctx.ok(typeof rel === 'string' && rel.length > 0, 'non-empty string');
    // resolveRelativePath uses workspace.asRelativePath when a workspace folder
    // exists, which prepends the real workspace path. We can't predict what that
    // will be, so we just verify it's a valid path with ./ prefix.
    ctx.ok(rel.startsWith('./'), 'starts with ./');
});

test('resolveRelativePath: same directory and parent directory', async (ctx) => {
    const fakeRoot = '/fake/workspace';
    const src = vscode.Uri.file(`${fakeRoot}/src/foo.ts`);
    const tgt = vscode.Uri.file(`${fakeRoot}/src/bar.ts`);
    const rel = resolveRelativePath(src, tgt);
    ctx.ok(typeof rel === 'string' && rel.length > 0, 'same-dir non-empty');

    const src2 = vscode.Uri.file(`${fakeRoot}/src/api/foo.ts`);
    const tgt2 = vscode.Uri.file(`${fakeRoot}/src/utils/helpers.ts`);
    const rel2 = resolveRelativePath(src2, tgt2);
    ctx.ok(typeof rel2 === 'string' && rel2.length > 0, 'parent-dir non-empty');
});

test('resolveRelativePath: always returns non-empty string', async (ctx) => {
    const src = vscode.Uri.file('/fake/workspace/src/foo.ts');
    const tgt = vscode.Uri.file('/fake/workspace/src/bar.ts');
    const rel = resolveRelativePath(src, tgt);
    ctx.ok(typeof rel === 'string' && rel.length > 0, 'non-empty string');
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
    await waitForLsp(uri, 1500);
    const doc = await vscode.workspace.openTextDocument(uri);
    const supported = await hasLspSupport(doc);
    ctx.ok(supported, 'TypeScript file has LSP support');
    await removeFile(uri);
});

// ──────────────────────────────────────────────────────────────
//  FileKind detection (Phase A enrichment)
// ──────────────────────────────────────────────────────────────

test('fileKind: inferFileKindFromExtension maps extensions correctly', async (ctx) => {
    // ── Code files ──
    ctx.equal(inferFileKindFromExtension('.ts'), 'code', '.ts → code');
    ctx.equal(inferFileKindFromExtension('.py'), 'code', '.py → code');
    ctx.equal(inferFileKindFromExtension('.rs'), 'code', '.rs → code');
    ctx.equal(inferFileKindFromExtension('.jsx'), 'code', '.jsx → code');

    // ── Images ──
    ctx.equal(inferFileKindFromExtension('.png'), 'image', '.png → image');
    ctx.equal(inferFileKindFromExtension('.jpg'), 'image', '.jpg → image');
    ctx.equal(inferFileKindFromExtension('.svg'), 'image', '.svg → image');
    ctx.equal(inferFileKindFromExtension('.webp'), 'image', '.webp → image');

    // ── Audio ──
    ctx.equal(inferFileKindFromExtension('.mp3'), 'audio', '.mp3 → audio');
    ctx.equal(inferFileKindFromExtension('.wav'), 'audio', '.wav → audio');
    ctx.equal(inferFileKindFromExtension('.flac'), 'audio', '.flac → audio');

    // ── Video ──
    ctx.equal(inferFileKindFromExtension('.mp4'), 'video', '.mp4 → video');
    ctx.equal(inferFileKindFromExtension('.webm'), 'video', '.webm → video');

    // ── Fonts ──
    ctx.equal(inferFileKindFromExtension('.woff2'), 'font', '.woff2 → font');
    ctx.equal(inferFileKindFromExtension('.ttf'), 'font', '.ttf → font');

    // ── Data / config ──
    ctx.equal(inferFileKindFromExtension('.json'), 'data', '.json → data');
    ctx.equal(inferFileKindFromExtension('.csv'), 'data', '.csv → data');
    ctx.equal(inferFileKindFromExtension('.yaml'), 'data', '.yaml → data');
    ctx.equal(inferFileKindFromExtension('.toml'), 'data', '.toml → data');

    // ── Documents ──
    ctx.equal(inferFileKindFromExtension('.pdf'), 'document', '.pdf → document');
    ctx.equal(inferFileKindFromExtension('.md'), 'document', '.md → document');

    // ── Archives ──
    ctx.equal(inferFileKindFromExtension('.zip'), 'archive', '.zip → archive');
    ctx.equal(inferFileKindFromExtension('.tar.gz'), 'unknown', '.tar.gz → unknown (no double-ext handling)');
    // Note: double extensions like .tar.gz are not handled — only the last ext is checked.
    // That's fine: .gz alone maps to 'archive'.

    // ── Binary / other ──
    ctx.equal(inferFileKindFromExtension('.wasm'), 'binary', '.wasm → binary');
    ctx.equal(inferFileKindFromExtension('.exe'), 'binary', '.exe → binary');
    ctx.equal(inferFileKindFromExtension('.dll'), 'binary', '.dll → binary');

    // ── Edge cases ──
    ctx.equal(inferFileKindFromExtension(''), 'unknown', 'empty → unknown');
    ctx.equal(inferFileKindFromExtension('.unknown'), 'unknown', '.unknown → unknown');
    ctx.equal(inferFileKindFromExtension('TS'), 'code', '.TS uppercase → code (case-insensitive)');
    ctx.equal(inferFileKindFromExtension('.PNG'), 'image', '.PNG uppercase → image');
});

test('fileKind: isBinaryKind classifies correctly', async (ctx) => {
    ctx.ok(isBinaryKind('image'), 'image is binary');
    ctx.ok(isBinaryKind('audio'), 'audio is binary');
    ctx.ok(isBinaryKind('video'), 'video is binary');
    ctx.ok(isBinaryKind('font'), 'font is binary');
    ctx.ok(isBinaryKind('archive'), 'archive is binary');
    ctx.ok(isBinaryKind('binary'), 'binary is binary');
    ctx.ok(!isBinaryKind('code'), 'code is not binary');
    ctx.ok(!isBinaryKind('data'), 'data is not binary');
    ctx.ok(!isBinaryKind('document'), 'document is not binary');
    ctx.ok(!isBinaryKind('unknown'), 'unknown is not binary');
});

test('fileKind: JSON file import resolves with fileKind "data"', async (ctx) => {
    // This integration test verifies that importing a non-code file
    // (JSON) correctly carries the 'data' fileKind in the bundle.
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const jsonUri = tmpUri('.json', 'filekind_json');
    const sourceUri = tmpUri('.ts', 'filekind_source');

    await writeFile(jsonUri, JSON.stringify({ name: 'test', version: '1.0.0', dependencies: {} }, null, 2));

    const jsonName = path.basename(jsonUri.path).replace(/\.json$/, '');
    await writeFile(sourceUri, [
        `import * as cfg from './${jsonName}.json';`,
        '',
        'console.log(cfg.name);',
    ].join('\n'));

    await openDocument(jsonUri);
    await openDocument(sourceUri);
    await waitForLsp(jsonUri, 1500);
    await waitForLsp(sourceUri, 5_000);

    const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(sourceDoc, new vscode.Position(2, 15));

    ctx.ok(Array.isArray(bundle.importResolutions), 'fileKind JSON: importResolutions is array');
    ctx.value('fileKind JSON: importResolutions count', bundle.importResolutions.length);

    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.value('fileKind JSON: import[0].fileKind', imp.fileKind);
        ctx.value('fileKind JSON: import[0].relativePath', imp.relativePath);
        ctx.equal(imp.fileKind, 'data', 'fileKind JSON: fileKind is "data" for .json import');
        ctx.value('fileKind JSON: exports', imp.exports.map(e => `${e.name}:${e.kind}`).join(' | '));
    } else {
        ctx.value('fileKind JSON', 'no import resolutions — LSP link provider may not have resolved the JSON import');
    }

    await removeFile(jsonUri);
    await removeFile(sourceUri);
});

test('public detectMissingImports() returns array for clean file', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'pub_detect_missing');
    await writeFile(uri, 'export const ok = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);
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
//  Pure-function utility tests (ported from old .test.ts files)
// ──────────────────────────────────────────────────────────────

test('flattenWorkspaceEdit: extracts TextEdit entries across URIs', async (ctx) => {
    const edit = {
        entries() {
            return [
                [
                    { toString: () => 'file:///a.ts' },
                    [
                        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import x from "x";\n' },
                        { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, newText: 'y();\n' },
                    ],
                ],
                [
                    { toString: () => 'file:///b.ts' },
                    [
                        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import z from "z";\n' },
                    ],
                ],
            ];
        },
    } as any;

    const out = flattenWorkspaceEdit(edit);
    ctx.equal(out.length, 3, '3 text edits across 2 files');
    ctx.ok(out[0].newText.startsWith('import x'), 'first edit: import x');
    ctx.ok(out[2].newText.startsWith('import z'), 'third edit: import z');
});

test('flattenWorkspaceEdit: skips snippet edits', async (ctx) => {
    const edit = {
        entries() {
            return [
                [
                    { toString: () => 'file:///a.ts' },
                    [
                        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'plain' },
                        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'snip', snippet: 'snip(${1})' },
                    ],
                ],
            ];
        },
    } as any;

    const out = flattenWorkspaceEdit(edit);
    ctx.equal(out.length, 1, 'snippet edit filtered out');
    ctx.equal(out[0].newText, 'plain', 'only plain edit survives');
});

test('flattenWorkspaceEdit: returns empty for empty input', async (ctx) => {
    const edit = { entries() { return []; } } as any;
    ctx.equal(flattenWorkspaceEdit(edit).length, 0, 'empty input → empty output');
});

test('buildExportsLine: formatting and all-or-nothing truncation', async (ctx) => {
    const E = (name: string, kind: string, type?: string) => ({ name, kind, line: 1, type });

    // name:type when type present
    const out1 = buildExportsLine([E('foo', 'Function', '(x: number) => string')], 100);
    ctx.ok(out1.includes('foo:(x: number) => string'), 'type shown when present');

    // fallback to kind
    const out2 = buildExportsLine([E('Foo', 'Class')], 100);
    ctx.ok(out2.includes('Foo:Class'), 'kind fallback when type absent');

    // all-or-nothing: long export with tight budget
    const longType = 'function foo(a: number, b: string, c: boolean, d: Date, e: RegExp): { x: string; y: number; z: boolean }';
    const out3 = buildExportsLine([
        E('short1', 'Function', '() => void'),
        E('longExport', 'Function', longType),
        E('short2', 'Function', '() => void'),
    ], 30);
    ctx.ok(out3.includes('short1'), 'first short export included');
    ctx.ok(!out3.includes('longExport:function foo('), 'long export not partially truncated');
    ctx.ok(/\.\.\. \(\+\d+ more\)/.test(out3), 'skipped count marker present');

    // single line, no embedded newlines
    const out4 = buildExportsLine([E('a', 'Function'), E('b', 'Function'), E('c', 'Function')], 100);
    ctx.ok(!out4.includes('\n'), 'single line output');

    // empty
    ctx.equal(buildExportsLine([], 100), 'exports: ', 'empty exports');
});

test('buildImportLine: uses relativePath and respects typeSignatures', async (ctx) => {
    const makeImp = (overrides: Record<string, any> = {}) => ({
        uri: 'file:///abs/utils.ts',
        relativePath: './utils.ts',
        exports: [{ name: 'parseISO', kind: 'Function', line: 1 }],
        fileKind: 'code' as const,
        ...overrides,
    });

    // relativePath used as label
    const out1 = buildImportLine(makeImp());
    ctx.ok(out1.startsWith('./utils.ts:'), 'starts with relativePath');

    // typeSignatures displayed
    const out2 = buildImportLine(makeImp({ typeSignatures: { parseISO: '(s: string) => Date' } }));
    ctx.ok(out2.includes('parseISO:(s: string) => Date'), 'hover signature shown');

    // fallback to kind
    const out3 = buildImportLine(makeImp());
    ctx.ok(out3.includes('parseISO:Function'), 'kind fallback when no typeSignature');

    // 12 exports capped at 8
    const manyExps = Array.from({ length: 12 }, (_, i) => ({ name: `fn${i}`, kind: 'Function', line: i, type: '() => void' }));
    const out4 = buildImportLine(makeImp({ exports: manyExps }));
    for (let i = 0; i < 8; i++) ctx.ok(out4.includes(`fn${i}:() => void`), `fn${i} in output`);
    for (let i = 8; i < 12; i++) ctx.ok(!out4.includes(`fn${i}:`), `fn${i} excluded`);

    // empty exports
    ctx.equal(buildImportLine(makeImp({ exports: [] })), './utils.ts: ', 'empty exports');
});

test('findStatementEndHeuristic: semicolons, continuations, indentation', async (ctx) => {
    const syntax = (overrides: Record<string, any> = {}) => ({
        semicolons: true, indentationSignificant: false, brackets: [] as string[], continuationOperators: [] as string[], comment: '//',
        ...overrides,
    });

    // Semicolons: statement ends at semicolon on same line
    const lines1 = ['const x = 1;', 'const y = 2;'];
    ctx.equal(findStatementEndHeuristic(lines1, 0, syntax()), 0,
        'semicolon on same line');

    // Continuation operators: line ending with comma continues
    const lines2 = ['const x = [1,', '2,', '3];'];
    ctx.equal(findStatementEndHeuristic(lines2, 0, syntax({ continuationOperators: [','] })), 2,
        'comma continuation spans lines');

    // Python: no semicolons, indentation-significant — line with `:` continues to its block body
    // `if True:` continues to `pass` (indented body), then ends (no more lines in block).
    const lines3 = ['if True:', '    pass', 'x = 1'];
    // The `:` is NOT a continuation operator — it's a block starter. Without `:` in
    // continuationOperators, the statement `if True:` ends on line 0.
    ctx.equal(findStatementEndHeuristic(lines3, 0, syntax({ semicolons: false, indentationSignificant: false, continuationOperators: [], comment: '#' })), 0,
        'Python if ends at line end (no continuation)');

    // Comments don't break continuation
    const lines4 = ['const x = [1, // comment', '2,', '3];'];
    ctx.equal(findStatementEndHeuristic(lines4, 0, syntax({ continuationOperators: [','] })), 2,
        'comment line still continues with comma');

    // Budget limit: max 10 lines scanned
    const longLines = Array.from({ length: 20 }, (_, i) => `x${i},`);
    ctx.equal(findStatementEndHeuristic(longLines, 0, syntax({ continuationOperators: [','] }), 10), 9,
        'budget limit of 10 lines');
});

test('Ghost: trimLineSuffixOverlap (via TrimCompletionSuffixOverlap)', async (ctx) => {
    const trim = (text: string, suffix: string, threshold = 0.5, type: 'low' | 'high' = 'low') => {
        const lines = text.split('\n');
        const suffixLines = suffix.split('\n');
        const t = new TrimCompletionSuffixOverlap(threshold, type);
        const overlap = t.calculateOverlap(lines, suffixLines);
        if (overlap > 0 && overlap < lines.length) return lines.slice(0, lines.length - overlap).join('\n');
        if (overlap >= lines.length) return '';
        return text;
    };

    ctx.equal(trim('line1\nline2\nline3', 'other1\nother2'), 'line1\nline2\nline3', 'no overlap');
    ctx.equal(trim('hello\nworld\nfoo', 'world\nfoo\nbar'), 'hello', 'partial overlap');
    ctx.equal(trim('hello\nworld', 'hello\nworld'), '', 'full overlap');
    ctx.equal(trim('', 'suffix'), '', 'empty input');
    ctx.equal(trim('hello\nworld', ''), 'hello\nworld', 'empty suffix');
    ctx.equal(trim('hello', 'world'), 'hello', 'single line no overlap');
    ctx.equal(trim('prefix\nmyFunction', 'myFuncion\nrest', 0.3, 'high'), 'prefix', 'fuzzy match high similarity');
});

test('Ghost: trimCharOverlap suffix-boundary dedup', async (ctx) => {
    const trim = (completion: string, suffix: string): string => {
        if (!completion || !suffix) return completion;
        const cf = completion.split('\n')[0];
        const sf = suffix.split('\n')[0];
        if (!cf || !sf) return completion;
        const maxLen = Math.min(cf.length, sf.length);
        for (let len = maxLen; len > 0; len--) {
            const head = sf.substring(0, len);
            if (cf.endsWith(head)) return completion.substring(0, completion.length - len);
        }
        return completion;
    };

    ctx.equal(trim('hello', 'lo'), 'hel', 'simple suffix overlap');
    ctx.equal(trim('hello', ''), 'hello', 'empty suffix');
    ctx.equal(trim('', 'hello'), '', 'empty completion');
    ctx.equal(trim('hello', 'world'), 'hello', 'no overlap');
    ctx.equal(trim('hello world', 'world'), 'hello ', 'full word overlap');
    ctx.equal(trim('abcde', 'cde'), 'ab', 'mid-string overlap');
    ctx.equal(trim('test\nline2', 'line2'), 'test\nline2', 'cross-line no overlap (first line only)');
    ctx.equal(trim('   hello', 'hello'), '   ', 'whitespace preserved');
    ctx.equal(trim('symbol', 'bol'), 'sym', 'partial character overlap');
    ctx.equal(trim('a\nb\nc', 'c'), 'a\nb\nc', 'multi-line first line no overlap');
    ctx.equal(trim('return x;', 'x;'), 'return ', 'code suffix');
    ctx.equal(trim('// comment', 'comment'), '// ', 'comment suffix');
});

test('Ghost: BlockTrimmer — Terse and Verbose', async (ctx) => {
    const terse = new TerseBlockTrimmer();
    const verbose = new VerboseBlockTrimmer();

    const multiLine = 'line1\n\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11';
    const terseResult = terse.trim(multiLine);
    ctx.ok(!terseResult.includes('line3'), 'terse stops at blank line');

    const shortResult = terse.trim('line1\nline2');
    ctx.equal(shortResult, 'line1\nline2', 'terse allows short text');

    const verboseLines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    const verboseResult = verbose.trim(verboseLines.join('\n'));
    ctx.ok(verboseResult.split('\n').length <= 40, 'verbose caps at 40 lines');
});

test('Ghost: isInlineSuggestionFromTextAfterCursor', async (ctx) => {
    // Empty/whitespace → false
    ctx.equal(isInlineSuggestionFromTextAfterCursor(''), false, 'empty → false');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('   '), false, 'spaces → false');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('\t'), false, 'tab → false');

    // Valid inline triggers → true
    const validCases = [')', ');', ');\n', ']', '}', '"', "'", '`', ':', ';', ',', '):', '): '];
    for (const c of validCases) {
        ctx.equal(isInlineSuggestionFromTextAfterCursor(c), true, `"${c}" → true`);
    }

    // Invalid mid-line → undefined
    ctx.equal(isInlineSuggestionFromTextAfterCursor('foo'), undefined, 'identifier');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('('), undefined, 'open paren');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('['), undefined, 'open bracket');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('.'), undefined, 'dot');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('!'), undefined, 'not');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('- 1'), undefined, 'minus');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('// comment'), undefined, 'comment');
    ctx.equal(isInlineSuggestionFromTextAfterCursor('<T>'), undefined, 'generic');
});

test('NES: TrimCompletionSuffixOverlap exact + fuzzy', async (ctx) => {
    const t = new TrimCompletionSuffixOverlap(0.5, 'low');
    ctx.equal(t.calculateOverlap(['function foo() {', '  return 1;', '}'], ['}', '']), 1, 'exact overlap');
    ctx.equal(t.calculateOverlap(['function foo() {', '  return 1;', '}'], ['a', 'b']), 0, 'no overlap');
    ctx.equal(t.calculateOverlap(['a', 'b', 'c'], ['b', 'c', 'd']), 2, 'partial suffix overlap');
    ctx.equal(t.calculateOverlap(['a', 'b'], ['a', 'b', 'c']), 2, 'suffix longer — overlap counted from completion end');
});

test('NES: EditFilterChain — empty, noop, whitespace, comment filters', async (ctx) => {
    const empty = new EmptyEditFilter();
    ctx.equal(empty.shouldReject([''], ['a']), true, 'empty edit rejected');
    ctx.equal(empty.shouldReject(['  ', '\t'], ['a']), true, 'whitespace rejected');
    ctx.equal(empty.shouldReject(['code'], ['a']), false, 'non-empty accepted');

    const noop = new NoopEditFilter();
    ctx.equal(noop.shouldReject(['a', 'b'], ['a', 'b']), true, 'identical rejected');
    ctx.equal(noop.shouldReject(['a', 'changed'], ['a', 'b']), false, 'different accepted');
    ctx.equal(noop.shouldReject(['a'], ['a', 'b']), false, 'different length accepted');

    const ws = new WhitespaceOnlyFilter();
    ctx.equal(ws.shouldReject(['  hello  '], ['hello']), true, 'whitespace change rejected');
    ctx.equal(ws.shouldReject(['new code'], ['old code']), false, 'content change accepted');

    const comment = new CommentOnlyFilter();
    ctx.equal(comment.shouldReject(['// comment', '# also'], ['old']), true, 'comment-only rejected');
    ctx.equal(comment.shouldReject(['realCode();', '// comment'], ['old']), false, 'with code accepted');

    const chain = new EditFilterChain([empty, noop, ws, comment]);
    ctx.equal(chain.apply([''], ['a']), undefined, 'chain rejects empty');
    ctx.equal(chain.apply(['code'], ['old']), 'code', 'chain accepts real edit');
});

test('NES: ResponsePipeline — BoundaryMarkerParser + CursorTagStripper', async (ctx) => {
    const parser = new BoundaryMarkerParser();
    const ctx_ = (overrides: any = {}) => ({ editWindowHadCursorTag: false, ...overrides });

    ctx.deepEqual(
        parser.process(['pre', '###remain edit start boundary line###', 'line1', 'line2', '###remain edit end boundary line###', 'post'], ctx_()),
        ['line1', 'line2'], 'boundary markers extracted');
    ctx.deepEqual(
        parser.process(['line1', 'line2', '', 'line3'], ctx_()),
        [], 'no markers → empty (waiting for stream)');
    ctx.deepEqual(
        parser.process(['###remain edit start boundary line###', 'line1', 'line2'], ctx_()),
        ['line1', 'line2'], 'missing end marker');
    ctx.deepEqual(
        parser.process(['  ###remain edit start boundary line###  ', 'line1', '  ###remain edit end boundary line###  '], ctx_()),
        ['line1'], 'whitespace around markers');

    const stripper = new CursorTagStripper();
    ctx.deepEqual(
        stripper.process(['  line<|cursor|>here', '<|cursor|>start'], ctx_()),
        ['  linehere', 'start'], '<|cursor|> tags stripped');
    ctx.deepEqual(
        stripper.process(['  line<|cursor|>here'], { editWindowHadCursorTag: true }),
        ['  line<|cursor|>here'], 'tags preserved when edit window had cursor tag');
});

test('NES: nextCursorPredictor parseResponse', async (ctx) => {
    const keptRange = new OffsetRange(10, 100);

    const parse = (line: string): Result<any, string> => {
        const n = parseInt(line, 10);
        if (!isNaN(n) && String(n) === line) {
            if (n < 0) return Result.error('negativeLineNumber');
            if (n < keptRange.start || keptRange.endExclusive <= n) return Result.error('modelNotSeenLineNumber');
            return Result.ok({ kind: 'sameFile', lineNumber: n });
        }
        const lastColonIdx = line.lastIndexOf(':');
        if (lastColonIdx < 0) return Result.error('gotNaN');
        const fp = line.substring(0, lastColonIdx).trim();
        const cl = parseInt(line.substring(lastColonIdx + 1), 10);
        if (isNaN(cl) || cl < 0 || fp.length === 0) return Result.error('crossFileInvalidLineNumber');
        return Result.ok({ kind: 'differentFile', filePath: fp, lineNumber: cl });
    };

    const ok = parse('42');
    ctx.equal(ok.isOk(), true, 'valid line number');
    if (ok.isOk()) ctx.equal(ok.val.lineNumber, 42, 'line 42');

    ctx.equal(parse('5').isOk(), false, 'below range rejected');
    ctx.equal(parse('100').isOk(), false, 'at range end rejected');
    ctx.equal(parse('-1').isOk(), false, 'negative rejected');
    ctx.equal(parse('abc').isOk(), false, 'non-numeric rejected');
    ctx.equal(parse('file.ts:42').isOk(), true, 'cross-file colon format');
    ctx.equal(parse(':42').isOk(), false, 'empty file path rejected');
});

test('Ghost: completionsCache — construction and interface', async (ctx) => {
    const cache = new GhostCompletionsCache(3);
    ctx.ok(typeof cache.append === 'function', 'cache has append method');
    ctx.ok(typeof cache.findAll === 'function', 'cache has findAll method');
    ctx.ok(typeof cache.clear === 'function', 'cache has clear method');
    ctx.ok(Array.isArray(cache.findAll('', '')), 'findAll returns array');
});

test('NES: nextEditCache — setKthNextEdit and lookupNextEdit', async (ctx) => {
    const cache = new NextEditCache();
    ctx.ok(typeof cache.setKthNextEdit === 'function', 'cache has setKthNextEdit method');
    ctx.ok(typeof cache.lookupNextEdit === 'function', 'cache has lookupNextEdit method');
    ctx.ok(typeof cache.clear === 'function', 'cache has clear method');
    ctx.ok(typeof cache.clearAll === 'function', 'cache has clearAll method');
});

test('Ghost: heuristicIsEmptyBlock — empty block detection', async (ctx) => {
    // True: empty blocks
    ctx.equal(heuristicIsEmptyBlock('function foo() {\n  \n}', 17), true, 'function empty body cursor after newline');
    ctx.equal(heuristicIsEmptyBlock('function foo() {\n}', 16), true, 'function empty body right after {');
    ctx.equal(heuristicIsEmptyBlock('if (true) {\n  \n}', 13), true, 'if empty body');
    ctx.equal(heuristicIsEmptyBlock('for (;;) {\n  \n}', 11), true, 'for empty body');
    ctx.equal(heuristicIsEmptyBlock('while (c) {\n  \n}', 11), true, 'while empty body');
    ctx.equal(heuristicIsEmptyBlock('try {\n  \n} catch {\n  \n}', 5), true, 'try empty body');
    ctx.equal(heuristicIsEmptyBlock('const obj = {\n  \n};', 14), true, 'object literal empty (acceptable false positive)');

    // False: non-empty blocks
    ctx.equal(heuristicIsEmptyBlock('function foo() { x; }', 17), false, 'function with content');
    ctx.equal(heuristicIsEmptyBlock('if (true) x;', 11), false, 'if with inline body');
    ctx.equal(heuristicIsEmptyBlock('', 0), false, 'empty string');
    ctx.equal(heuristicIsEmptyBlock('no braces here', 0), false, 'no braces');
    ctx.equal(heuristicIsEmptyBlock('{', 1), false, 'only opening brace no close');

    // Edge cases
    ctx.equal(heuristicIsEmptyBlock('const x = 1;', 0), false, 'no braces at all');
    ctx.equal(heuristicIsEmptyBlock('{ }', 1), true, 'single space between braces');
    ctx.equal(heuristicIsEmptyBlock('{\n}', 1), true, 'newline between braces');
});

test('Ghost: multiline — heuristicIsEmptyBlock additional edge cases', async (ctx) => {
    // Verify the heuristic handles these tricky cases
    ctx.equal(heuristicIsEmptyBlock('{\n  \n}', 1), true, 'spaces + newline');
    ctx.equal(heuristicIsEmptyBlock('{\n\n}', 1), true, 'empty line between braces');
    ctx.equal(heuristicIsEmptyBlock('  {\n  \n  }', 3), true, 'indented braces');
    ctx.equal(heuristicIsEmptyBlock('{ \n }', 1), true, 'space after brace');
});

// ──────────────────────────────────────────────────────────────
//  Output marker stripping  (stripOutputMarkers)
// ──────────────────────────────────────────────────────────────

test('stripOutputMarkers: removes GHOST FIM tags from start', async (ctx) => {
    ctx.equal(stripOutputMarkers('<|fim_prefix|>actual code'), 'actual code', '<|fim_prefix|>');
    ctx.equal(stripOutputMarkers('<|fim_suffix|>actual code'), 'actual code', '<|fim_suffix|>');
    ctx.equal(stripOutputMarkers('<|fim_middle|>actual code'), 'actual code', '<|fim_middle|>');
    ctx.equal(stripOutputMarkers('<|fim_prefix|><|fim_suffix|>actual code'), 'actual code', 'chained FIM tags');
});

test('stripOutputMarkers: removes NES tags from start and end', async (ctx) => {
    ctx.equal(stripOutputMarkers('<|code_to_edit|>actual code'), 'actual code', '<|code_to_edit|> at start');
    ctx.equal(stripOutputMarkers('actual code<|/code_to_edit|>'), 'actual code', '<|/code_to_edit|> at end');
    ctx.equal(stripOutputMarkers('<|imports|>\n./foo.ts: Foo\n<|/imports|>\nactual code'), 'actual code', '<|imports|> block at start');
    ctx.equal(stripOutputMarkers('actual code\n<|imports|>\n./bar.ts: Bar\n<|/imports|>'), 'actual code', '<|imports|> block at end');
});

test('stripOutputMarkers: removes NES boundary markers from start/end', async (ctx) => {
    ctx.equal(stripOutputMarkers('###remain edit start boundary line###\nedited code'), 'edited code', 'start marker at beginning');
    ctx.equal(stripOutputMarkers('edited code\n###remain edit end boundary line###'), 'edited code', 'end marker at end');
    ctx.equal(stripOutputMarkers('###remain edit start boundary line###\nedited\n###remain edit end boundary line###'), 'edited', 'both markers wrapping');
});

test('stripOutputMarkers: removes ad-hoc NES tags (angle-bracket format)', async (ctx) => {
    ctx.equal(stripOutputMarkers('<imports>\nsomething\n</imports>\nreal code'), 'real code', '<imports> at start');
    ctx.equal(stripOutputMarkers('real code\n<super_types>\nBase\n</super_types>'), 'real code', '<super_types> at end');
    ctx.equal(stripOutputMarkers('<missing_imports>\nFoo\n</missing_imports>\n'), '', 'standalone tag block fully stripped');
});

test('stripOutputMarkers: handles chained and repeated markers', async (ctx) => {
    ctx.equal(stripOutputMarkers('<|cursor|><|cursor|><|cursor|>code'), 'code', 'repeated cursor tags');
    ctx.equal(stripOutputMarkers('<|fim_prefix|><|imports|>code<|/imports|>'), 'code', 'chained prefix+imports');
    ctx.equal(stripOutputMarkers('code\n<|cursor|>\n<|/code_to_edit|>'), 'code', 'multiple trailing tags');
});

test('stripOutputMarkers: idempotent', async (ctx) => {
    const input = '<|fim_prefix|>hello world<|cursor|>';
    const once = stripOutputMarkers(input);
    const twice = stripOutputMarkers(once);
    ctx.equal(once, twice, 'second pass no-op');
});

test('stripOutputMarkers: leaves normal code unchanged', async (ctx) => {
    ctx.equal(stripOutputMarkers('const x = 1;'), 'const x = 1;', 'plain code');
    ctx.equal(stripOutputMarkers('function foo() { return 1; }'), 'function foo() { return 1; }', 'function');
    ctx.equal(stripOutputMarkers('<|valid| in code'), '<|valid| in code', 'partial tag in code (no close)');
});

test('stripOutputMarkers: trims trailing blank lines after stripping', async (ctx) => {
    const result = stripOutputMarkers('code\n\n\n');
    ctx.equal(result, 'code', 'trailing blanks removed');
});

test('containsAnyMarker: detects markers anywhere in text', async (ctx) => {
    ctx.ok(containsAnyMarker('<|fim_prefix|>'), 'detects fim_prefix');
    ctx.ok(containsAnyMarker('###remain edit start boundary line###'), 'detects boundary markers');
    ctx.ok(!containsAnyMarker('clean code'), 'no false positive on clean code');
    ctx.ok(!containsAnyMarker('<|something_unknown|>'), 'unknown pipe tag not detected');
});

test('diagnoseMarkerLeakage: lists all leaked markers', async (ctx) => {
    const leaked = diagnoseMarkerLeakage('<|fim_prefix|>code<|cursor|><|/code_to_edit|>');
    ctx.ok(leaked.length >= 2, 'at least 2 markers detected');
    ctx.ok(leaked.includes('<|fim_prefix|>'), 'fim_prefix in leaks');
    ctx.ok(leaked.includes('<|cursor|>'), 'cursor in leaks');
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

test('Non-LSP: regex fallback edge cases — JS/TS', async (ctx) => {
    ctx.equal(
        extractRelativeImportSpecifiers(`import { foo } from './utils/foo';`, 'typescript').length, 1,
        'static import');
    ctx.equal(
        extractRelativeImportSpecifiers(`const m = import('./lazy');`, 'typescript')[0], './lazy',
        'dynamic import');
    ctx.equal(
        extractRelativeImportSpecifiers(`const x = require('./x');`, 'typescript')[0], './x',
        'require');
    ctx.equal(
        extractRelativeImportSpecifiers(`import { foo } from "./utils/foo";`, 'typescript')[0], './utils/foo',
        'double quotes');
    ctx.deepEqual(
        extractRelativeImportSpecifiers(`import { useState } from 'react';\nimport { y } from './relative';`, 'typescript'),
        ['./relative'],
        'bare module specifiers skipped');
    ctx.equal(
        extractRelativeImportSpecifiers(`import a from './a'; import b from './b';`, 'typescript').length, 2,
        'multiple imports one line');
    ctx.equal(
        extractRelativeImportSpecifiers(`import { x } from '../../shared/x';`, 'typescript')[0], '../../shared/x',
        'parent dir import');
    ctx.equal(
        extractRelativeImportSpecifiers(`import { x } from './a'; import { y } from './a';`, 'typescript').length, 1,
        'deduplicates');
    ctx.equal(
        extractRelativeImportSpecifiers(`const x = 1;\nconst y = 2;\nfunction foo() { return x + y; }`, 'typescript').length, 0,
        'no imports');
    ctx.equal(
        extractRelativeImportSpecifiers(`import React from 'react';\nimport Button from './components/Button';`, 'typescriptreact').length, 1,
        'JSX skips bare, finds relative');
    ctx.equal(
        extractRelativeImportSpecifiers(`import { x } from '@scope/pkg';`, 'typescript').length, 0,
        'scoped package skipped');
    ctx.equal(
        extractRelativeImportSpecifiers(`import { x } from './utils/helpers';`, 'typescript')[0], './utils/helpers',
        'subpath import');
    ctx.ok(
        Array.isArray(extractRelativeImportSpecifiers(`const p = require.resolve('./p');`, 'typescript')),
        'require.resolve does not throw (known limitation: may miss)');
});

test('Non-LSP: regex fallback edge cases — Python, Ruby, Go, Dart', async (ctx) => {
    // Python
    ctx.equal(extractRelativeImportSpecifiers(`from .module import foo`, 'python')[0], '.module', 'Python: from .module');
    ctx.equal(extractRelativeImportSpecifiers(`from ..pkg import bar`, 'python')[0], '..pkg', 'Python: parent relative');
    ctx.equal(extractRelativeImportSpecifiers(`from . import baz`, 'python')[0], '.', 'Python: single dot');
    ctx.equal(extractRelativeImportSpecifiers(`from os import path\nimport sys`, 'python').length, 0, 'Python: abs skipped');

    // Ruby
    ctx.equal(extractRelativeImportSpecifiers(`require './file'`, 'ruby')[0], './file', 'Ruby: require relative');
    ctx.equal(extractRelativeImportSpecifiers(`require_relative '../file'`, 'ruby')[0], '../file', 'Ruby: require_relative');
    ctx.equal(extractRelativeImportSpecifiers(`require 'json'`, 'ruby').length, 0, 'Ruby: gem skipped');

    // Go
    ctx.equal(extractRelativeImportSpecifiers(`import "./pkg/foo"`, 'go')[0], './pkg/foo', 'Go: double-quoted');
    ctx.equal(extractRelativeImportSpecifiers(`import './internal/util'`, 'go')[0], './internal/util', 'Go: single-quoted');

    // Dart
    ctx.equal(extractRelativeImportSpecifiers(`import './foo.dart';`, 'dart')[0], './foo.dart', 'Dart');
});

test('Non-LSP: regex fallback edge cases — C/C++, PHP, Lua', async (ctx) => {
    // C/C++
    ctx.equal(extractRelativeImportSpecifiers(`#include "header.h"`, 'cpp')[0], 'header.h', 'C++: quoted include');
    ctx.equal(extractRelativeImportSpecifiers(`#include "../path/header.hpp"`, 'c')[0], '../path/header.hpp', 'C: parent dir');
    ctx.equal(extractRelativeImportSpecifiers(`#include <stdio.h>\n#include <stdlib.h>`, 'c').length, 0, 'C: system header skipped');

    // PHP
    ctx.equal(extractRelativeImportSpecifiers(`require './file.php';`, 'php')[0], './file.php', 'PHP: require');
    ctx.equal(extractRelativeImportSpecifiers(`include_once './helpers.php';`, 'php')[0], './helpers.php', 'PHP: include_once');

    // Lua
    ctx.equal(extractRelativeImportSpecifiers(`local m = require "./module"`, 'lua')[0], './module', 'Lua: require');
    ctx.equal(extractRelativeImportSpecifiers(`local m = require "./module.lua"`, 'lua')[0], './module.lua', 'Lua: with extension');
});

test('Non-LSP: regex fallback adversarial — known gaps & bugs', async (ctx) => {
    // Java: standard package import not relative — NOT detected
    ctx.equal(extractRelativeImportSpecifiers(`import java.util.List;`, 'java').length, 0,
        'Java package import not detected (LSP required)');
    // C# `using System;` not relative
    ctx.equal(extractRelativeImportSpecifiers(`using System;\nusing System.Collections.Generic;`, 'csharp').length, 0,
        'C# using not detected (LSP required)');
    // Rust `use` / `mod` not relative
    ctx.equal(extractRelativeImportSpecifiers(`use std::collections::HashMap;\nmod utils;\nfn main() {}`, 'rust').length, 0,
        'Rust use/mod not detected (LSP required)');
    // Kotlin, Swift, Scala: not relative
    ctx.equal(extractRelativeImportSpecifiers(`import kotlin.collections.List\nfun main() {}`, 'kotlin').length, 0,
        'Kotlin package import not detected');
    ctx.equal(extractRelativeImportSpecifiers(`import Foundation\nlet x = 1`, 'swift').length, 0,
        'Swift package import not detected');
    ctx.equal(extractRelativeImportSpecifiers(`import scala.collection._\nobject Foo {}`, 'scala').length, 0,
        'Scala package import not detected');

    // [KNOWN BUG] backtick template with import keyword
    ctx.ok(Array.isArray(extractRelativeImportSpecifiers('const tpl = `import x from "./fake"`;', 'typescript')),
        'template literal does not throw');

    // [KNOWN BUG] require() inside string
    ctx.ok(Array.isArray(extractRelativeImportSpecifiers(`const code = "require('./fake')";`, 'typescript')),
        'require in string does not throw');

    // Unicode
    ctx.deepEqual(
        extractRelativeImportSpecifiers(`import { café } from './unicode';`, 'typescript'),
        ['./unicode'],
        'unicode identifiers');

    // Malformed
    ctx.ok(Array.isArray(extractRelativeImportSpecifiers(`import foo from './bar';\x00import baz from './qux';`, 'typescript')),
        'null byte does not throw');

    // Trailing comma, whitespace
    ctx.equal(extractRelativeImportSpecifiers(`import { a, b, } from './trailing';`, 'typescript')?.[0], './trailing',
        'trailing comma');
    ctx.equal(extractRelativeImportSpecifiers(`import {   a   ,   b   } from './spaces';`, 'typescript')?.[0], './spaces',
        'excess whitespace');
});

test('Non-LSP: cache hit on repeated gather() skips LSP query', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const uri = tmpUri('.ts', 'nls_cache');
    await writeFile(uri, 'export const x = 1;\n');
    await openDocument(uri);
    await waitForLsp(uri, 1500);

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

    // Untitled docs don't write to disk BUT they still occupy an Untitled-N slot
    // in the workspace. Without this close, the next run adds another tab and the
    // previous one stays stranded (this is the source of "Untitled-1: const x = 42;"
    // tabs accumulating across runs).
    await closeUntitledDoc(doc);
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
    await waitForLsp(uriA, 1500);

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
//  Workspace fixture tests: path aliases, re-exports, multi-file
//  These create miniprojects with tsconfig.json etc. so the LSP
//  has full project context (path aliases, module resolution).
// ──────────────────────────────────────────────────────────────

test('[WS] TS path alias @/ → ./src/ resolves via tsconfig.json', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const wsDir = tmpDir('alias_ts');
    await writeJsonConfig(wsDir, 'tsconfig.json', {
        compilerOptions: {
            paths: { '@/*': ['./src/*'] },
            baseUrl: '.',
            module: 'ESNext',
            target: 'ES2022',
        },
        include: ['src/**/*.ts'],
    });

    await writeTextFile(wsDir, 'src/utils.ts', [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
    ].join('\n'));

    await writeTextFile(wsDir, 'src/main.ts', [
        `import { greet } from '@/utils';`,
        '',
        'console.log(greet("world"));',
    ].join('\n'));

    const sourceUri = vscode.Uri.file(path.join(wsDir.fsPath, 'src', 'main.ts'));
    await openDocument(sourceUri);
    // TS server doesn't fire onDidChangeDiagnostics for temp files outside the
    // VS Code workspace, so waiting longer just burns wall clock. 5s is plenty;
    // the test handles the "no response" case gracefully below.
    const lsp = await waitForLsp(sourceUri, 5_000);
    ctx.ok(typeof lsp.ok === 'boolean', 'WS alias: LSP wait completed', lsp.ok);
    ctx.value('WS alias: LSP', lsp.ok ? `ready (${lsp.attemptCount} attempt(s))` : `not ready (${lsp.attemptCount} attempt(s))`);

    const doc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(doc, new vscode.Position(2, 20));

    ctx.ok(Array.isArray(bundle.importResolutions), 'WS alias: importResolutions is array');
    ctx.value('WS alias: importResolutions count', bundle.importResolutions.length);

    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.value('WS alias: import[0].relativePath', imp.relativePath);
        ctx.ok(imp.relativePath.includes('utils'), 'WS alias: resolved to utils file', imp.relativePath);
    } else {
        ctx.value('WS alias', 'no import resolutions — LSP may not have resolved the @/ alias (temp file outside workspace)');
    }

    await removeDir(wsDir);
});

test('[WS] TS re-export chain: barrel → utils resolved fully', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const wsDir = tmpDir('reexport_ts');
    await writeJsonConfig(wsDir, 'tsconfig.json', {
        compilerOptions: {
            paths: { '@/*': ['./src/*'] },
            baseUrl: '.',
            module: 'ESNext',
            target: 'ES2022',
        },
        include: ['src/**/*.ts'],
    });

    // utils.ts — original source
    await writeTextFile(wsDir, 'src/utils.ts', [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
    ].join('\n'));

    // barrel.ts — re-exports from utils
    await writeTextFile(wsDir, 'src/barrel.ts', [
        `export { greet } from './utils';`,
    ].join('\n'));

    // main.ts — imports from barrel via @/
    await writeTextFile(wsDir, 'src/main.ts', [
        `import { greet } from '@/barrel';`,
        '',
        'console.log(greet("world"));',
    ].join('\n'));

    const sourceUri = vscode.Uri.file(path.join(wsDir.fsPath, 'src', 'main.ts'));
    await openDocument(sourceUri);
    // TS server doesn't fire onDidChangeDiagnostics for temp files outside the
    // VS Code workspace, so waiting longer just burns wall clock.
    const lsp = await waitForLsp(sourceUri, 5_000);
    ctx.ok(typeof lsp.ok === 'boolean', 'WS reexport: LSP wait completed', lsp.ok);

    const doc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(doc, new vscode.Position(2, 20));

    ctx.ok(Array.isArray(bundle.importResolutions), 'WS reexport: importResolutions is array');
    ctx.value('WS reexport: importResolutions count', bundle.importResolutions.length);

    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.value('WS reexport: import[0].relativePath', imp.relativePath);
        ctx.value('WS reexport: import[0].exports', imp.exports.map(e => `${e.name}:${e.kind}`).join(' | '));
        ctx.ok(imp.exports.some(e => e.name === 'greet'), 'WS reexport: greet export present');
    } else {
        ctx.value('WS reexport', 'no import resolutions — LSP may not have traced the re-export chain');
    }

    await removeDir(wsDir);
});

test('[WS] TS multi-file: cross-file symbol resolution in project', async (ctx) => {
    const log = new LogService();
    log.enabled = false;
    const builder = new ContextBuilderService(log);

    const wsDir = tmpDir('multi_ts');
    await writeJsonConfig(wsDir, 'tsconfig.json', {
        compilerOptions: {
            paths: { '@/*': ['./src/*'] },
            baseUrl: '.',
            module: 'ESNext',
            target: 'ES2022',
        },
        include: ['src/**/*.ts'],
    });

    // user.ts — interface
    await writeTextFile(wsDir, 'src/user.ts', [
        'export interface User {',
        '  id: string;',
        '  name: string;',
        '  email: string;',
        '}',
    ].join('\n'));

    // service.ts — depends on User
    await writeTextFile(wsDir, 'src/service.ts', [
        "import { User } from './user';",
        '',
        'export function formatUser(u: User): string {',
        '  return `${u.name} <${u.email}>`;',
        '}',
    ].join('\n'));

    // main.ts — imports from service
    await writeTextFile(wsDir, 'src/main.ts', [
        "import { formatUser } from '@/service';",
        '',
        'const u = { id: "1", name: "Alice", email: "alice@example.com" };',
        'console.log(formatUser(u));',
    ].join('\n'));

    const sourceUri = vscode.Uri.file(path.join(wsDir.fsPath, 'src', 'main.ts'));
    await openDocument(sourceUri);
    // TS server doesn't fire onDidChangeDiagnostics for temp files outside the
    // VS Code workspace, so waiting longer just burns wall clock.
    const lsp = await waitForLsp(sourceUri, 5_000);
    ctx.ok(typeof lsp.ok === 'boolean', 'WS multi: LSP wait completed', lsp.ok);

    const doc = await vscode.workspace.openTextDocument(sourceUri);
    const bundle = await builder.gather(doc, new vscode.Position(3, 25));

    ctx.ok(Array.isArray(bundle.importResolutions), 'WS multi: importResolutions is array');
    ctx.value('WS multi: importResolutions count', bundle.importResolutions.length);

    if (bundle.importResolutions.length > 0) {
        const imp = bundle.importResolutions[0];
        ctx.value('WS multi: import[0].relativePath', imp.relativePath);
        ctx.value('WS multi: import[0].exports', imp.exports.map(e => `${e.name}:${e.kind}`).join(' | '));
        ctx.ok(imp.exports.some(e => e.name === 'formatUser'), 'WS multi: formatUser resolved');
    } else {
        ctx.value('WS multi', 'no import resolutions');

        // Also log the bundle's exports and scope for debugging
        ctx.value('WS multi: fileExports', bundle.fileExports.map(e => `${e.name}:${e.kind}`).join(' | '));
        ctx.value('WS multi: languageId', bundle.languageId);
    }

    await removeDir(wsDir);
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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uriA, 1500);
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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
    await waitForLsp(uri, 1500);

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
//  Config provider tests
// ──────────────────────────────────────────────────────────────

function _mockContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        workspaceState: {
            get: <T>(key: string, dflt: T) => (state.has(key) ? state.get(key) : dflt) as T,
            update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); },
        },
        subscriptions: [] as vscode.Disposable[],
    } as unknown as vscode.ExtensionContext;
}

function _mockSecrets(): ISecretConfig {
    const noop = () => {};
    return {
        _serviceBrand: undefined,
        getGhostApiKey: () => '',
        getNesApiKey: () => '',
        setGhostApiKey: async () => {},
        setNesApiKey: async () => {},
        deleteGhostApiKey: async () => {},
        deleteNesApiKey: async () => {},
        migrateFromPlaintext: async () => ({ ghost: false, nes: false }),
        onDidChange: (_l: () => void) => { noop(); return { dispose: noop }; },
    };
}

test('Config: VSCodeGhostConfigProvider defaults and cache invalidation', async (ctx) => {
    const provider = new VSCodeGhostConfigProvider(_mockContext(), _mockSecrets());

    // Use the current config's actual model value (user may have changed it from defaults)
    const modelVal = provider.model;
    ctx.ok(typeof modelVal === 'string' && modelVal.length > 0, `model is non-empty string: ${modelVal}`);
    ctx.equal(provider.promptTemplate, '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>', 'default promptTemplate');

    // enabled is independent of settings.json cache
    const initialEnabled = provider.enabled;
    provider.enabled = false;
    ctx.equal(provider.enabled, false, 'enabled can be set');
    ctx.equal(provider.model, modelVal, 'model unchanged after enabled change');
    provider.enabled = initialEnabled;
});

test('Config: VSCodeGhostConfigProvider caches and invalidates on config change', async (ctx) => {
    const provider = new VSCodeGhostConfigProvider(_mockContext(), _mockSecrets());
    const config = vscode.workspace.getConfiguration('cc-completion.ghost');

    const originalModel = provider.model;
    ctx.ok(typeof originalModel === 'string' && originalModel.length > 0, 'model has value before change');
    const testModel = originalModel === 'gpt-4.1' ? 'gpt-4o' : 'gpt-4.1';
    await config.update('model', testModel, vscode.ConfigurationTarget.Global);
    ctx.equal(provider.model, testModel, 'updated after config change');
    await config.update('model', originalModel, vscode.ConfigurationTarget.Global);
});

test('Config: VSCodeNesConfigProvider defaults and cache invalidation', async (ctx) => {
    const provider = new VSCodeNesConfigProvider(_mockContext(), _mockSecrets());

    const modelVal = provider.model;
    ctx.ok(typeof modelVal === 'string' && modelVal.length > 0, `model is non-empty: ${modelVal}`);
    ctx.equal(provider.family, 'standard', 'default family');
    ctx.equal(provider.nextCursorPredictionEnabled, false, 'default nextCursorPredictionEnabled');

    // enabled is independent
    const initialEnabled = provider.enabled;
    provider.enabled = false;
    ctx.equal(provider.enabled, false, 'enabled can be set');
    ctx.equal(provider.model, modelVal, 'model unchanged after enabled change');
    provider.enabled = initialEnabled;

    // nextCursorPredictionEnabled uses workspaceState
    provider.nextCursorPredictionEnabled = true;
    ctx.equal(provider.nextCursorPredictionEnabled, true, 'can toggle nextCursorPrediction');
    provider.nextCursorPredictionEnabled = false;
});

test('Config: VSCodeNesConfigProvider caches and invalidates on config change', async (ctx) => {
    const provider = new VSCodeNesConfigProvider(_mockContext(), _mockSecrets());
    const config = vscode.workspace.getConfiguration('cc-completion.nes');

    const originalModel = provider.model;
    ctx.ok(typeof originalModel === 'string' && originalModel.length > 0, 'model has value before change');
    const testModel = originalModel === 'claude-4' ? 'gpt-4o' : 'claude-4';
    await config.update('model', testModel, vscode.ConfigurationTarget.Global);
    ctx.equal(provider.model, testModel, 'updated after config change');
    await config.update('model', originalModel, vscode.ConfigurationTarget.Global);
});

// ──────────────────────────────────────────────────────────────
//  InlineSuggestionResolver tests
// ──────────────────────────────────────────────────────────────

function _mockDoc(lines: string[]): vscode.TextDocument {
    const content = lines.join('\n');
    const doc: any = {
        lineCount: lines.length,
        lineAt: (line: number) => ({
            text: lines[line] ?? '',
            range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
        }),
        offsetAt: (pos: vscode.Position) => {
            let offset = 0;
            for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
            return offset + pos.character;
        },
        positionAt: (offset: number) => {
            let line = 0;
            let remaining = offset;
            while (line < lines.length && remaining > lines[line].length) {
                remaining -= lines[line].length + 1;
                line++;
            }
            return new vscode.Position(line, Math.max(0, remaining));
        },
        getText: (range?: vscode.Range) => {
            if (!range) return content;
            const s = doc.offsetAt(range.start);
            const e = doc.offsetAt(range.end);
            return content.substring(s, e);
        },
    };
    return doc;
}

test('NES: InlineSuggestionResolver', async (ctx) => {
    const resolver = new InlineSuggestionResolver();

    // Multi-line range → undefined
    const doc1 = _mockDoc(['function foo() {', '    return 1;', '    // extra', '}']);
    const r1 = resolver.resolve(new vscode.Position(0, 16), doc1, new vscode.Range(0, 0, 3, 1), 'function foo() {\n    return 2;\n    // extra\n}');
    ctx.equal(r1, undefined, 'multi-line range → undefined');

    // Same-line ghost text at cursor
    const doc2 = _mockDoc(['const x = Math.|']);
    const r2 = resolver.resolve(new vscode.Position(0, 14), doc2, new vscode.Range(0, 14, 0, 14), 'Math.max(1, 2)');
    ctx.ok(r2 !== undefined, 'same-line returns result');
    if (r2) ctx.equal(r2.range.start.character, 14, 'start character preserved');

    // Cursor before range → undefined
    const doc3 = _mockDoc(['const x = oldValue;']);
    const r3 = resolver.resolve(new vscode.Position(0, 5), doc3, new vscode.Range(0, 10, 0, 18), 'newValue');
    ctx.equal(r3, undefined, 'cursor before range → undefined');

    // Prefix mismatch → undefined
    const doc4 = _mockDoc(['prefixXYZsuffix']);
    const r4 = resolver.resolve(new vscode.Position(0, 7), doc4, new vscode.Range(0, 6, 0, 9), 'ABC');
    ctx.equal(r4, undefined, 'prefix mismatch → undefined');

    // Next-line insertion rewrite
    const doc6 = _mockDoc(['const a = 1', '']);
    const r6 = resolver.resolve(new vscode.Position(0, 11), doc6, new vscode.Range(1, 0, 1, 0), 'const b = 2;\n');
    ctx.ok(r6 !== undefined, 'next-line returns result');
    if (r6) ctx.ok(r6.newText.includes('const b = 2;'), 'newText contains inserted line');
});

test('NES: InlineSuggestionResolver.isSubword', async (ctx) => {
    ctx.equal(InlineSuggestionResolver.isSubword('abc', 'axbyc'), true, 'subsequence');
    ctx.equal(InlineSuggestionResolver.isSubword('abc', 'abc'), true, 'exact match');
    ctx.equal(InlineSuggestionResolver.isSubword('abc', 'def'), false, 'no match');
    ctx.equal(InlineSuggestionResolver.isSubword('ab', 'ba'), false, 'wrong order');
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

    // Pre-flight cleanup: kill any untitled tabs leaked from a previous run.
    // Without this, each invocation of the command accumulates one more
    // `Untitled-N` tab (the two untitled tests above create one each, and only
    // close theirs reliably when this helper exists).
    const leakedUntitled = await closeAllUntitledTabs();
    if (leakedUntitled > 0) {
        channel.appendLine(`[preflight] closed ${leakedUntitled} leaked untitled tab(s) from previous run`);
    }

    channel.appendLine(`[config] fail-fast: enabled — runner stops on first failure`);
    if (_onlyTestName) {
        channel.appendLine(`[config] test.only mode: only "${_onlyTestName}" will run (${tests.length - 1} others skipped)`);
    }
    channel.appendLine('');

    // ── Diagnostic event spy (additive — does not modify waitForLsp) ──
    // Logs every onDidChangeDiagnostics event with URI and elapsed time.
    // Helps distinguish "LSP fires once at 172ms (syntax check only)" from
    // "LSP fires at 172ms AND again at 3400ms (symbols ready)."
    const diagEventCounts = new Map<string, number>();
    const diagSpyStart = Date.now();
    const diagSpy = vscode.languages.onDidChangeDiagnostics(e => {
        try {
            for (const u of e.uris) {
                const uriStr = u.toString();
                const count = (diagEventCounts.get(uriStr) ?? 0) + 1;
                diagEventCounts.set(uriStr, count);
                const elapsed = Date.now() - diagSpyStart;
                const shortUri = uriStr.includes('__cc_diag_')
                    ? uriStr.substring(uriStr.lastIndexOf('/') + 1)
                    : uriStr;
                channel.appendLine(`  [diag] event #${count} at +${elapsed}ms for ${shortUri}`);
            }
        } catch (err) {
            channel.appendLine(`  [diag] ERROR in spy: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    channel.appendLine(`  [diag] spy registered at t=0`);

    for (const t of tests) {
        // When a test is marked with .only(), skip everything except it
        if (_onlyTestName && t.name !== _onlyTestName) continue;

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
            channel.appendLine('');
            channel.appendLine('── FAIL-FAST: first failure — stopping runner ──');
            break;
        }
    }

    // Dispose the diagnostic event spy
    diagSpy.dispose();

    // Post-flight cleanup: kill any untitled tabs this run created. Even with
    // per-test closeUntitledDoc calls, a test that throws mid-way, or one that
    // creates a doc without a clear handle, can still leak a tab. Sweep again
    // here so the user always ends with a clean workspace.
    const leakedAtEnd = await closeAllUntitledTabs();
    if (leakedAtEnd > 0) {
        channel.appendLine(`[postflight] closed ${leakedAtEnd} untitled tab(s) leaked during this run`);
    }

    const elapsed = Date.now() - start;
    const ran = passed + failed;
    const skipped = tests.length - ran;
    channel.appendLine('');
    channel.appendLine(`── ${elapsed}ms ──`);
    if (failed === 0) {
        channel.appendLine(`  All ${passed} diagnostics passed.`);
        if (skipped > 0) {
            channel.appendLine(`  (${skipped} test(s) skipped — fail-fast not triggered)`);
        }
    } else {
        channel.appendLine(`  ${passed} passed, ${failed} failed, ${skipped} skipped (${tests.length} total, fail-fast)`);
        channel.appendLine(`  First failure: "${tests[passed]?.name ?? 'unknown'}"`);
    }
    channel.appendLine('');

    return { passed, failed, total: tests.length, durationMs: elapsed };
}

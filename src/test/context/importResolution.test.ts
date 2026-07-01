import * as assert from 'assert';
import * as vscode from 'vscode';
import { ContextBuilderService } from '../../completions/context/contextBuilderService';
import { ILogService, LogService } from '../../completions/shared/log/logService';

suite('Import Resolution', () => {
    let log: ILogService;
    let builder: ContextBuilderService;

    suiteSetup(() => {
        log = new LogService();
        // Disable logging for test clarity
        log.enabled = false;
        builder = new ContextBuilderService(log);
    });

    async function waitForLSP(uri: vscode.Uri, timeoutMs = 20000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const s = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
            if (s && s.length > 0) return;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('LSP did not become ready within timeout');
    }

    /** Create a temp .ts file, write to disk, open, show to wake TS LSP. */
    async function createTempTsFile(content: string, prefix: string): Promise<vscode.TextDocument> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/tmp');
        const fileUri = vscode.Uri.joinPath(ws, `__ctx_${prefix}_${Date.now()}.ts`);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
        return doc;
    }

    test('resolves imports from a TypeScript file using document links', async () => {
        const targetDoc = await createTempTsFile(
            `export interface User { name: string; age: number; }
             export function greet(u: User): string { return 'hello'; }
             class Helper { static format(s: string): string { return s.trim(); } }`,
            'target',
        );

        const targetName = targetDoc.fileName.split('/').pop()!.replace(/\.ts$/, '');
        const sourceDoc = await createTempTsFile(
            `import { User, greet } from './${targetName}';
             function process(user: User) { return greet(user); }`,
            'source',
        );

        // Wait for LSP to be ready for the source file
        await waitForLSP(sourceDoc.uri, 25000);

        const position = new vscode.Position(1, 4);
        const bundle = await builder.gather(sourceDoc, position);

        assert.ok(bundle.importResolutions.length >= 1,
            `Expected at least 1 import resolution, got ${bundle.importResolutions.length}`);

        if (bundle.importResolutions.length > 0) {
            const resolved = bundle.importResolutions[0];
            assert.ok(resolved.uri.length > 0, 'Import target URI should not be empty');

            // Phase A: relativePath is mandatory
            assert.ok(typeof resolved.relativePath === 'string' && resolved.relativePath.length > 0,
                `Import resolution must have a non-empty relativePath, got: ${resolved.relativePath}`);
            assert.ok(resolved.relativePath.endsWith('.ts'),
                `relativePath should include file extension, got: ${resolved.relativePath}`);

            const exportNames = resolved.exports.map(e => e.name);
            assert.ok(exportNames.includes('User'),
                `Expected 'User' in resolved exports, got [${exportNames.join(', ')}]`);
            assert.ok(exportNames.includes('greet'),
                `Expected 'greet' in resolved exports, got [${exportNames.join(', ')}]`);
            assert.ok(exportNames.includes('Helper'),
                `Expected 'Helper' in resolved exports, got [${exportNames.join(', ')}]`);
        }
    }).timeout(40000);

    test('returns empty array for file with no imports', async () => {
        const doc = await createTempTsFile('const x = 1;\nconst y = 2;\n', 'noimports');
        await waitForLSP(doc.uri, 15000);
        const bundle = await builder.gather(doc, new vscode.Position(0, 0));
        assert.ok(Array.isArray(bundle.importResolutions));
        assert.strictEqual(bundle.importResolutions.length, 0,
            `Expected 0 import resolutions for file with no imports, got ${bundle.importResolutions.length}`);
    }).timeout(20000);

    test('import resolution coexists with other context fields', async () => {
        const doc = await createTempTsFile('const x = 1;\nconst y = 2;\n', 'ctxfields');
        await waitForLSP(doc.uri, 15000);
        const bundle = await builder.gather(doc, new vscode.Position(0, 0));

        assert.ok(Array.isArray(bundle.importResolutions), 'importResolutions should be an array');
        assert.ok(Array.isArray(bundle.missingImports), 'missingImports should be an array');
        assert.ok(Array.isArray(bundle.fileExports), 'fileExports should be an array');
        assert.strictEqual(bundle.languageId, 'typescript');
        assert.ok(bundle.languageSyntax !== undefined);
        assert.doesNotThrow(() => JSON.stringify(bundle));
    }).timeout(20000);
});

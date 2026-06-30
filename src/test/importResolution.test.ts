import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractRelativeImportSpecifiers, resolveSpecifierToUri, normalizePath } from '../completions/context/contextBuilderService';

suite('Import Resolution — helpers', () => {

    // ── extractRelativeImportSpecifiers ───────────────────────

    test('extracts relative import specifiers from TypeScript', () => {
        const text = `import { User } from './user';
import { greet } from '../utils/helpers';
import * as fs from 'fs';`;
        const specs = extractRelativeImportSpecifiers(text);
        assert.deepStrictEqual(specs, ['./user', '../utils/helpers']);
    });

    test('extracts require specifiers', () => {
        const text = `const fs = require('fs');
const helper = require('./helper');`;
        const specs = extractRelativeImportSpecifiers(text);
        assert.deepStrictEqual(specs, ['./helper']);
    });

    test('handles double-quoted specifiers', () => {
        const text = `import { User } from "./user";`;
        const specs = extractRelativeImportSpecifiers(text);
        assert.deepStrictEqual(specs, ['./user']);
    });

    test('returns empty for file with no imports', () => {
        const text = 'const x = 1;\nconsole.log(x);';
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text), []);
    });

    test('deduplicates identical specifiers', () => {
        const text = `import { User } from './user';
import { UserRole } from './user';`;
        const specs = extractRelativeImportSpecifiers(text);
        assert.deepStrictEqual(specs, ['./user']);
    });

    test('skips package imports (non-relative)', () => {
        const text = `import { Component } from 'react';
import { greet } from './greet';`;
        const specs = extractRelativeImportSpecifiers(text);
        assert.deepStrictEqual(specs, ['./greet']);
    });

    // ── normalizePath ─────────────────────────────────────────

    test('normalizePath resolves . and ..', () => {
        assert.strictEqual(normalizePath('/a/b/c/./d'), '/a/b/c/d');
        assert.strictEqual(normalizePath('/a/b/c/../d'), '/a/b/d');
        assert.strictEqual(normalizePath('a/b/../c/./d'), 'a/c/d');
    });
});

suite('Import Resolution — integration', () => {

    async function waitForLSP(uri: vscode.Uri, timeoutMs = 15000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const s = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
            if (s && s.length > 0) return;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('LSP did not become ready within timeout');
    }

    async function createFixture(content: string, tag: string): Promise<vscode.TextDocument> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/tmp');
        const uri = vscode.Uri.joinPath(ws, `__fx_${tag}_${Date.now()}.ts`);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
        return doc;
    }

    test('resolveSpecifierToUri resolves ./ import to existing file', async () => {
        const target = await createFixture(
            `export const x = 1;`, 't1',
        );
        const dir = target.fileName.substring(0, target.fileName.lastIndexOf('/'));
        const name = target.fileName.split('/').pop()!.replace(/\.ts$/, '');
        const uri = await resolveSpecifierToUri(`./${name}`, dir, 'file');
        assert.ok(uri, 'Should resolve to a URI');
        assert.ok(uri!.path.endsWith('.ts'), `Should end with .ts, got ${uri!.path}`);
    });

    test('DocumentSymbol provider returns exports from resolved file', async () => {
        const target = await createFixture(
            `export interface User { name: string; }
             export function greet(): string { return 'hello'; }
             class Helper {}`,
            't2',
        );
        await waitForLSP(target.uri);
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', target.uri);
        assert.ok(symbols && symbols.length >= 3,
            `Expected at least 3 symbols, got ${symbols?.length ?? 0}`);
        const names = symbols!.map(s => s.name);
        assert.ok(names.includes('User'));
        assert.ok(names.includes('greet'));
        assert.ok(names.includes('Helper'));
    }).timeout(25000);
});

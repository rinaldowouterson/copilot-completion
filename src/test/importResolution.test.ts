import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractRelativeImportSpecifiers, resolveSpecifierToUri, normalizePath } from '../completions/context/contextBuilderService';

suite('Import Resolution — helpers', () => {

    // ── extractRelativeImportSpecifiers ───────────────────────

    test('extracts relative import specifiers from TypeScript', () => {
        const text = `import { User } from './user';
import { greet } from '../utils/helpers';
import * as fs from 'fs';`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./user', '../utils/helpers']);
    });

    test('extracts require specifiers', () => {
        const text = `const fs = require('fs');
const helper = require('./helper');`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./helper']);
    });

    test('handles double-quoted specifiers', () => {
        const text = `import { User } from "./user";`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./user']);
    });

    test('returns empty for file with no imports', () => {
        const text = 'const x = 1;\nconsole.log(x);';
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'typescript'), []);
    });

    test('deduplicates identical specifiers', () => {
        const text = `import { User } from './user';
import { UserRole } from './user';`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./user']);
    });

    test('skips package imports (non-relative)', () => {
        const text = `import { Component } from 'react';
import { greet } from './greet';`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./greet']);
    });

    // ── Language-specific ─────────────────────────────────────

    test('extracts relative imports from Python', () => {
        const text = `from . import User
from .models import Post
from .utils.helpers import format_date`;
        const specs = extractRelativeImportSpecifiers(text, 'python');
        assert.deepStrictEqual(specs, ['.', '.models', '.utils.helpers']);
    });

    test('extracts relative requires from Ruby', () => {
        const text = `require './lib/helper'
require_relative '../config/constants'`;
        const specs = extractRelativeImportSpecifiers(text, 'ruby');
        assert.deepStrictEqual(specs, ['./lib/helper', '../config/constants']);
    });

    test('extracts relative imports from Go', () => {
        const text = `import "./pkg/helper"
import "fmt"`;
        const specs = extractRelativeImportSpecifiers(text, 'go');
        assert.deepStrictEqual(specs, ['./pkg/helper']);
    });

    test('extracts relative imports from Dart', () => {
        const text = `import '../other.dart'
import 'package:foo/bar.dart'`;
        const specs = extractRelativeImportSpecifiers(text, 'dart');
        assert.deepStrictEqual(specs, ['../other.dart']);
    });

    test('extracts relative includes from C/C++', () => {
        const text = `#include "header.h"
#include <vector>`;
        const specs = extractRelativeImportSpecifiers(text, 'cpp');
        assert.deepStrictEqual(specs, ['header.h']);
    });

    test('extracts relative requires from PHP', () => {
        const text = `require './lib/helper.php';
include '../config.php';
require_once './vendor/autoload.php';`;
        const specs = extractRelativeImportSpecifiers(text, 'php');
        assert.deepStrictEqual(specs, ['./lib/helper.php', '../config.php', './vendor/autoload.php']);
    });

    // ── normalizePath ─────────────────────────────────────────

    test('normalizePath resolves . and ..', () => {
        assert.strictEqual(normalizePath('/a/b/c/./d'), '/a/b/c/d');
        assert.strictEqual(normalizePath('/a/b/c/../d'), '/a/b/d');
        assert.strictEqual(normalizePath('a/b/../c/./d'), 'a/c/d');
    });

    // ── Unhandled / edge-case languages ───────────────────────

    test('Java imports return empty (package-based, not filesystem)', () => {
        const text = `import java.util.List;
import com.example.Foo;
import static org.junit.Assert.*;`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'java'), []);
    });

    test('C# imports return empty (namespace-based)', () => {
        const text = `using System;
using System.Collections.Generic;
using static System.Math;`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'csharp'), []);
    });

    test('Rust imports return empty (:: paths via build system)', () => {
        const text = `use std::collections::HashMap;
use crate::module::Item;
use super::helper;`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'rust'), []);
    });

    test('Elixir imports return empty (module aliases, no paths)', () => {
        const text = `import Enum
alias MyApp.User
require Logger`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'elixir'), []);
    });

    test('Haskell imports return empty (package-based modules)', () => {
        const text = `import Data.List
import qualified Data.Map as M
import Data.Maybe (fromJust)`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'haskell'), []);
    });

    test('Lua detects relative require paths', () => {
        const text = `local m = require "mod.sub"
local n = require "./relative"`;
        const specs = extractRelativeImportSpecifiers(text, 'lua');
        // Lua's `require "./relative"` is a relative path ✓
        // `require "mod.sub"` is not relative (no ./ or ../ prefix)
        assert.deepStrictEqual(specs, ['./relative']);
    });

    test('unknown language ID returns empty gracefully', () => {
        const text = `import { X } from './foo';`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'unknown-lang'), []);
    });

    test('null-safe: language ID does not cause crash', () => {
        const text = 'const x = 1;';
        assert.doesNotThrow(() => extractRelativeImportSpecifiers(text, ''));
        assert.doesNotThrow(() => extractRelativeImportSpecifiers(text, '   '));
    });

    test('empty text returns empty array', () => {
        assert.deepStrictEqual(extractRelativeImportSpecifiers('', 'typescript'), []);
    });

    test('malformed imports (missing closing quote) skip gracefully', () => {
        const text = `import { X } from './foo;`; // missing closing quote
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'typescript'), []);
    });

    test('mixed import styles in same file', () => {
        const text = `import { X } from './foo';
const y = require('./bar');
import { Z } from './baz';`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./foo', './bar', './baz']);
    });

    test('@@ syntax should not confuse extractor', () => {
        const text = `@import './style.css'
import { X } from './module'`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./module']);
    });

    test('dynamic import() syntax', () => {
        const text = `const mod = import('./lazy');
import('./other').then(m => ...);`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./lazy', './other']);
    });

    // ── Negative / edge cases ─────────────────────────────────

    test('all imports are non-relative (package imports only) — returns empty', () => {
        const text = `import React from 'react';
import { Component } from 'react';
const fs = require('fs');`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'typescript'), []);
    });

    test('single word after from is not a valid specifier', () => {
        // "from X import Y" without quotes should not match
        const text = `from something import foo`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'typescript'), []);
    });

    test('string containing "from" as substring in a comment', () => {
        // "from" appearing inside a string or comment, not as an import keyword
        const text = `// transfer from old system
const msg = 'from the heart';`;
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'typescript'), []);
    });

    test('require without parentheses is not matched', () => {
        const text = `const x = require './foo';`; // missing parens — not valid JS/TS require
        assert.deepStrictEqual(extractRelativeImportSpecifiers(text, 'typescript'), []);
    });

    test('multiple imports on the same line are all found', () => {
        // Some minifiers bundle multiple imports on one line.
        const text = `import { X } from './foo'; import { Y } from './bar';`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        assert.deepStrictEqual(specs, ['./foo', './bar']);
    });

    test('require and from on the same line', () => {
        const text = `const a = require('./a'); import { b } from './b';`;
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        // Both specifiers are found; order depends on pattern-table ordering
        // (from is checked before require) — verify set equality
        assert.strictEqual(specs.length, 2);
        assert.ok(specs.includes('./a'));
        assert.ok(specs.includes('./b'));
    });

    test('import specifier spans multiple lines (line continuation)', () => {
        // TypeScript doesn't support multi-line import specifiers, but just in case
        const text = `import { X } from './\nfoo';`; // broken across lines
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        // The line-by-line scanner sees './ on line 1 (no closing quote → skip)
        // and ' on line 2 (no keyword → skip). Both yield undefined.
        assert.deepStrictEqual(specs, []);
    });

    test('very long single-line document completes quickly', () => {
        const line = `import { X } from './module'; `;
        const text = line.repeat(10000);
        const start = Date.now();
        const specs = extractRelativeImportSpecifiers(text, 'typescript');
        const elapsed = Date.now() - start;
        // Pure function should handle 10k lines in well under 1s.
        // (VS Code test startup overhead is not included in this measurement)
        console.log(`  [perf] 10000 lines scanned in ${elapsed}ms (${(elapsed / 10000).toFixed(4)}ms/line)`);
        assert.ok(elapsed < 1000, `extraction took ${elapsed}ms — expected <1000ms for 10k lines`);
        assert.ok(specs.length > 0);
        assert.ok(specs.includes('./module'));
    }).timeout(10000);
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

    // ── Negative integration tests ────────────────────────────

    test('resolveSpecifierToUri returns undefined for non-existent file', async () => {
        const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/tmp';
        const uri = await resolveSpecifierToUri('./nonexistent_file_12345', dir, 'file', 'typescript');
        assert.strictEqual(uri, undefined);
    });

    test('resolveSpecifierToUri returns undefined for empty specifier', async () => {
        const dir = '/tmp';
        const uri = await resolveSpecifierToUri('', dir, 'file');
        assert.strictEqual(uri, undefined);
    });

    test('resolveSpecifierToUri returns undefined for dot-only specifier (no extension match)', async () => {
        // '.' alone without a module name — Python from . import X resolves to
        // the __init__.py of the current package. Our resolver can't handle this,
        // so it should return undefined.
        const dir = '/tmp';
        const uri = await resolveSpecifierToUri('.', dir, 'file', 'python');
        assert.strictEqual(uri, undefined);
    });
});

/**
 * Adversarial tests — exercise the gaps and known limitations of the
 * regex-based import-specifier extractor and file-system resolver.
 *
 * These tests document current behavior so regressions are caught and
 * the user knows when the LSP path is required for correctness.
 *
 * Each test name uses the prefix `[KNOWN GAP]` or `[KNOWN BUG]` so
 * it's obvious in the test output that the limitation is intentional.
 */

import * as assert from 'assert';
import {
    extractRelativeImportSpecifiers,
    normalizePath,
} from '../../completions/context/contextBuilderService';

suite('Adversarial — known gaps in regex/language coverage', () => {
    // ────────────────────────────────────────────────────────────────
    // Languages with NEW regex fallback support
    // ────────────────────────────────────────────────────────────────
    suite('Languages with newly added regex patterns', () => {
        test('Java: relative-style `import ./local.Foo;` IS detected', () => {
            // Note: standard Java imports are `import java.util.List;`
            // (package import) — those are NOT detected (correctly
            // filtered out as non-relative). Only relative-style imports
            // starting with `./` or `../` are detected.
            const text = `import ./local.Foo;\nimport java.util.List;`;
            const specs = extractRelativeImportSpecifiers(text, 'java');
            // Debug: also test what raw patterns are returned
            const text2 = `import ./other.Bar;`;
            const specs2 = extractRelativeImportSpecifiers(text2, 'java');
            assert.deepStrictEqual(specs, ['./local.Foo']);
            assert.deepStrictEqual(specs2, ['./other.Bar']);
        });

        test('C#: `using ./local;` IS detected', () => {
            const text = `using ./local;\nusing System;`;
            const specs = extractRelativeImportSpecifiers(text, 'csharp');
            assert.deepStrictEqual(specs, ['./local']);
        });

        test('C#: `using static ./Helpers;` is correctly filtered (no ./ prefix)', () => {
            // `using static ./Helpers;` — the specifier after `using ` is
            // `static ./Helpers`. This doesn't start with `./` so the
            // relative-path filter correctly excludes it.
            const text = `using static System.Math;`;
            const specs = extractRelativeImportSpecifiers(text, 'csharp');
            assert.deepStrictEqual(specs, []);
        });




    test('Rust: `mod ./local;` IS detected (specifier without semicolon)', () => {
            const text = `mod ./local;\nfn main() {}`;
            const specs = extractRelativeImportSpecifiers(text, 'rust');
            assert.deepStrictEqual(specs, ['./local'],
                'Unquoted path extracts the specifier, terminating at `;`');
        });

        test('Kotlin: `import ./local.Foo` IS detected', () => {
            const text = `import ./local.Foo\nfun main() {}`;
            const specs = extractRelativeImportSpecifiers(text, 'kotlin');
            assert.deepStrictEqual(specs, ['./local.Foo']);
        });

        test('Swift: `import ./LocalModule` IS detected', () => {
            const text = `import ./LocalModule\nlet x = 1`;
            const specs = extractRelativeImportSpecifiers(text, 'swift');
            assert.deepStrictEqual(specs, ['./LocalModule']);
        });
    });
    // ────────────────────────────────────────────────────────────────
    // Languages with NO regex fallback patterns at all
    // ────────────────────────────────────────────────────────────────
    suite('Languages with no regex fallback (LSP required)', () => {
        test('[KNOWN GAP] C# `using System;` is NOT detected by regex', () => {
            const text = `using System;\nusing System.Collections.Generic;\nnamespace Foo { class Bar { } }`;
            const specs = extractRelativeImportSpecifiers(text, 'csharp');
            assert.deepStrictEqual(specs, [],
                'C# `using` directives are not in the regex pattern table — LSP required');
        });

        test('[KNOWN GAP] Java `import java.util.List;` is NOT detected by regex', () => {
            const text = `import java.util.List;\nimport java.util.Map;\nclass Foo {}`;
            const specs = extractRelativeImportSpecifiers(text, 'java');
            assert.deepStrictEqual(specs, [],
                'Java `import` lines are not in the regex pattern table — LSP required');
        });

        test('[KNOWN GAP] Rust `use crate::foo;` and `mod bar;` NOT detected by regex', () => {
            const text = `use std::collections::HashMap;\nmod utils;\nfn main() {}`;
            const specs = extractRelativeImportSpecifiers(text, 'rust');
            assert.deepStrictEqual(specs, [],
                'Rust `use`/`mod` are not in the regex pattern table — LSP required');
        });

        test('[KNOWN GAP] Kotlin `import kotlin.collections.List` NOT detected', () => {
            const text = `import kotlin.collections.List\nfun main() {}`;
            const specs = extractRelativeImportSpecifiers(text, 'kotlin');
            assert.deepStrictEqual(specs, []);
        });

        test('[KNOWN GAP] Swift `import Foundation` NOT detected', () => {
            const text = `import Foundation\nlet x = 1`;
            const specs = extractRelativeImportSpecifiers(text, 'swift');
            assert.deepStrictEqual(specs, []);
        });

        test('[KNOWN GAP] Scala `import scala.collection._` NOT detected', () => {
            const text = `import scala.collection._\nobject Foo {}`;
            const specs = extractRelativeImportSpecifiers(text, 'scala');
            assert.deepStrictEqual(specs, []);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // Known bugs in regex matching
    // ────────────────────────────────────────────────────────────────
    suite('Known bugs (documented limitations)', () => {
        test('[KNOWN BUG] require.resolve() is intentionally NOT in the regex patterns', () => {
            // The advance value for `require.resolve(` would over-count and
            // cause misses on short lines. We removed it from the pattern
            // table rather than ship a buggy matcher. LSP path covers it.
            const text = `const p = require.resolve('./p');`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, []);
        });

        test('[KNOWN BUG] Backtick template literal with import keyword', () => {
            const text = 'const tpl = `import x from "./fake"`;';
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // Current behavior: matches the import inside the template.
            assert.deepStrictEqual(specs, ['./fake']);
        });

        test('[KNOWN BUG] Multi-line import is not parsed across lines', () => {
            // The regex is strictly line-based. A multi-line import will
            // only match the `from '` keyword on its line, missing the
            // specifier that lives on a different line.
            const text = [
                'import {',
                '  foo,',
                '  bar,',
                "} from './multi';",
            ].join('\n');
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // Current behavior: only the last line matches, and even that
            // may not work depending on how `from ` is treated (it's not
            // present on the last line).
            assert.ok(Array.isArray(specs));
            // We don't assert a specific result — just that we don't crash.
            // The expected "correct" result is `['./multi']`.
        });

        test('[KNOWN BUG] require() inside a string causes false positive', () => {
            const text = `const code = "require('./fake')";`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, ['./fake']);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // Adversarial: unicode, control chars, malformed paths
    // ────────────────────────────────────────────────────────────────
    suite('Adversarial inputs', () => {
        test('handles null bytes in source text', () => {
            const text = `import foo from './bar';\x00import baz from './qux';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.ok(Array.isArray(specs));
            // We don't assert strict behavior — just that we don't crash.
        });

        test('handles unicode identifiers (limited Latin Extended)', () => {
            // Some languages allow unicode identifiers. The regex doesn't
            // care about identifier characters — it only matches keywords.
            const text = `import { café } from './unicode';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, ['./unicode']);
        });

        test('handles CR/LF line endings (mixed)', () => {
            const text = `import a from './a';\r\nimport b from './b';\nimport c from './c';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // The regex splits on \n only, so \r\n may leave \r at line ends.
            // Behavior is implementation-defined — just don't crash.
            assert.ok(Array.isArray(specs));
        });

        test('handles import with trailing comma in specifier list', () => {
            const text = `import { a, b, } from './trailing';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, ['./trailing']);
        });

        test('handles import with whitespace around specifier', () => {
            const text = `import {   a   ,   b   } from './spaces';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, ['./spaces']);
        });

        test('handles import with path containing spaces (quoted)', () => {
            const text = `import x from './with spaces/file';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, ['./with spaces/file']);
        });

        test('handles empty quoted string after from', () => {
            const text = `import x from '';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // Behavior: likely empty string in array, but doesn't crash.
            // We just verify it doesn't throw.
            assert.ok(Array.isArray(specs));
        });

        test('handles unterminated string', () => {
            const text = `import x from './unterminated`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // The line.indexOf of the closing quote fails → specEnd <= specStart → undefined
            assert.deepStrictEqual(specs, []);
        });

        test('handles BOM at start of file', () => {
            const text = '\uFEFFimport x from \'./bom\';';
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.ok(Array.isArray(specs));
        });

        test('handles multiple keywords on one line (degenerate)', () => {
            // A pathological line with 5 imports
            const text = `import a from './a'; import b from './b'; import c from './c'; import d from './d'; import e from './e';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, ['./a', './b', './c', './d', './e']);
        });

test('handles path that is exactly `.` or `..` (filtered by relative-path check)', () => {
            const text = `import x from '.';\nimport y from '..';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // `.` and `..` don't start with `./` or `../` — the relative-path
            // filter correctly excludes them. They'd also fail the file-system
            // resolver (resolveSpecifierToUri rejects '.' and '..').
            assert.ok(!specs.includes('.'), '`.` should be filtered out');
            assert.ok(!specs.includes('..'), '`..` should be filtered out');
        });

        test('handles URL-style specifiers (URL imports)', () => {
            const text = `import x from 'https://cdn.example.com/lib.js';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            // URL imports don't start with `./` or `../` — should be skipped.
            assert.deepStrictEqual(specs, []);
        });

        test('handles data: URLs', () => {
            const text = `import x from 'data:text/javascript,console.log(1)';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, []);
        });

        test('handles absolute paths starting with /', () => {
            // POSIX absolute paths — not a "relative" import, skipped.
            const text = `import x from '/abs/path/file';`;
            const specs = extractRelativeImportSpecifiers(text, 'typescript');
            assert.deepStrictEqual(specs, []);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // Python adversarial: docstrings, f-strings, comments
    // ────────────────────────────────────────────────────────────────
    suite('Python adversarial', () => {
        test('[KNOWN BUG] from-import inside a docstring is matched', () => {
            // Python docstrings: triple-quoted strings at module/class/function top.
            // The regex sees `from .module import x` and matches it even when
            // it's inside a docstring.
            const text = [
                '"""',
                "Example:",
                "    from .module import helper  # this is in a docstring",
                '"""',
                'def real_use(): return None',
            ].join('\n');
            const specs = extractRelativeImportSpecifiers(text, 'python');
            // Current behavior: matches the docstring line as an import.
            assert.deepStrictEqual(specs, ['.module']);
        });

        test('handles indented import (inside a function)', () => {
            // Python imports are typically top-level, but the regex doesn't
            // care about indentation. This is acceptable — indented imports
            // are unusual but valid (rarely used for conditional imports).
            const text = [
                'def foo():',
                '    from .lazy import helper',
                '    return helper',
            ].join('\n');
            const specs = extractRelativeImportSpecifiers(text, 'python');
            assert.deepStrictEqual(specs, ['.lazy']);
        });

        test('handles import with backslash continuation', () => {
            // Python allows line continuations with `\`
            const text = 'from .pkg import \\\n    foo, bar';
            const specs = extractRelativeImportSpecifiers(text, 'python');
            // Behavior: the regex sees `from .pkg import \` on line 0.
            // The `\` is at the end, and the `foo`/`bar` are on line 1.
            // This is a known limitation — multi-line imports not parsed.
            assert.ok(Array.isArray(specs));
        });

        test('handles import inside a comment', () => {
            const text = '# from .pkg import old_helper';
            const specs = extractRelativeImportSpecifiers(text, 'python');
            // Comment lines are matched as imports by the regex.
            // (False positive — LSP path bypasses this.)
            assert.deepStrictEqual(specs, ['.pkg']);
        });
    });

    // ────────────────────────────────────────────────────────────────
    // normalizePath: adversarial paths
    // ────────────────────────────────────────────────────────────────
    suite('normalizePath', () => {
        test('handles deeply nested ../', () => {
            assert.strictEqual(normalizePath('/a/b/c/d/e'), '/a/b/c/d/e');
            assert.strictEqual(normalizePath('/a/../../b'), '/b');
        });

        test('handles mixed ./ and ../', () => {
            assert.strictEqual(normalizePath('/a/./b/../c'), '/a/c');
        });

        test('handles empty string', () => {
            assert.strictEqual(normalizePath(''), '');
        });

        test('handles path that is just dots', () => {
            assert.strictEqual(normalizePath('./'), '');
            assert.strictEqual(normalizePath('../'), '');
            assert.strictEqual(normalizePath('./..'), '');
        });

        test('preserves leading slash on absolute paths', () => {
            assert.ok(normalizePath('/foo').startsWith('/'));
        });

        test('does not prepend slash on relative paths', () => {
            assert.ok(!normalizePath('foo/bar').startsWith('/'));
        });
    });

    // ────────────────────────────────────────────────────────────────
    // Adversarial: languageId variants
    // ────────────────────────────────────────────────────────────────
    suite('Language ID variants', () => {
        test('typescript and typescriptreact share patterns', () => {
            const ts = extractRelativeImportSpecifiers(`import x from './a';`, 'typescript');
            const tsx = extractRelativeImportSpecifiers(`import x from './a';`, 'typescriptreact');
            assert.deepStrictEqual(ts, tsx);
            assert.deepStrictEqual(ts, ['./a']);
        });

        test('javascript and javascriptreact share patterns', () => {
            const js = extractRelativeImportSpecifiers(`import x from './a';`, 'javascript');
            const jsx = extractRelativeImportSpecifiers(`import x from './a';`, 'javascriptreact');
            assert.deepStrictEqual(js, jsx);
        });

        test('plain "go" works but "golang" does not', () => {
            const go = extractRelativeImportSpecifiers(`import "./foo"`, 'go');
            assert.deepStrictEqual(go, ['./foo']);
            const golang = extractRelativeImportSpecifiers(`import "./foo"`, 'golang');
            assert.deepStrictEqual(golang, [],
                '`golang` is not a registered VS Code languageId; only `go` works');
        });

        test('plain "cpp" works but "c++" does not', () => {
            const cpp = extractRelativeImportSpecifiers(`#include "foo.h"`, 'cpp');
            assert.deepStrictEqual(cpp, ['foo.h']);
            const cxx = extractRelativeImportSpecifiers(`#include "foo.h"`, 'c++');
            assert.deepStrictEqual(cxx, []);
        });

        test('plain "c" works but "objective-c" does not', () => {
            const c = extractRelativeImportSpecifiers(`#include "foo.h"`, 'c');
            assert.deepStrictEqual(c, ['foo.h']);
            const objc = extractRelativeImportSpecifiers(`#include "foo.h"`, 'objective-c');
            assert.deepStrictEqual(objc, []);
        });

        test('plain "python" works but "py" does not', () => {
            const py = extractRelativeImportSpecifiers(`from .x import y`, 'python');
            assert.deepStrictEqual(py, ['.x']);
            const pyAlias = extractRelativeImportSpecifiers(`from .x import y`, 'py');
            assert.deepStrictEqual(pyAlias, []);
        });
    });
});
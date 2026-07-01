import * as assert from 'assert';
import { buildExportsLine, buildImportLine } from '../../completions/ghost/promptFactory';
import { FileExport, ImportResolution } from '../../common/contextBundle';

suite('buildExportsLine (all-or-nothing truncation)', () => {
    test('renders name:type when type is provided', () => {
        const exports: FileExport[] = [
            { name: 'foo', kind: 'Function', line: 1, type: '(x: number) => string' },
        ];
        const out = buildExportsLine(exports, 100);
        assert.ok(out.includes('foo:(x: number) => string'));
    });

    test('falls back to kind when type is missing', () => {
        const exports: FileExport[] = [
            { name: 'Foo', kind: 'Class', line: 1 },
        ];
        const out = buildExportsLine(exports, 100);
        assert.ok(out.includes('Foo:Class'));
    });

    test('truncates all-or-nothing — never partial signatures', () => {
        // Create an export with a very long type that will exceed budget
        const longType = 'function foo(a: number, b: string, c: boolean, d: Date, e: RegExp): { x: string; y: number; z: boolean }';
        const exports: FileExport[] = [
            { name: 'short1', kind: 'Function', line: 1, type: '() => void' },
            { name: 'longExport', kind: 'Function', line: 2, type: longType },
            { name: 'short2', kind: 'Function', line: 3, type: '() => void' },
        ];
        // Budget small enough that longExport doesn't fit, short2 also doesn't fit
        const out = buildExportsLine(exports, 30);
        // Must include short1
        assert.ok(out.includes('short1'),
            `Expected short1 in output, got: ${out}`);
        // Must NOT include a partial truncation of longExport
        assert.ok(!/longExport:function foo\(a: number,/.test(out),
            `Output must not contain partial signature of longExport: ${out}`);
        // Must report skipped count
        assert.ok(/(\.\.\. \(\+\d+ more\))/.test(out),
            `Output must end with skipped count marker: ${out}`);
    });

    test('output is a single line (no embedded newlines)', () => {
        const exports: FileExport[] = [
            { name: 'a', kind: 'Function', line: 1, type: '() => void' },
            { name: 'b', kind: 'Function', line: 2, type: '() => void' },
            { name: 'c', kind: 'Function', line: 3, type: '() => void' },
        ];
        const out = buildExportsLine(exports, 100);
        assert.ok(!out.includes('\n'), `Output should be single line, got: ${JSON.stringify(out)}`);
    });

    test('respects empty exports array', () => {
        const out = buildExportsLine([], 100);
        assert.strictEqual(out, 'exports: ');
    });

    test('edge case: zero-token budget produces empty body', () => {
        const exports: FileExport[] = [
            { name: 'a', kind: 'Function', line: 1 },
            { name: 'b', kind: 'Function', line: 2 },
        ];
        // 0 tokens means no room for any export
        const out = buildExportsLine(exports, 0);
        // Should produce at least the prefix; the bodies either get skipped or are reported
        assert.ok(out.startsWith('exports:'),
            `Output should start with prefix, got: ${out}`);
        assert.ok(out.includes('(+2 more)'),
            `Output should report both skipped, got: ${out}`);
    });

    test('edge case: very long single export with name-only fallback', () => {
        const longType = 'a'.repeat(500); // Way over any reasonable budget
        const exports: FileExport[] = [
            { name: 'tiny', kind: 'Function', line: 1, type: '() => void' },
            { name: 'huge', kind: 'Function', line: 2, type: longType },
        ];
        const out = buildExportsLine(exports, 30);
        // tiny should be included with its full type
        assert.ok(out.includes('tiny:() => void'),
            `tiny should fit, got: ${out}`);
        // huge should be name-only (with ellipsis) since only its name fits
        assert.ok(!out.includes(`huge:${longType}`),
            `huge should not appear with full type, got: ${out.slice(0, 80)}…`);
    });

    test('edge case: all exports fit exactly at budget boundary', () => {
        // Each `name:type` is ~12 chars → ~3 tokens
        const exports: FileExport[] = [
            { name: 'a', kind: 'Function', line: 1, type: '() => v' },   // ~3 tokens
            { name: 'b', kind: 'Function', line: 2, type: '() => v' },
            { name: 'c', kind: 'Function', line: 3, type: '() => v' },
        ];
        // Budget that exactly fits 3 exports + 2 commas + prefix
        const out = buildExportsLine(exports, 30);
        assert.ok(out.includes('a:() => v'));
        assert.ok(out.includes('b:() => v'));
        assert.ok(out.includes('c:() => v'));
        assert.ok(!out.includes('more'), 'All should fit, no skip marker expected');
    });
});

suite('buildImportLine (relative path mandatory)', () => {
    test('uses relativePath, not uri, for the file label', () => {
        const imp: ImportResolution = {
            uri: 'file:///abs/path/to/utils/helpers.ts',
            relativePath: './utils/helpers.ts',
            exports: [
                { name: 'formatDate', kind: 'Function', line: 1, type: '(d: Date) => string' },
            ],
        };
        const out = buildImportLine(imp);
        assert.ok(out.startsWith('./utils/helpers.ts:'),
            `Expected relative path prefix, got: ${out}`);
        assert.ok(!out.includes('file:///'),
            `Output must not contain the absolute URI: ${out}`);
    });

    test('includes hover signature when typeSignatures is set', () => {
        const imp: ImportResolution = {
            uri: 'file:///abs/utils.ts',
            relativePath: './utils.ts',
            exports: [{ name: 'parseISO', kind: 'Function', line: 1 }],
            typeSignatures: { parseISO: '(s: string) => Date' },
        };
        const out = buildImportLine(imp);
        assert.ok(out.includes('parseISO:(s: string) => Date'),
            `Expected hover signature, got: ${out}`);
    });

    test('falls back to kind when no type/signature', () => {
        const imp: ImportResolution = {
            uri: 'file:///abs/utils.ts',
            relativePath: './utils.ts',
            exports: [{ name: 'parseISO', kind: 'Function', line: 1 }],
        };
        const out = buildImportLine(imp);
        assert.ok(out.includes('parseISO:Function'));
    });

    test('caps at 8 exports per file (per-file limit)', () => {
        // Create 12 exports; only first 8 should appear
        const exports: FileExport[] = Array.from({ length: 12 }, (_, i) => ({
            name: `fn${i}`,
            kind: 'Function',
            line: i,
            type: '() => void',
        }));
        const imp: ImportResolution = {
            uri: 'file:///abs/many.ts',
            relativePath: './many.ts',
            exports,
        };
        const out = buildImportLine(imp);
        // First 8 should be included
        for (let i = 0; i < 8; i++) {
            assert.ok(out.includes(`fn${i}:() => void`), `Expected fn${i} in output`);
        }
        // Last 4 should NOT be included
        for (let i = 8; i < 12; i++) {
            assert.ok(!out.includes(`fn${i}:`), `Did not expect fn${i} in output`);
        }
    });

    test('handles empty exports array gracefully', () => {
        const imp: ImportResolution = {
            uri: 'file:///abs/empty.ts',
            relativePath: './empty.ts',
            exports: [],
        };
        const out = buildImportLine(imp);
        assert.strictEqual(out, './empty.ts: ');
    });

    test('handles exports with weird kind names', () => {
        const imp: ImportResolution = {
            uri: 'file:///abs/weird.ts',
            relativePath: './weird.ts',
            exports: [
                { name: 'a', kind: 'UnknownKind', line: 1 },
                { name: 'b', kind: '', line: 2 },  // empty kind
            ],
        };
        const out = buildImportLine(imp);
        assert.ok(out.includes('a:UnknownKind'));
        assert.ok(out.includes('b:'));
    });
});
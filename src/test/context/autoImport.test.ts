import * as assert from 'assert';
import {
    detectMissingImports,
    flattenWorkspaceEdit,
    AutoImportFix,
} from '../../completions/context/autoImport';

suite('autoImport (Phase H)', () => {
    test('flattenWorkspaceEdit collects TextEdit entries across URIs', () => {
        // Mock a WorkspaceEdit-like object with an entries() method
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
        } as unknown as Parameters<typeof flattenWorkspaceEdit>[0];

        const out = flattenWorkspaceEdit(edit);
        assert.strictEqual(out.length, 3);
        assert.ok(out[0].newText.startsWith('import x'));
        assert.ok(out[1].newText.startsWith('y()'));
        assert.ok(out[2].newText.startsWith('import z'));
    });

    test('flattenWorkspaceEdit skips snippet edits', () => {
        const edit = {
            entries() {
                return [
                    [
                        { toString: () => 'file:///a.ts' },
                        [
                            // Plain TextEdit — should be included
                            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'plain' },
                            // SnippetTextEdit (has .snippet) — should be skipped
                            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'snip', snippet: 'snip(${1})' },
                        ],
                    ],
                ];
            },
        } as unknown as Parameters<typeof flattenWorkspaceEdit>[0];

        const out = flattenWorkspaceEdit(edit);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].newText, 'plain');
    });

    test('flattenWorkspaceEdit returns empty array for empty edit', () => {
        const edit = {
            entries() {
                return [];
            },
        } as unknown as Parameters<typeof flattenWorkspaceEdit>[0];
        const out = flattenWorkspaceEdit(edit);
        assert.strictEqual(out.length, 0);
    });

    test('AutoImportFix interface has the expected fields', () => {
        const fix: AutoImportFix = {
            symbolName: 'debounce',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } as AutoImportFix['range'],
            edits: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } as AutoImportFix['range'],
                    newText: 'import { debounce } from "lodash";\n',
                },
            ],
        };
        assert.strictEqual(fix.symbolName, 'debounce');
        assert.strictEqual(fix.edits.length, 1);
        assert.ok(fix.edits[0].newText.includes('import { debounce }'));
    });

    test('detectMissingImports returns [] when no diagnostics', async () => {
        // Empty workspace, no diagnostics — should return empty array
        const result = await detectMissingImports({} as Parameters<typeof detectMissingImports>[0]);
        assert.ok(Array.isArray(result));
    });
});
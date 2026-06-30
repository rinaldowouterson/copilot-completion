import * as assert from 'assert';
import * as vscode from 'vscode';
import { InlineSuggestionResolver } from '../../../completions/nes/core/inlineSuggestionResolver';

/** Minimal mock TextDocument sufficient for InlineSuggestionResolver tests */
function mockDoc(lines: string[]): vscode.TextDocument {
    const content = lines.join('\n');
    const doc = {
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
            const startOff = doc.offsetAt(range.start);
            const endOff = doc.offsetAt(range.end);
            return content.substring(startOff, endOff);
        },
    } as unknown as vscode.TextDocument;
    return doc;
}

suite('InlineSuggestionResolver', () => {
    const resolver = new InlineSuggestionResolver();

    test('returns undefined when range spans multiple lines after strip', () => {
        const doc = mockDoc([
            'function foo() {',
            '    return 1;',
            '    // extra',
            '}',
        ]);
        const range = new vscode.Range(0, 0, 3, 1);
        const newText = 'function foo() {\n    return 2;\n    // extra\n}';
        const result = resolver.resolve(new vscode.Position(0, 16), doc, range, newText);
        assert.strictEqual(result, undefined);
    });

    test('returns adjusted range for same-line ghost text at cursor', () => {
        const doc = mockDoc(['const x = Math.|']);
        const cursorPos = new vscode.Position(0, 14);
        const range = new vscode.Range(0, 14, 0, 14);
        const newText = 'Math.max(1, 2)';
        const result = resolver.resolve(cursorPos, doc, range, newText);
        assert.ok(result);
        assert.strictEqual(result.newText, 'Math.max(1, 2)');
        assert.strictEqual(result.range.start.character, 14);
    });

    test('returns undefined when cursor is before range start', () => {
        const doc = mockDoc(['const x = oldValue;']);
        const range = new vscode.Range(0, 10, 0, 18);
        const newText = 'newValue';
        const result = resolver.resolve(new vscode.Position(0, 5), doc, range, newText);
        assert.strictEqual(result, undefined);
    });

    test('returns undefined when prefix before cursor does not match', () => {
        const doc = mockDoc(['prefixXYZsuffix']);
        const range = new vscode.Range(0, 6, 0, 9);
        const newText = 'ABC';
        const result = resolver.resolve(new vscode.Position(0, 7), doc, range, newText);
        assert.strictEqual(result, undefined);
    });

    test('strips common line prefix for multi-line edit but returns undefined (no multi-line ghost text)', () => {
        const doc = mockDoc([
            'line1: same prefix',
            'line2: same prefix but different end',
            'line3: different',
        ]);
        const range = new vscode.Range(0, 0, 2, 18);
        const newText = [
            'line1: same prefix',
            'line2: same prefix with changes',
            'line3: different',
        ].join('\n');
        const result = resolver.resolve(new vscode.Position(1, 31), doc, range, newText);
        // InlineSuggestionResolver rejects multi-line edits — only same-line
        // ghost text is supported. The strip itself works, but the resolver
        // returns undefined because the stripped range still spans multiple lines.
        assert.strictEqual(result, undefined);
    });

    test('handles next-line insertion rewrite', () => {
        const doc = mockDoc(['const a = 1', '']);
        const cursorPos = new vscode.Position(0, 11);
        const range = new vscode.Range(1, 0, 1, 0);
        const newText = 'const b = 2;\n';
        const result = resolver.resolve(cursorPos, doc, range, newText);
        assert.ok(result);
        assert.strictEqual(result.range.start.line, 0);
        assert.strictEqual(result.range.start.character, 11);
        assert.ok(result.newText.includes('const b = 2;'));
    });

    test('isSubword returns true for subsequence', () => {
        assert.strictEqual(InlineSuggestionResolver.isSubword('abc', 'axbyc'), true);
        assert.strictEqual(InlineSuggestionResolver.isSubword('abc', 'abc'), true);
    });

    test('isSubword returns false for non-subsequence', () => {
        assert.strictEqual(InlineSuggestionResolver.isSubword('abc', 'def'), false);
        assert.strictEqual(InlineSuggestionResolver.isSubword('ab', 'ba'), false);
    });
});

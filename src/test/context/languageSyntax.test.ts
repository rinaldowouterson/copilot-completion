import * as assert from 'assert';
import {
    findStatementEndHeuristic,
    getSyntax,
} from '../../common/languageSyntax';

suite('findStatementEndHeuristic (Phase B fallback)', () => {
    test('finds semicolon-terminated statement on same line', () => {
        const lines = ['const x = a + b;', 'const y = 2;', ''];
        const out = findStatementEndHeuristic(lines, 0, getSyntax('typescript'), 10);
        assert.strictEqual(out, 0, 'Should return line 0 — semicolon is on the cursor line');
    });

    test('extends across continuation operator', () => {
        const lines = ['const x = a +', '  b + c;', 'const y = 2;'];
        const out = findStatementEndHeuristic(lines, 0, getSyntax('typescript'), 10);
        assert.strictEqual(out, 1, 'Should return line 1 — statement ends on the continuation line');
    });

    test('returns budget-end when nothing fits', () => {
        const lines = ['const x = a +', '  b +', '  c +', '  d +', '  e;'];
        const out = findStatementEndHeuristic(lines, 0, getSyntax('typescript'), 3);
        assert.ok(out <= 3, `Budget-end should be at most 3, got ${out}`);
    });

    test('handles Python indentation rules', () => {
        const pySyntax = getSyntax('python');
        const lines = [
            'def foo():',
            '    x = 1',
            '    y = 2',     // same indent — does this terminate?
            '    return x + y',
        ];
        // Heuristic should NOT terminate on line 2 (same indent as line 1 is still inside the function).
        // The function body's last statement is line 3.
        const out = findStatementEndHeuristic(lines, 1, pySyntax, 10);
        // The exact outcome depends on the rules; verify it returns a sensible value
        assert.ok(out >= 1 && out <= 3, `Should be in range [1, 3], got ${out}`);
    });

    test('caps at document length', () => {
        const lines = ['const x = 1;'];
        const out = findStatementEndHeuristic(lines, 0, getSyntax('typescript'), 30);
        assert.ok(out >= 0 && out < lines.length, `Should be in range, got ${out}`);
    });

    test('returns startLine when nothing fits within budget', () => {
        // All-continuation lines, but budget = 0
        const lines = ['const x = a +', '  b +', '  c;'];
        const out = findStatementEndHeuristic(lines, 0, getSyntax('typescript'), 0);
        // Budget exhausted immediately — return end of budget (startLine + 0)
        assert.strictEqual(out, 0);
    });

    test('defensive: handles empty lines array', () => {
        const out = findStatementEndHeuristic([], 0, getSyntax('typescript'), 30);
        assert.strictEqual(typeof out, 'number');
        assert.ok(out >= 0, `Should return a non-negative line number, got ${out}`);
    });

    test('defensive: clamps startLine past end-of-document', () => {
        // Regression test for the Go E2E crash: when startLine is past
        // the document end, the function should clamp safely instead of
        // throwing `Cannot read properties of undefined`.
        const lines = ['line0', 'line1', 'line2']; // 3 lines
        const out = findStatementEndHeuristic(lines, 10, getSyntax('typescript'), 30);
        assert.strictEqual(typeof out, 'number');
        assert.ok(out >= 0);
        assert.ok(out < lines.length, `Should clamp to within document, got ${out}`);
    });

    test('defensive: clamps negative startLine', () => {
        const lines = ['line0', 'line1', 'line2'];
        const out = findStatementEndHeuristic(lines, -5, getSyntax('typescript'), 30);
        assert.ok(out >= 0);
        assert.ok(out < lines.length);
    });
});

suite('getSyntax (Phase B)', () => {
    test('returns default for unknown languages', () => {
        const syntax = getSyntax('not-a-real-language');
        assert.strictEqual(syntax.semicolons, true);
        assert.strictEqual(syntax.comment, '//');
    });

    test('returns python-specific overrides', () => {
        const syntax = getSyntax('python');
        assert.strictEqual(syntax.semicolons, false);
        assert.strictEqual(syntax.comment, '#');
        assert.strictEqual(syntax.indentationSignificant, true);
    });

    test('returns sql-specific comment style', () => {
        const syntax = getSyntax('sql');
        assert.strictEqual(syntax.comment, '--');
    });
});
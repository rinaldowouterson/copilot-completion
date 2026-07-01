import * as assert from 'assert';
import { cleanHoverSignature } from '../../completions/context/hoverEnrichment';

suite('cleanHoverSignature (Phase C)', () => {
    test('strips triple-backtick code fences', () => {
        const raw = '```ts\nfunction foo(x: number): string { return ""; }\n```';
        const out = cleanHoverSignature(raw);
        assert.ok(!out.includes('```'), `Output should not contain fences, got: ${out}`);
        assert.ok(out.includes('function foo'), 'Output should retain function body');
        assert.ok(out.includes('number'), 'Output should retain parameter type');
    });

    test('collapses multi-line to single line', () => {
        const raw = 'function foo(\n  x: number,\n  y: string,\n): boolean';
        const out = cleanHoverSignature(raw);
        assert.ok(!out.includes('\n'), `Output should be single line, got: ${out}`);
        assert.ok(out.includes(' '), 'Output should contain whitespace separators');
    });

    test('returns empty string for whitespace-only input', () => {
        const out = cleanHoverSignature('   \n\t  \n');
        assert.strictEqual(out, '');
    });

    test('returns empty string for code-fence-only input', () => {
        const out = cleanHoverSignature('```ts\n```');
        assert.strictEqual(out, '');
    });

    test('truncates long signatures with ellipsis', () => {
        const raw = 'function veryLongFunctionName(' + 'a: number, '.repeat(50) + '): void';
        const out = cleanHoverSignature(raw);
        assert.ok(out.endsWith('…'), `Expected truncation with ellipsis, got: ${out.slice(-20)}`);
        // Verify the truncation occurred (output is shorter than input)
        assert.ok(out.length < raw.length);
    });

    test('preserves short signatures unchanged (except whitespace)', () => {
        const raw = 'const x: number';
        const out = cleanHoverSignature(raw);
        assert.strictEqual(out, 'const x: number');
    });

    test('handles strings without fences', () => {
        const raw = 'class Foo { bar(): string { return ""; } }';
        const out = cleanHoverSignature(raw);
        assert.strictEqual(out, 'class Foo { bar(): string { return ""; } }');
    });
});
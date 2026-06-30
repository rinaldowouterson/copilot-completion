import * as assert from 'assert';
import { heuristicIsEmptyBlock } from '../../../completions/ghost/multiline/emptyBlockHeuristic';

suite('heuristicIsEmptyBlock', () => {

    // ── True: empty block cases ────────────────────────────────

    test('function with empty body, cursor on blank line inside', () => {
        const text = 'function foo() {\n  \n}';
        // '{' is at index 15. Cursor after the newline = index 17
        const offset = 17; // after '{\n'
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('function with empty body, cursor immediately after {', () => {
        const text = 'function foo() {\n}';
        const offset = 16; // right after '{'
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('if block with empty body', () => {
        const text = 'if (true) {\n  \n}';
        const offset = text.indexOf('{') + 1; // after '{'
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('for loop with empty body', () => {
        const text = 'for (let i = 0; i < n; i++) {\n  \n}';
        const offset = text.indexOf('{') + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('while loop with empty body', () => {
        const text = 'while (condition) {\n  \n}';
        const offset = text.indexOf('{') + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('try with empty body', () => {
        const text = 'try {\n  \n} catch {\n  \n}';
        const tryOffset = text.indexOf('{') + 1; // try's '{'
        assert.strictEqual(heuristicIsEmptyBlock(text, tryOffset), true);
    });

    test('object literal with empty body (acceptable false positive)', () => {
        const text = 'const obj = {\n  \n};';
        const offset = text.indexOf('{') + 1;
        // This is technically an object literal, not a block statement,
        // but multi-line completion here is still useful (completing object props).
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('cursor on same line as opening brace, empty block', () => {
        const text = 'if (x) { }';
        const offset = text.indexOf('{') + 1; // right after '{', before ' }'
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('arrow function with empty block body', () => {
        const text = 'const fn = () => {\n  \n};';
        const offset = text.indexOf('{') + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    // ── False: non-empty block cases ───────────────────────────

    test('function with code inside', () => {
        const text = 'function foo() {\n  return 1;\n}';
        const offset = text.indexOf('{') + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), false);
    });

    test('if block with code inside', () => {
        const text = 'if (x) {\n  console.log("hi");\n}';
        const offset = text.indexOf('{') + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), false);
    });

    test('nested blocks: outer empty but inner not at cursor', () => {
        const text = 'function outer() {\n  if (x) { return 1; }\n}';
        // Cursor at start of outer function body
        const outerOffset = text.indexOf('{') + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, outerOffset), false);
    });

    test('cursor not at a block (just text)', () => {
        const text = 'const x = 1;\nconst y = 2;';
        assert.strictEqual(heuristicIsEmptyBlock(text, 5), false);
    });

    test('cursor at end of non-block line', () => {
        const text = 'const x = 1;';
        const offset = text.length;
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), false);
    });

    test('cursor at very start of file', () => {
        const text = 'function foo() {\n}';
        assert.strictEqual(heuristicIsEmptyBlock(text, 0), false);
    });

    test('no braces at all in file', () => {
        const text = 'const x = 1;\nconst y = 2;\nconsole.log(x + y);';
        assert.strictEqual(heuristicIsEmptyBlock(text, 10), false);
    });

    // ── Edge cases ─────────────────────────────────────────────

    test('cursor inside a class method that has content', () => {
        const text = 'class Foo {\n  bar() {\n    return 1;\n  }\n}';
        // Cursor inside bar() body, which has content
        const barBodyOpen = text.indexOf('{', text.indexOf('bar()')) + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, barBodyOpen), false);
    });

    test('cursor inside a class method that is empty', () => {
        const text = 'class Foo {\n  bar() {\n    // TODO\n  }\n}';
        // bar() body has a comment — that's content
        const barBodyOpen = text.indexOf('{', text.indexOf('bar()')) + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, barBodyOpen), false);
    });

    test('empty string returns false', () => {
        assert.strictEqual(heuristicIsEmptyBlock('', 0), false);
    });

    test('negative offset returns false', () => {
        assert.strictEqual(heuristicIsEmptyBlock('{}', -1), false);
    });

    test('offset beyond text length returns false', () => {
        assert.strictEqual(heuristicIsEmptyBlock('{}', 10), false);
    });

    test('template literal with expression (acceptable false positive)', () => {
        const text = 'const str = `${}`';
        const offset = text.indexOf('{', text.indexOf('$')) + 1;
        // The heuristic doesn't understand template expressions vs blocks.
        // This is an acceptable limitation — rare edge case.
        assert.strictEqual(heuristicIsEmptyBlock(text, offset), true);
    });

    test('nested empty block with cursor at outer block', () => {
        // Cursor at outer function body. Inner has an empty if block.
        const text = 'function foo() {\n  if (x) {\n  }\n}';
        const outerOffset = text.indexOf('{') + 1;
        // Outer body contains "if (x) { }" which is non-whitespace
        assert.strictEqual(heuristicIsEmptyBlock(text, outerOffset), false);
    });

    test('nested empty block with cursor at inner block', () => {
        const text = 'function foo() {\n  if (x) {\n    \n  }\n}';
        // Find the inner '{' (the if-block)
        const outerOpen = text.indexOf('{');
        const innerOpen = text.indexOf('{', outerOpen + 1) + 1;
        assert.strictEqual(heuristicIsEmptyBlock(text, innerOpen), true);
    });

    test('cursor at closing brace of empty block (acceptable — block is empty)', () => {
        const text = 'function foo() { }';
        const closeBrace = text.indexOf('}');
        // The heuristic sees the empty block { } and returns true.
        // This is acceptable — in practice the cursor won't be at '}'
        // when requesting a completion.
        assert.strictEqual(heuristicIsEmptyBlock(text, closeBrace), true);
    });

    test('cursor inside non-block parentheses', () => {
        const text = 'if (x) { }';
        // Cursor inside the condition parentheses, not the block
        const parenOpen = text.indexOf('(');
        const parenClose = text.indexOf(')');
        // offset between ( and )
        const midParen = parenOpen + Math.floor((parenClose - parenOpen) / 2);
        assert.strictEqual(heuristicIsEmptyBlock(text, midParen), false);
    });
});

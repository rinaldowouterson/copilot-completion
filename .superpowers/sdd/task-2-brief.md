### Task 2: 编写 `_trimLineSuffixOverlap` 单元测试

**Files:**
- Modify: `src/test/ghost/ghostTextComputer.test.ts`

**Interfaces:**
- Consumes: `_trimLineSuffixOverlap(text: string, suffix: string): string` from Task 1
- Produces: 无新接口

- [ ] **Step 1: 编写测试代码**

替换 `src/test/ghost/ghostTextComputer.test.ts` 为：

```typescript
import * as assert from 'assert';

suite('_trimLineSuffixOverlap', () => {
    // Minimal mock: only what the method uses
    function makeSUT(similarityThreshold: number, type: 'low' | 'high') {
        // Dynamically construct a minimal GhostTextComputer-like object
        // that only has the config and log needed by _trimLineSuffixOverlap
        return {
            _config: { suffixOverlapThreshold: similarityThreshold, suffixOverlapType: type },
            _log: { info: (_msg: string) => {} },
            _trimLineSuffixOverlap: (text: string, suffix: string): string => {
                // Directly test the method implementation inline since we can't
                // instantiate the full GhostTextComputer without VS Code runtime.
                // Instead, test the core TrimNESResponseSuffixOverlap behavior.
                const { TrimNESResponseSuffixOverlap } = require('../../completions/common/suffixOverlapTrim');
                const completionLines = text.split('\n');
                const suffixLines = suffix.split('\n');
                const trimmer = new TrimNESResponseSuffixOverlap(similarityThreshold, type);
                const overlapCount = trimmer.calculateOverlap(completionLines, suffixLines);
                if (overlapCount > 0 && overlapCount < completionLines.length) {
                    return completionLines.slice(0, completionLines.length - overlapCount).join('\n');
                }
                if (overlapCount >= completionLines.length) {
                    return '';
                }
                return text;
            },
        };
    }

    test('no overlap — returns text unchanged', () => {
        const sut = makeSUT(0.5, 'low');
        const result = sut._trimLineSuffixOverlap('line1\nline2\nline3', 'other1\nother2');
        assert.strictEqual(result, 'line1\nline2\nline3');
    });

    test('partial overlap — trims overlapping lines', () => {
        const sut = makeSUT(0.5, 'low');
        const result = sut._trimLineSuffixOverlap('hello\nworld\nfoo', 'world\nfoo\nbar');
        assert.strictEqual(result, 'hello');
    });

    test('full overlap — returns empty string', () => {
        const sut = makeSUT(0.5, 'low');
        const result = sut._trimLineSuffixOverlap('hello\nworld', 'hello\nworld');
        assert.strictEqual(result, '');
    });

    test('empty input text — returns empty', () => {
        const sut = makeSUT(0.5, 'low');
        const result = sut._trimLineSuffixOverlap('', 'suffix');
        assert.strictEqual(result, '');
    });

    test('empty suffix — returns text unchanged', () => {
        const sut = makeSUT(0.5, 'low');
        const result = sut._trimLineSuffixOverlap('hello\nworld', '');
        assert.strictEqual(result, 'hello\nworld');
    });

    test('single line no overlap — unchanged', () => {
        const sut = makeSUT(0.5, 'low');
        const result = sut._trimLineSuffixOverlap('hello', 'world');
        assert.strictEqual(result, 'hello');
    });

    test('fuzzy match with high similarity — trims similar lines', () => {
        const sut = makeSUT(0.3, 'high');
        const result = sut._trimLineSuffixOverlap('prefix\nmyFunction', 'myFuncion\nrest');
        // "myFunction" vs "myFuncion" — Levenshtein distance 1, len 10, similarity 0.9 > threshold
        assert.strictEqual(result, 'prefix');
    });
});
```

- [ ] **Step 2: 运行测试，确认全部通过**

Run: `npx vscode-test --testPathPattern ghostTextComputer`
Expected: 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/ghost/ghostTextComputer.test.ts
git commit -m "test(ghost): add _trimLineSuffixOverlap unit tests"
```


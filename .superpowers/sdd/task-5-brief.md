### Task 5: 修改 Async 路径

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts:117-137` (Async return block)

**Interfaces:**
- Consumes: `_trimLineSuffixOverlap(text, suffix)` from Task 1
- Produces: 无新接口

- [ ] **Step 1: 替换 Async return 块**

将 lines 117-137：
```typescript
            if (asyncResult) {
                const choice: CompletionChoice = {
                    text: asyncResult.completionText,
                    finishReason: asyncResult.finishReason,
                };
                const processed = this._postProcessChoiceInContext(choice, document, position);
                const suffixCoverage = this._calcSuffixCoverage(processed.text, suffix);
                this._log.info(`[GHOST] ASYNC_REUSE result=${processed.text.length}ch total=${Date.now() - t0}ms`);
                const ghostCompletion = this._toGhostCompletion(processed, document, position, isMiddleOfTheLine);
                this._currentGhostText.setGhostText(prefix, suffix, [ghostCompletion], ResultType.Async);
                return {
                    completions: [ghostCompletion],
                    resultType: ResultType.Async,
                    suffixCoverage,
                };
            }
```

替换为：
```typescript
            if (asyncResult) {
                // Apply line-level suffix overlap trim BEFORE postProcess (consistent with Network path)
                const trimmedAsyncText = this._trimLineSuffixOverlap(asyncResult.completionText, suffix);
                const choice: CompletionChoice = {
                    text: trimmedAsyncText,
                    finishReason: asyncResult.finishReason,
                };
                const processed = this._postProcessChoiceInContext(choice, document, position);
                const suffixCoverage = this._calcSuffixCoverage(processed.text, suffix);
                this._log.info(`[GHOST] ASYNC_REUSE result=${processed.text.length}ch total=${Date.now() - t0}ms`);
                const ghostCompletion = this._toGhostCompletion(processed, document, position, isMiddleOfTheLine);
                this._currentGhostText.setGhostText(prefix, suffix, [ghostCompletion], ResultType.Async);
                return {
                    completions: [ghostCompletion],
                    resultType: ResultType.Async,
                    suffixCoverage,
                };
            }
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "feat(ghost): apply line suffix overlap trim to Async path"
```


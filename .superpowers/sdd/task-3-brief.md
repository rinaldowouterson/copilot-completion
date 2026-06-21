### Task 3: 修改 TypingAsSuggested 路径

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts:85-96` (TypingAsSuggested return block)

**Interfaces:**
- Consumes: `_trimLineSuffixOverlap(text, suffix)` from Task 1
- Produces: 无新接口（修改现有 return 语句）

- [ ] **Step 1: 替换 TypingAsSuggested return 块**

将 lines 85-96：
```typescript
        // Step 3.5: Typing-as-suggested check (via CurrentGhostText singleton)
        const typingSuggested = this._currentGhostText.getCompletionsForUserTyping(prefix, suffix);
        if (typingSuggested && typingSuggested.length > 0) {
            this._log.info(`[GHOST] TYPING_AS_SUGGESTED count=${typingSuggested.length} total=${Date.now() - t0}ms`);
            return {
                completions: typingSuggested.map(c => this._toGhostCompletion(
                    { text: c.completionText, finishReason: 'stop' },
                    document, position, isMiddleOfTheLine,
                )),
                resultType: ResultType.TypingAsSuggested,
                suffixCoverage: this._calcSuffixCoverage(typingSuggested[0].completionText, suffix),
            };
        }
```

替换为：
```typescript
        // Step 3.5: Typing-as-suggested check (via CurrentGhostText singleton)
        const typingSuggested = this._currentGhostText.getCompletionsForUserTyping(prefix, suffix);
        if (typingSuggested && typingSuggested.length > 0) {
            // Apply line-level suffix overlap trim to each completion, filter empty results
            const trimmedCompletions = typingSuggested
                .map(c => ({
                    ...c,
                    completionText: this._trimLineSuffixOverlap(c.completionText, suffix),
                }))
                .filter(c => c.completionText !== '');
            if (trimmedCompletions.length === 0) {
                this._log.info(`[GHOST] TYPING_AS_SUGGESTED all trimmed to empty total=${Date.now() - t0}ms`);
                return undefined;
            }
            this._log.info(`[GHOST] TYPING_AS_SUGGESTED count=${trimmedCompletions.length}/${typingSuggested.length} total=${Date.now() - t0}ms`);
            return {
                completions: trimmedCompletions.map(c => this._toGhostCompletion(
                    { text: c.completionText, finishReason: 'stop' },
                    document, position, isMiddleOfTheLine,
                )),
                resultType: ResultType.TypingAsSuggested,
                suffixCoverage: this._calcSuffixCoverage(trimmedCompletions[0].completionText, suffix),
            };
        }
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "feat(ghost): apply line suffix overlap trim to TypingAsSuggested path"
```


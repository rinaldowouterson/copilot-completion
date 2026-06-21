### Task 4: 修改 Cache 路径

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts:98-111` (Cache return block)

**Interfaces:**
- Consumes: `_trimLineSuffixOverlap(text, suffix)` from Task 1
- Produces: 无新接口

- [ ] **Step 1: 替换 Cache return 块**

将 lines 98-111：
```typescript
        // Step 4: Cache lookup
        const t2 = Date.now();
        const cached = this._cache.findAll(prefix, suffix);
        if (cached.length > 0) {
            const cacheResult = this._postProcessChoiceInContext(cached[0], document, position);
            this._log.info(`[GHOST] CACHE_HIT count=${cached.length} result="${this._trunc(cacheResult.text, 60)}" [${Date.now() - t2}ms] total=${Date.now() - t0}ms`);
            const ghostCompletionCache = this._toGhostCompletion(cacheResult, document, position, isMiddleOfTheLine);
            this._currentGhostText.setGhostText(prefix, suffix, [ghostCompletionCache], ResultType.Cache);
            return {
                completions: [ghostCompletionCache],
                resultType: ResultType.Cache,
                suffixCoverage: this._calcSuffixCoverage(cacheResult.text, suffix),
            };
        }
        this._log.debug(`[GHOST] cache_miss [${Date.now() - t2}ms]`);
```

替换为：
```typescript
        // Step 4: Cache lookup
        const t2 = Date.now();
        const cached = this._cache.findAll(prefix, suffix);
        if (cached.length > 0) {
            // Apply line-level suffix overlap trim BEFORE postProcess (consistent with Network path)
            const trimmedCacheText = this._trimLineSuffixOverlap(cached[0].text, suffix);
            const cacheResult = this._postProcessChoiceInContext(
                { text: trimmedCacheText, finishReason: cached[0].finishReason },
                document,
                position,
            );
            this._log.info(`[GHOST] CACHE_HIT count=${cached.length} result="${this._trunc(cacheResult.text, 60)}" [${Date.now() - t2}ms] total=${Date.now() - t0}ms`);
            const ghostCompletionCache = this._toGhostCompletion(cacheResult, document, position, isMiddleOfTheLine);
            this._currentGhostText.setGhostText(prefix, suffix, [ghostCompletionCache], ResultType.Cache);
            return {
                completions: [ghostCompletionCache],
                resultType: ResultType.Cache,
                suffixCoverage: this._calcSuffixCoverage(cacheResult.text, suffix),
            };
        }
        this._log.debug(`[GHOST] cache_miss [${Date.now() - t2}ms]`);
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "feat(ghost): apply line suffix overlap trim to Cache path"
```


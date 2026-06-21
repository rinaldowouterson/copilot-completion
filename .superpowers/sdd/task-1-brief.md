### Task 1: 添加 `_trimLineSuffixOverlap` 方法

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts` (在 `_trimCharOverlap` 方法之后插入)

**Interfaces:**
- Consumes: `TrimNESResponseSuffixOverlap` from `../../common/suffixOverlapTrim`, `this._config.suffixOverlapThreshold`, `this._config.suffixOverlapType`, `this._log`
- Produces: `_trimLineSuffixOverlap(text: string, suffix: string): string`

- [ ] **Step 1: 在 `_trimCharOverlap` 方法之后插入新方法**

在 `ghostTextComputer.ts` 中，`_trimCharOverlap` 方法结束的 `}` 之后，`_postProcessChoiceInContext` 方法之前，插入：

```typescript
    // Line-level suffix overlap trimmer — shared across all 4 return paths
    _trimLineSuffixOverlap(text: string, suffix: string): string {
        const completionLines = text.split('\n');
        const suffixLines = suffix.split('\n');
        const trimmer = new TrimNESResponseSuffixOverlap(
            this._config.suffixOverlapThreshold,
            this._config.suffixOverlapType,
        );
        const overlapCount = trimmer.calculateOverlap(completionLines, suffixLines);
        if (overlapCount > 0 && overlapCount < completionLines.length) {
            this._log.info(`[GHOST] line_trim overlap=${overlapCount} lines`);
            return completionLines.slice(0, completionLines.length - overlapCount).join('\n');
        }
        if (overlapCount >= completionLines.length) {
            this._log.info(`[GHOST] line_trim ALL_LINES overlap=${overlapCount} >= ${completionLines.length} — returning empty`);
            return '';
        }
        return text;
    }
```

- [ ] **Step 2: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "feat(ghost): add _trimLineSuffixOverlap method for line-level suffix overlap trimming"
```


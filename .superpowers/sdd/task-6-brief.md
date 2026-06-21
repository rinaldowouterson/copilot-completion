### Task 6: 替换 Network 路径的 inline 代码

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts:294-307` (Network inline line-trim block)

**Interfaces:**
- Consumes: `_trimLineSuffixOverlap(text, suffix)` from Task 1
- Produces: 无新接口

- [ ] **Step 1: 替换 Network 路径 inline 代码**

将 lines 294-307：
```typescript
            // Step 11: Line-level suffix overlap
            const completionLines = charTrimmedText.split('\n');
            const suffixLines = suffix.split('\n');
            const overlapTrimmer = new TrimNESResponseSuffixOverlap(
                this._config.suffixOverlapThreshold,
                this._config.suffixOverlapType,
            );
            const lineOverlapCount = overlapTrimmer.calculateOverlap(completionLines, suffixLines);
            const trimmedLines = lineOverlapCount > 0
                ? completionLines.slice(0, completionLines.length - lineOverlapCount)
                : completionLines;
            if (lineOverlapCount > 0) {
                this._log.info(`[GHOST] line_trim overlap=${lineOverlapCount} lines`);
            }
            const trimmedText = trimmedLines.join('\n');
```

替换为：
```typescript
            // Step 11: Line-level suffix overlap (via shared method)
            const trimmedText = this._trimLineSuffixOverlap(charTrimmedText, suffix);
```

- [ ] **Step 2: 验证未使用的 import**

检查 `TrimNESResponseSuffixOverlap` 是否仍在文件中其他位置被直接引用。查看文件中唯一直接引用处（原 line 296 `new TrimNESResponseSuffixOverlap(...)`）已被替换，但 import 仍保留，因为 `_trimLineSuffixOverlap` 方法内部也使用该类 —— import 不变。

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "refactor(ghost): replace Network path inline suffix overlap trim with shared method"
```


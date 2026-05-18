# NES 补全数据后处理对齐设计

## 背景

当前 NES 补全流程的数据后处理（`NextEditResult` 类型 + `_toInlineItems` 方法）与参考实现
`fake-vscode-copilot-chat/src/extension/inlineEdits/vscode-node/inlineCompletionProvider.ts`
中的 `provideInlineCompletionItems` 不一致，导致 VS Code 无法正确展示补全结果。

Ghost 补全已实现完毕，不在本次范围内。

## 差异分析

| 维度 | 当前实现 | 参考实现 |
|------|----------|----------|
| `NextEditResult` 结构 | `{ edit: string, range: Range (硬编码) }` | `{ edit: StringReplacement, displayLocation, action, jumpToPosition, cacheEntry }` |
| 替换范围计算 | 硬编码 `(line-2, 0)` 到 `(line+5, 0)` | 从 `replaceRange` (OffsetRange) 通过 `fromOffsetRange` 解析 |
| Ghost text 判定 | 无 | `toInlineSuggestion()` 前置判定 |
| displayLocation | 无 | 传递 edit window 行号 label |
| Cursor jump | command 附加到普通 item | 专用 jumpToPosition item |
| 缓存防重展 | 无 | `wasRenderedAsInlineSuggestion` 标记 + 门控 |

## 变更文件

| 文件 | 操作 | 变更内容 |
|------|------|----------|
| `src/completions/nes/types.ts` | 修改 | 扩展 `NextEditResult`：增加 `displayLocation`、`cacheEntry`、`isFromCursorJump`、`jumpToPosition` |
| `src/completions/nes/nextEditCache.ts` | 修改 | `CachedEdit` 增加 `wasRenderedAsInlineSuggestion` 标记字段 |
| `src/completions/nes/core/nesWorkflow.ts` | 修改 | `_buildResult` 改为从原始文档计算 edit window 的实际偏移范围，传递 `cacheEntry` |
| `src/completions/nes/nextEditProvider.ts` | 修改 | `_toInlineItems` 重写：使用 `InlineSuggestionResolver` 判定 ghost text；cursor jump 走专用路径；`handleDidShowCompletionItem` 回写标记 |
| `src/completions/nes/core/inlineSuggestionResolver.ts` | **新建** | 封装 `toInlineSuggestion` 逻辑，仅支持同文件场景 |

不涉及：response/ 目录、prompt 构建、ghost 补全、notebook。

## 类型设计

### NextEditResult（扩展后）

```typescript
export interface NextEditResult {
    edit: string;
    range: vscode.Range;          // 实际替换范围（edit window 在文档中的 Range）
    cursorAfterEdit?: vscode.Position;
    displayLocation?: {
        range: vscode.Range;
        label: string;
    };
    cacheEntry?: CachedEdit;
    isFromCursorJump: boolean;
    jumpToPosition?: vscode.Position;
    cursorPrediction?: CursorJumpPrediction;  // 保留
}
```

### CachedEdit 新增字段

```typescript
export interface CachedEdit {
    // ... 现有字段 ...
    wasRenderedAsInlineSuggestion?: boolean;
}
```

## 新增类：InlineSuggestionResolver

文件：`src/completions/nes/core/inlineSuggestionResolver.ts`

单一职责：判断一个 edit 能否以 ghost text 形式在光标处渲染。

```
InlineSuggestionResolver
  + resolve(cursorPos, doc, range, newText): InlineSuggestion | undefined
  - tryAdjustNextLineInsertion(...)
  - stripCommonLinePrefix(...)
  - validateSameLineGhostText(...)
  - isSubword(a, b): boolean
```

`resolve()` 返回 `{ range, newText }` 时，表示可以在光标处以 ghost text 展示；
返回 `undefined` 时，使用完整的 edit window range 作为非 inline NES 展示。

## NesWorkflow._buildResult 重写

将当前硬编码 range：

```typescript
// 当前
range: new vscode.Range(
    new vscode.Position(editStartLine, 0),
    new vscode.Position(Math.min(position.line + 5, document.lineCount - 1), 0),
)
```

改为从原始文档计算 edit window 的实际字符偏移 → 转换为 VS Code Range：

1. 遍历文档行，计算 edit window 起始行的字符偏移量 startOffset
2. 计算 edit window 结束行之后的字符偏移量 endOffset
3. `range = new vscode.Range(startLine, 0) → (endExclusive, 0)`
4. 构造 `displayLocation = { range, label: "NES: L{start}-L{end}" }`
5. 返回完整 NextEditResult

## NextEditProvider._toInlineItems 重写

```typescript
private _toInlineItems(result: NextEditResult): vscode.InlineCompletionItem[] {
    // 1. Cursor jump 场景：创建专用 jumpToPosition item（无 insertText）
    if (result.jumpToPosition) {
        const item = new vscode.InlineCompletionItem('', result.range);
        item.jumpToPosition = result.jumpToPosition;
        return [item];
    }

    // 2. 用 InlineSuggestionResolver 判定可否 ghost text
    const inlineSuggestion = this._inlineSuggestionResolver.resolve(
        /* cursor position */, /* document */, result.range, result.edit
    );

    // 3. 决定使用的 range 和 insertText
    const range = inlineSuggestion?.range ?? result.range;
    const insertText = inlineSuggestion?.newText ?? result.edit;

    // 4. 构造 InlineCompletionItem
    const item = new vscode.InlineCompletionItem(insertText, range);
    if (result.displayLocation) {
        item.displayLocation = result.displayLocation;
    }
    if (result.cursorPrediction) {
        item.command = { ... };
    }

    return [item];
}
```

## nesMimicGhostTextBehavior 门控

在 `_toInlineItems` 开头增加：

```typescript
if (result.cacheEntry?.wasRenderedAsInlineSuggestion && !inlineSuggestion) {
    return [];  // 抑制：之前以 inline 形式展示过，当前无法 inline
}
```

在 `handleDidShowCompletionItem` 中回写标记：

```typescript
if (item.isInlineCompletion && item.info.cacheEntry) {
    item.info.cacheEntry.wasRenderedAsInlineSuggestion = true;
}
```

## 数据流

```
NesWorkflow.execute()
  → LLM 响应
  → ResponsePipeline.process()   → parsedLines[]
  → EditFilterChain.apply()      → finalEdit: string
  → _buildResult(finalEdit, doc, pos, cacheEntry)
       → 计算 edit window 实际 Range
       → 构造 NextEditResult（含 displayLocation、cacheEntry）

NextEditProvider.provideInlineCompletionItems()
  → NesWorkflow.execute()  + cursor prediction retry
  → _toInlineItems(result)
       → InlineSuggestionResolver.resolve()
       → 构造 InlineCompletionItem（含 displayLocation、command）
       → handleDidShow 回写 wasRenderedAsInlineSuggestion
```

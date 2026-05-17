# GHOST 补全缩进重叠裁剪 Fix

## 问题

光标在纯空白行上时（如 `    <|cursor|>`），GHOST FIM 补全返回带缩进的文本（如 `    }`）。`InlineCompletionItem` 使用 `new vscode.Range(position, position)` 将补全文本直接插入光标位置，导致双重缩进（`        }`）。用户按 Tab 确认时 VS Code 丢弃补全。

```
当前行: "    " (4 spaces, cursor at col 4)
补全:   "    }" (4 spaces + brace)
插入后: "        }" (8 spaces + brace)  ← 缩进错误，Tab 消失
```

## 设计

### 裁剪条件（两个条件必须同时满足）

1. **光标前行首到光标的文本全为空白** — 说明这一行还没写代码
2. **裁剪重叠后，补全文本以非空白字符开头** — 说明补全的缩进量恰好等于当前行已有空白量，补全意图是回退到外层缩进（如 `}` / `pass` / `else:`），而非更深层嵌套

### 裁剪逻辑

```
补全文本开头从索引 0 起，与当前行光标前文本（全空白）逐个比较，每匹配一个空白字符就裁掉补全文本的首字符。

"    }"   + currPrefix "    " → 裁掉 4 字符 → "}"      以 "}" 开头(非空白) → 触发 ✅
"        print" + currPrefix "    " → 裁掉 4 字符 → "    print" 以 " " 开头(空白) → 不触发 ✅
"    pass" + currPrefix "    " → 裁掉 4 字符 → "pass"   以 "p" 开头(非空白) → 触发 ✅
```

### 插入位置

在 `ghostTextProvider.ts` 的 `provideInlineCompletionItems()` 中，`new vscode.InlineCompletionItem(...)` 之前。

### 影响范围

仅影响「当前行纯空白 + 补全退回到外层缩进」的场景。不影响：
- 行首光标
- 行中有代码字符
- 补全是更深嵌套（如 Python `        print(i)`）
- 多行补全（首行为换行的不触发裁剪）

## 伪代码

```typescript
function trimIndentOverlap(completionText: string, currentLinePrefix: string): string {
    // 条件 1: 光标前文本全为空白
    if (!/^\s*$/.test(currentLinePrefix)) return completionText;
    
    let trimmed = completionText;
    for (let i = 0; i < currentLinePrefix.length && i < trimmed.length; i++) {
        if (trimmed[i] !== currentLinePrefix[i]) break;
        trimmed = trimmed.substring(1);
    }
    
    // 条件 2: 裁剪后以非空白开头
    if (trimmed.length === 0 || trimmed[0].match(/\s/)) return completionText;
    
    return trimmed;
}
```

## 变更文件

- `src/completions/ghost/ghostTextProvider.ts` — 添加 `trimIndentOverlap()` 函数，在生成 `InlineCompletionItem` 前调用

## 测试场景

| # | 当前行 | col | 补全 | 预期 |
|---|--------|-----|------|------|
| 1 | `    \|` | 4 | `    }` | `}` ✅ 裁剪 |
| 2 | `\|` | 0 | `    }` | `    }` ✅ 不裁剪（无重叠） |
| 3 | `  \|` | 2 | `    }` | `  }` ✅ 裁剪 2 字符 |
| 4 | `    foo();\|` | 10 | `\n    }` | `\n    }` ✅ 不裁剪（行非空白） |
| 5 | `if (\|` | 4 | `x > 0)` | `x > 0)` ✅ 不裁剪（行非空白） |
| 6 | `    \|` | 4 | `        pass` | `        pass` ✅ 不裁剪（裁后以空白开头） |
| 7 | `    \|` | 4 | `    pass` | `pass` ✅ 裁剪 |
| 8 | `    \|` col 4 | 4 | `\n    // comment` | `\n    // comment` ✅ 不裁剪（开头不同字符） |

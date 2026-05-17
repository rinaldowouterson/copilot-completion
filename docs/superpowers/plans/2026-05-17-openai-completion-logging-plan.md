# OpenAICompletionAdapter 日志集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `OpenAICompletionAdapter` 添加日志功能，记录请求/响应的详细状态

**Architecture:** 通过构造函数注入 `ILogService`，在关键节点（请求发送、响应成功/失败）添加日志调用

**Tech Stack:** TypeScript, VSCode LogOutputChannel, ILogService DI

---

## 文件结构

```
src/
├── completions/shared/llm/openaiCompletionAdapter.ts  (修改)
├── extension.ts                                          (修改)
└── test/llm/openaiCompletionAdapter.test.ts             (修改)
```

---

## Task 1: 修改 OpenAICompletionAdapter 构造函数

**Files:**
- Modify: `src/completions/shared/llm/openaiCompletionAdapter.ts:1-62`
- Test: `src/test/llm/openaiCompletionAdapter.test.ts`

- [ ] **Step 1: 更新 import 并添加 ILogService 参数**

```typescript
import { ILLMAdapter } from './llmAdapter';
import { ILogService } from '../log/logService';  // 新增
import { LLMRequest, LLMResponse, LLMError, normalizeBody } from './llmRequest';
import { readSSEStream } from './sseStream';

export class OpenAICompletionAdapter implements ILLMAdapter {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly model: string,
        private readonly logService: ILogService,  // 新增
    ) {}
```

- [ ] **Step 2: 在 send 方法开头添加请求日志**

```typescript
async send(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    // 日志: 发送请求
    this.logService.debug(`[OpenAI] 发送请求 | model=${this.model} | maxTokens=${request.max_tokens} | temperature=${request.temperature}`);

    const url = `${this.baseUrl}/completions`;
```

- [ ] **Step 3: 在 !response.ok 分支添加错误日志**

```typescript
if (!response.ok) {
    const text = await response.text();
    this.logService.error(`[OpenAI] 请求失败 | status=${response.status} | error=${text}`);
    throw new LLMError(`OpenAI completions API failed: ${response.status}`, response.status, text);
}
```

- [ ] **Step 4: 在返回前添加成功响应日志**

在 `_parseJSON` 调用之前添加:
```typescript
const jsonResponse = this._parseJSON(await response.text());
this.logService.debug(`[OpenAI] 响应成功 | textLength=${jsonResponse.text.length} | finishReason=${jsonResponse.finishReason}`);
return jsonResponse;
```

对于 SSE 流式响应，在 `return { text, finishReason };` 之前添加:
```typescript
this.logService.debug(`[OpenAI] 流式响应完成 | textLength=${text.length}`);
return { text, finishReason };
```

- [ ] **Step 5: 更新测试文件**

```typescript
import * as assert from 'assert';
import { OpenAICompletionAdapter } from '../../completions/shared/llm/openaiCompletionAdapter';
import { ILogService } from '../../completions/shared/log/logService';

// Mock LogService
const mockLogService: ILogService = {
    _serviceBrand: undefined,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    show: () => {},
};

suite('OpenAICompletionAdapter', () => {
    test('should construct with correct URL path', () => {
        const adapter = new OpenAICompletionAdapter('http://127.0.0.1:8080/v1', 'sk-test', 'gpt-4o', mockLogService);
        assert.ok(adapter instanceof OpenAICompletionAdapter);
    });
});
```

- [ ] **Step 6: 验证构建**

Run: `npm run compile`
Expected: 无编译错误

- [ ] **Step 7: 运行测试**

Run: `npm test -- --grep "OpenAICompletionAdapter"`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/completions/shared/llm/openaiCompletionAdapter.ts src/test/llm/openaiCompletionAdapter.test.ts
git commit -m "feat: add logging to OpenAICompletionAdapter"
```

---

## Task 2: 更新 extension.ts 传入 logService

**Files:**
- Modify: `src/extension.ts:107-111`

- [ ] **Step 1: 更新 adapter 注册，传入 logService**

将:
```typescript
llmManager.register('completions', new OpenAICompletionAdapter(
    ghostConfig.baseUrl,
    ghostConfig.apiKey,
    ghostConfig.model,
));
```

改为:
```typescript
llmManager.register('completions', new OpenAICompletionAdapter(
    ghostConfig.baseUrl,
    ghostConfig.apiKey,
    ghostConfig.model,
    logService,
));
```

- [ ] **Step 2: 验证构建**

Run: `npm run compile`
Expected: 无编译错误

- [ ] **Step 3: 提交**

```bash
git add src/extension.ts
git commit -m "feat: inject logService into OpenAICompletionAdapter"
```
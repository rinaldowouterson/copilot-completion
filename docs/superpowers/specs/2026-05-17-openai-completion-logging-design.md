# OpenAICompletionAdapter 日志集成设计

**日期**: 2026-05-17
**目标**: 为 `openaiCompletionAdapter.ts` 添加 `logService.ts` 日志功能

---

## 1. 变更概述

为 `OpenAICompletionAdapter` 类集成日志服务，支持详细级别的请求/响应追踪。

---

## 2. 架构变更

### 2.1 依赖注入

**文件**: `src/completions/shared/llm/openaiCompletionAdapter.ts`

```typescript
import { ILogService } from '../log/logService';

// 构造函数新增参数
constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly logService: ILogService,
) {}
```

### 2.2 日志调用点

| 时机 | 级别 | 消息格式 |
|------|------|---------|
| 发送请求 | debug | `[OpenAI] 发送请求 | model=${model} | maxTokens=${max_tokens} | temperature=${temperature}` |
| 响应成功 | debug | `[OpenAI] 响应成功 | textLength=${length} | finishReason=${finishReason}` |
| 响应失败 | error | `[OpenAI] 请求失败 | status=${status} | error=${message}` |

### 2.3 API Key 脱敏策略

- **部分脱敏**: `Bearer sk-xxx...` 显示为 `Bearer ***`
- 请求体内容：脱敏仅用于日志输出，不影响实际请求

---

## 3. 实现要点

1. **导入 ILogService**: 在文件顶部添加 import
2. **构造函数参数**: 在末尾添加 `logService: ILogService`
3. **日志位置**:
   - `debug`: 在 fetch 之前记录请求参数
   - `debug`: 在 return 之前记录响应结果
   - `error`: 在 `!response.ok` 分支记录错误

---

## 4. 调用方适配

创建 `OpenAICompletionAdapter` 的地方需要传入 `ILogService` 实例。
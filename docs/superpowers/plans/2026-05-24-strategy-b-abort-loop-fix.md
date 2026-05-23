# Strategy B Implementation Plan — Abort Loop Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the continuous ABORT loop when Ghost and NES are both enabled during fast typing, by implementing request reuse (Ghost AsyncCompletionsManager) and graceful cancellation delay (NES 1000ms timeout), strictly aligned with reference project `fake-vscode-copilot-chat`.

**Architecture:** B1 rewrites Ghost's AsyncCompletionsManager from a stub to a proper LRU-based request manager that matches in-flight requests by prefix/suffix, enabling reuse instead of new LLM calls per keystroke. B3 adds a 1000ms TimeoutTimer to NES cancellation so that in-flight LLM requests survive brief typematic pauses, allowing the next keystroke to reuse (join) them instead of starting over. Together these eliminate the wasteful per-keystroke LLM request pattern.

**Tech Stack:** TypeScript, VS Code Extension API, custom DI container

---

### Task 1: Create LRUCacheMap utility

**Files:**
- Create: `src/common/lruCacheMap.ts`

- [ ] **Step 1: Create src/common/lruCacheMap.ts**

```typescript
export class LRUCacheMap<K, V> {
    private readonly _map = new Map<K, V>();
    private readonly _maxSize: number;

    constructor(maxSize: number) {
        this._maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const value = this._map.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this._map.delete(key);
            this._map.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this._map.has(key)) {
            this._map.delete(key);
        } else if (this._map.size >= this._maxSize) {
            // Delete least recently used (first entry)
            const firstKey = this._map.keys().next().value;
            if (firstKey !== undefined) {
                this._map.delete(firstKey);
            }
        }
        this._map.set(key, value);
    }

    delete(key: K): boolean {
        return this._map.delete(key);
    }

    clear(): void {
        this._map.clear();
    }

    get size(): number {
        return this._map.size;
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this._map[Symbol.iterator]();
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/common/lruCacheMap.ts
git commit -m "feat: add LRUCacheMap utility for async completion request tracking"
```

---

### Task 2: Implement Ghost AsyncCompletionsManager

**Files:**
- Modify: `src/completions/ghost/asyncCompletions.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\completions-core\vscode-node\lib\src\ghostText\asyncCompletions.ts`

- [ ] **Step 1: Rewrite asyncCompletions.ts**

Replace the entire file:

```typescript
import { LRUCacheMap } from '../../common/lruCacheMap';

export interface IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;
    shouldWaitForAsyncCompletions(prefix: string, suffix: string): boolean;
    updateCompletion(headerRequestId: string, text: string): void;
    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cancellationTokenSource: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>
    ): void;
    getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
    ): Promise<AsyncCompletionResult | undefined>;
    cancelStaleRequests(headerRequestId: string): void;
    clear(): void;
}

export interface AsyncCompletionResult {
    completionText: string;
    finishReason: string;
}

interface BaseAsyncCompletionRequest {
    cancellationTokenSource: { cancel(): void };
    headerRequestId: string;
    prefix: string;
    suffix: string;
}

interface PendingRequest extends BaseAsyncCompletionRequest {
    state: 'pending';
    partialCompletionText?: string;
    resultPromise: Promise<AsyncCompletionResult>;
}

interface CompletedRequest extends BaseAsyncCompletionRequest {
    state: 'completed';
    result: AsyncCompletionResult;
}

type AsyncCompletionRequest = PendingRequest | CompletedRequest;

export class AsyncCompletionsManager implements IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;

    private readonly _requests = new LRUCacheMap<string, AsyncCompletionRequest>(100);

    /** Lock: only the most recent requester can cancel stale requests. */
    private _mostRecentRequestId = '';

    shouldWaitForAsyncCompletions(prefix: string, suffix: string): boolean {
        for (const [, request] of this._requests) {
            if (this._isCandidate(prefix, suffix, request)) {
                return true;
            }
        }
        return false;
    }

    updateCompletion(headerRequestId: string, text: string): void {
        const request = this._requests.get(headerRequestId);
        if (!request || request.state !== 'pending') return;
        request.partialCompletionText = text;
    }

    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cts: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>,
    ): void {
        this._requests.set(headerRequestId, {
            state: 'pending',
            cancellationTokenSource: cts,
            headerRequestId,
            prefix,
            suffix,
            resultPromise,
        });

        resultPromise
            .then(result => {
                this._requests.set(headerRequestId, {
                    state: 'completed',
                    cancellationTokenSource: cts,
                    headerRequestId,
                    prefix,
                    suffix,
                    result,
                });
            })
            .catch(() => {
                this._requests.delete(headerRequestId);
            });
    }

    async getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
    ): Promise<AsyncCompletionResult | undefined> {
        this._mostRecentRequestId = headerRequestId;

        for (const [, request] of this._requests) {
            if (!this._isCandidate(prefix, suffix, request)) {
                this._cancelStaleRequest(headerRequestId, request);
                continue;
            }

            if (request.state === 'completed') {
                const remainingPrefix = prefix.substring(request.prefix.length);
                let { completionText } = request.result;
                if (
                    !completionText.startsWith(remainingPrefix) ||
                    completionText.length <= remainingPrefix.length
                ) {
                    this._requests.delete(request.headerRequestId);
                    continue;
                }
                completionText = completionText.substring(remainingPrefix.length);
                return { ...request.result, completionText };
            }
        }
        return undefined;
    }

    cancelStaleRequests(headerRequestId: string): void {
        this._mostRecentRequestId = headerRequestId;
        for (const [, request] of this._requests) {
            this._cancelStaleRequest(headerRequestId, request);
        }
    }

    clear(): void {
        this._requests.clear();
    }

    private _isCandidate(prefix: string, suffix: string, request: AsyncCompletionRequest): boolean {
        if (request.suffix !== suffix) return false;
        if (!prefix.startsWith(request.prefix)) return false;
        const remainingPrefix = prefix.substring(request.prefix.length);
        if (request.state === 'completed') {
            return (
                request.result.completionText.startsWith(remainingPrefix) &&
                request.result.completionText.trimEnd().length > remainingPrefix.length
            );
        }
        if (request.partialCompletionText === undefined) return true;
        return request.partialCompletionText.startsWith(remainingPrefix);
    }

    private _cancelStaleRequest(headerRequestId: string, request: AsyncCompletionRequest): void {
        if (headerRequestId !== this._mostRecentRequestId) return;
        if (request.state === 'completed') return;
        request.cancellationTokenSource.cancel();
        this._requests.delete(request.headerRequestId);
    }
}
```

IMPORTANT: Remove the old `createServiceIdentifier` import at the top of the file. The `IAsyncCompletionsManager` is already defined in `services.ts` (check that the existing import from `../../di/services` for `IAsyncCompletionsManager` still works).

Wait — check the existing file. It defines `IAsyncCompletionsManager` using `createServiceIdentifier`. The new interface must keep the same service identifier. Keep the service identifier import but update the interface:

The `createServiceIdentifier` call at the top should stay:
```typescript
import { createServiceIdentifier } from '../../di/services';
export const IAsyncCompletionsManager = createServiceIdentifier<IAsyncCompletionsManager>('IAsyncCompletionsManager');
```

But the INTERFACE definition changes to the new expanded one shown above.

- [ ] **Step 2: Verify compilation**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```

Fix any callers that reference the old `IAsyncCompletionsManager` interface (the GhostTextComputer constructor injects `IAsyncCompletionsManager` — ensure it still compiles with the new interface).

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/asyncCompletions.ts
git commit -m "feat: implement AsyncCompletionsManager with LRU-based request reuse"
```

---

### Task 3: Wire AsyncCompletionsManager into GhostTextComputer

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\completions-core\vscode-node\lib\src\ghostText\ghostText.ts` (lines 410-442)

- [ ] **Step 1: Add request reuse before network call**

In `getGhostText()`, after the typing-as-suggested check (Step 3.5) and after the cache miss (Step 4), insert a new Step before the network request (Step 6 prompt build):

```typescript
// Step 4.5: Check async completions (in-flight request reuse)
const asyncHeaderRequestId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
if (this._asyncManager.shouldWaitForAsyncCompletions(prefix, suffix)) {
    this._log.debug(`[GHOST] async_wait — checking in-flight requests`);
    const asyncResult = await this._asyncManager.getFirstMatchingRequest(
        asyncHeaderRequestId, prefix, suffix
    );
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
    this._log.debug(`[GHOST] async_wait — no matching request found`);
}
```

- [ ] **Step 2: Register new network request in AsyncManager**

After the LLM request succeeds (in the Network result path, around line 263 where `ghostCompletion` is built), add:

```typescript
// Register with AsyncCompletionsManager for future reuse
const abortControllerForAsync = new AbortController();
this._asyncManager.queueCompletionRequest(
    `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prefix,
    suffix,
    { cancel: () => abortControllerForAsync.abort() },
    Promise.resolve({ completionText: ghostCompletion.completionText, finishReason: response.finishReason }),
);
```

- [ ] **Step 3: Verify compilation and existing tests**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "feat: wire AsyncCompletionsManager into GhostTextComputer for request reuse"
```

---

### Task 4: NES 1000ms cancellation delay

**Files:**
- Modify: `src/completions/nes/core/nesWorkflow.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\inlineEdits\node\nextEditProvider.ts` (lines 959-1004, `_hookupCancellation`)

- [ ] **Step 1: Add cancellation delay in the network request section**

In `execute()`, change the `cancelListener` setup (around line 106-109) to use a 1000ms timeout:

Current code:
```typescript
const cancelListener = token?.onCancellationRequested(() => {
    this._log.info(`[NES]  ABORT — CancellationToken triggered`);
    abortController.abort();
});
```

Replace with:
```typescript
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
const cancelListener = token?.onCancellationRequested(() => {
    this._log.info(`[NES]  ABORT — CancellationToken triggered (1000ms delay)`);
    if (cancelTimer) clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
        if (abortController.signal.aborted) return;
        this._log.info(`[NES]  ABORT — executing after 1000ms delay`);
        abortController.abort();
    }, 1000);
});
```

And update the `finally` block to clear the timer:
```typescript
finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    cancelListener?.dispose();
}
```

- [ ] **Step 2: Same for GhostTextComputer**

In `src/completions/ghost/ghostTextComputer.ts`, apply the same pattern. Change the cancelListener (around line 148-151):

Current:
```typescript
const cancelListener = token?.onCancellationRequested(() => {
    this._log.info(`[GHOST] ABORT — CancellationToken triggered`);
    abortController.abort();
});
```

Replace with:
```typescript
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
const cancelListener = token?.onCancellationRequested(() => {
    this._log.info(`[GHOST] ABORT — CancellationToken triggered (1000ms delay)`);
    if (cancelTimer) clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
        if (abortController.signal.aborted) return;
        this._log.info(`[GHOST] ABORT — executing after 1000ms delay`);
        abortController.abort();
    }, 1000);
});
```

And update the finally block (around line 262-264):
```typescript
finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    cancelListener?.dispose();
}
```

- [ ] **Step 3: Verify compilation**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/completions/nes/core/nesWorkflow.ts src/completions/ghost/ghostTextComputer.ts
git commit -m "feat: add 1000ms cancellation delay to prevent abort loop during fast typing"
```

---

### Task 5: Integration verification

- [ ] **Step 1: Full TypeScript compilation**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 2: Build VSIX**

```bash
cd E:/workspace/vscode/copilot-completion && npx vsce package
```
Expected: VSIX built successfully.

- [ ] **Step 3: Commit (if any fixes needed)**

```bash
git add <fixed-files>
git commit -m "fix: integration fixes for Strategy B"
```

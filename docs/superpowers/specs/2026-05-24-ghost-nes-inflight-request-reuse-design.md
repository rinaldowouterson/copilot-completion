# Ghost & NES In-Flight Request Reuse Design

> **Problem:** Strategy B's 1000ms cancellation delay prevented abort loops but did not prevent duplicate LLM calls. Each keystroke still starts a NEW Ghost and NES network request because `queueCompletionRequest` was called AFTER the network request completed, so in-flight requests were never visible to subsequent keystrokes for reuse.

**Goal:** Align Ghost and NES with reference project `fake-vscode-copilot-chat` so that in-flight LLM requests are registered BEFORE they complete, enabling subsequent keystrokes to join/reuse them instead of starting new ones.

---

## 1. Utility Classes

### 1.1 `src/common/subject.ts` (NEW)

Reference: `fake-vscode-copilot-chat/.../util/subject.ts`

```typescript
export interface Observer<T> {
    next: (value: T) => void;
    complete?: () => void;
    error?: (err: unknown) => void;
}

export class Subject<T> {
    private observers = new Set<Observer<T>>();
    subscribe(observer: Observer<T>): () => void { ... }
    next(value: T): void { ... }
    error(err: unknown): void { ... }
    complete(): void { ... }
}

export class ReplaySubject<T> extends Subject<T> {
    // Replays the last emitted value to new subscribers
    private _value: T | undefined;
    override subscribe(observer: Observer<T>): () => void { ... }
    override next(value: T): void { ... }
}
```

### 1.2 `Deferred<T>` in `src/common/async.ts` (MODIFY)

Add `Deferred<T>` to the existing async utilities file. Reference: `fake-vscode-copilot-chat/.../util/async.ts`

```typescript
export class Deferred<T> {
    resolve: (value: T | PromiseLike<T>) => void = () => {};
    reject: (reason?: unknown) => void = () => {};
    readonly promise: Promise<T> = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });
}
```

---

## 2. Ghost: `asyncCompletions.ts` Rewrite

Reference: `fake-vscode-copilot-chat/.../ghostText/asyncCompletions.ts`

### 2.1 Core changes from current implementation

| Aspect | Current | Reference (target) |
|--------|---------|-------------------|
| Request states | `pending`, `completed` | `Pending`, `Completed`, `Error` |
| Pending tracking | None (registered after completion) | Registered immediately with `ReplaySubject` |
| `getFirstMatchingRequest` | Synchronous iteration over completed only | Subscription-based, waits for pending to complete |
| `queueCompletionRequest` return | `void` | `Promise<void>` (propagates errors) |
| Request matching | `suffix` string | `prompt.suffix` (same concept, different name) |

### 2.2 Key design elements

**A. ReplaySubject per request**

Each request gets a `ReplaySubject<AsyncCompletionRequest>`. When `updateCompletion` is called during streaming, it pushes partial updates via `subject.next()`. When the request completes, `queueCompletionRequest`'s `.then()` pushes the completed state via `subject.next()` and `subject.complete()`. New subscribers immediately receive the last value (pending or completed).

**B. Deferred-based getFirstMatchingRequest**

Instead of iterating synchronously, `getFirstMatchingRequest` creates a `Deferred` and subscribes to each candidate request's `ReplaySubject`. When a candidate emits a completed state that matches the prefix, the Deferred resolves. If all candidates finish without a match, the Deferred resolves to `undefined`.

**C. request matching uses suffix**

`_isCandidate` checks `request.suffix === suffix` (not `request.prompt.suffix` — we use a simplified model without the Prompt object). This matches our existing codebase pattern.

### 2.3 Interface

```typescript
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
    ): Promise<void>;
    getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
    ): Promise<AsyncCompletionResult | undefined>;
    cancelStaleRequests(headerRequestId: string): void;
    clear(): void;
}
```

(Same as current Strategy B interface — no signature changes, only behavior changes.)

---

## 3. Ghost: `ghostTextComputer.ts` Flow Refactor

Reference: `fake-vscode-copilot-chat/.../ghostText/ghostText.ts` lines 523-558

### 3.1 Current flow (WRONG)

```
Step 4.5: Check shouldWaitForAsyncCompletions → getFirstMatchingRequest (never finds anything)
Step 8:   await adapter.send(...)
Step 14:  queueCompletionRequest(Promise.resolve(completedResult))  ← TOO LATE
```

### 3.2 Target flow (CORRECT)

```
Step 4.5: Check shouldWaitForAsyncCompletions → getFirstMatchingRequest
           ↓ if found → return ASYNC result (reuse)
           ↓ if not found → continue to Step 8

Step 8:   Create asyncCancellationTokenSource (separate from abortController)
          const requestPromise = adapter.send(...)  ← returns Promise, DON'T await yet
          queueCompletionRequest(id, prefix, suffix, asyncCancellationTokenSource, requestPromise)
          ↑ REGISTERED AS PENDING immediately

Step 8b:  const result = await getFirstMatchingRequest(id, prefix, suffix)
          ↑ Waits for OUR OWN request (or another matching one) to complete
          ↑ Returns the completed result with prefix adjustment

Step 9+:  Post-process result (same as current)
```

### 3.3 Key changes

1. **Separate CancellationTokenSource for async manager**: Create `asyncCancellationTokenSource` distinct from `abortController`. The async manager uses `asyncCancellationTokenSource.cancel()` to kill stale requests, while `abortController` is used for the 1000ms delayed abort from the VS Code token.

2. **Register BEFORE awaiting**: Call `queueCompletionRequest` with the real pending promise, then call `getFirstMatchingRequest` to wait for the result.

3. **Remove old Step 14 registration**: The after-completion `queueCompletionRequest(Promise.resolve(...))` call is no longer needed — the request is already registered as pending and upgraded to completed automatically.

4. **Remove Step 4.5**: The check at Step 4.5 (after cache miss) remains but with updated behavior — now `getFirstMatchingRequest` can actually find pending requests and wait for them.

---

## 4. NES: `nesWorkflow.ts` In-Flight Request Join

Reference: `fake-vscode-copilot-chat/.../inlineEdits/node/nextEditProvider.ts`

### 4.1 Problem

Same as Ghost — each call to `NesWorkflow.execute()` creates a new LLM request even if a request from the previous keystroke is still in-flight. The 1000ms delay prevents the old request from being aborted, but the new request starts a separate LLM call.

### 4.2 Solution: Pending request tracking + reference counting

Add to `NesWorkflow`:

```typescript
interface PendingNesRequest {
    headerRequestId: string;
    documentText: string;
    position: vscode.Position;
    abortController: AbortController;
    liveDependants: number;
    resultPromise: Promise<NextEditResult | undefined>;
    resultResolve: (value: NextEditResult | undefined) => void;
}
```

In `execute()`:
1. Before Step 1 (cache lookup), check if `_pendingRequest` exists and matches (same document text, cursor within edit window)
2. If matches: **join** — increment `liveDependants`, await `resultPromise`, return
3. If doesn't match: cancel stale pending request (if `liveDependants === 0`), create new one

### 4.3 Reference counting (_hookupCancellation)

When cancellation fires:
- Decrement `liveDependants`
- If `liveDependants > 0`: defer cancellation (others are still waiting)
- If `liveDependants === 0` and fetch issued: 1000ms delay before actual abort
- If `liveDependants === 0` and fetch NOT issued: abort immediately

### 4.4 Result broadcasting

When a pending NES request completes:
- Resolve `resultPromise` → all joiners receive the same result
- Set `_pendingRequest = undefined`

---

## 5. Error Handling

- **Ghost**: If `queueCompletionRequest`'s promise rejects, the request is deleted from LRU cache and the subject errors. Any subscribers in `getFirstMatchingRequest` receive the error and clean up.
- **NES**: If the pending request fails, all joiners receive `undefined` and the provider falls through to create a new request.
- **AbortError**: Both Ghost and NES handle AbortError in their existing catch blocks — no change needed.

---

## 6. Files Changed

| File | Change |
|------|--------|
| `src/common/subject.ts` | **NEW** — Subject, ReplaySubject, Observer |
| `src/common/async.ts` | **MODIFY** — Add Deferred |
| `src/completions/ghost/asyncCompletions.ts` | **REWRITE** — ReplaySubject + subscription-based getFirstMatchingRequest |
| `src/completions/ghost/ghostTextComputer.ts` | **REFACTOR** — Register pending promise before await |
| `src/completions/nes/core/nesWorkflow.ts` | **REFACTOR** — Pending request join + reference counting |

## 7. Verification

1. `npx tsc --noEmit` — zero errors
2. `npx vsce package` — VSIX builds successfully
3. Manual test: fast typing with both NES and Ghost enabled — observe only one LLM request per provider per "burst" of typing, subsequent keystrokes reuse the in-flight request
4. Log check: `[GHOST] async_wait` messages appear when reuse happens; `[NES] JOIN` messages appear when joining pending request

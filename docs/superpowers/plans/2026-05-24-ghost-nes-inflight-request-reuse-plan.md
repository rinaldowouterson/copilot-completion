# Ghost & NES In-Flight Request Reuse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Ghost completion latency during fast typing by registering in-flight LLM requests BEFORE they complete (enabling reuse), and add reference-counted cancellation to NES, strictly aligned with reference project `fake-vscode-copilot-chat`.

**Architecture:** Ghost: Rewrite `AsyncCompletionsManager` with `ReplaySubject` per request so `getFirstMatchingRequest` subscribes to candidates and resolves when any completes. Refactor `GhostTextComputer` to register `queueCompletionRequest` with the real pending promise before awaiting. NES: Add `_pendingRequest` tracking with `liveDependants` reference counting so multiple callers can join one in-flight request.

**Tech Stack:** TypeScript, VS Code Extension API, custom DI container

---

### Task 1: Create Subject/ReplaySubject utilities

**Files:**
- Create: `src/common/subject.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\completions-core\vscode-node\lib\src\util\subject.ts`

- [ ] **Step 1: Create src/common/subject.ts**

```typescript
/**
 * Observer interface for the Subject.
 */
export interface Observer<T> {
    next: (value: T) => void;
    complete?: () => void;
    error?: (err: unknown) => void;
}

/** A simple implementation of an observable Subject. */
export class Subject<T> {
    private observers = new Set<Observer<T>>();

    constructor() { }

    subscribe(observer: Observer<T>): () => void {
        this.observers.add(observer);
        return () => this.observers.delete(observer);
    }

    next(value: T): void {
        for (const observer of this.observers) {
            observer.next(value);
        }
    }

    error(err: unknown): void {
        for (const observer of this.observers) {
            observer.error?.(err);
        }
    }

    complete(): void {
        for (const observer of this.observers) {
            observer.complete?.();
        }
    }
}

/** A variant of Subject that replays the last value to new subscribers. */
export class ReplaySubject<T> extends Subject<T> {
    private _value: T | undefined;

    override subscribe(observer: Observer<T>): () => void {
        const subscription = super.subscribe(observer);
        if (this._value !== undefined) { observer.next(this._value); }
        return subscription;
    }

    override next(value: T): void {
        this._value = value;
        super.next(value);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/common/subject.ts
git commit -m "feat: add Subject and ReplaySubject utility classes"
```

---

### Task 2: Add Deferred utility

**Files:**
- Modify: `src/common/async.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\completions-core\vscode-node\lib\src\util\async.ts`

- [ ] **Step 1: Append Deferred class to src/common/async.ts**

Append after the existing `GlobalIdleValue` class:

```typescript
/**
 * Deferred promise implementation to enable delayed promise resolution.
 */
export class Deferred<T> {
    resolve: (value: T | PromiseLike<T>) => void = () => {};
    reject: (reason?: unknown) => void = () => {};

    readonly promise: Promise<T> = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/common/async.ts
git commit -m "feat: add Deferred utility for manual promise resolution"
```

---

### Task 3: Rewrite asyncCompletions.ts with ReplaySubject pattern

**Files:**
- Modify: `src/completions/ghost/asyncCompletions.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\completions-core\vscode-node\lib\src\ghostText\asyncCompletions.ts`

- [ ] **Step 1: Replace asyncCompletions.ts entirely**

Key changes from current implementation:
1. Add `subject: ReplaySubject<AsyncCompletionRequest>` to `BaseAsyncCompletionRequest`
2. `queueCompletionRequest` registers as Pending immediately, returns `Promise<void>`, upgrades to Completed via `.then()` with `subject.next()` + `subject.complete()`
3. `updateCompletion` pushes partial updates via `subject.next(request)`
4. `getFirstMatchingRequest` uses `Deferred` + subscribes to candidates' `ReplaySubject` instead of iterating synchronously

```typescript
import { LRUCacheMap } from '../../common/lruCacheMap';
import { ReplaySubject } from '../../common/subject';
import { Deferred } from '../../common/async';
import { createServiceIdentifier } from '../../di/services';

export const IAsyncCompletionsManager = createServiceIdentifier<IAsyncCompletionsManager>('IAsyncCompletionsManager');

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

export interface AsyncCompletionResult {
    completionText: string;
    finishReason: string;
}

enum AsyncCompletionRequestState {
    Pending,
    Completed,
}

interface BaseAsyncCompletionRequest {
    cancellationTokenSource: { cancel(): void };
    headerRequestId: string;
    prefix: string;
    suffix: string;
    subject: ReplaySubject<AsyncCompletionRequest>;
    partialCompletionText?: string;
}

interface PendingAsyncCompletionRequest extends BaseAsyncCompletionRequest {
    state: AsyncCompletionRequestState.Pending;
}

interface CompletedAsyncCompletionRequest extends BaseAsyncCompletionRequest {
    state: AsyncCompletionRequestState.Completed;
    result: AsyncCompletionResult;
}

type AsyncCompletionRequest = PendingAsyncCompletionRequest | CompletedAsyncCompletionRequest;

export class AsyncCompletionsManager implements IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;

    private readonly _requests = new LRUCacheMap<string, AsyncCompletionRequest>(100);

    /** Lock: only the most recent requester can cancel stale requests. */
    private _mostRecentRequestId = '';

    shouldWaitForAsyncCompletions(prefix: string, suffix: string): boolean {
        for (const [, request] of this._requests) {
            if (_isCandidate(prefix, suffix, request)) {
                return true;
            }
        }
        return false;
    }

    updateCompletion(headerRequestId: string, text: string): void {
        const request = this._requests.get(headerRequestId);
        if (!request) return;
        request.partialCompletionText = text;
        request.subject.next(request);
    }

    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cts: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>,
    ): Promise<void> {
        const subject = new ReplaySubject<AsyncCompletionRequest>();
        this._requests.set(headerRequestId, {
            state: AsyncCompletionRequestState.Pending,
            cancellationTokenSource: cts,
            headerRequestId,
            prefix,
            suffix,
            subject,
        });

        return resultPromise
            .then(result => {
                this._requests.delete(headerRequestId);
                const completed: CompletedAsyncCompletionRequest = {
                    state: AsyncCompletionRequestState.Completed,
                    cancellationTokenSource: cts,
                    headerRequestId,
                    prefix,
                    suffix,
                    subject,
                    result,
                };
                this._requests.set(headerRequestId, completed);
                subject.next(completed);
                subject.complete();
            })
            .catch(() => {
                this._requests.delete(headerRequestId);
                subject.error(new Error('Request failed'));
            });
    }

    async getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
    ): Promise<AsyncCompletionResult | undefined> {
        this._mostRecentRequestId = headerRequestId;
        let resolved = false;
        const deferred = new Deferred<AsyncCompletionResult | undefined>();
        const subscriptions = new Map<string, () => void>();

        const finishRequest = (id: string) => () => {
            const subscription = subscriptions.get(id);
            if (subscription === undefined) return;
            subscription();
            subscriptions.delete(id);
            if (!resolved && subscriptions.size === 0) {
                resolved = true;
                deferred.resolve(undefined);
            }
        };

        const next = (request: AsyncCompletionRequest) => {
            if (_isCandidate(prefix, suffix, request)) {
                if (request.state === AsyncCompletionRequestState.Completed) {
                    const remainingPrefix = prefix.substring(request.prefix.length);
                    let { completionText } = request.result;
                    if (
                        !completionText.startsWith(remainingPrefix) ||
                        completionText.length <= remainingPrefix.length
                    ) {
                        finishRequest(request.headerRequestId)();
                        return;
                    }
                    completionText = completionText.substring(remainingPrefix.length);
                    deferred.resolve({ ...request.result, completionText });
                    resolved = true;
                }
            } else {
                this._cancelStaleRequest(headerRequestId, request);
                finishRequest(request.headerRequestId)();
            }
        };

        for (const [id, request] of this._requests) {
            if (_isCandidate(prefix, suffix, request)) {
                subscriptions.set(
                    id,
                    request.subject.subscribe({
                        next,
                        error: finishRequest(id),
                        complete: finishRequest(id),
                    })
                );
            } else {
                this._cancelStaleRequest(headerRequestId, request);
            }
        }

        return deferred.promise.finally(() => {
            for (const dispose of subscriptions.values()) {
                dispose();
            }
        });
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

    private _cancelStaleRequest(headerRequestId: string, request: AsyncCompletionRequest): void {
        if (headerRequestId !== this._mostRecentRequestId) return;
        if (request.state === AsyncCompletionRequestState.Completed) return;
        request.cancellationTokenSource.cancel();
        this._requests.delete(request.headerRequestId);
    }
}

function _isCandidate(prefix: string, suffix: string, request: AsyncCompletionRequest): boolean {
    if (request.suffix !== suffix) return false;
    if (!prefix.startsWith(request.prefix)) return false;
    const remainingPrefix = prefix.substring(request.prefix.length);
    if (request.state === AsyncCompletionRequestState.Completed) {
        return (
            request.result.completionText.startsWith(remainingPrefix) &&
            request.result.completionText.trimEnd().length > remainingPrefix.length
        );
    }
    if (request.partialCompletionText === undefined) return true;
    return request.partialCompletionText.startsWith(remainingPrefix);
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/asyncCompletions.ts
git commit -m "feat: rewrite AsyncCompletionsManager with ReplaySubject and subscription-based matching"
```

---

### Task 4: Refactor GhostTextComputer — register pending promise before await

**Files:**
- Modify: `src/completions/ghost/ghostTextComputer.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\completions-core\vscode-node\lib\src\ghostText\ghostText.ts` lines 523-558

- [ ] **Step 1: Remove the after-completion registration**

Delete the "Register with AsyncCompletionsManager for future reuse" block (lines 304-312 in current file):

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

Remove this entire block.

- [ ] **Step 2: Replace the network request section — register BEFORE await**

Replace the section from `const adapter = this._llmManager.getAdapter('completions');` through the `return` in the try block.

**Old code to replace (lines 224-319):**
The entire try block from `const adapter = ...` through the `return { completions: [ghostCompletion], ... }`.

**New code:**

```typescript
        const adapter = this._llmManager.getAdapter('completions');
        const ourRequestId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const asyncCancellationTokenSource = { cancel: () => abortController.abort() };

        try {
            // Initiate network request but DON'T await yet
            const requestPromise = adapter.send(
                {
                    baseUrl: this._config.baseUrl,
                    apiKey: this._config.apiKey,
                    model: this._config.model,
                    prompt,
                    max_tokens: effectiveTokens,
                    temperature: 0,
                    stop: (requestMultiline ? ['\n\n',"\n```"] : ['\n']).concat(this._config.stops),
                    top_p:1,
                    n:1,
                    stream: this._config.stream,
                    presence_penalty: this._config.presencePenalty,
                    frequency_penalty: this._config.frequencyPenalty,
                },
                abortController.signal,
            );

            // Register as pending IMMEDIATELY — before awaiting
            void this._asyncManager.queueCompletionRequest(
                ourRequestId,
                prefix,
                suffix,
                asyncCancellationTokenSource,
                requestPromise.then(response => ({
                    completionText: response.text,
                    finishReason: response.finishReason,
                })),
            );

            // Wait for result via async manager (handles both our own and reused requests)
            const asyncResult = await this._asyncManager.getFirstMatchingRequest(
                ourRequestId, prefix, suffix
            );

            if (!asyncResult) {
                this._log.info(`[GHOST] NO_RESULT — getFirstMatchingRequest returned undefined total=${Date.now() - t0}ms`);
                return undefined;
            }

            const networkMs = (Date.now() - t5);
            this._log.info(`[GHOST] NETWORK finish=${asyncResult.finishReason} text=${asyncResult.completionText.length}ch [${networkMs}ms]`);
            this._log.debug('\n'+asyncResult.completionText);

            // Step 9: Block trim
            const rawText = asyncResult.completionText;
            const blockTrimmedText = requestMultiline
                ? new VerboseBlockTrimmer().trim(rawText)
                : new TerseBlockTrimmer().trim(rawText);
            if (blockTrimmedText !== rawText) {
                this._log.debug(`[GHOST] block_trim ${rawText.length}→${blockTrimmedText.length}ch multiline=${requestMultiline}`);
            }

            // Step 10: Character-level suffix overlap
            const charTrimmedText = this._trimCharOverlap(blockTrimmedText, suffix);
            if (charTrimmedText !== blockTrimmedText) {
                this._log.info(`[GHOST] char_trim removed="${this._trunc(blockTrimmedText.slice(charTrimmedText.length), 40)}"`);
            }

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

            // Step 12: Post-process (adjustLeadingWhitespace, displayText separation)
            const processed = this._postProcessChoiceInContext(
                { text: trimmedText, finishReason: asyncResult.finishReason },
                document,
                position,
            );

            // Step 13: Calculated suffix coverage
            const suffixCoverage = this._calcSuffixCoverage(processed.text, suffix);

            this._log.info(`[GHOST] RESULT resultType=Network final=${processed.text.length}ch total=${Date.now() - t0}ms`);
            this._log.debug(`\n`+ processed.text);

            // Step 14: Cache & return
            const choices: CompletionChoice[] = [{
                text: processed.text,
                finishReason: asyncResult.finishReason,
            }];
            this._cache.append(prefix, suffix, choices[0]);

            // Step 13.5: Build GhostCompletion
            const ghostCompletion = this._toGhostCompletion(processed, document, position, isMiddleOfTheLine);

            // Store for typing-as-suggested on next keystroke
            this._currentGhostText.setGhostText(prefix, suffix, [ghostCompletion], ResultType.Network, asyncResult.finishReason);

            // Step 14: Return
            return {
                completions: [ghostCompletion],
                resultType: ResultType.Network,
                suffixCoverage,
            };
        } catch (err) {
            if ((err as {name?: string})?.name === 'AbortError') {
                this._log.info(`[GHOST] ABORTED after ${Date.now() - t0}ms`);
                return undefined;
            }
            this._log.error(`[GHOST] ERROR after ${Date.now() - t0}ms: ${err}`);
            return undefined;
        } finally {
            if (cancelTimer) clearTimeout(cancelTimer);
            cancelListener?.dispose();
        }
```

**Critical note:** The `old_string` for this edit must include everything from `const adapter = this._llmManager.getAdapter('completions');` through the closing `}` of the finally block (line 330). Use a multi-line unique tag to make the edit reliable. A safe anchor is the `const adapter` line at the start and the `}` closing `getGhostText` at the end of the finally block.

- [ ] **Step 3: Verify compilation**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/completions/ghost/ghostTextComputer.ts
git commit -m "feat: register Ghost LLM request as pending before awaiting, enabling in-flight reuse"
```

---

### Task 5: Add NES pending request tracking with reference counting

**Files:**
- Modify: `src/completions/nes/core/nesWorkflow.ts`

**Reference:** `E:\workspace\vscode\fake-vscode-copilot-chat\src\extension\inlineEdits\node\nextEditProvider.ts` lines 959-1004 (`_hookupCancellation`), lines 556-680 (in-flight check and join)

- [ ] **Step 1: Add PendingNesRequest interface and field to NesWorkflow**

Add import at top:

```typescript
import { Deferred } from '../../../common/async';
```

Add interface after existing interfaces (before `export class NesWorkflow`):

```typescript
interface PendingNesRequest {
    headerRequestId: string;
    documentUri: string;
    documentText: string;
    position: vscode.Position;
    abortController: AbortController;
    liveDependants: number;
    deferred: Deferred<NesExecutionResult>;
}
```

Add field to `NesWorkflow` class (after `_historyTracker`):

```typescript
private _pendingRequest: PendingNesRequest | undefined;
```

- [ ] **Step 2: Add pending request check at start of execute()**

Insert after `this._log.info('[NES] ===== START =====');` (after line 54) and before the cancellation check (line 56):

```typescript
        // Step 0.5: Check for pending in-flight request
        const docUri = document.uri.toString();
        const docText = document.getText();

        if (this._pendingRequest) {
            const pending = this._pendingRequest;
            const sameDoc = pending.documentUri === docUri && pending.documentText === docText;
            const cursorNearby = Math.abs(pending.position.line - position.line) <= 10;

            if (sameDoc && cursorNearby) {
                // Join existing pending request
                this._log.info(`[NES]  JOIN pending=${pending.headerRequestId} liveDependants=${pending.liveDependants}`);
                pending.liveDependants++;

                const cancelDisposable = token?.onCancellationRequested(() => {
                    pending.liveDependants--;
                    if (pending.liveDependants <= 0) {
                        this._log.info(`[NES]  ABORT — all dependants gone (1000ms delay)`);
                        setTimeout(() => {
                            if (pending.liveDependants <= 0) {
                                pending.abortController.abort();
                            }
                        }, 1000);
                    }
                });

                try {
                    const result = await pending.deferred.promise;
                    this._log.info(`[NES]  JOIN_RESULT edit=${result.editResult?.edit.length ?? 0}ch`);
                    return result;
                } finally {
                    pending.liveDependants--;
                    cancelDisposable?.dispose();
                }
            }

            // Document changed — clean up stale pending if no dependants
            if (pending.liveDependants <= 0) {
                this._log.debug(`[NES]  DISCARD stale pending request ${pending.headerRequestId}`);
                this._pendingRequest = undefined;
            }
        }
```

- [ ] **Step 3: Create pending request record when issuing new network request**

Before the network request section (before `const t4 = Date.now();` at line 103), add:

```typescript
        // Create pending request record for joiners
        const headerRequestId = `nes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const deferred = new Deferred<NesExecutionResult>();
        this._pendingRequest = {
            headerRequestId,
            documentUri: docUri,
            documentText: docText,
            position,
            abortController,  // will be assigned below before use
            liveDependants: 1,
            deferred,
        };
```

But wait — `abortController` is defined later (at line 106). We need to assign it after creation. Let me restructure.

Actually, a cleaner approach: create a helper method that sets up the pending request record, and call it right after creating the abortController.

Move the pending request initialization to after `const abortController = new AbortController();` (line 106):

Replace line 106:
```typescript
        const abortController = new AbortController();
```

With:
```typescript
        const abortController = new AbortController();
        const headerRequestId = `nes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const deferred = new Deferred<NesExecutionResult>();
        const pendingRequest: PendingNesRequest = {
            headerRequestId,
            documentUri: docUri,
            documentText: docText,
            position,
            abortController,
            liveDependants: 1,
            deferred,
        };
        // Cancel any previous pending (stale), register new one
        if (this._pendingRequest && this._pendingRequest.liveDependants <= 0) {
            this._pendingRequest.abortController.abort();
        }
        this._pendingRequest = pendingRequest;
```

- [ ] **Step 4: Resolve pending request deferred when result is ready**

In both result return paths, resolve the deferred before returning.

**Path A — streaming first edit found (around line 196-201):**

After `if (firstResult) {` and before `return { editResult: firstResult, ... }`, add:

```typescript
            // If first edit was found during streaming, return it immediately
            if (firstResult) {
                const totalMs = Date.now() - t0;
                this._log.info(`[NES]  RESULT (streaming) edit=${firstResult.edit.length}ch total=${totalMs}ms`);
                this._log.info(`edit = '${firstResult.edit}', editfull = '${firstResult.fullEditText}'\n range = (start = ${firstResult.range.start}, end =${firstResult.range.end}), cursorAfterEdit = ${firstResult.cursorAfterEdit}\njump = ${firstResult.isFromCursorJump}, ${firstResult.jumpToPosition}`);
                const nesResult = { editResult: firstResult, promptPieces: promptAssembly.promptPieces };
                deferred.resolve(nesResult);
                return nesResult;
            }
```

**Path B — fallback result (around line 245-249):**

After the fallback result is built and before `return { editResult: result, ... }`:

```typescript
            const nesResult = { editResult: result, promptPieces: promptAssembly.promptPieces };
            deferred.resolve(nesResult);
            return nesResult;
```

**Cancel/error paths — resolve with undefined:**

In the catch block (around line 251-257), before `return { editResult: undefined }`:

```typescript
            deferred.resolve({ editResult: undefined });
```

And in the finally block, clean up:

```typescript
        } finally {
            if (cancelTimer) clearTimeout(cancelTimer);
            cancelListener?.dispose();
            if (this._pendingRequest === pendingRequest) {
                this._pendingRequest = undefined;
            }
        }
```

- [ ] **Step 5: Verify compilation**

```bash
cd E:/workspace/vscode/copilot-completion && npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/completions/nes/core/nesWorkflow.ts
git commit -m "feat: add pending request tracking with reference counting to NES workflow"
```

---

### Task 6: Integration verification

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
git commit -m "fix: integration fixes for in-flight request reuse"
```

- [ ] **Step 4: Manual verification checklist**

1. Install the VSIX in VS Code
2. Open a TypeScript file
3. Enable both Ghost and NES completions
4. Type rapidly — observe debug logs
5. Expected: `[GHOST] async_wait` messages appear when reuse happens
6. Expected: `[GHOST] ASYNC_REUSE` messages appear when a pending request completes and is reused
7. Expected: `[NES] JOIN` messages appear when joining an existing NES request
8. Expected: Ghost completion appears with reduced latency during fast typing

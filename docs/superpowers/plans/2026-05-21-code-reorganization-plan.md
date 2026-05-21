# Code Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the cc-completion codebase by consolidating scattered definitions, merging trivial files, moving shared code to common/, deleting unused code. Zero behavior changes.

**Architecture:** Sequential restructuring — each task moves/deletes/merges files then verifies via `tsc --noEmit`. The `src/common/` directory becomes the single home for base utilities. GHOST type files are consolidated. NES stubs lose their general-purpose utilities to common/.

**Tech Stack:** TypeScript 5.9, VSCode Extension API 1.110, webpack

---

### Task 1: Create src/common/ directory and scaffold

**Files:**
- Create: `src/common/` (directory only)

- [ ] **Step 1: Create the common directory**

```bash
mkdir -p src/common
```

- [ ] **Step 2: Verify creation**

```bash
ls -d src/common/
```
Expected: `src/common/`

---

### Task 2: Move base/common/* files to src/common/

**Files:**
- Move: `src/base/common/async.ts` → `src/common/async.ts`
- Move: `src/base/common/errors.ts` → `src/common/errors.ts`
- Move: `src/base/common/event.ts` → `src/common/event.ts`
- Move: `src/base/common/lifecycle.ts` → `src/common/lifecycle.ts`
- Move: `src/base/common/linkedList.ts` → `src/common/linkedList.ts`
- Modify: `src/di/instantiation.ts:8`
- Modify: `src/di/instantiationService.ts:8,9,10,11,16`

- [ ] **Step 1: Move the files**

```bash
mv src/base/common/async.ts src/common/async.ts
mv src/base/common/errors.ts src/common/errors.ts
mv src/base/common/event.ts src/common/event.ts
mv src/base/common/lifecycle.ts src/common/lifecycle.ts
mv src/base/common/linkedList.ts src/common/linkedList.ts
```

- [ ] **Step 2: Update `src/di/instantiation.ts` line 8 — change lifecycle import**

Old:
```typescript
import { DisposableStore } from '../base/common/lifecycle';
```
New:
```typescript
import { DisposableStore } from '../common/lifecycle';
```

- [ ] **Step 3: Update `src/di/instantiationService.ts` lines 8-11, 16 — change all base/common imports**

Old:
```typescript
import { GlobalIdleValue } from '../base/common/async';
import { Event } from '../base/common/event';
import { illegalState } from '../base/common/errors';
import { DisposableStore, dispose, IDisposable, isDisposable, toDisposable } from '../base/common/lifecycle';
```
```typescript
import { LinkedList } from '../base/common/linkedList';
```
New:
```typescript
import { GlobalIdleValue } from '../common/async';
import { Event } from '../common/event';
import { illegalState } from '../common/errors';
import { DisposableStore, dispose, IDisposable, isDisposable, toDisposable } from '../common/lifecycle';
```
```typescript
import { LinkedList } from '../common/linkedList';
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors (or only pre-existing errors unrelated to these changes)

- [ ] **Step 5: Commit**

```bash
git add src/common/ src/di/instantiation.ts src/di/instantiationService.ts
git add src/base/ 2>/dev/null || true
git commit -m "refactor: move base/common utilities to src/common/"
```

---

### Task 3: Move NES stubs utilities to src/common/

**Files:**
- Move: `src/completions/nes/stubs/arrays.ts` → `src/common/arrays.ts`
- Move: `src/completions/nes/stubs/assert.ts` → `src/common/assert.ts`
- Move: `src/completions/nes/stubs/result.ts` → `src/common/result.ts`
- Modify: `src/completions/nes/diffHistoryForPrompt.ts:7`
- Modify: `src/completions/nes/recentFilesForPrompt.ts:5`
- Modify: `src/completions/nes/promptCrafting.ts:6,7,8`
- Modify: `src/completions/nes/nextCursorPredictor.ts:9`
- Modify: `src/test/nes/core/nextCursorPredictor.test.ts:3`

- [ ] **Step 1: Move the files**

```bash
mv src/completions/nes/stubs/arrays.ts src/common/arrays.ts
mv src/completions/nes/stubs/assert.ts src/common/assert.ts
mv src/completions/nes/stubs/result.ts src/common/result.ts
```

- [ ] **Step 2: Update `src/completions/nes/diffHistoryForPrompt.ts` line 7**

Old:
```typescript
import { groupAdjacentBy, pushMany } from './stubs/arrays';
```
New:
```typescript
import { groupAdjacentBy, pushMany } from '../../../common/arrays';
```

- [ ] **Step 3: Update `src/completions/nes/recentFilesForPrompt.ts` line 5**

Old:
```typescript
import { batchArrayElements } from './stubs/arrays';
```
New:
```typescript
import { batchArrayElements } from '../../../common/arrays';
```

- [ ] **Step 4: Update `src/completions/nes/promptCrafting.ts` lines 6-8**

Old:
```typescript
import { Result } from './stubs/result';
import { range } from './stubs/arrays';
import { assertNever } from './stubs/assert';
```
New:
```typescript
import { Result } from '../../../common/result';
import { range } from '../../../common/arrays';
import { assertNever } from '../../../common/assert';
```

- [ ] **Step 5: Update `src/completions/nes/nextCursorPredictor.ts` line 9**

Old:
```typescript
import { Result } from './stubs/result';
```
New:
```typescript
import { Result } from '../../../common/result';
```

- [ ] **Step 6: Update `src/test/nes/core/nextCursorPredictor.test.ts` line 3**

Old:
```typescript
import { Result } from '../../../completions/nes/stubs/result';
```
New:
```typescript
import { Result } from '../../../common/result';
```

- [ ] **Step 7: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors related to arrays/assert/result imports

- [ ] **Step 8: Commit**

```bash
git add src/common/arrays.ts src/common/assert.ts src/common/result.ts
git add src/completions/nes/diffHistoryForPrompt.ts src/completions/nes/recentFilesForPrompt.ts src/completions/nes/promptCrafting.ts src/completions/nes/nextCursorPredictor.ts
git add src/test/nes/core/nextCursorPredictor.test.ts
git add src/completions/nes/stubs/ 2>/dev/null || true
git commit -m "refactor: move general-purpose nes stubs to src/common/"
```

---

### Task 4: Move suffixOverlapTrim to src/common/

**Files:**
- Move: `src/completions/nes/suffixOverlapTrim.ts` → `src/common/suffixOverlapTrim.ts`
- Modify: `src/completions/ghost/ghostTextComputer.ts:13`
- Modify: `src/completions/nes/core/editResultAssembler.ts:7`
- Modify: `src/test/nes/suffixOverlapTrim.test.ts:2`

- [ ] **Step 1: Move the file**

```bash
mv src/completions/nes/suffixOverlapTrim.ts src/common/suffixOverlapTrim.ts
```

- [ ] **Step 2: Update `src/completions/ghost/ghostTextComputer.ts` line 13**

Old:
```typescript
import { TrimNESResponseSuffixOverlap } from '../nes/suffixOverlapTrim';
```
New:
```typescript
import { TrimNESResponseSuffixOverlap } from '../../common/suffixOverlapTrim';
```

- [ ] **Step 3: Update `src/completions/nes/core/editResultAssembler.ts` line 7**

Old:
```typescript
import { TrimNESResponseSuffixOverlap } from '../suffixOverlapTrim';
```
New:
```typescript
import { TrimNESResponseSuffixOverlap } from '../../../common/suffixOverlapTrim';
```

- [ ] **Step 4: Update `src/test/nes/suffixOverlapTrim.test.ts` line 2**

Old:
```typescript
import { TrimNESResponseSuffixOverlap } from '../../completions/nes/suffixOverlapTrim';
```
New:
```typescript
import { TrimNESResponseSuffixOverlap } from '../../common/suffixOverlapTrim';
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors related to suffixOverlapTrim imports

- [ ] **Step 6: Commit**

```bash
git add src/common/suffixOverlapTrim.ts
git add src/completions/ghost/ghostTextComputer.ts src/completions/nes/core/editResultAssembler.ts
git add src/test/nes/suffixOverlapTrim.test.ts
git add src/completions/nes/ 2>/dev/null || true
git commit -m "refactor: move suffixOverlapTrim to src/common/ (shared by ghost + nes)"
```

---

### Task 5: Merge resultType.ts into ghost/types.ts

**Files:**
- Modify: `src/completions/ghost/types.ts` — add ResultType enum
- Modify: `src/completions/ghost/ghostTextComputer.ts:15` — change import
- Delete: `src/completions/ghost/resultType.ts`

- [ ] **Step 1: Add `ResultType` enum to `src/completions/ghost/types.ts`**

Append at the end of the file:
```typescript
export enum ResultType {
    Network = 0,
    Cache = 1,
    TypingAsSuggested = 2,
    Cycling = 3,
    Async = 4,
}
```

- [ ] **Step 2: Update `src/completions/ghost/ghostTextComputer.ts` line 15**

Old:
```typescript
import { ResultType } from './resultType';
```
New:
```typescript
import { ResultType } from './types';
```

(Note: `ghostTextComputer.ts` already imports from `./types` on line 14. Merge the imports:)

Old (lines 14-15):
```typescript
import { DiagnosticSummary, GhostCompletion } from './types';
import { ResultType } from './resultType';
```
New (lines 14-15):
```typescript
import { DiagnosticSummary, GhostCompletion, ResultType } from './types';
```

- [ ] **Step 3: Delete `src/completions/ghost/resultType.ts`**

```bash
rm src/completions/ghost/resultType.ts
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors related to ResultType

- [ ] **Step 5: Commit**

```bash
git add src/completions/ghost/types.ts src/completions/ghost/ghostTextComputer.ts
git add src/completions/ghost/resultType.ts 2>/dev/null || true
git commit -m "refactor: merge resultType.ts into ghost/types.ts"
```

---

### Task 6: Merge current.ts + last.ts into ghostTextState.ts

**Files:**
- Create: `src/completions/ghost/ghostTextState.ts`
- Modify: `src/completions/ghost/ghostTextComputer.ts:9,10`
- Modify: `src/completions/ghost/inlineCompletion.ts:4,5`
- Delete: `src/completions/ghost/current.ts`
- Delete: `src/completions/ghost/last.ts`

- [ ] **Step 1: Create `src/completions/ghost/ghostTextState.ts`**

Content (merged from current.ts + last.ts):
```typescript
import * as vscode from 'vscode';

export interface CurrentGhostTextState {
    completionText: string;
    uri: vscode.Uri;
    version: number;
}

export class CurrentGhostText {
    private _state: CurrentGhostTextState | undefined;

    setGhostText(uri: vscode.Uri, version: number, completionText: string): void {
        this._state = { completionText, uri, version };
    }

    getCompletionsForUserTyping(
        uri: vscode.Uri,
        version: number,
    ): string | undefined {
        if (!this._state) return undefined;
        if (this._state.uri.toString() !== uri.toString()) return undefined;
        if (this._state.version !== version) return undefined;
        return this._state.completionText;
    }

    hasAcceptedCurrentCompletion(): boolean {
        return false;
    }
}

export class LastGhostText {
    resetState(): void {}
}
```

- [ ] **Step 2: Update `src/completions/ghost/ghostTextComputer.ts` lines 9-10**

Old:
```typescript
import { CurrentGhostText } from './current';
import { LastGhostText } from './last';
```
New:
```typescript
import { CurrentGhostText, LastGhostText } from './ghostTextState';
```

- [ ] **Step 3: Update `src/completions/ghost/inlineCompletion.ts` lines 4-5**

Old:
```typescript
import { CurrentGhostText } from './current';
import { LastGhostText } from './last';
```
New:
```typescript
import { CurrentGhostText, LastGhostText } from './ghostTextState';
```

- [ ] **Step 4: Delete old files**

```bash
rm src/completions/ghost/current.ts
rm src/completions/ghost/last.ts
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors related to CurrentGhostText or LastGhostText

- [ ] **Step 6: Commit**

```bash
git add src/completions/ghost/ghostTextState.ts
git add src/completions/ghost/ghostTextComputer.ts src/completions/ghost/inlineCompletion.ts
git add src/completions/ghost/current.ts src/completions/ghost/last.ts 2>/dev/null || true
git commit -m "refactor: merge current.ts and last.ts into ghostTextState.ts"
```

---

### Task 7: Merge nes/stubs/errors.ts into common/errors.ts

**Files:**
- Modify: `src/common/errors.ts` — add BugIndicatingError and illegalArgument
- Modify: `src/completions/nes/xtabCurrentDocument.ts:1` — update import
- Modify: `src/completions/nes/recentFilesForPrompt.ts:6` — update import
- Delete: `src/completions/nes/stubs/errors.ts`

- [ ] **Step 1: Add BugIndicatingError and illegalArgument to `src/common/errors.ts`**

Current content of `src/common/errors.ts`:
```typescript
// Minimal stub: provides only what the DI code needs

export function illegalState(name?: string): Error {
    if (name) {
        return new Error(`Illegal state: ${name}`);
    } else {
        return new Error('Illegal state');
    }
}
```

New content:
```typescript
// Minimal stub: provides only what the DI code needs

export function illegalState(name?: string): Error {
    if (name) {
        return new Error(`Illegal state: ${name}`);
    } else {
        return new Error('Illegal state');
    }
}

export class BugIndicatingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BugIndicatingError';
    }
}

export function illegalArgument(message: string): Error {
    return new Error(`Illegal argument: ${message}`);
}
```

- [ ] **Step 2: Update `src/completions/nes/xtabCurrentDocument.ts` line 1**

Old:
```typescript
import { BugIndicatingError } from './stubs/errors';
```
New:
```typescript
import { BugIndicatingError } from '../../../common/errors';
```

- [ ] **Step 3: Update `src/completions/nes/recentFilesForPrompt.ts` line 6**

Old:
```typescript
import { illegalArgument } from './stubs/errors';
```
New:
```typescript
import { illegalArgument } from '../../../common/errors';
```

- [ ] **Step 4: Delete `src/completions/nes/stubs/errors.ts`**

```bash
rm src/completions/nes/stubs/errors.ts
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors related to BugIndicatingError or illegalArgument

- [ ] **Step 6: Commit**

```bash
git add src/common/errors.ts
git add src/completions/nes/xtabCurrentDocument.ts src/completions/nes/recentFilesForPrompt.ts
git add src/completions/nes/stubs/errors.ts 2>/dev/null || true
git commit -m "refactor: merge nes/stubs/errors.ts into common/errors.ts"
```

---

### Task 8: Delete unused production files

**Files:**
- Delete: `src/completions/ghost/normalizeIndent.ts`
- Delete: `src/completions/ghost/requestContext.ts`
- Delete: `src/completions/nes/speculativeRequest.ts`
- Delete: `src/completions/nes/cursorLineDivergence.ts`
- Delete: `src/completions/nes/nesProvider.ts`
- Delete: `src/completions/nes/core/diffComputer.ts`
- Delete: `src/completions/nes/editRebase.ts`
- Delete: `src/completions/nes/editIntent.ts`
- Delete: `src/completions/nes/responseFormatHandlers.ts`

- [ ] **Step 1: Delete all unused production files**

```bash
rm src/completions/ghost/normalizeIndent.ts
rm src/completions/ghost/requestContext.ts
rm src/completions/nes/speculativeRequest.ts
rm src/completions/nes/cursorLineDivergence.ts
rm src/completions/nes/nesProvider.ts
rm src/completions/nes/core/diffComputer.ts
rm src/completions/nes/editRebase.ts
rm src/completions/nes/editIntent.ts
rm src/completions/nes/responseFormatHandlers.ts
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors (these files had zero production references)

- [ ] **Step 3: Commit**

```bash
git add src/completions/ghost/normalizeIndent.ts src/completions/ghost/requestContext.ts 2>/dev/null || true
git add src/completions/nes/speculativeRequest.ts src/completions/nes/cursorLineDivergence.ts src/completions/nes/nesProvider.ts 2>/dev/null || true
git add src/completions/nes/core/diffComputer.ts 2>/dev/null || true
git add src/completions/nes/editRebase.ts src/completions/nes/editIntent.ts src/completions/nes/responseFormatHandlers.ts 2>/dev/null || true
git commit -m "refactor: delete unused production files (9 files)"
```

---

### Task 9: Delete unused test files

**Files:**
- Delete: `src/test/nes/editRebase.test.ts`
- Delete: `src/test/nes/responseFormatHandlers.test.ts`

- [ ] **Step 1: Delete the test files**

```bash
rm src/test/nes/editRebase.test.ts
rm src/test/nes/responseFormatHandlers.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add src/test/nes/editRebase.test.ts src/test/nes/responseFormatHandlers.test.ts 2>/dev/null || true
git commit -m "refactor: delete tests for removed unused code"
```

---

### Task 10: Remove unused named exports

**Files:**
- Modify: `src/completions/nes/tags.ts` — remove ResponseTags namespace
- Modify: `src/completions/ghost/types.ts` — remove CompletionResult, GhostTextOptions
- Modify: `src/completions/nes/stubs/languageContext.ts` — remove export from SnippetContext, LanguageContextItem

- [ ] **Step 1: Remove `ResponseTags` namespace from `src/completions/nes/tags.ts`**

Delete lines 41-55 (the entire `ResponseTags` namespace block):

Delete:
```typescript
export namespace ResponseTags {
    export const NO_EDIT = '<NO_EDIT>';

    export const NO_CHANGE = {
        start: '<NO_CHANGE>'
    };
    export const EDIT = {
        start: '<EDIT>',
        end: '</EDIT>'
    };
    export const INSERT = {
        start: '<INSERT>',
        end: '</INSERT>'
    };
}
```

Keep `PromptTags` namespace (lines 1-39) intact.

- [ ] **Step 2: Remove `CompletionResult` and `GhostTextOptions` from `src/completions/ghost/types.ts`**

Delete these two interface blocks:

```typescript
export interface CompletionResult {
    completion: GhostCompletion;
    isMiddleOfTheLine: boolean;
    suffixCoverage: number;
}

export interface GhostTextOptions {
    isSpeculative: boolean;
    delay: number;
}
```

Keep: `GhostCompletion`, `DiagnosticSummary`, and the newly added `ResultType` enum.

- [ ] **Step 3: Remove `export` from `SnippetContext` and `LanguageContextItem` in `src/completions/nes/stubs/languageContext.ts`**

These types are used internally by `LanguageContextResponse` (which IS imported externally), but are never imported directly by consumers.

Change line 7:
```typescript
// Old:
export interface SnippetContext {
// New:
interface SnippetContext {
```

Change line 19:
```typescript
// Old:
export interface LanguageContextItem {
// New:
interface LanguageContextItem {
```

Keep: `export enum ContextKind`, `export interface TraitContext`, `export interface LanguageContextResponse`.

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/completions/nes/tags.ts src/completions/ghost/types.ts src/completions/nes/stubs/languageContext.ts
git commit -m "refactor: remove unused named exports"
```

---

### Task 11: Consolidate duplicate LineRange0Based definition

**Files:**
- Modify: `src/completions/nes/similarFilesContextService.ts` — remove local definition, import from types
- Modify: `src/completions/nes/types.ts` — no change needed (definition already present)

- [ ] **Step 1: Update `src/completions/nes/similarFilesContextService.ts`**

Old (lines 1-4):
```typescript
export interface LineRange0Based {
    startLine: number;
    endLineExclusive: number;
}
```
Replace with:
```typescript
import { LineRange0Based } from './types';
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No errors — LineRange0Based is already exported from types.ts with identical shape

- [ ] **Step 3: Commit**

```bash
git add src/completions/nes/similarFilesContextService.ts
git commit -m "refactor: consolidate duplicate LineRange0Based definition into types.ts"
```

---

### Task 12: Remove empty base/ directory

**Files:**
- Delete: `src/base/` (empty directory)

- [ ] **Step 1: Remove the empty directory tree**

```bash
rmdir src/base/common/ 2>/dev/null || true
rmdir src/base/ 2>/dev/null || true
```

- [ ] **Step 2: Verify no references remain**

```bash
grep -r "base/common" src/ || echo "No references to base/common remain"
```
Expected: `No references to base/common remain`

- [ ] **Step 3: Commit**

```bash
git add src/base/ 2>/dev/null || true
git commit -m "chore: remove empty src/base/ directory"
```

---

### Task 13: Remove nesProvider reference from extension.ts (if any) and final verification

**Files:**
- Modify: `src/extension.ts` — verify and clean up if needed

- [ ] **Step 1: Check if extension.ts references nesProvider**

```bash
grep -n "nesProvider" src/extension.ts || echo "No reference found"
```
Expected: `No reference found` (confirmed earlier — extension.ts imports from nextEditProvider, not nesProvider)

- [ ] **Step 2: Run full lint check**

```bash
npm run lint 2>&1
```
Expected: Zero errors (ignore pre-existing warnings)

- [ ] **Step 3: Run webpack compile**

```bash
npm run compile 2>&1
```
Expected: Successful compilation, no errors

- [ ] **Step 4: Run tests**

```bash
npm test 2>&1
```
Expected: All tests pass (the 2 deleted test files are gone)

- [ ] **Step 5: Final commit**

```bash
git add -A
git status
git commit -m "chore: final verification after code reorganization"
```

---

## Dependency Order

Tasks must execute sequentially in numeric order. Each task depends on the previous:
```
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10 → Task 11 → Task 12 → Task 13
```

No task can be parallelized since each modifies imports that subsequent tasks depend on.

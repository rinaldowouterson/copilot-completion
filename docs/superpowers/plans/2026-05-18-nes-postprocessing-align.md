# NES Post-processing Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align NES completion data post-processing (NextEditResult type + _toInlineItems) with reference implementation so VS Code correctly renders completion results.

**Architecture:** Extend NextEditResult type with displayLocation/cacheEntry/jumpToPosition fields. Add InlineSuggestionResolver class for ghost-text feasibility detection. Rewrite _buildResult to compute actual edit window range from document offsets. Rewrite _toInlineItems with inline suggestion resolution and nesMimicGhostTextBehavior gating.

**Tech Stack:** TypeScript, VS Code Extension API, Mocha + assert

---

### Task 1: Config Keys and Types

**Files:**
- Modify: `src/config/configKeys.ts`
- Modify: `src/config/nesConfig.ts`
- Modify: `src/completions/nes/nextEditCache.ts`
- Modify: `src/completions/nes/types.ts`

- [ ] **Step 1: Add mimicGhostTextBehavior key to configKeys.ts**

```typescript
// In src/config/configKeys.ts, add one line inside the Nes block (after nextCursorPredictionEnabled):
Nes: {
    // ... existing keys ...
    nextCursorPredictionEnabled: 'cc-completion.nes.nextCursorPrediction.enabled',
    mimicGhostTextBehavior: 'cc-completion.nes.mimicGhostTextBehavior',  // ADD THIS LINE
}
```

- [ ] **Step 2: Add mimicGhostTextBehavior getter to nesConfig.ts**

```typescript
// In src/config/nesConfig.ts, add to INesConfigProvider interface (after nextCursorPredictionEnabled):
get mimicGhostTextBehavior(): boolean;

// In src/config/nesConfig.ts, add to VSCodeNesConfigProvider class (after nextCursorPredictionEnabled getter):
get mimicGhostTextBehavior(): boolean {
    return vscode.workspace.getConfiguration()
        .get<boolean>(ConfigKeys.Nes.mimicGhostTextBehavior, false);
}
```

- [ ] **Step 3: Add wasRenderedAsInlineSuggestion to CachedEdit in nextEditCache.ts**

```typescript
// In src/completions/nes/nextEditCache.ts, add to CachedEdit interface:
export interface CachedEdit {
    docId: string;
    docContentHash: string;
    editWindow: { startLine: number; endLineExclusive: number };
    edit: string;
    cacheTime: number;
    /** Set when this edit was returned as an inline (ghost text) suggestion */
    wasRenderedAsInlineSuggestion?: boolean;  // ADD THIS LINE
}
```

- [ ] **Step 4: Extend NextEditResult in types.ts**

```typescript
// In src/completions/nes/types.ts, replace the NextEditResult interface:

export interface NextEditResult {
    /** The full edit text (content of edit window after modification) */
    edit: string;
    /** Range in the document to replace with edit text */
    range: vscode.Range;
    /** Predicted cursor position after accepting the edit */
    cursorAfterEdit?: vscode.Position;
    /** Display location for VS Code rendering */
    displayLocation?: {
        range: vscode.Range;
        label: string;
    };
    /** Reference to cache entry, for wasRenderedAsInlineSuggestion write-back */
    cacheEntry?: import('./nextEditCache').CachedEdit;
    /** Whether this result came from a cursor jump request */
    isFromCursorJump: boolean;
    /** If set, this is a cursor-jump-only suggestion with no text edit */
    jumpToPosition?: vscode.Position;
    /** Cursor prediction metadata (for predict-retry flow) */
    cursorPrediction?: CursorJumpPrediction;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/config/configKeys.ts src/config/nesConfig.ts src/completions/nes/nextEditCache.ts src/completions/nes/types.ts
git commit -m "feat: add mimicGhostTextBehavior config and extend NextEditResult type"
```

---

### Task 2: InlineSuggestionResolver — Test

**Files:**
- Create: `src/test/nes/core/inlineSuggestionResolver.test.ts`

- [ ] **Step 1: Write test file**

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { InlineSuggestionResolver } from '../../../completions/nes/core/inlineSuggestionResolver';

/** Minimal mock TextDocument sufficient for InlineSuggestionResolver tests */
function mockDoc(lines: string[]): vscode.TextDocument {
    const content = lines.join('\n');
    return {
        lineCount: lines.length,
        lineAt: (line: number) => ({
            text: lines[line] ?? '',
            range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
        }),
        offsetAt: (pos: vscode.Position) => {
            let offset = 0;
            for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
            return offset + pos.character;
        },
        positionAt: (offset: number) => {
            let line = 0;
            let remaining = offset;
            while (line < lines.length && remaining > lines[line].length) {
                remaining -= lines[line].length + 1;
                line++;
            }
            return new vscode.Position(line, Math.max(0, remaining));
        },
        getText: (range?: vscode.Range) => {
            if (!range) return content;
            const startOff = (this as any).offsetAt(range.start);
            const endOff = (this as any).offsetAt(range.end);
            return content.substring(startOff, endOff);
        },
    } as unknown as vscode.TextDocument;
}

suite('InlineSuggestionResolver', () => {
    const resolver = new InlineSuggestionResolver();

    test('returns undefined when range spans multiple lines after strip', () => {
        const doc = mockDoc([
            'function foo() {',
            '    return 1;',
            '    // extra',
            '}',
        ]);
        const range = new vscode.Range(0, 0, 3, 1);
        const newText = 'function foo() {\n    return 2;\n    // extra\n}';
        const result = resolver.resolve(new vscode.Position(0, 16), doc, range, newText);
        assert.strictEqual(result, undefined);
    });

    test('returns adjusted range for same-line ghost text at cursor', () => {
        const doc = mockDoc(['const x = Math.|']);
        const cursorPos = new vscode.Position(0, 14); // at the pipe position
        const range = new vscode.Range(0, 14, 0, 14); // empty range at cursor
        const newText = 'Math.max(1, 2)';
        const result = resolver.resolve(cursorPos, doc, range, newText);
        assert.ok(result);
        assert.strictEqual(result.newText, 'Math.max(1, 2)');
        assert.strictEqual(result.range.start.character, 14);
    });

    test('returns undefined when cursor is before range start', () => {
        const doc = mockDoc(['const x = oldValue;']);
        const range = new vscode.Range(0, 10, 0, 18); // replaces "oldValue"
        const newText = 'newValue';
        // cursor at position 5 (before range start)
        const result = resolver.resolve(new vscode.Position(0, 5), doc, range, newText);
        assert.strictEqual(result, undefined);
    });

    test('returns undefined when prefix before cursor does not match', () => {
        const doc = mockDoc(['prefixXYZsuffix']);
        const range = new vscode.Range(0, 6, 0, 9); // "XYZ"
        const newText = 'ABC';
        // cursor at position 7, replaced text before cursor is "X" but newText before cursor is "A"
        const result = resolver.resolve(new vscode.Position(0, 7), doc, range, newText);
        assert.strictEqual(result, undefined);
    });

    test('strips common line prefix for multi-line edit', () => {
        const doc = mockDoc([
            'line1: same prefix',
            'line2: same prefix but different end',
            'line3: different',
        ]);
        const range = new vscode.Range(0, 0, 2, 18);
        const newText = [
            'line1: same prefix',
            'line2: same prefix with changes',
            'line3: different',
        ].join('\n');
        // cursor at end of line 1
        const result = resolver.resolve(new vscode.Position(1, 31), doc, range, newText);
        // should strip the common "line1: same prefix\n" and reduce to 2 lines
        assert.ok(result);
        assert.strictEqual(result.range.start.line, 1);
        assert.strictEqual(result.range.end.line, 2);
    });

    test('handles next-line insertion rewrite', () => {
        const doc = mockDoc(['const a = 1', '']);
        const cursorPos = new vscode.Position(0, 11); // end of line 0
        // empty-range insertion at start of next line with trailing newline
        const range = new vscode.Range(1, 0, 1, 0);
        const newText = 'const b = 2;\n';
        const result = resolver.resolve(cursorPos, doc, range, newText);
        assert.ok(result);
        assert.strictEqual(result.range.start.line, 0);
        assert.strictEqual(result.range.start.character, 11);
        // newText should be lineBreak + trimmed newText
        assert.ok(result.newText.includes('const b = 2;'));
    });

    test('isSubword returns true for subsequence', () => {
        assert.strictEqual(InlineSuggestionResolver.isSubword('abc', 'axbyc'), true);
        assert.strictEqual(InlineSuggestionResolver.isSubword('abc', 'abc'), true);
    });

    test('isSubword returns false for non-subsequence', () => {
        assert.strictEqual(InlineSuggestionResolver.isSubword('abc', 'def'), false);
        assert.strictEqual(InlineSuggestionResolver.isSubword('ab', 'ba'), false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails (class not yet implemented)**

```bash
npx mocha --require ts-node/register src/test/nes/core/inlineSuggestionResolver.test.ts
```
Expected: FAIL with "Cannot find module '../../../completions/nes/core/inlineSuggestionResolver'"

- [ ] **Step 3: Commit**

```bash
git add src/test/nes/core/inlineSuggestionResolver.test.ts
git commit -m "test: add InlineSuggestionResolver tests"
```

---

### Task 3: InlineSuggestionResolver — Implementation

**Files:**
- Create: `src/completions/nes/core/inlineSuggestionResolver.ts`

- [ ] **Step 1: Write implementation**

```typescript
import * as vscode from 'vscode';

export interface InlineSuggestionEdit {
    readonly range: vscode.Range;
    readonly newText: string;
}

/**
 * Determines whether an edit can be displayed as an inline (ghost text) suggestion
 * at the cursor position. If so, returns the possibly-adjusted range and text.
 */
export class InlineSuggestionResolver {

    resolve(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        const nextLineInsertion = this._tryAdjustNextLineInsertion(cursorPos, doc, range, newText);
        if (nextLineInsertion) {
            return nextLineInsertion;
        }

        let effectiveRange = range;
        let effectiveText = newText;

        if (effectiveRange.start.line !== effectiveRange.end.line) {
            const stripped = this._stripCommonLinePrefix(doc, effectiveRange, effectiveText);
            effectiveRange = stripped.range;
            effectiveText = stripped.newText;
        }

        if (effectiveRange.start.line !== effectiveRange.end.line || effectiveRange.start.line !== cursorPos.line) {
            return undefined;
        }

        return this._validateSameLineGhostText(cursorPos, doc, effectiveRange, effectiveText);
    }

    private _tryAdjustNextLineInsertion(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        if (!range.isEmpty) return undefined;
        if (cursorPos.line + 1 !== range.start.line || range.start.character !== 0) return undefined;
        if (doc.lineAt(cursorPos.line).text.length !== cursorPos.character) return undefined;

        const targetLineFullyConsumed = doc.lineAt(range.end.line).text.length === range.end.character;
        const noLeftoverAfterInsertion = newText.endsWith('\n') || (newText.includes('\n') && targetLineFullyConsumed);
        if (!noLeftoverAfterInsertion) return undefined;

        const lineBreak = doc.getText(new vscode.Range(cursorPos, range.start));
        const trimmedNewText = newText.replace(/\r?\n$/, '');
        return { range: new vscode.Range(cursorPos, cursorPos), newText: lineBreak + trimmedNewText };
    }

    private _stripCommonLinePrefix(
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): { range: vscode.Range; newText: string } {
        const replacedText = doc.getText(range);
        const maxLen = Math.min(replacedText.length, newText.length);
        let commonLen = 0;
        while (commonLen < maxLen && replacedText[commonLen] === newText[commonLen]) {
            commonLen++;
        }
        if (commonLen === 0) return { range, newText };

        const lastNewline = replacedText.lastIndexOf('\n', commonLen - 1);
        if (lastNewline < 0) return { range, newText };

        const strippedLen = lastNewline + 1;
        const newStart = doc.positionAt(doc.offsetAt(range.start) + strippedLen);
        return { range: new vscode.Range(newStart, range.end), newText: newText.substring(strippedLen) };
    }

    private _validateSameLineGhostText(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        const replacedText = doc.getText(range);
        const cursorOffsetInReplacedText = cursorPos.character - range.start.character;
        if (cursorOffsetInReplacedText < 0) return undefined;
        if (
            replacedText.substring(0, cursorOffsetInReplacedText) !==
            newText.substring(0, cursorOffsetInReplacedText)
        ) {
            return undefined;
        }
        if (!InlineSuggestionResolver.isSubword(replacedText, newText)) return undefined;
        return { range, newText };
    }

    static isSubword(a: string, b: string): boolean {
        for (let aIdx = 0, bIdx = 0; aIdx < a.length; bIdx++) {
            if (bIdx >= b.length) return false;
            if (a[aIdx] === b[bIdx]) aIdx++;
        }
        return true;
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npx mocha --require ts-node/register src/test/nes/core/inlineSuggestionResolver.test.ts
```
Expected: all 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/completions/nes/core/inlineSuggestionResolver.ts
git commit -m "feat: add InlineSuggestionResolver for ghost text feasibility detection"
```

---

### Task 4: NesWorkflow._buildResult Rewrite

**Files:**
- Modify: `src/completions/nes/core/nesWorkflow.ts`

- [ ] **Step 1: Rewrite _buildResult method**

Replace the existing `_buildResult` (lines 245-256) with:

```typescript
private _buildResult(
    edit: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    cacheEntry?: CachedEdit,
): NextEditResult {
    const documentLines = document.getText().split('\n');
    const ewRange = this._editWindowResolver.resolve(documentLines, position.line);

    const startLine = ewRange.start;
    const endLineExclusive = Math.min(ewRange.endExclusive, document.lineCount);

    const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLineExclusive, 0),
    );

    const nextLine = Math.min(position.line + 1, document.lineCount - 1);

    return {
        edit,
        range,
        cursorAfterEdit: new vscode.Position(nextLine, 0),
        displayLocation: {
            range,
            label: `L${startLine + 1}-L${endLineExclusive}`,
        },
        cacheEntry,
        isFromCursorJump: false,
    };
}
```

- [ ] **Step 2: Update cache hit call site in execute()**

In `execute()`, change the cache hit path (around line 66-73) to pass `cached`:

```typescript
const cached = this._cache.lookupNextEdit(document.uri.toString(), document);
if (cached) {
    this._log.info(`[NES]  CACHE_HIT edit=${cached.edit.length}ch age=${Date.now() - cached.cacheTime}ms total=${Date.now() - t0}ms`);
    if (token?.isCancellationRequested) {
        this._log.info(`[NES]  CANCEL after_cache_hit`);
        return this._emptyResult(document, position);
    }
    const result = this._buildResult(cached.edit, document, position, cached);
    return { editResult: result, promptPieces: null! };
}
```

- [ ] **Step 3: Update new cache call site in execute()**

In `execute()`, change the cache storage + build result path (around line 148-163) to extract `cacheEntry`:

```typescript
// Step 6: Cache result
const cacheEntry: CachedEdit = {
    docId: document.uri.toString(),
    docContentHash: this._hash(docText),
    editWindow: {
        startLine: Math.max(0, position.line - 2),
        endLineExclusive: position.line + 6,
    },
    edit: finalEdit,
    cacheTime: Date.now(),
};
this._cache.setKthNextEdit(document.uri.toString(), cacheEntry);

const totalMs = Date.now() - t0;
this._log.info(`[NES]  RESULT edit=${finalEdit.length}ch preview="${this._trunc(finalEdit, 100)}" total=${totalMs}ms`);

const result = this._buildResult(finalEdit, document, position, cacheEntry);
return { editResult: result, promptPieces };
```

- [ ] **Step 4: Add CachedEdit import**

Ensure `CachedEdit` is imported at the top of nesWorkflow.ts:

```typescript
import { CachedEdit, INextEditCache } from '../nextEditCache';
```

- [ ] **Step 5: Compile to verify no type errors**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```
Expected: no errors related to nesWorkflow.ts

- [ ] **Step 6: Commit**

```bash
git add src/completions/nes/core/nesWorkflow.ts
git commit -m "feat: rewrite _buildResult to compute actual edit window range and pass cacheEntry"
```

---

### Task 5: NextEditProvider._toInlineItems Rewrite

**Files:**
- Modify: `src/completions/nes/nextEditProvider.ts`

- [ ] **Step 1: Add imports for InlineSuggestionResolver**

At the top of `nextEditProvider.ts`, add:

```typescript
import { InlineSuggestionResolver } from './core/inlineSuggestionResolver';
```

- [ ] **Step 2: Add InlineSuggestionResolver property**

In the `NextEditProvider` class, add a private property:

```typescript
private readonly _inlineSuggestionResolver = new InlineSuggestionResolver();
```

- [ ] **Step 3: Rewrite _toInlineItems method**

Replace the existing `_toInlineItems` method (lines 128-138) with:

```typescript
private _toInlineItems(
    result: NextEditResult,
    document: vscode.TextDocument,
    cursorPosition: vscode.Position,
): vscode.InlineCompletionItem[] {
    // 1. Cursor jump: create jump-to-position item (no insertText)
    if (result.jumpToPosition) {
        const item = new vscode.InlineCompletionItem('', result.range);
        item.jumpToPosition = result.jumpToPosition;
        return [item];
    }

    // 2. Try to convert to inline (ghost text) suggestion
    const inline = this._inlineSuggestionResolver.resolve(
        cursorPosition,
        document,
        result.range,
        result.edit,
    );

    // 3. Gate: suppress if was previously shown as inline but now can't be
    if (
        this._config.mimicGhostTextBehavior
        && result.cacheEntry?.wasRenderedAsInlineSuggestion
        && !inline
    ) {
        this._log.debug(`[NES]  suppressing cached suggestion — was inline, now not`);
        return [];
    }

    // 4. Mark cache entry as rendered inline
    if (inline && result.cacheEntry) {
        result.cacheEntry.wasRenderedAsInlineSuggestion = true;
    }

    // 5. Use adjusted range/text if inline, otherwise full edit window
    const range = inline?.range ?? result.range;
    const insertText = inline?.newText ?? result.edit;

    // 6. Build item
    const item = new vscode.InlineCompletionItem(insertText, range);

    if (result.displayLocation) {
        item.displayLocation = result.displayLocation;
    }

    if (result.cursorPrediction) {
        item.command = {
            title: 'NES cursor jump',
            command: 'cc-completion.nes.cursorJump',
            arguments: [result.cursorPrediction],
        };
    }

    return [item];
}
```

- [ ] **Step 4: Update call sites for _toInlineItems**

In `provideInlineCompletionItems`, update the two call sites:

**Call site 1** (primary NES, around line 69-72):

```typescript
const { editResult, promptPieces } = await this._workflow.execute(document, position, token);

if (editResult) {
    return this._toInlineItems(editResult, document, position);
}
```

**Call site 2** (cursor prediction retry, around line 115-122):

```typescript
const { editResult: retryResult } = await this._workflow.execute(
    document, position, token, predictedPos,
);

if (retryResult) {
    retryResult.cursorPrediction = prediction;
    return this._toInlineItems(retryResult, document, position);
}
```

- [ ] **Step 5: Compile to verify no type errors**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```
Expected: no errors related to nextEditProvider.ts

- [ ] **Step 6: Commit**

```bash
git add src/completions/nes/nextEditProvider.ts
git commit -m "feat: rewrite _toInlineItems with InlineSuggestionResolver and mimicGhostTextBehavior gate"
```

---

### Task 6: Integration Verification

- [ ] **Step 1: Run all NES tests**

```bash
npx mocha --require ts-node/register "src/test/nes/**/*.test.ts"
```
Expected: all tests pass, including the new InlineSuggestionResolver tests

- [ ] **Step 2: Full TypeScript compilation check**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors

- [ ] **Step 3: Run extension tests (if available)**

```bash
npm test
```

- [ ] **Step 4: Commit any final adjustments**

```bash
git add -A
git commit -m "chore: final integration verification for NES post-processing alignment"
```

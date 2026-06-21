# Task 5 Report: Modify Async path to apply _trimLineSuffixOverlap

**Status:** ✅ Complete  
**Commit:** `1861936`  
**Compilation:** ✅ `npx tsc --noEmit` — no errors  

## Summary

Modified the Async (in-flight request reuse) block in `ghostTextComputer.ts` to apply `_trimLineSuffixOverlap()` before `_postProcessChoiceInContext()`, consistent with the Network path order: **line trim → postProcess → toGhostCompletion**.

### Change Details

- **File:** `src/completions/ghost/ghostTextComputer.ts` (~line 148)
- **What changed:** Inserted `_trimLineSuffixOverlap(asyncResult.completionText, suffix)` call before constructing the `CompletionChoice` object
- **Result:** The `trimmedAsyncText` is used instead of raw `asyncResult.completionText`

## Concerns

None.

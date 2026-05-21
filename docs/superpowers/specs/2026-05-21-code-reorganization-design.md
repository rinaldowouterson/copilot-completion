# Code Reorganization Design

**Date:** 2026-05-21
**Status:** approved

## Goal

Reorganize the `cc-completion` VSCode extension codebase: consolidate scattered definitions, move common code to shared folders, group module code together, delete unused code, follow OOP design principles and patterns. **Functionality must remain unchanged.**

## Target Directory Structure

```
src/
├── common/                              # Shared base utilities
│   ├── async.ts                         #  ← base/common/async.ts
│   ├── errors.ts                        #  ← base/common/errors.ts
│   ├── event.ts                         #  ← base/common/event.ts
│   ├── lifecycle.ts                     #  ← base/common/lifecycle.ts
│   ├── linkedList.ts                    #  ← base/common/linkedList.ts
│   ├── arrays.ts                        #  ← nes/stubs/arrays.ts
│   ├── assert.ts                        #  ← nes/stubs/assert.ts
│   ├── result.ts                        #  ← nes/stubs/result.ts
│   └── suffixOverlapTrim.ts             #  ← nes/suffixOverlapTrim.ts (shared by GHOST + NES)
│
├── di/                                  # DI framework (import paths updated)
│   ├── descriptors.ts
│   ├── graph.ts
│   ├── instantiation.ts
│   ├── instantiationService.ts
│   ├── serviceCollection.ts
│   └── services.ts
│
├── config/                              # Configuration (unchanged)
│   ├── configKeys.ts
│   ├── ghostConfig.ts
│   └── nesConfig.ts
│
├── completions/
│   ├── shared/                          # GHOST/NES shared infrastructure (unchanged)
│   │   ├── llm/
│   │   │   ├── llmAdapter.ts
│   │   │   ├── llmRequest.ts
│   │   │   ├── anthropicAdapter.ts
│   │   │   ├── openaiChatAdapter.ts
│   │   │   ├── openaiCompletionAdapter.ts
│   │   │   ├── openaiResponseAdapter.ts
│   │   │   └── sseStream.ts
│   │   └── log/
│   │       └── logService.ts
│   │
│   ├── ghost/                           # GHOST module (unused files removed)
│   │   ├── types.ts
│   │   ├── resultType.ts
│   │   ├── asyncCompletions.ts
│   │   ├── blockTrimmer.ts
│   │   ├── completionsCache.ts
│   │   ├── current.ts
│   │   ├── ghostTextComputer.ts
│   │   ├── ghostTextProvider.ts
│   │   ├── inlineCompletion.ts
│   │   ├── inlineSuggestion.ts
│   │   ├── last.ts
│   │   ├── promptFactory.ts
│   │   ├── radix.ts
│   │   ├── recentEditsProvider.ts
│   │   └── multiline/
│   │       └── ... (unchanged)
│   │
│   └── nes/                             # NES module (unused files removed, general utils extracted)
│       ├── types.ts
│       ├── nextEditProvider.ts
│       ├── nextEditCache.ts
│       ├── promptCrafting.ts
│       ├── promptCraftingUtils.ts
│       ├── tags.ts
│       ├── xtabCurrentDocument.ts
│       ├── lintErrors.ts
│       ├── recentFilesForPrompt.ts
│       ├── similarFilesContextService.ts
│       ├── nextCursorPredictor.ts
│       ├── diffHistoryForPrompt.ts
│       ├── stubs/                       # NES-specific stubs only
│       │   ├── abstractText.ts
│       │   ├── languageContext.ts
│       │   ├── network.ts
│       │   ├── offsetRange.ts
│       │   ├── position.ts
│       │   ├── positionToOffsetImpl.ts
│       │   ├── stringEdit.ts
│       │   ├── types.ts
│       │   └── errors.ts
│       ├── core/
│       │   ├── nesWorkflow.ts
│       │   ├── promptAssembler.ts
│       │   ├── editResultAssembler.ts
│       │   ├── editWindowResolver.ts
│       │   ├── inlineSuggestionResolver.ts
│       │   └── nesHistoryTracker.ts
│       └── response/
│           ├── responsePipeline.ts
│           ├── responseDiffer.ts
│           ├── editFilterChain.ts
│           └── lineReplacement.ts
│
├── ui/                                  # UI (unchanged)
│   └── statusBarPanel.ts
│
└── extension.ts                         # Entry point (import paths updated)
```

## Files to Delete

### Production files (9)

| File | Reason |
|---|---|
| `ghost/normalizeIndent.ts` | Zero references |
| `ghost/requestContext.ts` | Zero references |
| `nes/speculativeRequest.ts` | Zero references |
| `nes/cursorLineDivergence.ts` | Zero references |
| `nes/nesProvider.ts` | Zero references (NextEditProvider is the actual entry point) |
| `nes/core/diffComputer.ts` | Zero references (superseded by ResponseDiffer) |
| `nes/editRebase.ts` | Test-only reference, incomplete implementation |
| `nes/editIntent.ts` | Test-only reference |
| `nes/responseFormatHandlers.ts` | Test-only reference |

### Test files (3)

| File | Reason |
|---|---|
| `test/nes/editRebase.test.ts` | Source file deleted |
| `test/nes/responseFormatHandlers.test.ts` | Source files deleted (editIntent.ts + responseFormatHandlers.ts) |

## Files to Move

| File | From | To | Reason |
|---|---|---|---|
| 5 files in `base/common/` | `src/base/common/` | `src/common/` | Merge base utilities |
| `nes/stubs/arrays.ts` | `src/completions/nes/stubs/` | `src/common/` | General-purpose utility |
| `nes/stubs/assert.ts` | `src/completions/nes/stubs/` | `src/common/` | General-purpose utility |
| `nes/stubs/result.ts` | `src/completions/nes/stubs/` | `src/common/` | General-purpose utility |
| `nes/suffixOverlapTrim.ts` | `src/completions/nes/` | `src/common/` | Shared by GHOST and NES |

## Duplicate Definitions to Consolidate

- `LineRange0Based` is defined in both `similarFilesContextService.ts` and `types.ts`. The version in `similarFilesContextService.ts` is unused externally. Keep the one in `types.ts`.

## Unused Named Exports to Remove

| Export | File | Reason |
|---|---|---|
| `ResponseTags` | `tags.ts` | Zero references |
| `SnippetContext` | `stubs/languageContext.ts` | Zero explicit imports (internal type only) |
| `LanguageContextItem` | `stubs/languageContext.ts` | Zero explicit imports (internal type only) |

## Import Path Updates

Files affected by the restructuring will have their imports updated. Key impacts:

- `di/instantiation.ts` — `base/common/` → `common/`
- `di/instantiationService.ts` — `base/common/` → `common/`
- All files importing from `nes/stubs/arrays`, `nes/stubs/assert`, `nes/stubs/result` — updated to `common/`
- `ghost/ghostTextComputer.ts` — `nes/suffixOverlapTrim` → `common/suffixOverlapTrim`
- `nes/core/editResultAssembler.ts` — `../suffixOverlapTrim` → `common/suffixOverlapTrim`
- `extension.ts` — remove `nesProvider` import, update moved file imports

## Design Patterns (Existing, Preserved)

The codebase already employs several appropriate patterns which will be preserved:

- **Chain of Responsibility** — `ResponsePipeline` (`IResponseStage`) and `EditFilterChain` (`IEditFilter`)
- **Strategy** — `IMultilineStrategy` / `DefaultMultilineStrategy`
- **Dependency Injection** — VSCode-style `IInstantiationService` + `createServiceIdentifier`
- **Facade** — `NesWorkflow` encapsulates the complex NES pipeline
- **Repository** — `NextEditCache` for NES result caching

No new patterns are introduced as part of this reorganization — the goal is structural cleanup, not functional redesign.

## Verification

- `npm run compile` must succeed with zero errors
- `npm run lint` must pass
- `npm test` must pass (with deleted test files removed)
- All existing functionality must be preserved — no behavior changes

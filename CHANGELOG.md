# Change Log

## [Unreleased]

### Added — LSP-first context pipeline
- **Phase A — LSP import resolution with file-system fallback**: relative paths are now mandatory on `ImportResolution` and computed once during `gather()` (workspace-relative with `./` prefix).
- **Phase B — LSP `SelectionRange` for statement boundaries** with heuristic fallback. The existing `findStatementEnd` is now async `(document, position) → number`; the heuristic is exposed as `findStatementEndHeuristic`.
- **Phase C — Hover enrichment for cross-file type signatures** (`executeHoverProvider`). Top-5 exports per imported file receive a `name:type` signature in the prompt. Falls back to `name:Kind` when hover is unavailable.
- **Phase D — LSP detection + hourly notification**: missing LSP triggers a once-per-hour, per-language info message with four actions — "Install Directly" (in-IDE via `workbench.extensions.installExtension`, prerequisite first for Python), "Show in Extensions Marketplace" (internal `vscode:extension/<id>` URI with marketplace URL fallback), "Copy install command", or "Dismiss".
- **Phase G — Local type hierarchy for OOP**: `prepareTypeHierarchy` + `provideTypeHierarchySupertypes` adds super-types to `ContextBundle.superTypes` (capped at 5).
- **Phase H — Auto-import suggestions via LSP `executeCodeActionProvider`**: missing-import diagnostics are converted into NES inline completion items with `additionalTextEdits`. Pure LSP, zero model tokens.

### Prompt format (new)
- File exports: single-line `// exports: name:type, name:type, ... (+N more)` with all-or-nothing truncation.
- Imports: wrapped in `<|imports|>...</|imports|>` with workspace-relative paths (`./Button.tsx`).
- Scopes: `<scope>`/`<|scope|>` tag with optional single-super-type extension.

### Planned (Phase I — TODO)
- Broader LSP auto-fix integration: organize imports, remove unused, lint fixes,
  formatting, refactoring suggestions. See `.plans/2026-06-30-lsp-first-context-pipeline-plan.md` (Phase I).

## 1.0.2 (2026-06-21)

- 修复 `GHOST` 命中缓存后，后缀未修正问题

## 1.0.2 (2026-05-23)

- 修复 `GHOST` 与 `NES` 同时开启时，补全延迟过高问题

## 1.0.1 (2026-05-22)

- 配置实时更新
- 完善请求参数

## 1.0.0 (2026-05-22)

- 实现 NES 功能
- 实现 GHOST 功能

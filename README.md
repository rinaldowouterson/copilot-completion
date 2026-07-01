# Copilot Completion

> [github copilot chat](https://github.com/microsoft/vscode-copilot-chat)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Code completion VS Code extension powered by LLMs — supporting both **GHOST** (Fill-in-the-Middle) inline completions and **NES** (Next Edit Suggestion) predictive edits.

[中文文档](README.zh-CN.md)

## Features

### GHOST — Fill-in-the-Middle (FIM) Inline Completion

- Ghost-text inline suggestions displayed directly in the editor as you type
- Prefix/suffix context sent to the model via configurable FIM prompt template
- **Multi-line detection chain**: ML model scoring, empty block detection, suffix presence, file size guard, and newline detection
- Tree-sitter powered block parsing for intelligent completion boundaries
- Suffix overlap trimming with configurable similarity thresholds
- Caching and debouncing for responsive UX

### NES — Next Edit Suggestion

- Predicts the developer's **next edit** anywhere in the current file (not just at the cursor)
- **Edit window** resolution around the cursor with merge conflict marker awareness
- **Cursor jump prediction**: anticipates where the developer will navigate next. **This feature is not good for normal LLM.**
- **Edit intent classification**: high / medium / low aggressiveness filtering
- Response post-processing pipeline: boundary marker parsing → cursor tag stripping → line-level diff → suffix overlap trimming
- Multiple response format handlers: edit-window, code-block, edit-intent, unified XML, custom diff-patch

### Supported LLM Backends

| Adapter | API Endpoint | Best For |
|---|---|---|
| `OpenAIChatAdapter` | `/chat/completions` | NES |
| `OpenAICompletionAdapter` | `/completions` | Native FIM (GHOST) |

> [!tip]
> - `Qwen2.5 coder` is good for `GHOST`, which can run in local and provide better suggestion.
> - `Qwen3.5 9B MIT` performs well for `GHOST` and `NES` individually. **however, running this LLM locally and using it for both GHOST and NES simultaneously will lead to slow inference when your computer lacks sufficient performance. The beast way is that `GHOST` and `NES` use different LLM.** 

## Configuration

All settings are under the `cc-completion` prefix.

### GHOST Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `ghost.baseUrl` | `string` | `""` | API base URL |
| `ghost.apiKey` | `string` | `""` | API key |
| `ghost.model` | `string` | `"gpt-4o"` | Model name |
| `ghost.stops` | `string[]` | `[]` | Stop sequences for response generation |
| `ghost.promptTemplate` | `string` | `<\|fim_prefix\|>{prefix}<\|fim_suffix\|>{suffix}<\|fim_middle\|>` | FIM prompt template |
| `ghost.capabilities.limits.max_output_tokens` | `number` | `512` | Max output tokens (hard cap) |
| `ghost.capabilities.limits.max_context_window_tokens` | `number` | `128000` | Max context window tokens |
| `ghost.capabilities.limits.delay` | `number` | `150` | Minimum delay (ms) between network requests |
| `ghost.suffixOverlapThreshold` | `number` | `0.6` | Suffix overlap similarity threshold |
| `ghost.suffixOverlapType` | `"low"` \| `"high"` | `"low"` | Overlap detection mode |
| `ghost.presencePenalty` | `number` | `1` | Presence penalty (-2 to 2) |
| `ghost.frequencyPenalty` | `number` | `0.2` | Frequency penalty (-2 to 2) |
| `ghost.stream` | `boolean` | `true` | Enable SSE streaming |

### NES Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `nes.baseUrl` | `string` | `""` | API base URL |
| `nes.apiKey` | `string` | `""` | API key |
| `nes.model` | `string` | `"gpt-4o"` | Model name |
| `nes.supportedEndpoint` | `"chat/completions"` | `"chat/completions"` | LLM API endpoint |
| `nes.family` | `"standard"` \| `"openai-o"` \| `"openai-gpt5"` \| `"deepseek"` \| `"qwen"` | `"standard"` | Model family for NES thinking mode |
| `nes.capabilities.limits.max_output_tokens` | `number` | `8192` | Max output tokens (hard cap) |
| `nes.capabilities.limits.max_context_window_tokens` | `number` | `128000` | Max context window tokens |
| `nes.capabilities.supports.thinking` | `boolean` | `false` | Model supports thinking/reasoning |
| `nes.capabilities.supports.reasoning_effort` | `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | — | Supported reasoning effort level |
| `nes.suffixOverlapThreshold` | `number` | `0.9` | Suffix overlap similarity threshold |
| `nes.suffixOverlapType` | `"low"` \| `"high"` | `"high"` | Overlap detection mode |
| `nes.presencePenalty` | `number` | `1` | Presence penalty (-2 to 2) |
| `nes.frequencyPenalty` | `number` | `0.2` | Frequency penalty (-2 to 2) |
| `nes.stream` | `boolean` | `true` | Enable SSE streaming |

## Commands

| Command | Description |
|---|---|
| `CC Completion: Toggle Panel` | Toggle the status bar panel visibility |

## Requirements

- VS Code `^1.110.0`

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Production build
npm run package

# Lint
npm run lint
```

## Architecture

```
src/
├── completions/
│   ├── ghost/          # GHOST: FIM inline completion
│   │   └── multiline/  # Multi-line detection chain + tree-sitter
│   ├── nes/            # NES: Next Edit Suggestion
│   │   ├── core/       # Workflow, history, edit-window, result assembly
│   │   ├── response/   # Response pipeline, differ, filter chain
│   │   └── stubs/      # Data type stubs
│   └── shared/         # Shared LLM adapters and log service
├── common/             # Shared utilities (arrays, result type, suffix trim, context bundle)
├── completions/context/# Context pipeline: LSP-first imports, hover, type hierarchy, auto-import
├── config/             # Configuration providers (GHOST + NES)
├── di/                 # Dependency injection container
├── test/               # Test suites
└── ui/                 # Status bar panel
```

## Language Support

cc-completion uses VS Code's Language Server Protocol (LSP) to enrich the
prompt context with **cross-file information** — import resolution,
hover-derived type signatures, exact statement boundaries, class hierarchy,
and missing-import diagnostics.

The completion itself (GHOST fill-in-the-middle, NES edit prediction) is
**file-local** — it operates on prefix/suffix of the current document. The
LSP only matters for the *context* the model sees before the prefix.

### When does an LSP matter?

| Language characteristic | LSP impact |
|---|---|
| Many cross-file imports (`from .foo import bar`) | **High** — hover signatures on imports dramatically reduce model hallucination |
| Class/interface hierarchies (Java, C#, OOP TS) | **High** — super-types disambiguate method overrides |
| Single-file scripts (SQL, PowerShell, simple Bash) | **None** — no imports, no cross-file refs; the notification would be noise |
| Built-in TS server (TS/JS) | **None** — VS Code ships the TS server, no extension needed |

### Recommended LSP extensions

Languages where our context pipeline materially benefits:

| Language | LSP extension | Publisher | Prerequisite |
|---|---|---|---|
| TypeScript / JavaScript | *(built-in TS server)* | Microsoft | — |
| Python | `ms-python.vscode-pylance` | Microsoft | `ms-python.python` (Python extension — interpreter discovery) |
| C# | `ms-dotnettools.csharp` | Microsoft | — (Roslyn LSP is bundled) |
| C / C++ | `ms-vscode.cpptools` | Microsoft | — |
| Java | `redhat.java` | Red Hat | — |
| Go | `golang.go` | Go Team | — |
| Rust | `rust-lang.rust-analyzer` | rust-lang | — |
| PHP | `bmewburn.vscode-intelephense-client` | Ben Mewburn | — |
| Ruby | `shopify.ruby-lsp` | Shopify | — |
| Dart | `dart-code.dart-code` | Dart Code | — |
| Lua | `sumneko.lua` | sumneko | — |

When a language server is missing, cc-completion falls back to regex-based
import extraction and a heuristic statement-end scanner, and shows a
once-per-hour-per-language info message with four actions:

1. **Install Directly** — installs the extension in-IDE via the internal
   `workbench.extensions.installExtension` command. VS Code shows the
   trust-publisher dialog ("Do you trust the publisher X?"); click
   "Yes, I trust" to complete the install. A progress notification
   ("Installing X…") stays visible until the install actually finishes
   (detected via `extensions.onDidChange`), then the cooldown is reset
   so the next completion picks up the new LSP. For Python, the
   prerequisite extension (`ms-python.python`) is installed first and
   waited on before the LSP install starts.
2. **Show in Extensions Marketplace** — opens the extension's detail
   page in VS Code's Extensions view via the internal
   `vscode:extension/<id>` URI. User reads the description / reviews and
   clicks Install themselves. Falls back to the marketplace URL in the
   browser if the internal URI is rejected.
3. **Copy install command** — copies `code --install-extension …` to the
   clipboard (with the prerequisite prepended for Python) so you can
   paste it into a terminal.
4. **Dismiss** — closes the notification.

Without an LSP, the prompt context will be less rich (no hover signatures,
no class hierarchy, no missing-import detection).

### Languages intentionally NOT in the map

| Language | Reason |
|---|---|
| SQL (`ms-mssql.mssql`) | One file = one query batch — no imports, no useful hover |
| PowerShell (`ms-vscode.powershell`) | One file = one script — same reasoning |
| Markdown / JSON / YAML | Data formats, not programming languages |

## License

[MIT](LICENSE.txt)

import { createServiceIdentifier } from '../../di/services';
import { DiagnosticSummary } from './types';
import {
    ContextBundle,
    FileExport,
    ImportResolution,
} from '../../common/contextBundle';

export const IGhostPromptFactory = createServiceIdentifier<IGhostPromptFactory>('IGhostPromptFactory');

export interface IGhostPromptFactory {
    readonly _serviceBrand: undefined;
    createPrompt(params: {
        template: string;
        prefix: string;
        suffix: string;
        languageId: string;
        diagnostics: DiagnosticSummary[];
        recentEdits: string[];
        context?: ContextBundle;
    }): string;
}

/** Shared helper used by both GHOST and NES to determine comment prefix per language. */
export function getCommentPrefix(languageId: string): string {
    const hashLanguages = new Set([
        'python', 'ruby', 'shellscript', 'bash', 'yaml', 'toml', 'perl', 'r',
    ]);
    if (hashLanguages.has(languageId)) {
        return '#';
    }
    return '//';
}

/**
 * Tokens per character — coarse estimator. ~0.25 token per char
 * (one token ≈ 4 chars). Used for the all-or-nothing export
 * truncation budget.
 */
function estimateTokens(s: string): number {
    return Math.ceil(s.length / 4);
}

/**
 * All-or-nothing export truncation.
 *
 * Format: `name:type` per export. If the next export doesn't fit in
 * the remaining budget, skip it entirely. After at least one export
 * has been included, optionally emit a `name:…` placeholder (ellipsis
 * signals truncated type) when only the name fits.
 *
 * Never produce a truncated signature like `UserService:class{getUse…`
 * — that confuses the model more than no signature at all.
 */
export function buildExportsLine(
    exports: ReadonlyArray<FileExport>,
    maxTokens: number = 100,
): string {
    const prefix = 'exports: ';
    const parts: string[] = [];
    let currentTokens = estimateTokens(prefix);

    for (const exp of exports) {
        const type = exp.type ?? exp.kind;
        const fullPart = `${exp.name}:${type}`;
        const fullTokens = estimateTokens(fullPart) + 1; // +1 for comma

        if (currentTokens + fullTokens <= maxTokens) {
            parts.push(fullPart);
            currentTokens += fullTokens;
            continue;
        }

        // Doesn't fit — try name-only placeholder
        const placeholder = `${exp.name}:…`;
        const placeholderTokens = estimateTokens(placeholder) + 1;
        if (parts.length > 0 && currentTokens + placeholderTokens <= maxTokens) {
            parts.push(placeholder);
            currentTokens += placeholderTokens;
        }
        // Either way: stop here, report skipped count below
        break;
    }

    const skipped = exports.length - parts.length;
    if (skipped > 0) parts.push(`... (+${skipped} more)`);

    return prefix + parts.join(', ');
}

/**
 * Build a single-line import section for a single `ImportResolution`.
 * Format: `./relative/path.ext: name:type, name:type`
 */
export function buildImportLine(imp: ImportResolution): string {
    const parts: string[] = [];
    for (const exp of imp.exports.slice(0, 8)) {
        const sig = imp.typeSignatures?.[exp.name];
        const type = sig ?? exp.type ?? exp.kind;
        parts.push(`${exp.name}:${type}`);
    }
    return `${imp.relativePath}: ${parts.join(', ')}`;
}

/**
 * Cap on the total imports section (multi-line). Keeps the prompt
 * bounded. Per-line caps may still apply for very wide files.
 */
const IMPORTS_MAX_LINES = 5;

export class GhostPromptFactory implements IGhostPromptFactory {
    readonly _serviceBrand: undefined;

    createPrompt(params: {
        template: string;
        prefix: string;
        suffix: string;
        languageId: string;
        diagnostics: DiagnosticSummary[];
        recentEdits: string[];
        context?: ContextBundle;
    }): string {
        const contextLines: string[] = [];
        const commentPrefix = getCommentPrefix(params.languageId);

        // Language ID
        contextLines.push(`${commentPrefix} language: ${params.languageId}`);

        // Diagnostics (cap at 5)
        if (params.diagnostics.length > 0) {
            for (const d of params.diagnostics.slice(0, 5)) {
                contextLines.push(`${commentPrefix} diagnostics: [Line ${d.line}] ${d.message}`);
            }
        }

        // Recent edits
        if (params.recentEdits.length > 0) {
            contextLines.push(`${commentPrefix} recent edits:`);
            for (const edit of params.recentEdits) {
                contextLines.push(`${commentPrefix} ${edit}`);
            }
        }

        // Phase H: missing imports (informational — actual import is via LSP code action)
        if (params.context?.missingImports && params.context.missingImports.length > 0) {
            const parts = params.context.missingImports.slice(0, 5)
                .map(m => m.sourceModule ? `${m.symbolName} from ${m.sourceModule}` : m.symbolName);
            contextLines.push(`${commentPrefix} missing: ${parts.join(', ')}`);
        }

        // Context bundle: enclosing scope
        if (params.context?.enclosingScope) {
            const scope = params.context.enclosingScope;
            // Phase G: single super-type inline; multiple super-types are surfaced by NES
            // via a separate `<|super_types|>` tag (NES-only).
            contextLines.push(`${commentPrefix} scope: ${scope.kind} ${scope.name} (line ${scope.startLine}–${scope.endLine})`);
        }

        // Context bundle: file exports (single-line, all-or-nothing truncation)
        if (params.context?.fileExports && params.context.fileExports.length > 0) {
            const line = buildExportsLine(params.context.fileExports, 100);
            contextLines.push(`${commentPrefix} ${line}`);
        }

        // Context bundle: import resolutions — wrapped in <|imports|> tag
        // (multi-source content needs explicit boundaries so the model
        // knows this list is from imports, not the current file).
        if (params.context?.importResolutions && params.context.importResolutions.length > 0) {
            const imports = params.context.importResolutions.slice(0, IMPORTS_MAX_LINES);
            const importLines = imports.map(imp => `${commentPrefix} ${buildImportLine(imp)}`);
            contextLines.push('<|imports|>');
            for (const line of importLines) contextLines.push(line);
            contextLines.push('<|/imports|>');
        }

        const context = contextLines.join('\n') + '\n';
        return params.template
            .replace(/\{prefix\}/g, '\n' + context + params.prefix)
            .replace(/\{suffix\}/g, '\n' + params.suffix + '\n');
    }
}

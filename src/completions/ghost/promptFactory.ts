import { createServiceIdentifier } from '../../di/services';
import { DiagnosticSummary } from './types';
import { ContextBundle } from '../../common/contextBundle';

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

        // Context bundle: enclosing scope
        if (params.context?.enclosingScope) {
            const scope = params.context.enclosingScope;
            contextLines.push(`${commentPrefix} scope: ${scope.kind} ${scope.name} (line ${scope.startLine}–${scope.endLine})`);
        }

        // Context bundle: file exports
        if (params.context?.fileExports && params.context.fileExports.length > 0) {
            const names = params.context.fileExports.map(e => `${e.name} (${e.kind})`).join(', ');
            contextLines.push(`${commentPrefix} file exports: ${names}`);
        }

        // Context bundle: import resolutions (cap at 5)
        if (params.context?.importResolutions && params.context.importResolutions.length > 0) {
            for (const imp of params.context.importResolutions.slice(0, 5)) {
                const pathLabel = imp.uri.split('/').pop() || imp.uri;
                const names = imp.exports.map(e => e.name).join(', ');
                contextLines.push(`${commentPrefix} import ${pathLabel} → ${names}`);
            }
        }

        const context = contextLines.join('\n') + '\n';
        return params.template
            .replace(/\{prefix\}/g, '\n' + context + params.prefix)
            .replace(/\{suffix\}/g, '\n' + params.suffix + '\n');
    }
}

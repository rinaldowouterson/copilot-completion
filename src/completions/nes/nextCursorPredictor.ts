import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { ILLMAdapterManager } from '../shared/llm/llmAdapter';
import { INesConfigProvider } from '../../config/nesConfig';
import { ILogService } from '../shared/log/logService';

export type CursorJumpPrediction =
    | { readonly kind: 'sameFile'; readonly lineNumber: number }
    | { readonly kind: 'differentFile'; readonly filePath: string; readonly lineNumber: number };

const SYSTEM_MSG = 'Your task is to predict the line number where the developer is most likely to make their next edit. If you jump in the current file, just output the line number. If you want to jump to another file, output the filepath (relative to workspace root), colon, then line number. Output no explanation.';

export class NextCursorPredictor {
    constructor(
        @IInstantiationService private readonly _instaService: IInstantiationService,
        @INesConfigProvider private readonly _config: INesConfigProvider,
        @ILLMAdapterManager private readonly _llmManager: ILLMAdapterManager,
        @ILogService private readonly _log: ILogService,
    ) { }

    async predict(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<CursorJumpPrediction | undefined> {
        const text = document.getText().replace(/\r\n/g, '\n');
        const lines = text.split('\n');
        const cursorLine = position.line;

        // Build a compact prompt: 15 lines above cursor + cursor line marked + 15 below
        const startLine = Math.max(0, cursorLine - 15);
        const endLine = Math.min(lines.length, cursorLine + 16);
        const snippet: string[] = [];
        for (let i = startLine; i < endLine; i++) {
            if (i === cursorLine) {
                snippet.push(`${i}|${lines[i].substring(0, position.character)}<|cursor|>${lines[i].substring(position.character)}`);
            } else {
                snippet.push(`${i}|${lines[i]}`);
            }
        }

        const userPrompt = `current_file: ${document.uri.toString()}\n${snippet.join('\n')}`;

        try {
            const endpoint = this._config.supportedEndpoint;
            const adapter = this._llmManager.getAdapter(endpoint);
            const abortController = new AbortController();
            const cancelListener = token?.onCancellationRequested(() => abortController.abort());

            const response = await adapter.send(
                {
                    messages: [
                        { role: 'system', content: SYSTEM_MSG },
                        { role: 'user', content: userPrompt },
                    ],
                    max_tokens: 64,
                    temperature: 0,
                },
                abortController.signal,
            );

            cancelListener?.dispose();
            return this._parse(response.text.trim());
        } catch {
            return undefined;
        }
    }

    private _parse(trimmed: string): CursorJumpPrediction | undefined {
        const lineNumber = parseInt(trimmed, 10);
        if (!isNaN(lineNumber) && String(lineNumber) === trimmed) {
            if (lineNumber < 0) return undefined;
            return { kind: 'sameFile', lineNumber };
        }

        const lastColonIdx = trimmed.lastIndexOf(':');
        if (lastColonIdx <= 0) return undefined;

        const filePath = trimmed.substring(0, lastColonIdx).trim();
        const crossLine = parseInt(trimmed.substring(lastColonIdx + 1), 10);
        if (isNaN(crossLine) || crossLine < 0 || filePath.length === 0) return undefined;
        return { kind: 'differentFile', filePath, lineNumber: crossLine };
    }
}

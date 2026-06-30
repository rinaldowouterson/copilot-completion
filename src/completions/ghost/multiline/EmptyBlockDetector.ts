import * as vscode from 'vscode';
import { IMultilineDetector, DetectionResult, MultilineContext } from './types';
import { heuristicIsEmptyBlock } from './emptyBlockHeuristic';

export class EmptyBlockDetector implements IMultilineDetector {
    get name(): string { return 'EmptyBlock'; }

    async detect(ctx: MultilineContext): Promise<DetectionResult> {
        const text = ctx.document.getText();

        // Check current cursor position
        if (heuristicIsEmptyBlock(text, ctx.document.offsetAt(ctx.position))) {
            return { decision: 'multiline' };
        }

        // If inline (mid-line), also check end-of-line position
        if (ctx.isMiddleOfTheLine) {
            const eol = ctx.document.lineAt(ctx.position.line).range.end;
            if (heuristicIsEmptyBlock(text, ctx.document.offsetAt(eol))) {
                return { decision: 'multiline' };
            }
        }

        return { decision: 'defer' };
    }
}

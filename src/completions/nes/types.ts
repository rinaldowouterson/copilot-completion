import * as vscode from 'vscode';

export { PromptingStrategy } from './stubs/types';

export enum ResponseFormat {
    EditWindowOnly = 'EditWindowOnly',
}

export interface NextEditResult {
    edit: string;
    range: vscode.Range;
    cursorAfterEdit?: vscode.Position;
}

export interface LineRange0Based {
    startLine: number;
    endLineExclusive: number;
}

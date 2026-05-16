import * as vscode from 'vscode';

export enum PromptingStrategy {
    Xtab275 = 'Xtab275',
}

export enum ResponseFormat {
    EditWindowOnly = 'EditWindowOnly',
}

export interface StatelessNextEditRequest {
    document: vscode.TextDocument;
    position: vscode.Position;
    strategy: PromptingStrategy;
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

export interface PromptPieces {
    currentDocument: {
        text: string;
        cursorLine: number;
        cursorColumn: number;
    };
    editWindowRange: LineRange0Based;
    areaAroundRange: LineRange0Based;
    languageContext: string;
    lintErrors: string[];
    editHistory: string[];
    neighborSnippets: string[];
}

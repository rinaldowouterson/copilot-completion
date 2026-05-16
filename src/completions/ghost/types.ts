export interface GhostCompletion {
    completionIndex: number;
    completionText: string;
    displayText: string;
    displayNeedsWsOffset: boolean;
}

export interface CompletionResult {
    completion: GhostCompletion;
    isMiddleOfTheLine: boolean;
    suffixCoverage: number;
}

export interface GhostTextOptions {
    isSpeculative: boolean;
    delay: number;
}

export interface DiagnosticSummary {
    line: number;
    severity: 'error' | 'warning';
    message: string;
}

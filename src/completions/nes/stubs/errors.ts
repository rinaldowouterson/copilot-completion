export class BugIndicatingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BugIndicatingError';
    }
}

export function illegalArgument(message: string): Error {
    return new Error(`Illegal argument: ${message}`);
}

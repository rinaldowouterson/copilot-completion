import { createServiceIdentifier } from '../../di/services';

export const IGhostCompletionsCache = createServiceIdentifier<IGhostCompletionsCache>('IGhostCompletionsCache');

export interface IGhostCompletionsCache {
    readonly _serviceBrand: undefined;
    findAll(prefix: string, suffix: string): CompletionChoice[];
    append(prefix: string, suffix: string, choice: CompletionChoice): void;
    clear(): void;
}

export interface CompletionChoice {
    text: string;
    finishReason: string;
}

export class GhostCompletionsCache implements IGhostCompletionsCache {
    readonly _serviceBrand: undefined;
    private readonly _cache: Map<string, CompletionChoice[]>;
    private readonly _keys: string[];

    constructor(private readonly _maxSize: number = 100) {
        this._cache = new Map();
        this._keys = [];
    }

    private _makeKey(prefix: string, suffix: string): string {
        return `${prefix}\0${suffix}`;
    }

    findAll(prefix: string, suffix: string): CompletionChoice[] {
        return this._cache.get(this._makeKey(prefix, suffix)) || [];
    }

    append(prefix: string, suffix: string, choice: CompletionChoice): void {
        const key = this._makeKey(prefix, suffix);
        const existing = this._cache.get(key) || [];
        existing.push(choice);
        this._cache.set(key, existing);

        const idx = this._keys.indexOf(key);
        if (idx >= 0) {
            this._keys.splice(idx, 1);
        }
        this._keys.push(key);

        while (this._keys.length > this._maxSize) {
            const oldest = this._keys.shift()!;
            this._cache.delete(oldest);
        }
    }

    clear(): void {
        this._cache.clear();
        this._keys.length = 0;
    }
}

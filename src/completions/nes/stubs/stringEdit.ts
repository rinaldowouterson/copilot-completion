import { OffsetRange } from './offsetRange';

export class StringReplacement {
    static insert(offset: number, text: string): StringReplacement {
        return new StringReplacement(new OffsetRange(offset, offset), text);
    }

    constructor(
        public readonly range: OffsetRange,
        public readonly newText: string,
    ) { }
}

export class StringEdit {
    static single(replacement: StringReplacement): StringEdit {
        return new StringEdit([replacement]);
    }

    constructor(public readonly replacements: StringReplacement[]) { }

    applyOnText(text: { getLines(): string[]; toString(): string }): { getLines(): string[]; toString(): string } {
        const str = text.toString();
        let result = str;
        // Apply replacements in reverse order to preserve offsets
        const sorted = [...this.replacements].sort((a, b) => b.range.start - a.range.start);
        for (const r of sorted) {
            result = result.substring(0, r.range.start) + r.newText + result.substring(r.range.endExclusive);
        }
        return {
            getLines: () => result.split(/\r?\n/),
            toString: () => result,
        };
    }

    getNewRanges(): OffsetRange[] {
        return this.replacements.map(r =>
            new OffsetRange(r.range.start, r.range.start + r.newText.length)
        );
    }

    applyToOffsetRange(range: OffsetRange): OffsetRange {
        // Simplified stub - just return the range unchanged
        return range;
    }
}

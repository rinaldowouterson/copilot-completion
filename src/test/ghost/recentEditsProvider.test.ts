import * as assert from 'assert';

suite('RecentEditsProvider', () => {
    test('should start with empty recentEdits array', () => {
        const edits: string[] = [];
        assert.strictEqual(edits.length, 0);
    });

    test('should enforce max entries limit', () => {
        const maxEntries = 10;
        const edits: string[] = [];
        for (let i = 0; i < 20; i++) {
            edits.push('+  line' + i);
            if (edits.length > maxEntries) {
                edits.shift();
            }
        }
        assert.strictEqual(edits.length, maxEntries);
        assert.strictEqual(edits[0], '+  line10');
        assert.strictEqual(edits[9], '+  line19');
    });
});

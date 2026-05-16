import * as assert from 'assert';
import { GhostCompletionsCache } from '../../completions/ghost/completionsCache';

suite('GhostCompletionsCache', () => {
    test('should find cached completion by prefix+suffix', () => {
        const cache = new GhostCompletionsCache(100);
        cache.append('function hello()', '{', { text: '  console.log("hi");', finishReason: 'stop' });
        const results = cache.findAll('function hello()', '{');
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].text, '  console.log("hi");');
    });

    test('should return empty for cache miss', () => {
        const cache = new GhostCompletionsCache(100);
        cache.append('function a()', '{', { text: 'x', finishReason: 'stop' });
        const results = cache.findAll('function b()', '{');
        assert.strictEqual(results.length, 0);
    });

    test('should clear cache', () => {
        const cache = new GhostCompletionsCache(100);
        cache.append('p', 's', { text: 't', finishReason: 'stop' });
        assert.strictEqual(cache.findAll('p', 's').length, 1);
        cache.clear();
        assert.strictEqual(cache.findAll('p', 's').length, 0);
    });

    test('should evict oldest entries when capacity exceeded', () => {
        const cache = new GhostCompletionsCache(2);
        cache.append('a', '', { text: '1', finishReason: 'stop' });
        cache.append('b', '', { text: '2', finishReason: 'stop' });
        cache.append('c', '', { text: '3', finishReason: 'stop' });
        assert.strictEqual(cache.findAll('a', '').length, 0);
        assert.strictEqual(cache.findAll('b', '').length, 1);
        assert.strictEqual(cache.findAll('c', '').length, 1);
    });

    test('should accumulate multiple choices for same key', () => {
        const cache = new GhostCompletionsCache(10);
        cache.append('p', 's', { text: 'a', finishReason: 'stop' });
        cache.append('p', 's', { text: 'b', finishReason: 'stop' });
        assert.strictEqual(cache.findAll('p', 's').length, 2);
    });
});

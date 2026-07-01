import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { resolveRelativePath } from '../../completions/context/relativePath';

suite('resolveRelativePath (Phase A)', () => {
    /**
     * Build a URI from a fs path. `vscode.Uri.file` normalizes the path
     * (e.g. C:\foo\bar on Windows), but the helper should still work.
     */
    function uriFromFs(p: string): vscode.Uri {
        return vscode.Uri.file(p);
    }

    test('returns a path starting with "./" or "../"', () => {
        // Two arbitrary paths inside an arbitrary workspace
        const fakeRoot = process.platform === 'win32' ? 'C:\\fake\\workspace' : '/fake/workspace';
        const source = uriFromFs(path.join(fakeRoot, 'src', 'foo.ts'));
        const target = uriFromFs(path.join(fakeRoot, 'src', 'utils', 'helpers.ts'));
        const rel = resolveRelativePath(source, target);
        assert.ok(rel.startsWith('./') || rel.startsWith('../'),
            `Expected relative path with leading ./ or ../, got ${rel}`);
    });

    test('handles same-directory target', () => {
        const fakeRoot = process.platform === 'win32' ? 'C:\\fake\\workspace' : '/fake/workspace';
        const source = uriFromFs(path.join(fakeRoot, 'src', 'foo.ts'));
        const target = uriFromFs(path.join(fakeRoot, 'src', 'bar.ts'));
        const rel = resolveRelativePath(source, target);
        assert.strictEqual(rel, './bar.ts');
    });

    test('handles parent-directory target', () => {
        const fakeRoot = process.platform === 'win32' ? 'C:\\fake\\workspace' : '/fake/workspace';
        const source = uriFromFs(path.join(fakeRoot, 'src', 'api', 'foo.ts'));
        const target = uriFromFs(path.join(fakeRoot, 'src', 'utils', 'helpers.ts'));
        const rel = resolveRelativePath(source, target);
        assert.strictEqual(rel, '../utils/helpers.ts');
    });

    test('returns a string (never undefined)', () => {
        const source = uriFromFs('/fake/workspace/src/foo.ts');
        const target = uriFromFs('/fake/workspace/src/bar.ts');
        const rel = resolveRelativePath(source, target);
        assert.ok(typeof rel === 'string');
        assert.ok(rel.length > 0);
    });
});
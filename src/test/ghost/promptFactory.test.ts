import * as assert from 'assert';
import { GhostPromptFactory } from '../../completions/ghost/promptFactory';
import { DiagnosticSummary } from '../../completions/ghost/types';

suite('GhostPromptFactory', () => {
    test('should replace {prefix} and {suffix} placeholders', () => {
        const factory = new GhostPromptFactory();
        const template = '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>';
        const result = factory.createPrompt({
            template,
            prefix: 'function hello() {',
            suffix: '}',
            languageId: 'javascript',
            diagnostics: [],
            recentEdits: [],
        });
        // Context is injected between the tag and the prefix/suffix content
        assert.ok(result.includes('// language: javascript'));
        assert.ok(result.includes('function hello() {'));
        assert.ok(result.includes('<|fim_prefix|>'));
        // Suffix content is on a new line after the tag
        assert.ok(result.includes('<|fim_suffix|>'));
        assert.ok(result.includes('}'));
        assert.ok(result.includes('<|fim_middle|>'));
    });

    test('should prepend language ID context', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'typescript',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(result.includes('// language: typescript'));
    });

    test('should use # for Python/Ruby/Shell languages', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'python',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(result.includes('# language: python'));
    });

    test('should prepend diagnostics summary', () => {
        const factory = new GhostPromptFactory();
        const diagnostics: DiagnosticSummary[] = [
            { line: 3, severity: 'error', message: 'Cannot find name "foo"' },
        ];
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'python',
            diagnostics,
            recentEdits: [],
        });
        assert.ok(result.includes('# diagnostics: [Line 3] Cannot find name "foo"'));
    });

    test('should prepend recent edits', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'go',
            diagnostics: [],
            recentEdits: ['+  func Add(a, b int) int {', '+    return a + b', '+  }'],
        });
        assert.ok(result.includes('// recent edits:'));
        assert.ok(result.includes('+  func Add(a, b int) int {'));
    });

    test('should not include empty sections', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'javascript',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(!result.includes('diagnostics'));
        assert.ok(!result.includes('recent edits'));
    });

    test('should cap diagnostics at 5 entries', () => {
        const factory = new GhostPromptFactory();
        const diagnostics: DiagnosticSummary[] = [
            { line: 1, severity: 'error', message: 'err1' },
            { line: 2, severity: 'error', message: 'err2' },
            { line: 3, severity: 'error', message: 'err3' },
            { line: 4, severity: 'error', message: 'err4' },
            { line: 5, severity: 'error', message: 'err5' },
            { line: 6, severity: 'error', message: 'err6' },
        ];
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'javascript',
            diagnostics,
            recentEdits: [],
        });
        // Only 5 diagnostics should appear
        const matches = result.match(/diagnostics:/g);
        assert.strictEqual(matches?.length, 5);
    });
});

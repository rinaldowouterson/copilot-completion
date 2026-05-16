import * as assert from 'assert';
import * as vscode from 'vscode';

suite('GhostConfigProvider', () => {
    test('should return default values when no config set', () => {
        const config = vscode.workspace.getConfiguration('cc-completion.ghost');
        assert.strictEqual(config.get('enabled'), true);
        assert.strictEqual(config.get('model'), 'gpt-4o');
        assert.strictEqual(config.get('promptTemplate'), '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>');
        assert.strictEqual(config.get('capabilities.limits.max_output_tokens'), 256);
    });

    test('should return empty strings for baseUrl and apiKey by default', () => {
        const config = vscode.workspace.getConfiguration('cc-completion.ghost');
        assert.strictEqual(config.get('baseUrl'), '');
        assert.strictEqual(config.get('apiKey'), '');
    });
});

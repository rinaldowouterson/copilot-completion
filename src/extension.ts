import * as vscode from 'vscode';
import { InstantiationServiceBuilder, SyncDescriptor, ICurrentGhostText, ILastGhostText, IContextBuilderService } from './di/services';
import { IInstantiationService } from './di/instantiation';

// Config
import { IGhostConfigProvider, VSCodeGhostConfigProvider } from './config/ghostConfig';
import { INesConfigProvider, VSCodeNesConfigProvider } from './config/nesConfig';
import { ISecretConfig, VSCodeSecretConfig } from './config/secretConfig';

// Shared
import { ILogService, LogService } from './completions/shared/log/logService';
import { ILLMAdapterManager, LLMAdapterManager } from './completions/shared/llm/llmAdapter';
import { OpenAIChatCompletionAdapter } from './completions/shared/llm/openaiChatCompletionAdapter';
import { OpenAIResponseAdapter } from './completions/shared/llm/openaiResponseAdapter';
import { AnthropicAdapter } from './completions/shared/llm/anthropicAdapter';
import { OpenAICompletionAdapter } from './completions/shared/llm/openaiCompletionAdapter';

// GHOST
import { IGhostPromptFactory, GhostPromptFactory } from './completions/ghost/promptFactory';
import { IGhostCompletionsCache, GhostCompletionsCache } from './completions/ghost/completionsCache';
import { IRecentEditsProvider, RecentEditsProvider } from './completions/ghost/recentEditsProvider';
import { IGhostTextProvider, GhostTextProvider } from './completions/ghost/ghostTextProvider';
import { CurrentGhostText, LastGhostText } from './completions/ghost/ghostTextState';
import { IAsyncCompletionsManager, AsyncCompletionsManager } from './completions/ghost/asyncCompletions';
import { IMultilineStrategy } from './completions/ghost/multiline/types';
import { DefaultMultilineStrategy } from './completions/ghost/multiline/DefaultMultilineStrategy';
import { setWasmDirPath } from './completions/ghost/multiline/treeSitter/fileLoader';

// NES
import { INesProvider, NextEditProvider } from './completions/nes/nextEditProvider';
import { INextEditCache, NextEditCache } from './completions/nes/nextEditCache';

// UI
import { IStatusBarPanel, StatusBarPanel } from './ui/statusBarPanel';
import { ContextBuilderService } from './completions/context/contextBuilderService';

export function activate(context: vscode.ExtensionContext) {
    const logService = new LogService();
    logService.clear();
    logService.info('CC Completion activating...');

    // Initialize WASM path for tree-sitter
    setWasmDirPath(context.extensionUri.fsPath);

    // Build DI container
    const builder = new InstantiationServiceBuilder();

    // === Config (direct instances, with context for workspaceState) ===
    const secrets = new VSCodeSecretConfig(context);
    builder.define(ISecretConfig, secrets);

    const ghostConfig = new VSCodeGhostConfigProvider(context, secrets);
    const nesConfig = new VSCodeNesConfigProvider(context, secrets);
    builder.define(IGhostConfigProvider, ghostConfig);
    builder.define(INesConfigProvider, nesConfig);

    // === Shared ===
    builder.define(ILogService, logService);
    builder.define(ILLMAdapterManager, new LLMAdapterManager());

    // === GHOST services ===
    builder.define(IGhostPromptFactory, new SyncDescriptor(GhostPromptFactory));
    builder.define(IGhostCompletionsCache, new SyncDescriptor(GhostCompletionsCache));
    builder.define(IRecentEditsProvider, new SyncDescriptor(RecentEditsProvider));
    builder.define(IAsyncCompletionsManager, new SyncDescriptor(AsyncCompletionsManager));
    builder.define(IGhostTextProvider, new SyncDescriptor(GhostTextProvider));
    builder.define(IMultilineStrategy, new SyncDescriptor(DefaultMultilineStrategy));
    builder.define(ICurrentGhostText, new SyncDescriptor(CurrentGhostText));
    builder.define(ILastGhostText, new SyncDescriptor(LastGhostText));

    // === NES services ===
    builder.define(INextEditCache, new SyncDescriptor(NextEditCache));
    builder.define(INesProvider, new SyncDescriptor(NextEditProvider));

    // === Context (shared between GHOST and NES) ===
    builder.define(IContextBuilderService, new ContextBuilderService());

    // === UI ===
    builder.define(IStatusBarPanel, new SyncDescriptor(StatusBarPanel));

    // Seal
    const instantiationService = builder.seal();
    context.subscriptions.push(instantiationService);

    // One-shot migration of plaintext settings.json apiKey entries into SecretStorage.
    // Idempotent — running again with empty plaintext is a no-op.
    void secrets.migrateFromPlaintext().then(migrated => {
        if (migrated.ghost || migrated.nes) {
            const count = (migrated.ghost ? 1 : 0) + (migrated.nes ? 1 : 0);
            vscode.window.showInformationMessage(
                `CC Completion: ${count} API key${count === 1 ? '' : 's'} moved to secure storage.`,
            );
        }
    });

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('cc-completion.setGhostApiKey', () => setApiKeyCommand(secrets, 'ghost')),
        vscode.commands.registerCommand('cc-completion.setNesApiKey', () => setApiKeyCommand(secrets, 'nes')),
        vscode.commands.registerCommand('cc-completion.clearGhostApiKey', () => clearApiKeyCommand(secrets, 'ghost')),
        vscode.commands.registerCommand('cc-completion.clearNesApiKey', () => clearApiKeyCommand(secrets, 'nes')),
    );

    // Register LLM adapters
    registerLLMAdapters(instantiationService, ghostConfig, nesConfig, logService);

    // Activate providers
    const ghostProvider = instantiationService.createInstance(GhostTextProvider);
    const nesProvider = instantiationService.createInstance(NextEditProvider);
    const statusBar = instantiationService.createInstance(StatusBarPanel);

    context.subscriptions.push(
        ghostProvider.register(),
        nesProvider.register(),
        statusBar.register(),
    );

    logService.info('CC Completion activated');
}

function registerLLMAdapters(
    is: IInstantiationService,
    ghostConfig: IGhostConfigProvider,
    nesConfig: INesConfigProvider,
    log: ILogService,
): void {
    const llmManager = is.invokeFunction(accessor =>
        accessor.get(ILLMAdapterManager),
    );

    // GHOST: always completions
    llmManager.register('completions', new OpenAICompletionAdapter(log));
    log.debug('Registered GHOST adapter: completions');

    // NES: based on supportedEndpoint config
    const endpoint = nesConfig.supportedEndpoint;
    const { baseUrl, apiKey, model } = nesConfig;

    switch (endpoint) {
        case 'chat/completions':
            llmManager.register('chat/completions', new OpenAIChatCompletionAdapter());
            break;
        // TODO - support other endpoints like 'responses' and 'messages' once we have a use case for them
        // case 'responses':
        //     llmManager.register('responses', new OpenAIResponseAdapter(
        //         baseUrl, apiKey, model,
        //         nesConfig.presencePenalty,
        //         nesConfig.frequencyPenalty,
        //         nesConfig.stream,
        //     ));
        //     break;
        // case 'messages':
        //     llmManager.register('messages', new AnthropicAdapter(
        //         baseUrl, apiKey, model,
        //         nesConfig.stream,
        //     ));
        //     break;
    }
    log.debug(`Registered NES adapter: ${endpoint}`);
}

export function deactivate() {}

/**
 * Prompt user for an API key and store it in SecretStorage.
 * Re-entry without clearing the secret shows the existing value.
 */
async function setApiKeyCommand(
    secrets: ISecretConfig,
    pipeline: 'ghost' | 'nes',
): Promise<void> {
    const current = pipeline === 'ghost' ? secrets.getGhostApiKey() : secrets.getNesApiKey();
    const input = await vscode.window.showInputBox({
        prompt: `Enter ${pipeline.toUpperCase()} API key`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: current ? '(set — leave blank to keep, type new value to replace)' : 'paste key',
    });

    if (input === undefined) {
        return; // user cancelled
    }
    if (input.trim() === '') {
        return; // unchanged
    }

    if (pipeline === 'ghost') {
        await secrets.setGhostApiKey(input.trim());
    } else {
        await secrets.setNesApiKey(input.trim());
    }
    vscode.window.showInformationMessage(`CC Completion: ${pipeline.toUpperCase()} API key saved to secure storage.`);
}

async function clearApiKeyCommand(
    secrets: ISecretConfig,
    pipeline: 'ghost' | 'nes',
): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
        `Clear ${pipeline.toUpperCase()} API key from secure storage?`,
        { modal: true },
        'Clear',
    );
    if (confirmed !== 'Clear') {
        return;
    }
    if (pipeline === 'ghost') {
        await secrets.deleteGhostApiKey();
    } else {
        await secrets.deleteNesApiKey();
    }
    vscode.window.showInformationMessage(`CC Completion: ${pipeline.toUpperCase()} API key cleared.`);
}

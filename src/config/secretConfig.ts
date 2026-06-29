import * as vscode from 'vscode';
import { createServiceIdentifier } from '../di/services';

/**
 * Centralised access to the extension's SecretStorage bucket.
 *
 * One service, two key namespaces (`ghost.apiKey`, `nes.apiKey`).
 * The plaintext settings.json entries (`cc-completion.ghost.apiKey`,
 * `cc-completion.nes.apiKey`) remain readable as a one-shot fallback
 * during migration but should not be relied on after the user runs
 * the `cc-completion.migrateApiKeys` command.
 *
 * Callers receive a string synchronously: SecretStorage is `Promise`-shaped
 * per the VS Code API, so we resolve on construction and refresh on
 * `onDidChangeSecrets`. In-memory mirrors are kept so existing
 * synchronous `get apiKey()` consumers (adapters, providers) keep working.
 */
export const ISecretConfig = createServiceIdentifier<ISecretConfig>('ISecretConfig');

export interface ISecretConfig {
    readonly _serviceBrand: undefined;

    /** Synchronous read. Returns in-memory cached value, or `''` if unset. */
    getGhostApiKey(): string;
    getNesApiKey(): string;

    /** Atomic store + cache update. */
    setGhostApiKey(value: string): Promise<void>;
    setNesApiKey(value: string): Promise<void>;

    /** Atomic clear + cache update. */
    deleteGhostApiKey(): Promise<void>;
    deleteNesApiKey(): Promise<void>;

    /**
     * One-shot migration: read plaintext `cc-completion.{ghost,nes}.apiKey`
     * from settings.json, validate non-empty, write to SecretStorage, clear
     * plaintext. Returns a per-pipeline boolean indicating whether a key was
     * migrated. Idempotent — running twice is a no-op.
     */
    migrateFromPlaintext(): Promise<{ ghost: boolean; nes: boolean }>;

    /** Fires after a successful set/delete/migrate. Listeners re-read sync getters. */
    onDidChange(listener: () => void): vscode.Disposable;
}

export const GHOST_API_KEY_SECRET = 'cc-completion.ghost.apiKey.secret';
export const NES_API_KEY_SECRET = 'cc-completion.nes.apiKey.secret';
const PLAINTEXT_GHOST_API_KEY = 'cc-completion.ghost.apiKey';
const PLAINTEXT_NES_API_KEY = 'cc-completion.nes.apiKey';

export class VSCodeSecretConfig implements ISecretConfig {
    readonly _serviceBrand: undefined;

    private readonly _onDidChange = new vscode.EventEmitter<void>();

    constructor(private readonly _context: vscode.ExtensionContext) {
        // React to secret changes from any source (other windows, other extensions on this machine).
        const changeSub = _context.secrets.onDidChange(e => {
            if (e.key === GHOST_API_KEY_SECRET || e.key === NES_API_KEY_SECRET) {
                // Refresh both caches — SecretStorage gives us only the key, not which namespace,
                // and they're cheap to re-read.
                void this._refreshFromStorage();
                this._onDidChange.fire();
            }
        });
        _context.subscriptions.push(this._onDidChange);
        _context.subscriptions.push(changeSub);

        // Initial load — must complete before any sync `get apiKey()` is read.
        // We do not await here; activations that need a ready API key must call
        // `await secrets.initialize()` (added by the activate() function in extension.ts).
        this._ready = this._refreshFromStorage();
    }

    private _ready: Promise<void>;
    /** Awaitable for callers that want to guarantee the in-memory mirror is loaded. */
    initialize(): Promise<void> { return this._ready; }

    // In-memory mirror, kept in sync with `_context.secrets`.
    private _ghostApiKey: string = '';
    private _nesApiKey: string = '';

    private async _refreshFromStorage(): Promise<void> {
        const [ghost, nes] = await Promise.all([
            this._context.secrets.get(GHOST_API_KEY_SECRET),
            this._context.secrets.get(NES_API_KEY_SECRET),
        ]);
        this._ghostApiKey = ghost ?? '';
        this._nesApiKey = nes ?? '';
    }

    // --- Sync getters (the API surface used by adapters and providers) ---

    getGhostApiKey(): string {
        return this._ghostApiKey;
    }

    getNesApiKey(): string {
        return this._nesApiKey;
    }

    // --- Async setters ---

    async setGhostApiKey(value: string): Promise<void> {
        await this._context.secrets.store(GHOST_API_KEY_SECRET, value);
        this._ghostApiKey = value;
        this._onDidChange.fire();
    }

    async setNesApiKey(value: string): Promise<void> {
        await this._context.secrets.store(NES_API_KEY_SECRET, value);
        this._nesApiKey = value;
        this._onDidChange.fire();
    }

    async deleteGhostApiKey(): Promise<void> {
        await this._context.secrets.delete(GHOST_API_KEY_SECRET);
        this._ghostApiKey = '';
        this._onDidChange.fire();
    }

    async deleteNesApiKey(): Promise<void> {
        await this._context.secrets.delete(NES_API_KEY_SECRET);
        this._nesApiKey = '';
        this._onDidChange.fire();
    }

    onDidChange(listener: () => void): vscode.Disposable {
        return this._onDidChange.event(listener);
    }

    // --- Migration ---

    async migrateFromPlaintext(): Promise<{ ghost: boolean; nes: boolean }> {
        const config = vscode.workspace.getConfiguration();
        const plaintextGhost = config.get<string | undefined>(PLAINTEXT_GHOST_API_KEY);
        const plaintextNes = config.get<string | undefined>(PLAINTEXT_NES_API_KEY);

        const result = { ghost: false, nes: false };

        // Ghost
        const trimmedGhost = plaintextGhost?.trim();
        if (trimmedGhost && !this._ghostApiKey) {
            await this.setGhostApiKey(trimmedGhost);
            await config.update(PLAINTEXT_GHOST_API_KEY, '', vscode.ConfigurationTarget.Global);
            result.ghost = true;
        } else if (trimmedGhost) {
            // Already have a secret-stored key; clear plaintext silently.
            await config.update(PLAINTEXT_GHOST_API_KEY, '', vscode.ConfigurationTarget.Global);
        }

        // NES
        const trimmedNes = plaintextNes?.trim();
        if (trimmedNes && !this._nesApiKey) {
            await this.setNesApiKey(trimmedNes);
            await config.update(PLAINTEXT_NES_API_KEY, '', vscode.ConfigurationTarget.Global);
            result.nes = true;
        } else if (trimmedNes) {
            await config.update(PLAINTEXT_NES_API_KEY, '', vscode.ConfigurationTarget.Global);
        }

        return result;
    }
}

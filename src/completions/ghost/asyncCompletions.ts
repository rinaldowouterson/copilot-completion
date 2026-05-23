import { LRUCacheMap } from '../../common/lruCacheMap';
import { createServiceIdentifier } from '../../di/services';

export const IAsyncCompletionsManager = createServiceIdentifier<IAsyncCompletionsManager>('IAsyncCompletionsManager');

export interface IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;
    shouldWaitForAsyncCompletions(prefix: string, suffix: string): boolean;
    updateCompletion(headerRequestId: string, text: string): void;
    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cancellationTokenSource: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>
    ): void;
    getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
    ): Promise<AsyncCompletionResult | undefined>;
    cancelStaleRequests(headerRequestId: string): void;
    clear(): void;
}

export interface AsyncCompletionResult {
    completionText: string;
    finishReason: string;
}

interface BaseAsyncCompletionRequest {
    cancellationTokenSource: { cancel(): void };
    headerRequestId: string;
    prefix: string;
    suffix: string;
}

interface PendingRequest extends BaseAsyncCompletionRequest {
    state: 'pending';
    partialCompletionText?: string;
    resultPromise: Promise<AsyncCompletionResult>;
}

interface CompletedRequest extends BaseAsyncCompletionRequest {
    state: 'completed';
    result: AsyncCompletionResult;
}

type AsyncCompletionRequest = PendingRequest | CompletedRequest;

export class AsyncCompletionsManager implements IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;

    private readonly _requests = new LRUCacheMap<string, AsyncCompletionRequest>(100);

    /** Lock: only the most recent requester can cancel stale requests. */
    private _mostRecentRequestId = '';

    shouldWaitForAsyncCompletions(prefix: string, suffix: string): boolean {
        for (const [, request] of this._requests) {
            if (this._isCandidate(prefix, suffix, request)) {
                return true;
            }
        }
        return false;
    }

    updateCompletion(headerRequestId: string, text: string): void {
        const request = this._requests.get(headerRequestId);
        if (!request || request.state !== 'pending') return;
        request.partialCompletionText = text;
    }

    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cts: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>,
    ): void {
        this._requests.set(headerRequestId, {
            state: 'pending',
            cancellationTokenSource: cts,
            headerRequestId,
            prefix,
            suffix,
            resultPromise,
        });

        resultPromise
            .then(result => {
                this._requests.set(headerRequestId, {
                    state: 'completed',
                    cancellationTokenSource: cts,
                    headerRequestId,
                    prefix,
                    suffix,
                    result,
                });
            })
            .catch(() => {
                this._requests.delete(headerRequestId);
            });
    }

    async getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
    ): Promise<AsyncCompletionResult | undefined> {
        this._mostRecentRequestId = headerRequestId;

        for (const [, request] of this._requests) {
            if (!this._isCandidate(prefix, suffix, request)) {
                this._cancelStaleRequest(headerRequestId, request);
                continue;
            }

            if (request.state === 'completed') {
                const remainingPrefix = prefix.substring(request.prefix.length);
                let { completionText } = request.result;
                if (
                    !completionText.startsWith(remainingPrefix) ||
                    completionText.length <= remainingPrefix.length
                ) {
                    this._requests.delete(request.headerRequestId);
                    continue;
                }
                completionText = completionText.substring(remainingPrefix.length);
                return { ...request.result, completionText };
            }
        }
        return undefined;
    }

    cancelStaleRequests(headerRequestId: string): void {
        this._mostRecentRequestId = headerRequestId;
        for (const [, request] of this._requests) {
            this._cancelStaleRequest(headerRequestId, request);
        }
    }

    clear(): void {
        this._requests.clear();
    }

    private _isCandidate(prefix: string, suffix: string, request: AsyncCompletionRequest): boolean {
        if (request.suffix !== suffix) return false;
        if (!prefix.startsWith(request.prefix)) return false;
        const remainingPrefix = prefix.substring(request.prefix.length);
        if (request.state === 'completed') {
            return (
                request.result.completionText.startsWith(remainingPrefix) &&
                request.result.completionText.trimEnd().length > remainingPrefix.length
            );
        }
        if (request.partialCompletionText === undefined) return true;
        return request.partialCompletionText.startsWith(remainingPrefix);
    }

    private _cancelStaleRequest(headerRequestId: string, request: AsyncCompletionRequest): void {
        if (headerRequestId !== this._mostRecentRequestId) return;
        if (request.state === 'completed') return;
        request.cancellationTokenSource.cancel();
        this._requests.delete(request.headerRequestId);
    }
}

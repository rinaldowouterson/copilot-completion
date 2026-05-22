import { ILLMAdapter } from './llmAdapter';
import { LLMRequest, LLMResponse, LLMError, normalizeBody } from './llmRequest';
import { readSSEStream } from './sseStream';
import { ILogService } from '../log/logService';

export class OpenAICompletionAdapter implements ILLMAdapter {
    constructor(
        private readonly logService: ILogService,
    ) {}

    async send(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        this.logService.debug(`[OpenAI] Sending request | model=${request.model} | maxTokens=${request.max_tokens} | temperature=${request.temperature}`);

        const url = `${request.baseUrl}/completions`;
        const body = JSON.stringify({
            model: request.model,
            prompt: request.prompt || '',
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            n: request.n,
            presence_penalty: request.presence_penalty,
            frequency_penalty: request.frequency_penalty,
            stream: request.stream,
            stop: request.stop
        });

        const response =  await fetch(url, {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${request.apiKey}`,
            },
            body: normalizeBody(body),
        });

        if (!response.ok) {
            const text = await response.text();
            this.logService.error(`[OpenAI] Request failed | status=${response.status} | error=${text}`);
            throw new LLMError(`OpenAI completions API failed: ${response.status}`, response.status, text + body);
        }

        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/event-stream')) {
            let text = '';
            let finishReason = 'stop';
            await readSSEStream(response, signal, json => {
                const choice = json.choices?.[0];
                if (choice?.text) text += choice.text;
                if (choice?.finish_reason) finishReason = choice.finish_reason;
            });
            this.logService.debug(`[OpenAI] Streaming response complete | textLength=${text.length}`);
            return { text, finishReason };
        }
        const jsonResponse = this._parseJSON(await response.text());
        this.logService.debug(`[OpenAI] Response success | textLength=${jsonResponse.text.length} | finishReason=${jsonResponse.finishReason}`);
        return jsonResponse;
    }

    private _parseJSON(raw: string): LLMResponse {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const choices = json.choices as Array<Record<string, unknown>>;
        return {
            text: choices[0]?.text as string || '',
            finishReason: choices[0]?.finish_reason as string || 'stop',
        };
    }
}

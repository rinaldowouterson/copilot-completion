import { ILogService } from '../log/logService';
import { ILLMAdapter } from './llmAdapter';
import { LLMRequest, LLMResponse, LLMError, Capabilities, normalizeBody } from './llmRequest';
import { readSSEStream } from './sseStream';

export class OpenAIChatCompletionAdapter implements ILLMAdapter {

    async *sendStream(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<string, LLMResponse> {
        const result = await this.send(request, signal);
        yield result.text;
        return result;
    }

    async send(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        const url = `${request.baseUrl}/chat/completions`;
        const bodyObj: Record<string, unknown> = {
            model: request.model,
            messages: request.messages || [],
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            presence_penalty: request.presence_penalty,
            frequency_penalty: request.frequency_penalty,
            stream: request.stream,
            stop: request.stop,
            top_p: request.top_p,
            n: request.n,
        };

        applyThinkingParams(bodyObj, request.capabilities,request.family);

        const body = JSON.stringify(bodyObj);

        const response = await fetch(url, {
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
            throw new LLMError(`OpenAI chat request failed: ${response.status}`, response.status, text + body);
        }

        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/event-stream')) {
            let text = '';
            let finishReason = 'stop';
            await readSSEStream(response, signal, json => {
                const choice = json.choices?.[0];
                if (choice?.delta?.content) text += choice.delta.content;
                if (choice?.finish_reason) finishReason = choice.finish_reason;
            });
            return { text, finishReason };
        }
        return this._parseJSON(await response.text());
    }

    private _parseJSON(raw: string): LLMResponse {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const choices = json.choices as Array<Record<string, unknown>>;
        const message = choices[0]?.message as Record<string, string> | undefined;
        return {
            text: message?.content || '',
            finishReason: choices[0]?.finish_reason as string || 'stop',
        };
    }
}

function applyThinkingParams(
    body: Record<string, unknown>,
    capabilities?: Capabilities,
    family?: string,
): void {
    if(family === undefined) return;

    if (capabilities?.thinking) {
        switch (family) {
            case 'deepseek':
                body.enable_thinking = capabilities?.thinking === true;
                break;
            case 'qwen':
                body.enable_thinking = capabilities?.thinking === true;
                break;
        }
    }

    if(capabilities?.reasoning_effort){
        const effort = (capabilities?.reasoning_effort as string) || 'medium'; 
        switch (family) {
            case 'openai-o':
                body.reasoning_effort = effort;
                break;
            case 'openai-gpt5':
                body.reasoning = { effort };
                break;
        }
    }

}

export { applyThinkingParams };

/**
 * Regex matching VS Code chat editing session markup tags.
 * These are internal markers that leak into FIM prompts when
 * the extension runs inside a chat editing virtual document.
 *
 * Match groups:
 *   - `<|tag_name|>`   and   `<|/tag_name|>`  (closing tags)
 *   - `###remain edit start boundary line###`
 *   - `###remain edit end boundary line###`
 */
export const CHAT_MARKUP_RE = /<\|[\w/]+\|>|###remain\s+edit\s+(?:start|end)\s+boundary\s+line###/;

/**
 * Returns true if `text` contains any known chat editing session markup.
 * Used to reject prompts that would cause the LLM to reproduce these markers.
 */
export function containsChatMarkup(text: string): boolean {
    return CHAT_MARKUP_RE.test(text);
}

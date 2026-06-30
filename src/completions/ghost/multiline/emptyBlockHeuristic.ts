/**
 * Heuristic empty-block detection — alternative to tree-sitter WASM parsing.
 *
 * Determines whether the cursor is at the start of an empty block body
 * (function body, if/else, for, while, try/catch, object literal, etc.)
 * by character-level brace matching.
 *
 * Pure function — no LSP calls, no WASM, no VS Code dependency.
 * Works for any language with C-style braces ({ }).
 */

/**
 * Check if the cursor at `offset` in `text` is at the start of an empty block body.
 *
 * Strategy:
 *   1. Walk backward from `offset` to find the opening `{`.
 *      - If the character immediately before `offset` is `{`, that's our brace.
 *      - Otherwise, walk backward through whitespace/newlines to find the previous `{`.
 *   2. Walk forward from `offset` to find the matching `}`, tracking brace depth.
 *   3. If everything between `{` and `}` is whitespace or empty → empty block → `true`.
 *
 * @param text - Full document text
 * @param offset - Cursor offset (0-based character index)
 * @returns `true` if cursor is at an empty block start, `false` otherwise
 */
export function heuristicIsEmptyBlock(text: string, offset: number): boolean {
    if (!text || offset <= 0 || offset > text.length) return false;

    // --- Step 1: Find the opening brace '{' before the cursor ---

    let braceOpen = -1;

    // Fast path: character immediately before cursor is '{'
    if (text[offset - 1] === '{') {
        braceOpen = offset - 1;
    } else {
        // Walk backward from offset-1, skipping whitespace, to find '{'
        // This handles cases like:
        //   if (x) {
        //          │ <-- cursor here, '{' is on the previous line
        for (let i = offset - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '{') {
                braceOpen = i;
                break;
            }
            if (ch === '}' || ch === ';' || ch === '\n' || ch === '\r') {
                // '{' must be the first non-whitespace after a previous '}', ';', or newline.
                // If we hit any of these before finding '{', the cursor isn't inside a new block.
                // Actually, we need to be more permissive. The cursor could be:
                //   if (x) {  <-- '{' on same line as 'if'
                //     │      <-- cursor here (newline after '{')
                // Let's continue scanning backward past newlines.
                if (ch === '\n' || ch === '\r') continue;
                if (ch === ';' || ch === '}') {
                    // If we hit ';' or '}', there's no block start before cursor
                    return false;
                }
            }
            // Skip whitespace
            if (ch === ' ' || ch === '\t') continue;
        }
    }

    if (braceOpen === -1) return false;

    // --- Step 2: Walk forward from cursor to find matching '}' ---

    let braceClose = -1;
    let depth = 1; // we're inside the opening '{'
    const searchStart = Math.max(offset, braceOpen + 1);

    for (let i = searchStart; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                braceClose = i;
                break;
            }
        }
    }

    if (braceClose === -1) return false; // no matching '}' — malformed

    // --- Step 3: Check if everything between opening '{' and closing '}' is whitespace ---

    const blockContent = text.slice(braceOpen + 1, braceClose);
    return blockContent.trim().length === 0;
}

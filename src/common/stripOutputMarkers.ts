/**
 * Unified output-marker stripper.
 *
 * Both GHOST (FIM) and NES (edit prediction) wrap context information in
 * structured tags inside the prompt (e.g. `<|imports|>`, `<|fim_prefix|>`,
 * `###remain edit start boundary line###`).  The model should never reproduce
 * these markers, but in practice it sometimes does — especially at the start
 * or end of a completion.
 *
 * Instead of rejecting the whole completion when markers leak (the old
 * `containsChatMarkup` approach), we **strip** any known markers from the
 * beginning and end of the output string.  This is more resilient: a single
 * stray `<|imports|>` at the start doesn't trash a 50-line completion.
 *
 * The stripper is idempotent — applying it twice is the same as once.
 */

// ──────────────────────────────────────────────────────────────
//  Known marker patterns
// ──────────────────────────────────────────────────────────────

const MARKERS: readonly string[] = [
    // GHOST FIM tags
    '<|fim_prefix|>',
    '<|fim_suffix|>',
    '<|fim_middle|>',

    // NES PromptTags  (pipe-delimited)
    '<|cursor|>',
    '<|code_to_edit|>',
    '<|/code_to_edit|>',
    '<|area_around_code_to_edit|>',
    '<|/area_around_code_to_edit|>',
    '<|area_code_prefix|>',
    '<|/area_code_prefix|>',
    '<|area_code_suffix|>',
    '<|/area_code_suffix|>',
    '<|current_file_content|>',
    '<|/current_file_content|>',
    '<|cursor_location|>',
    '<|/cursor_location|>',
    '<|edit_diff_history|>',
    '<|/edit_diff_history|>',
    '<|recently_viewed_code_snippets|>',
    '<|/recently_viewed_code_snippets|>',
    '<|recently_viewed_code_snippet|>',
    '<|/recently_viewed_code_snippet|>',
    '<|linter|>',
    '<|/linter|>',

    // GHOST imports (pipe-delimited)
    '<|imports|>',
    '<|/imports|>',

    // NES ad-hoc tags (angle-bracket, no pipes)
    '<imports>',
    '</imports>',
    '<super_types>',
    '</super_types>',
    '<missing_imports>',
    '</missing_imports>',
    '<file_exports>',
    '</file_exports>',
    '<scope>',
    '</scope>',

    // NES boundary markers
    '###remain edit start boundary line###',
    '###remain edit end boundary line###',

    // Code-fence variants that sometimes wrap the markers
    '```',
];

/**
 * Build a single RegExp that matches ANY of the known markers.
 * Used for the "strip from start/end" logic.
 */
function buildMarkerPattern(): RegExp {
    // Sort longest-first so greedy patterns like <|area_around_code_to_edit|>
    // match before shorter ones like <|code_to_edit|>.
    const sorted = [...MARKERS].sort((a, b) => b.length - a.length);
    const escaped = sorted.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^(?:${escaped.join('|')})+`, '');
}

const START_RE = buildMarkerPattern();
// End pattern: same markers but anchored to end-of-string, with optional
// trailing whitespace/newlines BETWEEN markers.
const END_RE = new RegExp(`(?:${[...MARKERS].sort((a, b) => b.length - a.length).map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})+$`, '');

/**
 * Strip known prompt markers from the *beginning* of `text`.
 *
 * Handles chained markers: `<|imports|><|cursor|>actual code` → `actual code`
 */
export function stripStartMarkers(text: string): string {
    let prev: string;
    do {
        prev = text;
        text = text.replace(START_RE, '');
    } while (text !== prev);
    return text;
}

/**
 * Strip known prompt markers from the *end* of `text`.
 *
 * Handles chained markers: `actual code<|cursor|></imports>` → `actual code`
 */
export function stripEndMarkers(text: string): string {
    let prev: string;
    do {
        prev = text;
        text = text.replace(END_RE, '');
    } while (text !== prev);
    return text;
}

/**
 * Strip known markers from both start and end of `text`.
 * Also trims trailing blank lines after stripping.
 */
export function stripOutputMarkers(text: string): string {
    let result = stripStartMarkers(text);
    result = stripEndMarkers(result);
    // Trim trailing blank lines common after marker stripping
    while (result.endsWith('\n') || result.endsWith('\r')) {
        result = result.slice(0, -1);
    }
    return result;
}

/**
 * Convenience: strip markers from every element in a string array (lines).
 */
export function stripOutputMarkersFromLines(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    const joined = lines.join('\n');
    const stripped = stripOutputMarkers(joined);
    return stripped ? stripped.split('\n') : [];
}

/**
 * Check whether `text` contains ANY known markers (anywhere, not just
 * at start/end).  Useful for logging/debugging, not for rejection.
 */
export function containsAnyMarker(text: string): boolean {
    return MARKERS.some(m => text.includes(m));
}

/**
 * Log a warning for every marker found anywhere in `text`.
 * Useful for diagnostics — call on the final output to see what leaked.
 */
export function diagnoseMarkerLeakage(text: string): string[] {
    return MARKERS.filter(m => text.includes(m));
}

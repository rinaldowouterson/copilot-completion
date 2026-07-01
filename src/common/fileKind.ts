/**
 * File-kind detection — categorises imported files by their content type.
 *
 * This lets downstream consumers (GHOST prompt factories, NES assemblers)
 * decide whether to include or skip non-code imports (images, audio, fonts,
 * archives, etc.) in their context bundles, saving tokens and avoiding
 * meaningless symbol dumps.
 *
 * Detection is extension-based by default (fast, no I/O). Content sniffing
 * (magic bytes) can be added later as a hardening step.
 */

import * as vscode from 'vscode';

/**
 * High-level file kind categories.
 *
 * Ordered by commonality: code is the default for most imports.
 */
export type FileKind =
    | 'code'        // Source code — the default for known programming languages
    | 'image'       // PNG, JPG, GIF, SVG, WebP, BMP, ICO, etc.
    | 'audio'       // MP3, WAV, FLAC, OGG, AAC, WMA, etc.
    | 'video'       // MP4, AVI, MOV, MKV, WebM, etc.
    | 'font'        // WOFF, WOFF2, TTF, OTF, EOT, etc.
    | 'data'        // JSON, CSV, XML, YAML, TOML, INI, etc.
    | 'document'    // PDF, DOC, DOCX, Markdown, RST, etc.
    | 'archive'     // ZIP, TAR, GZ, BZ2, XZ, 7Z, RAR, etc.
    | 'binary'      // Other binary (exe, dll, .o, .wasm, .bin, etc.)
    | 'unknown';    // Could not determine

/**
 * Extension → FileKind mapping.
 *
 * Focuses on non-code file kinds. Code files are detected by the presence
 * of LSP symbols; if no symbols are found, the file kind still tells us
 * what sort of file we're dealing with.
 */
const EXTENSION_MAP: Record<string, FileKind> = {
    // ── Images ──
    'png': 'image',
    'jpg': 'image',
    'jpeg': 'image',
    'gif': 'image',
    'svg': 'image',
    'webp': 'image',
    'bmp': 'image',
    'ico': 'image',
    'tiff': 'image',
    'tif': 'image',
    'avif': 'image',

    // ── Audio ──
    'mp3': 'audio',
    'wav': 'audio',
    'flac': 'audio',
    'ogg': 'audio',
    'aac': 'audio',
    'wma': 'audio',
    'm4a': 'audio',
    'opus': 'audio',

    // ── Video ──
    'mp4': 'video',
    'avi': 'video',
    'mov': 'video',
    'mkv': 'video',
    'webm': 'video',
    'wmv': 'video',
    'm4v': 'video',

    // ── Fonts ──
    'woff': 'font',
    'woff2': 'font',
    'ttf': 'font',
    'otf': 'font',
    'eot': 'font',

    // ── Data / config ──
    'json': 'data',
    'jsonc': 'data',
    'csv': 'data',
    'tsv': 'data',
    'xml': 'data',
    'yaml': 'data',
    'yml': 'data',
    'toml': 'data',
    'ini': 'data',
    'cfg': 'data',
    'conf': 'data',

    // ── Documents ──
    'pdf': 'document',
    'md': 'document',
    'markdown': 'document',
    'rst': 'document',
    'txt': 'document',
    'doc': 'document',
    'docx': 'document',
    'xls': 'document',
    'xlsx': 'document',
    'ppt': 'document',
    'pptx': 'document',

    // ── Archives ──
    'zip': 'archive',
    'tar': 'archive',
    'gz': 'archive',
    'gzip': 'archive',
    'bz2': 'archive',
    'xz': 'archive',
    '7z': 'archive',
    'rar': 'archive',
    'zst': 'archive',

    // ── Binary / other ──
    'exe': 'binary',
    'dll': 'binary',
    'so': 'binary',
    'dylib': 'binary',
    'wasm': 'binary',
    'o': 'binary',
    'a': 'binary',
    'lib': 'binary',
    'obj': 'binary',
    'bin': 'binary',
    'dat': 'binary',
    'db': 'binary',
    'sqlite': 'binary',
    'whl': 'archive',
    'vsix': 'archive',
    'nupkg': 'archive',
    'jar': 'archive',
};

/**
 * Known programming-language extensions that map to `'code'`.
 *
 * When an extension isn't in EXTENSION_MAP (non-code categories) and IS
 * a programming language, we return 'code'. This list is intentionally
 * incomplete — anything not matched by EXTENSION_MAP or CODE_EXTENSIONS
 * falls through to `'unknown'`.
 */
const CODE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
    'py', 'rs', 'go', 'java', 'cs', 'cpp', 'c', 'h', 'hpp',
    'php', 'rb', 'dart', 'lua', 'kt', 'kts', 'swift',
    'scala', 'clj', 'cljs', 'elm', 'hs', 'ml', 'mli',
    'sql', 'graphql', 'gql',
    'sh', 'bash', 'zsh', 'fish',
    'css', 'scss', 'less', 'styl',
    'vue', 'svelte', 'astro',
    'pl', 'pm', 't', 'r', 'rmd',
    'erl', 'hrl', 'ex', 'exs',
    'zig', 'nim', 'crystal', 'ocaml', 'fsharp', 'fs',
    'd', 'pas', 'pp', 'inc',
    'cmake', 'makefile', 'gnumakefile',
    'gradle', 'groovy',
]);

/**
 * Infer file kind from a URI's file extension.
 *
 * This is a synchronous, zero-I/O operation — it only looks at the
 * file extension. For content-based detection (magic bytes), extend
 * this function with an async path that reads the first few bytes.
 *
 * @param uri - The file URI to inspect.
 * @returns The detected FileKind.
 */
export function inferFileKind(uri: vscode.Uri): FileKind {
    const basename = uri.fsPath;
    const dot = basename.lastIndexOf('.');
    const ext = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : '';
    if (!ext) return 'unknown';

    // Check non-code map first
    const mapped = EXTENSION_MAP[ext];
    if (mapped) return mapped;

    // Check if it's a known code extension
    if (CODE_EXTENSIONS.has(ext)) return 'code';

    return 'unknown';
}

/**
 * Infer file kind from a file extension string (for use in contexts
 * where you don't have a full URI, e.g. test assertions).
 */
export function inferFileKindFromExtension(ext: string): FileKind {
    const clean = ext.toLowerCase().replace(/^\./, '');
    if (!clean) return 'unknown';

    const mapped = EXTENSION_MAP[clean];
    if (mapped) return mapped;

    if (CODE_EXTENSIONS.has(clean)) return 'code';

    return 'unknown';
}

/**
 * Convenience check: is this file kind a source-code kind?
 */
export function isCodeKind(kind: FileKind): boolean {
    return kind === 'code';
}

/**
 * Convenience check: is this file kind likely binary (not human-readable)?
 */
export function isBinaryKind(kind: FileKind): boolean {
    switch (kind) {
        case 'image':
        case 'audio':
        case 'video':
        case 'font':
        case 'archive':
        case 'binary':
            return true;
        case 'code':
        case 'data':
        case 'document':
        case 'unknown':
            return false;
    }
}

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
 * Single authoritative map. Every known extension maps to exactly one FileKind.
 * If an extension isn't here, `inferFileKind` / `inferFileKindFromExtension`
 * return `'unknown'`.
 *
 * Maintained in alphabetical order within each category for easy scanning.
 */
const EXT_TO_KIND: Record<string, FileKind> = {
    // ── Archives ──
    '7z': 'archive',
    'bz2': 'archive',
    'gz': 'archive',
    'gzip': 'archive',
    'jar': 'archive',
    'nupkg': 'archive',
    'rar': 'archive',
    'tar': 'archive',
    'vsix': 'archive',
    'whl': 'archive',
    'xz': 'archive',
    'zip': 'archive',
    'zst': 'archive',

    // ── Audio ──
    'aac': 'audio',
    'flac': 'audio',
    'm4a': 'audio',
    'mp3': 'audio',
    'ogg': 'audio',
    'opus': 'audio',
    'wav': 'audio',
    'wma': 'audio',

    // ── Binary / other ──
    'a': 'binary',
    'bin': 'binary',
    'dat': 'binary',
    'db': 'binary',
    'dll': 'binary',
    'dylib': 'binary',
    'exe': 'binary',
    'lib': 'binary',
    'o': 'binary',
    'obj': 'binary',
    'so': 'binary',
    'sqlite': 'binary',
    'wasm': 'binary',

    // ── Code ──
    'astro': 'code',
    'bash': 'code',
    'c': 'code',
    'cjs': 'code',
    'clj': 'code',
    'cljs': 'code',
    'cmake': 'code',
    'cpp': 'code',
    'cs': 'code',
    'crystal': 'code',
    'css': 'code',
    'cts': 'code',
    'd': 'code',
    'dart': 'code',
    'elm': 'code',
    'erl': 'code',
    'ex': 'code',
    'exs': 'code',
    'fish': 'code',
    'fs': 'code',
    'fsharp': 'code',
    'go': 'code',
    'gql': 'code',
    'gradle': 'code',
    'graphql': 'code',
    'groovy': 'code',
    'h': 'code',
    'hpp': 'code',
    'hrl': 'code',
    'hs': 'code',
    'inc': 'code',
    'java': 'code',
    'js': 'code',
    'jsx': 'code',
    'kt': 'code',
    'kts': 'code',
    'less': 'code',
    'lua': 'code',
    'makefile': 'code',
    'mjs': 'code',
    'ml': 'code',
    'mli': 'code',
    'mts': 'code',
    'nim': 'code',
    'ocaml': 'code',
    'pas': 'code',
    'php': 'code',
    'pl': 'code',
    'pm': 'code',
    'pp': 'code',
    'py': 'code',
    'r': 'code',
    'rb': 'code',
    'rmd': 'code',
    'rs': 'code',
    'scala': 'code',
    'scss': 'code',
    'sh': 'code',
    'sql': 'code',
    'styl': 'code',
    'svelte': 'code',
    'swift': 'code',
    't': 'code',
    'ts': 'code',
    'tsx': 'code',
    'vue': 'code',
    'zsh': 'code',
    'zig': 'code',

    // ── Data / config ──
    'cfg': 'data',
    'conf': 'data',
    'csv': 'data',
    'ini': 'data',
    'json': 'data',
    'jsonc': 'data',
    'toml': 'data',
    'tsv': 'data',
    'xml': 'data',
    'yaml': 'data',
    'yml': 'data',

    // ── Documents ──
    'doc': 'document',
    'docx': 'document',
    'md': 'document',
    'markdown': 'document',
    'pdf': 'document',
    'ppt': 'document',
    'pptx': 'document',
    'rst': 'document',
    'txt': 'document',
    'xls': 'document',
    'xlsx': 'document',

    // ── Fonts ──
    'eot': 'font',
    'otf': 'font',
    'ttf': 'font',
    'woff': 'font',
    'woff2': 'font',

    // ── Images ──
    'avif': 'image',
    'bmp': 'image',
    'gif': 'image',
    'ico': 'image',
    'jpeg': 'image',
    'jpg': 'image',
    'png': 'image',
    'svg': 'image',
    'tif': 'image',
    'tiff': 'image',
    'webp': 'image',

    // ── Video ──
    'avi': 'video',
    'm4v': 'video',
    'mkv': 'video',
    'mov': 'video',
    'mp4': 'video',
    'webm': 'video',
    'wmv': 'video',
};

// ── Code "extensions" that aren't file extensions ──
// Some VS Code language IDs use pseudo-extensions like 'gnumakefile',
// 'makefile', 'dockerfile'. These have no dot — the extension lookup
// returns empty string and we'd miss them. Handle via a secondary check.
const FILENAME_OVERRIDES: Record<string, FileKind> = {
    'gnumakefile': 'code',
    'makefile': 'code',
};

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
    // 1. Check extension-based map
    const basename = uri.fsPath;
    const dot = basename.lastIndexOf('.');
    const ext = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : '';
    if (ext) {
        const mapped = EXT_TO_KIND[ext];
        if (mapped) return mapped;
    }

    // 2. Check filename overrides (makefile, dockerfile, etc.)
    const filename = basename.split('/').pop()?.toLowerCase() ?? '';
    const override = FILENAME_OVERRIDES[filename];
    if (override) return override;

    return 'unknown';
}

/**
 * Infer file kind from a file extension string (for use in contexts
 * where you don't have a full URI, e.g. test assertions).
 *
 * Unlike `inferFileKind`, this does NOT check `FILENAME_OVERRIDES`
 * (makefile, etc.) because those aren't file-extension-based.
 */
export function inferFileKindFromExtension(ext: string): FileKind {
    const clean = ext.toLowerCase().replace(/^\./, '');
    return EXT_TO_KIND[clean] ?? 'unknown';
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

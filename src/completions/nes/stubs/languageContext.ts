export enum ContextKind {
    Snippet = 'snippet',
    Trait = 'trait',
    File = 'file',
}

export interface SnippetContext {
    kind: ContextKind.Snippet;
    value: string;
    uri: { toString(): string };
}

export interface TraitContext {
    kind: ContextKind.Trait;
    name: string;
    value: string;
}

export interface LanguageContextItem {
    context: SnippetContext | TraitContext;
    onTimeout: boolean;
}

export interface LanguageContextResponse {
    items: readonly LanguageContextItem[];
}

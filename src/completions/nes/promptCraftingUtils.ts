import { DocumentId } from './stubs/types';
import { Schemas } from './stubs/network';

export function toUniquePath(documentId: DocumentId, workspaceRootPath: string | undefined): string {
    const filePath = documentId.path;
    const workspaceRootPathWithSlash = workspaceRootPath === undefined ? undefined : (workspaceRootPath.endsWith('/') ? workspaceRootPath : workspaceRootPath + '/');

    const updatedFilePath = workspaceRootPathWithSlash !== undefined && filePath.startsWith(workspaceRootPathWithSlash)
        ? filePath.substring(workspaceRootPathWithSlash.length)
        : filePath;

    return documentId.toUri().scheme === Schemas.vscodeNotebookCell ? `${updatedFilePath}#${documentId.fragment}` : updatedFilePath;
}

export function countTokensForLines(page: string[], computeTokens: (s: string) => number): number {
    return page.reduce((sum, line) => sum + computeTokens(line) + 1 /* \n */, 0);
}

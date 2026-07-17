declare module 'yaml' {
    export function parseAllDocuments(text: string, options?: unknown): readonly unknown[];
}

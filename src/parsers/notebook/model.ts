export interface NotebookRepresentation {
    mimeType: string;
    /** JSON representations retain their original numeric tokens and keys. */
    text: string;
    truncated: boolean;
    width?: number;
    height?: number;
}
export interface NotebookOutput {
    type: 'stream' | 'display_data' | 'execute_result' | 'error' | 'unknown';
    executionCount: number | null;
    name: string;
    text: string;
    errorName: string;
    errorValue: string;
    traceback: string;
    representations: NotebookRepresentation[];
}
export interface NotebookCell {
    /** File order, independent of execution count or optional cell id. */
    index: number;
    id: string;
    type: 'markdown' | 'code' | 'raw' | 'unknown';
    source: string;
    executionCount: number | null;
    sourceHidden: boolean;
    outputsHidden: boolean;
    outputs: NotebookOutput[];
    attachments: Record<string, NotebookRepresentation[]>;
}
export interface NotebookDocument {
    nbformat: number;
    nbformatMinor: number;
    language: string;
    kernelName: string;
    cells: NotebookCell[];
    totalCells: number;
    outputCount: number;
    errorCount: number;
}

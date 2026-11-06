/** Injected decoders can use this error to distinguish resource limits from bad data. */
export class McapDecompressionLimitError extends Error {
    override readonly name = 'McapDecompressionLimitError';
    constructor() { super('MCAP decoder memory limit exceeded'); }
}

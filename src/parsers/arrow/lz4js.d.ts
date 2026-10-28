declare module 'lz4js' {
    export function decompressFrame(input: Uint8Array, output: Uint8Array): number;
    export function decompressBlock(input: Uint8Array, output: Uint8Array, start: number, length: number, written: number): number;
    export function compress(input: Uint8Array): Uint8Array;
}
declare module 'lz4js/xxh32.js' {
    export function hash(seed: number, input: Uint8Array, start: number, length: number): number;
}

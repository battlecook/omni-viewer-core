import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    formatBigCount,
    GGUF_NORMALIZED_TEXT_BUDGET,
    GGUF_PARSE_METADATA_LIMIT,
    GGUF_PARSE_STRING_BYTE_LIMIT,
    GGUF_PARSE_TENSOR_LIMIT,
    GGUF_PREVIEW_ENTRY_LIMIT,
    normalizeGguf,
    parseGgufBytes,
    parseGgufUri,
    type GgufDocument,
    type HuggingFaceGgufOutput
} from './index.js';
import { createGgufFileRangeFetch, parseGgufFile } from './node.js';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function expectInvalid(document: GgufDocument): void {
    expect(document.summary).toEqual([{ labelKey: 'gguf.summary.status', value: 'invalid' }]);
}

function expectValid(document: GgufDocument): void {
    expect(document.summary).not.toEqual([{ labelKey: 'gguf.summary.status', value: 'invalid' }]);
}

function warningText(document: GgufDocument): string {
    return JSON.stringify({ warnings: document.warnings, errorDetail: document.errorDetail });
}

describe('GGUF parser adapter', () => {
    it('reads a local prefix into a JSON-safe document', async () => {
        const filePath = temporaryFile('model.gguf', buildGgufFixture());
        const document = await parseGgufFile(filePath);

        expect(document.warnings).toEqual([]);
        expect(document.format).toBe('gguf');
        expect(document.version).toBe(3);
        expect(document.byteOrder).toBe('little-endian');
        expect(document.title).toBe('Tiny Model');
        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.architecture', value: 'llama' });
        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.parameters', value: '6' });
        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.quantization', value: 'Q3_K_M' });
        expect(document.tensors).toEqual([expect.objectContaining({
            name: 'weight',
            dtype: 'F32',
            shape: ['2', '3'],
            elements: '6',
            offset: '0'
        })]);

        const tokens = document.metadata.find((entry) => entry.key === 'tokenizer.ggml.tokens');
        expect(tokens).toMatchObject({ type: 'ARRAY<STRING>', arrayLength: 10 });
        expect(tokens?.value).toContain('… (+2)');
        expect(() => JSON.stringify(document)).not.toThrow();
    });

    // Reading the header struct ourselves means a metadata key named like a
    // reserved field is just an oddly named key, not a spoofing vector: it lands in
    // the entry list and cannot reach the header. Flattening metadata into one
    // object, as @huggingface/gguf does, is what made this a collision.
    it('keeps a metadata key named after a header field from overwriting the header', async () => {
        const document = await parseGgufBytes(buildGgufFixture(0, undefined, 99));

        expectValid(document);
        expect(document.version).toBe(3);
        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.version', value: 'GGUF v3' });
        expect(document.metadata).toContainEqual(
            expect.objectContaining({ key: 'version', type: 'UINT32', value: '99' })
        );
    });

    it('still rejects a reserved-field collision when a caller supplies a verified header', () => {
        const document = normalizeGguf({
            metadata: { version: 99, tensor_count: 0n, kv_count: 1n },
            typedMetadata: {
                version: { value: 99, type: 4 },
                tensor_count: { value: 0n, type: 10 },
                kv_count: { value: 1n, type: 10 }
            },
            tensorInfos: [],
            tensorDataOffset: 32n,
            littleEndian: true,
            tensorInfoByteRange: [24, 24]
        } as unknown as HuggingFaceGgufOutput, '100 bytes', 100,
        { version: 3, tensorCount: 0n, metadataCount: 1n, littleEndian: true });

        expectInvalid(document);
        expect(warningText(document)).toMatch(/metadata.*reserved header fields/i);
    });

    it('rejects excessive source counts before the walk allocates any entry', async () => {
        const excessiveTensors = await parseGgufBytes(buildHeaderOnlyFixture(
            BigInt(GGUF_PARSE_TENSOR_LIMIT) + 1n,
            0n
        ));
        const excessiveMetadata = await parseGgufBytes(buildHeaderOnlyFixture(
            0n,
            BigInt(GGUF_PARSE_METADATA_LIMIT) + 1n
        ));

        expectInvalid(excessiveTensors);
        expect(warningText(excessiveTensors)).toMatch(/tensor count.*viewer parsing limit/i);
        expectInvalid(excessiveMetadata);
        expect(warningText(excessiveMetadata)).toMatch(/metadata count.*viewer parsing limit/i);
    });

    it('walks past a metadata array far larger than any element ceiling would have allowed', async () => {
        const document = await parseGgufBytes(buildCumulativeArrayLimitFixture());

        expectValid(document);
        expect(document.warnings).toEqual([]);
        const walked = document.metadata.find((entry) => entry.key === 'array.b');
        expect(walked).toMatchObject({ type: 'ARRAY<UINT8>' });
        expect(walked?.value).toContain(`[${Math.floor(2_000_000 / 2) + 1} items]`);
        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.metadataKeys', value: 2 });
    });

    // The cumulative string limit used to abandon the walk, which cost the tensor
    // index -- it starts wherever the last metadata value ends, so there was no way
    // back to it. It now only stops decoding text, and the walk runs to completion.
    it('drops display text but keeps the tensor index past the cumulative string limit', async () => {
        const document = await parseGgufBytes(buildCumulativeStringLimitFixture());

        expectValid(document);
        expect(document.warnings).toContainEqual({ key: 'gguf.warning.textTruncated' });
        expect(document.tensors).toEqual([expect.objectContaining({ name: 'weight', dtype: 'F32' })]);
        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.parameters', value: '6' });
        // The entry that crossed the limit still reports its type and declared size.
        expect(document.metadata.map((entry) => entry.key)).toEqual(['huge.a', 'huge.b']);
    });

    // The parser used to hand the file to @huggingface/gguf once the preflight
    // cleared it, which meant an array-element ceiling had to exist to stop that
    // handoff from materializing a whole vocabulary. Crossing the ceiling therefore
    // cost the tensor table, the parameter count and the quantization summary --
    // everything that made the document worth opening. Reading the tensor index in
    // the same walk removes the coupling: vocabulary size no longer decides it.
    it('reports tensors and parameters for a vocabulary past the retired element ceilings', async () => {
        const bytes = buildLargeVocabularyModel(550_000, 460_000);
        const filePath = temporaryFile('wide-vocab.gguf', bytes);

        const memory = await parseGgufBytes(bytes);
        const local = await parseGgufFile(filePath);

        for (const document of [memory, local]) {
            expectValid(document);
            expect(document.warnings).toEqual([]);
            expect(document.title).toBe('Wide Vocab');
            expect(document.tensors.map((tensor) => tensor.name))
                .toEqual(['token_embd.weight', 'output.weight']);
            expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.tensors', value: 2 });
            expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.parameters', value: '4.6K' });
            expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.quantization', value: 'F32' });
            expect(document.metadata.find((entry) => entry.key === 'tokenizer.ggml.tokens'))
                .toMatchObject({ type: 'ARRAY<STRING>', arrayLength: 550_000 });
        }
    });

    // Peak memory is not directly observable, so this measures the two quantities
    // that bound it: the largest chunk the reader ever holds, and the size of what
    // the finished document retains. Both must be flat in vocabulary size.
    //
    // Bytes *streamed* is deliberately not asserted flat, because it cannot be: a
    // GGUF string array records no byte size, so finding element n + 1 means
    // reading element n's length prefix. Walking a bigger vocabulary really does
    // move more bytes -- it just never accumulates them, which is the whole claim.
    // (Only fixed-width arrays can be jumped over outright, and those are skipped
    // without being requested at all.)
    it('streams a growing vocabulary through a fixed-size working set', async () => {
        const small = buildLargeVocabularyModel(200_000, 100_000);
        const large = buildLargeVocabularyModel(700_000, 350_000);
        // The premise: the file really did get much bigger.
        expect(large.byteLength).toBeGreaterThan(small.byteLength * 3);

        const smallRun = await measureParse(small);
        const largeRun = await measureParse(large);

        // More of the file is traversed...
        expect(largeRun.requests).toBeGreaterThan(smallRun.requests);
        // ...through a working set that does not grow with it.
        expect(largeRun.peakResponseBytes).toBe(smallRun.peakResponseBytes);
        expect(largeRun.peakResponseBytes).toBeLessThanOrEqual(2_000_000);
        // The only growth the document is allowed is the digits of the printed counts.
        expect(Math.abs(largeRun.retained - smallRun.retained)).toBeLessThan(50);
    });

    // https://github.com/battlecook/vscode-omni-viewer/issues/18: the previous 300K
    // complex-element ceiling cut through the middle of ordinary vocabularies, so
    // Qwen3, Llama 3 and friends all rendered as "invalid".
    it('parses a modern tokenizer vocabulary in full', async () => {
        const document = await parseGgufBytes(buildLargeVocabularyFixture(151_936, 151_387));

        expectValid(document);
        expect(document.warnings).toEqual([]);
        expect(document.metadata.find((entry) => entry.key === 'tokenizer.ggml.tokens'))
            .toMatchObject({ type: 'ARRAY<STRING>', arrayLength: 151_936 });
        expect(document.metadata.find((entry) => entry.key === 'tokenizer.ggml.merges'))
            .toMatchObject({ type: 'ARRAY<STRING>', arrayLength: 151_387 });
    });

    it('returns an invalid document when the source bytes are not GGUF', async () => {
        const filePath = temporaryFile('broken.gguf', new Uint8Array(32));
        const document = await parseGgufFile(filePath);

        expectInvalid(document);
        expect(warningText(document)).toMatch(/valid gguf|GGUF magic/i);
    });

    it('rejects unsafe alignment and negative tensor data offsets', async () => {
        const filePath = temporaryFile('bad-alignment.gguf', buildGgufFixture(0, 0x80000000));
        const parsed = await parseGgufFile(filePath);
        const normalized = normalizeGguf({
            metadata: { version: 3, tensor_count: 0n, kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 0n, type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            tensorInfos: [],
            tensorDataOffset: -2147483648n,
            littleEndian: true,
            tensorInfoByteRange: [24, 24]
        } as unknown as HuggingFaceGgufOutput, '100 bytes', 100);

        expectInvalid(parsed);
        expect(warningText(parsed)).toMatch(/alignment|tensor data offset/i);
        expectInvalid(normalized);
        expect(warningText(normalized)).toMatch(/tensor data offset/i);
    });

    it('rejects non-power-of-two alignments that ggml itself refuses to load', async () => {
        const filePath = temporaryFile('alignment-24.gguf', buildGgufFixture(0, 24));

        const document = await parseGgufFile(filePath);

        expectInvalid(document);
        expect(warningText(document)).toMatch(/alignment must be a uint32 power of two/i);
    });

    it('pads the tensor data offset up to a non-default power-of-two alignment', async () => {
        const filePath = temporaryFile('alignment-64.gguf', buildGgufFixture(0, 64));

        const document = await parseGgufFile(filePath);

        expectValid(document);
        expect(document.warnings).toEqual([]);
        expect(BigInt(document.tensorDataOffset ?? '-1') % 64n).toBe(0n);
    });

    it('rejects truncated remote, memory, and local files using their actual byte size', async () => {
        const bytes = buildTruncatedTensorIndexFixture();
        const filePath = temporaryFile('truncated.gguf', bytes);
        const fetchRange = vi.fn(async () => new Response(bytes.buffer as ArrayBuffer, {
            status: 206,
            headers: {
                'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
                'Content-Length': String(bytes.byteLength)
            }
        })) as typeof fetch;

        const remote = await parseGgufUri('https://models.example/truncated.gguf', { fetch: fetchRange });
        const memory = await parseGgufBytes(bytes);
        const local = await parseGgufFile(filePath);

        for (const document of [remote, memory, local]) {
            expectInvalid(document);
            expect(warningText(document)).toMatch(/end of the file/i);
        }
    });

    it('accepts tensorless files that end at the tensor index without alignment padding', async () => {
        const bytes = buildTensorlessGgufFixture();
        // The bug only shows up when the index end needs padding to reach the alignment.
        expect(bytes.byteLength % 32).not.toBe(0);
        const filePath = temporaryFile('vocab-only.gguf', bytes);

        const memory = await parseGgufBytes(bytes);
        const local = await parseGgufFile(filePath);

        for (const document of [memory, local]) {
            expectValid(document);
            expect(document.warnings).toEqual([]);
            expect(document.version).toBe(3);
            expect(document.tensors).toEqual([]);
            expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.architecture', value: 'bert' });
        }
    });

    it('still rejects a tensorless file whose tensor index itself runs past EOF', () => {
        const document = normalizeGguf({
            metadata: { version: 3, tensor_count: 0n, kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 0n, type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            tensorInfos: [],
            tensorDataOffset: 128n,
            littleEndian: true,
            tensorInfoByteRange: [24, 200]
        } as unknown as HuggingFaceGgufOutput, '100 bytes', 100);

        expectInvalid(document);
        expect(warningText(document)).toMatch(/tensor index extends past the end of the file/i);
    });

    it('still rejects tensor data offsets past EOF when the file declares tensors', () => {
        const document = normalizeGguf({
            metadata: { version: 3, tensor_count: 1n, kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 1n, type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            tensorInfos: [{ name: 'weight', n_dims: 1, shape: [1n], dtype: 0, offset: 0n }],
            tensorDataOffset: 128n,
            littleEndian: true,
            tensorInfoByteRange: [24, 100]
        } as unknown as HuggingFaceGgufOutput, '100 bytes', 100);

        expectInvalid(document);
        expect(warningText(document)).toMatch(/tensor data offset extends past the end of the file/i);
    });

    it('rejects individual tensor offsets that start at or beyond EOF', () => {
        const document = normalizeGguf({
            metadata: { version: 3, tensor_count: 1n, kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 1n, type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            tensorInfos: [{ name: 'weight', n_dims: 1, shape: [1n], dtype: 0, offset: 64n }],
            tensorDataOffset: 64n,
            littleEndian: true,
            tensorInfoByteRange: [24, 56]
        } as unknown as HuggingFaceGgufOutput, '100 bytes', 100);

        expectInvalid(document);
        expect(warningText(document)).toMatch(/weight.*end of the file/i);
    });

    it('rejects misaligned tensor offsets and tensor payloads that extend past EOF', () => {
        const base = {
            metadata: { version: 3, tensor_count: 1n, kv_count: 1n, 'general.alignment': 32 },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 1n, type: 10 },
                kv_count: { value: 1n, type: 10 },
                'general.alignment': { value: 32, type: 4 }
            },
            tensorDataOffset: 64n,
            littleEndian: true,
            tensorInfoByteRange: [24, 56]
        };
        const misaligned = normalizeGguf({
            ...base,
            tensorInfos: [{ name: 'weight', n_dims: 1, shape: [1n], dtype: 0, offset: 8n }]
        } as unknown as HuggingFaceGgufOutput, '1 KB', 1_024);
        const truncated = normalizeGguf({
            ...base,
            tensorInfos: [{ name: 'large', n_dims: 1, shape: [1_000n], dtype: 0, offset: 0n }]
        } as unknown as HuggingFaceGgufOutput, '65 bytes', 65);

        expectInvalid(misaligned);
        expect(warningText(misaligned)).toMatch(/offset.*not aligned/i);
        expectInvalid(truncated);
        expect(warningText(truncated)).toMatch(/large.*extends past.*file/i);
    });

    it('uses quantized block storage sizes when checking the tensor end', () => {
        const output = {
            metadata: { version: 3, tensor_count: 1n, kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 1n, type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            // Q4_0 stores each block of 32 elements in 18 bytes.
            tensorInfos: [{ name: 'quantized', n_dims: 1, shape: [32n], dtype: 2, offset: 0n }],
            tensorDataOffset: 64n,
            littleEndian: true,
            tensorInfoByteRange: [24, 56]
        } as unknown as HuggingFaceGgufOutput;

        const exact = normalizeGguf(output, '82 bytes', 82);
        const oneByteShort = normalizeGguf(output, '81 bytes', 81);

        expectValid(exact);
        expectInvalid(oneByteShort);
        expect(warningText(oneByteShort)).toMatch(/quantized.*extends past.*file/i);
    });

    it('keeps a bounded preview when a future tensor dtype has no known storage size', () => {
        const document = normalizeGguf({
            metadata: { version: 3, tensor_count: 1n, kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: 1n, type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            tensorInfos: [{ name: 'future', n_dims: 1, shape: [1n], dtype: 99, offset: 0n }],
            tensorDataOffset: 64n,
            littleEndian: true,
            tensorInfoByteRange: [24, 56]
        } as unknown as HuggingFaceGgufOutput, '65 bytes', 65);

        expectValid(document);
        expect(document.tensors).toEqual([expect.objectContaining({ name: 'future', dtype: 'UNKNOWN(99)' })]);
        expect(warningText(document)).toMatch(/unverifiedDtype/i);
    });

    it('connects AbortSignal to the local range stream', async () => {
        const filePath = temporaryFile('large.gguf', new Uint8Array(4_000_000));
        const abort = new AbortController();
        const fetchRange = createGgufFileRangeFetch(filePath, 4_000_000);
        const response = await fetchRange('https://omni-viewer.invalid/local.gguf', {
            headers: { Range: 'bytes=0-1999999' },
            signal: abort.signal
        });

        abort.abort();

        await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });

        const parseAbort = new AbortController();
        const parsing = parseGgufFile(filePath, undefined, parseAbort.signal);
        parseAbort.abort();
        await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('parses a remote GGUF through validated partial-content responses', async () => {
        const bytes = buildGgufFixture();
        const fetchRange = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('range')).toBe('bytes=0-1999999');
            return new Response(bytes.buffer as ArrayBuffer, {
                status: 206,
                headers: {
                    'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
                    'Content-Length': String(bytes.byteLength)
                }
            });
        }) as typeof fetch;

        const document = await parseGgufUri('https://models.example/model.gguf', {
            fetch: fetchRange,
            fileByteLength: bytes.byteLength
        });

        expect(document.version).toBe(3);
        expect(document.title).toBe('Tiny Model');
        expect(document.fileSize).not.toBe('Unknown');
        expect(fetchRange).toHaveBeenCalledTimes(1);
    });

    // The reader used to request a fixed placeholder URL, which only went unnoticed
    // because the real URI was handed to @huggingface/gguf separately and every
    // test supplies a transport that ignores the URL it is given.
    it('range-requests the URI it was given rather than a placeholder', async () => {
        const bytes = buildGgufFixture();
        const requested: string[] = [];
        const fetchRange = (async (input: RequestInfo | URL, init?: RequestInit) => {
            requested.push(String(input));
            return memoryRange(bytes)(input, init);
        }) as typeof fetch;

        const document = await parseGgufUri('https://models.example/a/b/model.gguf', { fetch: fetchRange });

        expectValid(document);
        expect(requested).not.toHaveLength(0);
        expect(new Set(requested)).toEqual(new Set(['https://models.example/a/b/model.gguf']));
    });

    it('rejects a Content-Range total that disagrees with the host-provided file size', async () => {
        const bytes = buildGgufFixture();
        const fetchRange = vi.fn(async () => new Response(bytes.buffer as ArrayBuffer, {
            status: 206,
            headers: {
                'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
                'Content-Length': String(bytes.byteLength)
            }
        })) as typeof fetch;

        const document = await parseGgufUri('https://models.example/wrong-size.gguf', {
            fetch: fetchRange,
            fileByteLength: bytes.byteLength + 1
        });

        expectInvalid(document);
        expect(warningText(document)).toMatch(/Content-Range total.*host-provided file byte length/i);
        expect(fetchRange).toHaveBeenCalledTimes(1);
    });

    it('rejects a short intermediate 206 response instead of zero-filling the missing range', async () => {
        const bytes = buildGgufFixture(1_600_000);
        const returnedBytes = bytes.slice(0, 1_000_000);
        const fetchShortRange = vi.fn(async () => new Response(returnedBytes.buffer as ArrayBuffer, {
            status: 206,
            headers: {
                'Content-Range': `bytes 0-${returnedBytes.byteLength - 1}/${bytes.byteLength}`,
                'Content-Length': String(returnedBytes.byteLength)
            }
        })) as typeof fetch;

        const document = await parseGgufUri('https://models.example/short-range.gguf', {
            fetch: fetchShortRange
        });

        expectInvalid(document);
        expect(warningText(document)).toMatch(/Content-Range.*requested byte range/i);
        expect(fetchShortRange).toHaveBeenCalledTimes(1);
    });

    it('walks into successive chunks and rejects a range that starts past EOF', async () => {
        // Metadata alone crosses the 2,000,000-byte chunk boundary, so the tensor
        // index that follows it can only be reached from a second chunk.
        const bytes = buildGgufFixture(2_100_000);
        const requestedRanges: string[] = [];
        const fetchRange = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const value = new Headers(init?.headers).get('range') ?? '';
            requestedRanges.push(value);
            const match = value.match(/^bytes=(\d+)-(\d+)$/)!;
            const start = Number(match[1]);
            const requestedEnd = Number(match[2]);
            if (start >= bytes.byteLength) {
                return new Response(null, {
                    status: 416,
                    headers: { 'Content-Range': `bytes */${bytes.byteLength}` }
                });
            }
            const end = Math.min(requestedEnd, bytes.byteLength - 1);
            const body = bytes.slice(start, end + 1);
            return new Response(body.buffer as ArrayBuffer, {
                status: 206,
                headers: {
                    'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
                    'Content-Length': String(body.byteLength)
                }
            });
        }) as typeof fetch;

        const remote = await parseGgufUri('https://models.example/small.gguf', { fetch: fetchRange });
        const memory = await parseGgufBytes(bytes);
        // A zero-length file makes even the first chunk unsatisfiable, which is the
        // only way a 416 reaches the reader now that nothing prefetches ahead of it.
        const empty = await parseGgufBytes(new Uint8Array(0));

        expect(remote.version).toBe(3);
        expect(remote.title).toBe('Tiny Model');
        expect(remote.tensors).toHaveLength(1);
        expect(memory.version).toBe(3);
        expect(requestedRanges).toEqual(['bytes=0-1999999', 'bytes=2000000-3999999']);
        expectInvalid(empty);
        expect(warningText(empty)).toMatch(/end of the file/i);
    });

    it('rejects a server that ignores Range before reading its response body', async () => {
        const arrayBuffer = vi.fn(async () => new ArrayBuffer(2_000_000_000));
        const fetchWithoutRanges = vi.fn(async () => ({
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Length': '2000000000' }),
            body: null,
            arrayBuffer
        } as unknown as Response)) as typeof fetch;

        const document = await parseGgufUri('https://models.example/model.gguf', { fetch: fetchWithoutRanges });

        expectInvalid(document);
        expect(warningText(document)).toMatch(/expected HTTP 206/i);
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('rejects partial responses without a valid Content-Range', async () => {
        const fetchWithoutContentRange = vi.fn(async () => new Response(new Uint8Array(16).buffer, {
            status: 206,
            headers: { 'Content-Length': '16' }
        })) as typeof fetch;

        const document = await parseGgufUri('https://models.example/model.gguf', {
            fetch: fetchWithoutContentRange
        });

        expectInvalid(document);
        expect(warningText(document)).toMatch(/Content-Range/i);
    });

    it('passes cancellation to the active remote fetch', async () => {
        const abort = new AbortController();
        let receivedSignal: AbortSignal | null = null;
        const pendingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            receivedSignal = init?.signal as AbortSignal;
            return new Promise<Response>((_resolve, reject) => {
                receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true });
            });
        }) as typeof fetch;

        const parsing = parseGgufUri('https://models.example/model.gguf', {
            fetch: pendingFetch,
            signal: abort.signal
        });
        await vi.waitFor(() => expect(pendingFetch).toHaveBeenCalledTimes(1));
        abort.abort();

        await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
        expect(receivedSignal).toBe(abort.signal);
    });

    it('bounds normalized tensor copies while preserving totals', () => {
        const tensorCount = GGUF_PREVIEW_ENTRY_LIMIT + 5;
        const tensorInfos = Array.from({ length: tensorCount }, (_, index) => ({
            name: `weight.${index}`,
            n_dims: 1,
            shape: [1n],
            dtype: 0,
            offset: BigInt(index * 32)
        }));
        const output = {
            metadata: { version: 3, tensor_count: BigInt(tensorCount), kv_count: 0n },
            typedMetadata: {
                version: { value: 3, type: 4 },
                tensor_count: { value: BigInt(tensorCount), type: 10 },
                kv_count: { value: 0n, type: 10 }
            },
            tensorInfos,
            tensorDataOffset: 32n,
            littleEndian: true,
            tensorInfoByteRange: [24, 32]
        } as unknown as HuggingFaceGgufOutput;

        const document = normalizeGguf(output);

        expect(document.summary).toContainEqual({ labelKey: 'gguf.summary.tensors', value: tensorCount });
        expect(document.tensors).toHaveLength(GGUF_PREVIEW_ENTRY_LIMIT);
        expect(document.tables[0]?.rows).toHaveLength(GGUF_PREVIEW_ENTRY_LIMIT);
        expect(document.rawPreview?.split('\n')).toHaveLength(GGUF_PREVIEW_ENTRY_LIMIT);
        expect(document.warnings).toContainEqual({
            key: 'gguf.warning.tensorsLimited',
            args: { shown: GGUF_PREVIEW_ENTRY_LIMIT, total: tensorCount }
        });
    });

    it('enforces per-string limits and a total normalized text budget', () => {
        const longText = 'x'.repeat(10_000);
        const tensorCount = GGUF_PREVIEW_ENTRY_LIMIT;
        const typedMetadata: Record<string, unknown> = {
            version: { value: 3, type: 4 },
            tensor_count: { value: BigInt(tensorCount), type: 10 },
            kv_count: { value: 300n, type: 10 }
        };
        for (let index = 0; index < 300; index += 1) {
            typedMetadata[`metadata.${index}.${longText}`] = { value: longText, type: 8 };
        }
        const output = {
            metadata: {
                version: 3,
                tensor_count: BigInt(tensorCount),
                kv_count: 300n,
                'general.name': longText,
                'general.architecture': longText
            },
            typedMetadata,
            tensorInfos: Array.from({ length: tensorCount }, (_, index) => ({
                name: `${index}.${longText}`,
                n_dims: 1,
                shape: [1n],
                dtype: 0,
                offset: BigInt(index * 32)
            })),
            tensorDataOffset: 32n,
            littleEndian: true,
            tensorInfoByteRange: [24, 32]
        } as unknown as HuggingFaceGgufOutput;

        const document = normalizeGguf(output);
        const tensorTable = document.tables[0]?.rows ?? [];
        const metadataTable = document.tables[1]?.rows ?? [];
        const budgetedCharacters = document.title.length
            + document.metadata.reduce((sum, entry) => sum + entry.key.length + entry.value.length, 0)
            + document.tensors.reduce((sum, tensor) => sum + tensor.name.length, 0)
            + tensorTable.reduce((sum, row) => sum + String(row[0]).length, 0)
            + metadataTable.reduce((sum, row) => sum + String(row[0]).length + String(row[2]).length, 0)
            + (document.rawPreview?.replaceAll('\n', '').length ?? 0);

        expect(document.title.length).toBeLessThanOrEqual(512);
        expect(document.tensors.every((tensor) => tensor.name.length <= 512)).toBe(true);
        expect(document.metadata.every((entry) => entry.key.length <= 512 && entry.value.length <= 2_000)).toBe(true);
        expect(budgetedCharacters).toBeLessThanOrEqual(GGUF_NORMALIZED_TEXT_BUDGET);
        expect(warningText(document)).toMatch(/textTruncated/i);
    });

    it('formats exact bigint parameter counts without converting through Number', () => {
        expect(formatBigCount(999n)).toBe('999');
        expect(formatBigCount(12_345n)).toBe('12.3K');
        expect(formatBigCount(1_234_567_890n)).toBe('1.2B');
        expect(formatBigCount(9_876_543_210_000n)).toBe('9.8T');
    });
});

/** Serves bounded ranges out of an in-memory buffer, like a well-behaved server. */
function memoryRange(bytes: Uint8Array): typeof fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const match = new Headers(init?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!;
        const start = Number(match[1]);
        if (start >= bytes.byteLength) {
            return new Response(null, {
                status: 416,
                headers: { 'Content-Range': `bytes */${bytes.byteLength}` }
            });
        }
        const end = Math.min(Number(match[2]), bytes.byteLength - 1);
        const body = bytes.slice(start, end + 1);
        return new Response(body.buffer as ArrayBuffer, {
            status: 206,
            headers: {
                'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
                'Content-Length': String(body.byteLength)
            }
        });
    }) as typeof fetch;
}

interface ParseMeasurement {
    requests: number;
    fetched: number;
    peakResponseBytes: number;
    retained: number;
}

/** Parses through a range server that records what the transport actually moved. */
async function measureParse(bytes: Uint8Array): Promise<ParseMeasurement> {
    const measurement: ParseMeasurement = { requests: 0, fetched: 0, peakResponseBytes: 0, retained: 0 };
    const serve = memoryRange(bytes);
    const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        measurement.requests += 1;
        const response = await serve(input, init);
        const body = new Uint8Array(await response.arrayBuffer());
        measurement.fetched += body.byteLength;
        measurement.peakResponseBytes = Math.max(measurement.peakResponseBytes, body.byteLength);
        return new Response(body.buffer as ArrayBuffer, {
            status: response.status,
            headers: response.headers
        });
    }) as typeof fetch;

    const document = await parseGgufUri('https://models.example/vocab.gguf', {
        fetch: countingFetch,
        fileByteLength: bytes.byteLength
    });
    expectValid(document);
    measurement.retained = JSON.stringify(document).length;
    return measurement;
}

/**
 * Growable little-endian writer. The `number[]` helpers below are fine for small
 * fixtures but quadratic-ish once a vocabulary reaches six figures, and the memory
 * tests need files that large.
 */
class GgufWriter {
    private bytes = new Uint8Array(1 << 16);
    private length = 0;

    ensure(extra: number): void {
        if (this.length + extra <= this.bytes.byteLength) return;
        let capacity = this.bytes.byteLength * 2;
        while (capacity < this.length + extra) capacity *= 2;
        const grown = new Uint8Array(capacity);
        grown.set(this.bytes.subarray(0, this.length));
        this.bytes = grown;
    }

    ascii(value: string): this {
        this.ensure(value.length);
        for (let index = 0; index < value.length; index += 1) {
            this.bytes[this.length + index] = value.charCodeAt(index);
        }
        this.length += value.length;
        return this;
    }

    u32(value: number): this {
        this.ensure(4);
        new DataView(this.bytes.buffer).setUint32(this.length, value, true);
        this.length += 4;
        return this;
    }

    u64(value: bigint): this {
        this.ensure(8);
        new DataView(this.bytes.buffer).setBigUint64(this.length, value, true);
        this.length += 8;
        return this;
    }

    /** A GGUF length-prefixed string. ASCII only, which every fixture here is. */
    str(value: string): this {
        return this.u64(BigInt(value.length)).ascii(value);
    }

    /** A length-prefixed string of `byteLength` copies of one byte, without a JS string. */
    filledString(byteLength: number, code: number): this {
        this.u64(BigInt(byteLength)).ensure(byteLength);
        this.bytes.fill(code, this.length, this.length + byteLength);
        this.length += byteLength;
        return this;
    }

    stringMetadata(key: string, value: string): this {
        return this.str(key).u32(8).str(value);
    }

    u32Metadata(key: string, value: number): this {
        return this.str(key).u32(4).u32(value);
    }

    stringArrayMetadata(key: string, count: number, prefix: string): this {
        this.str(key).u32(9).u32(8).u64(BigInt(count));
        for (let index = 0; index < count; index += 1) this.str(`${prefix}${index}`);
        return this;
    }

    tensor(name: string, shape: bigint[], dtype: number, offset: bigint): this {
        this.str(name).u32(shape.length);
        for (const dimension of shape) this.u64(dimension);
        return this.u32(dtype).u64(offset);
    }

    padTo(alignment: number): this {
        this.ensure(alignment);
        while (this.length % alignment !== 0) this.length += 1;
        return this;
    }

    zeros(count: number): this {
        this.ensure(count);
        this.length += count;
        return this;
    }

    done(): Uint8Array {
        return this.bytes.slice(0, this.length);
    }
}

/**
 * A model with a vocabulary large enough that its `tokens` + `merges` arrays cross
 * the 1,000,000-element ceiling the parser used to enforce, plus real tensors whose
 * payload follows the index.
 */
function buildLargeVocabularyModel(tokenCount: number, mergeCount: number): Uint8Array {
    const writer = new GgufWriter();
    writer.ascii('GGUF').u32(3).u64(2n).u64(4n);
    writer.stringMetadata('general.architecture', 'llama');
    writer.stringMetadata('general.name', 'Wide Vocab');
    writer.stringArrayMetadata('tokenizer.ggml.tokens', tokenCount, 't');
    writer.stringArrayMetadata('tokenizer.ggml.merges', mergeCount, 'm');
    // 4096 F32 elements = 16384 bytes, then 2048 more at the next aligned offset.
    writer.tensor('token_embd.weight', [64n, 64n], 0, 0n);
    writer.tensor('output.weight', [32n, 16n], 0, 16_384n);
    return writer.padTo(32).zeros(16_384 + 2_048).done();
}

function temporaryFile(name: string, bytes: Uint8Array): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gguf-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, bytes);
    return filePath;
}

function buildGgufFixture(descriptionLength = 0, alignment?: number, reservedVersion?: number): Uint8Array {
    const bytes: number[] = [];
    pushAscii(bytes, 'GGUF');
    pushU32(bytes, 3);
    pushU64(bytes, 1n); // tensors
    pushU64(bytes, BigInt(
        4
        + (descriptionLength > 0 ? 1 : 0)
        + (alignment === undefined ? 0 : 1)
        + (reservedVersion === undefined ? 0 : 1)
    ));

    pushStringMetadata(bytes, 'general.architecture', 'llama');
    pushStringMetadata(bytes, 'general.name', 'Tiny Model');
    pushU32Metadata(bytes, 'general.file_type', 12); // Q4_K
    pushStringArrayMetadata(bytes, 'tokenizer.ggml.tokens',
        Array.from({ length: 10 }, (_, index) => `token-${index}`));
    if (descriptionLength > 0) {
        pushStringMetadata(bytes, 'general.description', 'd'.repeat(descriptionLength));
    }
    if (alignment !== undefined) pushU32Metadata(bytes, 'general.alignment', alignment);
    if (reservedVersion !== undefined) pushU32Metadata(bytes, 'version', reservedVersion);

    pushString(bytes, 'weight');
    pushU32(bytes, 2); // dimensions
    pushU64(bytes, 2n);
    pushU64(bytes, 3n);
    pushU32(bytes, 0); // F32
    pushU64(bytes, 0n); // tensor-data-relative offset

    const payloadAlignment = alignment !== undefined && alignment <= 1_024 ? alignment : 32;
    while (bytes.length % payloadAlignment !== 0) bytes.push(0);
    bytes.push(...new Array<number>(24).fill(0));
    return Uint8Array.from(bytes);
}

/** A vocab-only GGUF: metadata, zero tensors, and no trailing alignment padding. */
function buildTensorlessGgufFixture(): Uint8Array {
    const bytes: number[] = [];
    pushAscii(bytes, 'GGUF');
    pushU32(bytes, 3);
    pushU64(bytes, 0n); // tensors
    pushU64(bytes, 1n); // metadata entries
    pushStringMetadata(bytes, 'general.architecture', 'bert');
    return Uint8Array.from(bytes);
}

function buildTruncatedTensorIndexFixture(): Uint8Array {
    const bytes: number[] = [];
    pushAscii(bytes, 'GGUF');
    pushU32(bytes, 3);
    pushU64(bytes, 1n);
    pushU64(bytes, 0n);
    return Uint8Array.from(bytes);
}

function buildHeaderOnlyFixture(tensorCount: bigint, metadataCount: bigint): Uint8Array {
    const bytes: number[] = [];
    pushAscii(bytes, 'GGUF');
    pushU32(bytes, 3);
    pushU64(bytes, tensorCount);
    pushU64(bytes, metadataCount);
    return Uint8Array.from(bytes);
}

function buildCumulativeArrayLimitFixture(): Uint8Array {
    const bytes: number[] = [];
    // Half of the retired 2,000,000-element ceiling, plus one, in each of two
    // arrays: the shape that used to trip the cumulative budget.
    const perArray = 1_000_001;
    pushAscii(bytes, 'GGUF'); pushU32(bytes, 3); pushU64(bytes, 0n); pushU64(bytes, 2n);
    for (const key of ['array.a', 'array.b']) {
        pushString(bytes, key); pushU32(bytes, 9); pushU32(bytes, 0); pushU64(bytes, BigInt(perArray));
        for (let index = 0; index < perArray; index += 1) bytes.push(0);
    }
    return Uint8Array.from(bytes);
}

/** Mirrors the tokenizer shape of a Qwen3-sized GGUF: two large STRING arrays. */
function buildLargeVocabularyFixture(tokenCount: number, mergeCount: number): Uint8Array {
    const bytes: number[] = [];
    pushAscii(bytes, 'GGUF'); pushU32(bytes, 3); pushU64(bytes, 0n); pushU64(bytes, 3n);
    pushStringMetadata(bytes, 'general.architecture', 'qwen3vl');
    pushIndexedStringArray(bytes, 'tokenizer.ggml.tokens', tokenCount, 't');
    pushIndexedStringArray(bytes, 'tokenizer.ggml.merges', mergeCount, 'm');
    return Uint8Array.from(bytes);
}

function pushIndexedStringArray(bytes: number[], key: string, count: number, prefix: string): void {
    pushString(bytes, key);
    pushU32(bytes, 9); // ARRAY
    pushU32(bytes, 8); // STRING element type
    pushU64(bytes, BigInt(count));
    for (let index = 0; index < count; index += 1) pushString(bytes, `${prefix}${index}`);
}

/**
 * Two metadata strings whose combined length crosses GGUF_PARSE_STRING_BYTE_LIMIT,
 * with the bytes actually present and a real tensor behind them. The strings have
 * to be genuinely there: a file that merely *declares* them and stops is truncated,
 * which is a structural rejection rather than a budget case.
 */
function buildCumulativeStringLimitFixture(): Uint8Array {
    const perString = Math.floor(GGUF_PARSE_STRING_BYTE_LIMIT / 2) + 1;
    const writer = new GgufWriter();
    writer.ascii('GGUF').u32(3).u64(1n).u64(2n);
    for (const key of ['huge.a', 'huge.b']) writer.str(key).u32(8).filledString(perString, 0x78);
    writer.tensor('weight', [2n, 3n], 0, 0n);
    return writer.padTo(32).zeros(24).done();
}

function pushStringMetadata(bytes: number[], key: string, value: string): void {
    pushString(bytes, key);
    pushU32(bytes, 8); // STRING
    pushString(bytes, value);
}

function pushU32Metadata(bytes: number[], key: string, value: number): void {
    pushString(bytes, key);
    pushU32(bytes, 4); // UINT32
    pushU32(bytes, value);
}

function pushStringArrayMetadata(bytes: number[], key: string, values: string[]): void {
    pushString(bytes, key);
    pushU32(bytes, 9); // ARRAY
    pushU32(bytes, 8); // STRING element type
    pushU64(bytes, BigInt(values.length));
    for (const value of values) pushString(bytes, value);
}

function pushString(bytes: number[], value: string): void {
    const encoded = new TextEncoder().encode(value);
    pushU64(bytes, BigInt(encoded.length));
    for (const byte of encoded) bytes.push(byte);
}

function pushAscii(bytes: number[], value: string): void {
    bytes.push(...new TextEncoder().encode(value));
}

function pushU32(bytes: number[], value: number): void {
    bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushU64(bytes: number[], value: bigint): void {
    for (let shift = 0n; shift < 64n; shift += 8n) bytes.push(Number(value >> shift & 0xffn));
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    formatBigCount,
    GGUF_NORMALIZED_TEXT_BUDGET,
    GGUF_PARSE_ARRAY_ELEMENT_LIMIT,
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
    it('uses @huggingface/gguf for local prefix parsing and creates a JSON-safe document', async () => {
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

    it('rejects metadata keys that overwrite parser-reserved header fields', async () => {
        const document = await parseGgufBytes(buildGgufFixture(0, undefined, 99));

        expectInvalid(document);
        expect(document.version).toBeUndefined();
        expect(warningText(document)).toMatch(/metadata.*reserved header fields/i);
    });

    it('rejects excessive source counts before the upstream parser creates entry objects', async () => {
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

    it('preflights cumulative metadata array elements and string bytes without boxing values', async () => {
        const arrays = await parseGgufBytes(buildCumulativeArrayLimitFixture());
        const strings = await parseGgufBytes(buildCumulativeStringLimitFixture());

        expectInvalid(arrays);
        expect(warningText(arrays)).toMatch(/metadata arrays.*cumulative element limit/i);
        expectInvalid(strings);
        expect(warningText(strings)).toMatch(/metadata strings.*cumulative byte limit/i);
    });

    it('returns an invalid document when the upstream parser rejects a file', async () => {
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

    it('accepts a terminal 416 when upstream prefetches past a small file', async () => {
        const bytes = buildGgufFixture(1_600_000);
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

        expect(remote.version).toBe(3);
        expect(remote.title).toBe('Tiny Model');
        expect(memory.version).toBe(3);
        expect(requestedRanges).toEqual(['bytes=0-1999999', 'bytes=2000000-3999999']);
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
    const perArray = Math.floor(GGUF_PARSE_ARRAY_ELEMENT_LIMIT / 2) + 1;
    pushAscii(bytes, 'GGUF'); pushU32(bytes, 3); pushU64(bytes, 0n); pushU64(bytes, 2n);
    for (const key of ['array.a', 'array.b']) {
        pushString(bytes, key); pushU32(bytes, 9); pushU32(bytes, 0); pushU64(bytes, BigInt(perArray));
        for (let index = 0; index < perArray; index += 1) bytes.push(0);
    }
    return Uint8Array.from(bytes);
}

function buildCumulativeStringLimitFixture(): Uint8Array {
    const bytes: number[] = [];
    const perString = Math.floor(GGUF_PARSE_STRING_BYTE_LIMIT / 2) + 1;
    pushAscii(bytes, 'GGUF'); pushU32(bytes, 3); pushU64(bytes, 0n); pushU64(bytes, 2n);
    pushString(bytes, 'a'); pushU32(bytes, 8); pushU64(bytes, BigInt(perString));
    for (let index = 0; index < perString; index += 1) bytes.push(0);
    pushString(bytes, 'b'); pushU32(bytes, 8); pushU64(bytes, BigInt(perString));
    return Uint8Array.from(bytes);
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArrowDocument } from '../../parsers/arrow/index.js';
import type { ParseOutcome } from '../../parsers/types.js';
import { parseSelfLoadingArrow } from '../../parsers/arrow/self-loading.js';
import { MountAbortedError } from '../types.js';
import { mountSelfLoadingArrowViewer } from './self-loading.js';

vi.mock('../../parsers/arrow/self-loading.js', () => ({ parseSelfLoadingArrow: vi.fn() }));
const ctx = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: { t: (key: string) => key }, logger: { log() {} } };
afterEach(() => vi.clearAllMocks());

describe('self-loading Arrow cancellation', () => {
    it.each(['mount', 'parse'] as const)('settles promptly when the %s signal aborts during a pending load', async which => {
        let finish!: (value: ParseOutcome<ArrowDocument>) => void;
        vi.mocked(parseSelfLoadingArrow).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const mountAbort = new AbortController(), parseAbort = new AbortController();
        const removeMount = vi.spyOn(mountAbort.signal, 'removeEventListener'), removeParse = vi.spyOn(parseAbort.signal, 'removeEventListener');
        const container = document.createElement('div');
        const pending = mountSelfLoadingArrowViewer({ fileName: 'sample.arrow', data: new Uint8Array() }, container, ctx, { signal: mountAbort.signal, parse: { signal: parseAbort.signal } });
        const rejected = expect(pending).rejects.toBeInstanceOf(MountAbortedError);
        (which === 'mount' ? mountAbort : parseAbort).abort();
        await rejected;
        expect(vi.mocked(parseSelfLoadingArrow).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(removeMount).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(removeParse).toHaveBeenCalledWith('abort', expect.any(Function));
        finish({ result: { status: 'failed', failure: { code: 'invalid-format', retryable: false, messageKey: 'diag.arrow.invalid' }, diagnostics: [] }, execution: { elapsedMillis: 0, workerUsed: false, hardLimitEnforced: false } });
        await Promise.resolve(); expect(container.childNodes).toHaveLength(0); expect(container.shadowRoot).toBeNull();
    });
});

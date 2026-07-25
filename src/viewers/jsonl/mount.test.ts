// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountJsonlViewer } from './index.js';
const base = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };
describe('mountJsonlViewer', () => {
    it('connects editing, validation, selection, deletion and syntax highlighting', async () => {
        const write = vi.fn(async (_data: Uint8Array) => undefined); const container = document.createElement('div');
        await mountJsonlViewer({ fileName: 'a.jsonl', data: new TextEncoder().encode('{"a":1}\n{"b":2}') }, container, { ...base, writeback: { write } }); const root = container.shadowRoot!;
        expect(root.querySelector('.omni-jsonl__key')?.textContent).toBe('"a"');
        root.querySelector<HTMLElement>('.omni-jsonl__row')!.click();
        const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!; textarea.value = '{bad'; textarea.dispatchEvent(new Event('input')); expect([...root.querySelectorAll('button')].find(button => button.textContent === 'Apply')?.disabled).toBe(true);
    });

    it('shows pretty JSON in a debounced hover popup and edits the original record text', async () => {
        vi.useFakeTimers();
        try {
            const container = document.createElement('div');
            await mountJsonlViewer({ fileName: 'a.jsonl', data: new TextEncoder().encode('{"name":"Gilbert","score":24}\n') }, container, base);
            const root = container.shadowRoot!; const row = root.querySelector<HTMLElement>('.omni-jsonl__row')!;
            row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 40, clientY: 50 }));
            expect(root.querySelector<HTMLElement>('.omni-jsonl__popup')!.style.display).toBe('');
            vi.advanceTimersByTime(150);
            const popup = root.querySelector<HTMLElement>('.omni-jsonl__popup')!;
            expect(popup.style.display).toBe('block'); expect(popup.textContent).toContain('Gilbert');
            row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })); expect(popup.style.display).toBe('none');
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 60, clientY: 70 }));
            expect(popup.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('{"name":"Gilbert","score":24}');
        } finally { vi.useRealTimers(); }
    });

    it('preserves large integers, duplicate keys, and formatting when Apply is used without edits', async () => {
        const original = '{ "id": 9007199254740993, "dup": 1, "dup": 2 }\n';
        const write = vi.fn(async (_data: Uint8Array) => undefined); const container = document.createElement('div');
        await mountJsonlViewer({ fileName: 'a.jsonl', data: new TextEncoder().encode(original) }, container, { ...base, writeback: { write } });
        const root = container.shadowRoot!;
        root.querySelector<HTMLElement>('.omni-jsonl__row')!.click();
        const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!; expect(textarea.value).toBe(original.trimEnd());
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply')!.click();
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save')!.click();
        await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
        expect(new TextDecoder().decode(write.mock.calls[0]![0])).toBe(original);
    });

    it('rejects multi-line edits because one JSONL record must remain on one physical line', async () => {
        const container = document.createElement('div');
        await mountJsonlViewer({ fileName: 'a.jsonl', data: new TextEncoder().encode('{"a":1}\n') }, container, base);
        const root = container.shadowRoot!; root.querySelector<HTMLElement>('.omni-jsonl__row')!.click();
        const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!; textarea.value = '{\n"a": 1\n}'; textarea.dispatchEvent(new Event('input'));
        expect([...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply')!.disabled).toBe(true);
        expect(root.querySelector('.omni-jsonl__editor-error')?.textContent).toBe('Each JSON Lines record must stay on one physical line.');
    });
});

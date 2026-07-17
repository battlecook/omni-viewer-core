// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../host/index.js';
import { createCatalogI18n } from '../../i18n/index.js';
import { MountAbortedError } from '../types.js';
import { exportFileName, mountCsvViewer, saveAsFileName } from './index.js';
import { mountFallbackViewer } from '../fallback/index.js';

const enc = new TextEncoder();

function stubCtx(): HostContext {
    return {
        assets: { resolveAssetUrl: async (p) => p },
        i18n: createCatalogI18n(),
        logger: { log: () => undefined }
    };
}

function csvInput(text: string, fileName = 'test.csv') {
    return { fileName, data: enc.encode(text) };
}

function shadow(container: HTMLElement): ShadowRoot {
    const root = container.shadowRoot;
    if (!root) throw new Error('expected shadow root');
    return root;
}

/** Header sort is deferred behind a double-click window; click + flush it. */
function clickSort(th: HTMLElement): void {
    vi.useFakeTimers();
    try {
        th.click();
        vi.runAllTimers();
    } finally {
        vi.useRealTimers();
    }
}

describe('mountCsvViewer', () => {
    it('renders headers and rows inside a shadow root', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('a,b\n1,2\n3,4\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const headers = [
            ...root.querySelectorAll('thead th:not(.omni-csv__rowops)')
        ].map((th) => th.textContent?.replace(/[▲▼]/g, '').trim());
        expect(headers).toEqual(['a', 'b']);
        expect(root.querySelectorAll('tbody tr').length).toBe(2);
        handle.dispose();
        expect(root.childNodes.length).toBe(0);
    });

    it('sorts when a header is clicked', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('n\n10\n2\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        clickSort(root.querySelector('thead th:not(.omni-csv__rowops)') as HTMLElement);
        const cells = [
            ...root.querySelectorAll('tbody td:not(.omni-csv__rowops)')
        ].map((td) => td.textContent);
        expect(cells).toEqual(['2', '10']);
        const th = root.querySelector('thead th:not(.omni-csv__rowops)');
        expect(th?.getAttribute('aria-sort')).toBe('ascending');
        handle.dispose();
    });

    it('long cells expose their full content via a hover tooltip', async () => {
        const longText = 'Record 1: A long searchable text field for virtual scrolling and cell truncation testing.';
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput(`body,tag\n"${longText}",short\n`),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const tds = [
            ...root.querySelectorAll('tbody td:not(.omni-csv__rowops)')
        ] as HTMLElement[];
        expect(tds[0]?.title).toBe(longText); // truncated cell -> full text
        expect(tds[1]?.title).toBe(''); // short cell -> no tooltip noise
        handle.dispose();
    });

    it('column resize: drag adjusts width, persists across re-render, dblclick resets', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('body,tag,role\nfoo,bar,dev\nbaz,qux,ops\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const grip = root.querySelector('.omni-csv__resize-handle') as HTMLElement;

        grip.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160 }));
        window.dispatchEvent(new MouseEvent('pointerup', {}));

        const table = () => root.querySelector('table') as HTMLTableElement;
        const firstCol = () => table().querySelector('col') as HTMLTableColElement;
        // jsdom offsetWidth is 0 -> fallback 120, +60px drag = 180px.
        expect(firstCol().style.width).toBe('180px');
        expect(table().style.tableLayout).toBe('fixed');
        // The table width tracks the frozen columns, so spare container space
        // cannot be distributed into the column that was not dragged.
        expect(table().style.width).toBe('360px');
        expect(table().style.minWidth).toBe('0');
        expect(table().querySelectorAll('col')[1]?.getAttribute('style')).toContain('60px');
        // Dragging another boundary must leave non-adjacent columns untouched.
        const secondGrip = [...root.querySelectorAll('.omni-csv__resize-handle')][1] as HTMLElement;
        secondGrip.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 220 }));
        window.dispatchEvent(new MouseEvent('pointerup', {}));
        expect(firstCol().style.width).toBe('180px');
        expect(table().querySelectorAll('col')[1]?.getAttribute('style')).toContain('80px');
        expect(table().querySelectorAll('col')[2]?.getAttribute('style')).toContain('100px');
        expect(table().style.width).toBe('360px');
        // Resizing must not have toggled the sort.
        const dataTh = () =>
            root.querySelector('thead th:not(.omni-csv__rowops)') as HTMLElement;
        expect(dataTh().getAttribute('aria-sort')).toBeNull();

        // Widths survive a re-render (sort toggling rebuilds the table).
        clickSort(dataTh());
        expect(firstCol().style.width).toBe('180px');
        expect(table().style.tableLayout).toBe('fixed');

        // Double-click resets that column; layout stays fixed while other
        // frozen columns still have widths. Resetting all returns to auto.
        (root.querySelector('.omni-csv__resize-handle') as HTMLElement).dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true })
        );
        expect(firstCol().style.width).toBe('');
        expect(table().style.tableLayout).toBe('fixed');

        const resetSecondGrip = [...root.querySelectorAll('.omni-csv__resize-handle')][1] as HTMLElement;
        resetSecondGrip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const resetThirdGrip = [...root.querySelectorAll('.omni-csv__resize-handle')][2] as HTMLElement;
        resetThirdGrip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(firstCol().style.width).toBe('');
        expect(table().style.tableLayout).toBe('');
        handle.dispose();
    });

    it('statistics toggle inserts a sticky stats row under the header', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('name,age\nkim,32\nlee,28\npark,\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        expect(root.querySelector('.omni-csv__stats-row')).toBeNull();

        const statsBtn = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => b.textContent === 'Statistics'
        ) as HTMLElement;
        statsBtn.click();

        const statsRow = root.querySelector('thead .omni-csv__stats-row');
        expect(statsRow).not.toBeNull();
        const cells = [
            ...(statsRow as HTMLElement).querySelectorAll<HTMLTableCellElement>(
                'th:not(.omni-csv__rowops)'
            )
        ];
        expect(cells.length).toBe(2); // aligned per column
        // Text column: count only. Numeric column with a null: full compact form.
        expect(cells[0]?.textContent).toBe('n=3');
        expect(cells[1]?.textContent).toBe('n=2 · null 33.3% · μ30 · 28~32');
        // Tooltip carries the detailed, document-wide figures.
        expect(cells[1]?.title).toContain('Count 2 / 3');
        expect(cells[1]?.title).toContain('Mean 30');

        statsBtn.click();
        expect(root.querySelector('.omni-csv__stats-row')).toBeNull();
        handle.dispose();
    });

    it('stats row aligns with the row-number column when both are on', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('n\n1\n2\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        for (const label of ['Row numbers', 'Statistics']) {
            (
                [...root.querySelectorAll('.omni-csv__toolbar button')].find(
                    (b) => b.textContent === label
                ) as HTMLElement
            ).click();
        }
        const statsCells = [
            ...(root.querySelector('.omni-csv__stats-row') as HTMLElement).querySelectorAll('th')
        ];
        expect(statsCells.length).toBe(2); // row-number spacer + 1 data column
        expect(statsCells[0]?.classList.contains('omni-csv__rownum')).toBe(true);
        expect(statsCells[1]?.textContent).toBe('n=2 · μ1.5 · 1~2');
        handle.dispose();
    });

    it('disables copy/export buttons without clipboard/save services (degraded mode)', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(csvInput('a\n1\n'), container, stubCtx());
        const root = shadow(container);
        // Degraded mode = disabled with an explanatory tooltip (undo/redo are
        // merely state-disabled and carry no tooltip).
        const degraded = [...root.querySelectorAll('.omni-csv__toolbar button')].filter(
            (b) => (b as HTMLButtonElement).disabled && (b as HTMLButtonElement).title.length > 0
        );
        expect(degraded.length).toBe(5); // Copy TSV, Copy JSON, Export file, Save, Save as
        handle.dispose();
    });

    it('copies TSV through the clipboard service when provided', async () => {
        const container = document.createElement('div');
        let copied = '';
        const ctx = {
            ...stubCtx(),
            clipboard: {
                writeText: async (text: string) => {
                    copied = text;
                }
            }
        };
        const handle = await mountCsvViewer(csvInput('a,b\n1,2\n'), container, ctx);
        const root = shadow(container);
        const copyBtn = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => !(b as HTMLButtonElement).disabled && b.textContent?.includes('TSV')
        ) as HTMLElement;
        copyBtn.click();
        await Promise.resolve();
        expect(copied).toBe('a\tb\n1\t2');
        handle.dispose();
    });

    it('shows diagnostics for ragged rows', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('a,b\n1\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const diag = root.querySelector('.omni-csv__diagnostics');
        expect(diag?.textContent).toContain('1 row(s)');
        handle.dispose();
    });

    it('rejects with MountAbortedError for an aborted signal', async () => {
        const container = document.createElement('div');
        const controller = new AbortController();
        controller.abort();
        await expect(
            mountCsvViewer(csvInput('a\n1\n'), container, stubCtx(), {
                signal: controller.signal
            })
        ).rejects.toBeInstanceOf(MountAbortedError);
    });

    it('double-click cell edit commits, dirty badge shows, save writes back', async () => {
        const container = document.createElement('div');
        let written = '';
        const ctx = {
            ...stubCtx(),
            writeback: {
                write: async (data: Uint8Array) => {
                    written = new TextDecoder().decode(data);
                }
            }
        };
        const handle = await mountCsvViewer(csvInput('name\nkim\nlee\n'), container, ctx);
        const root = shadow(container);
        const btn = (label: string) =>
            [...root.querySelectorAll('.omni-csv__toolbar button')].find(
                (b) => b.textContent === label || b.getAttribute('aria-label') === label
            ) as HTMLButtonElement;

        expect(handle.isDirty()).toBe(false);
        expect((root.querySelector('select') as HTMLSelectElement).disabled).toBe(false);

        const td = root.querySelector('tbody td:not(.omni-csv__rowops)') as HTMLElement;
        td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = td.querySelector('input') as HTMLInputElement;
        input.value = 'park';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        expect(handle.isDirty()).toBe(true);
        expect(root.querySelector('.omni-csv__dirty')?.textContent).toContain('Unsaved');
        // Dirty guard: delimiter switching is now disabled.
        expect((root.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
        expect(
            [...root.querySelectorAll('tbody td')].some((c) => c.textContent === 'park')
        ).toBe(true);

        btn('Save').click();
        await Promise.resolve();
        expect(written).toBe('name\npark\nlee');
        expect(handle.isDirty()).toBe(false);
        handle.dispose();
    });

    it('row insert/delete via right-click context menu and header rename via double-click', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(csvInput('n\n1\n2\n'), container, stubCtx());
        const root = shadow(container);

        const rightClick = (row: Element) =>
            row.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
            );
        const menuItem = (label: string) =>
            [...root.querySelectorAll('.omni-csv__menu button')].find(
                (b) => b.textContent === label
            ) as HTMLElement;

        // Insert below the first row via the context menu.
        rightClick(root.querySelector('tbody tr') as Element);
        expect(root.querySelector('.omni-csv__menu')).not.toBeNull();
        menuItem('Insert row below').click();
        expect(root.querySelector('.omni-csv__menu')).toBeNull(); // menu closes
        expect(root.querySelectorAll('tbody tr').length).toBe(3);

        // Delete that inserted (empty) row again.
        rightClick(root.querySelectorAll('tbody tr')[1] as Element);
        menuItem('Delete row').click();
        expect(root.querySelectorAll('tbody tr').length).toBe(2);

        // Header double-click renames (single click would sort after a delay).
        const th = root.querySelector('thead th:not(.omni-csv__rowops)') as HTMLElement;
        th.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const headerInput = th.querySelector('input') as HTMLInputElement;
        headerInput.value = 'num';
        headerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const renamedTh = root.querySelector('thead th:not(.omni-csv__rowops)');
        expect(renamedTh?.textContent).toContain('num');
        expect(renamedTh?.getAttribute('aria-sort')).toBeNull();
        handle.dispose();
    });

    it('partial documents are not editable: no row ops, dblclick shows a notice', async () => {
        const lines = ['h'];
        for (let i = 0; i < 20; i++) lines.push(String(i));
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput(lines.join('\n')),
            container,
            stubCtx(),
            { limits: { maxEntries: 5 } }
        );
        const root = shadow(container);
        (root.querySelector('tbody tr') as Element).dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
        expect(root.querySelector('.omni-csv__menu')).toBeNull();
        const td = root.querySelector('tbody td') as HTMLElement;
        td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(td.querySelector('input')).toBeNull();
        expect(root.querySelector('.omni-csv__toast')?.textContent).toContain(
            'fully parsed'
        );
        handle.dispose();
    });

    it('search input filters rows, shows match summary and no-match message', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('name\nalice\nbob\nALINA\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const input = root.querySelector('input[type="search"]') as HTMLInputElement;

        input.value = 'al';
        input.dispatchEvent(new Event('input'));
        expect(root.querySelectorAll('tbody tr').length).toBe(2); // alice, ALINA
        expect(root.querySelector('.omni-csv__meta')?.textContent).toContain('2 / 3');

        input.value = 'zzz';
        input.dispatchEvent(new Event('input'));
        expect(root.querySelector('tbody')).toBeNull();
        expect(root.querySelector('.omni-csv__empty')?.textContent).toContain(
            'No matching rows'
        );
        handle.dispose();
    });

    it('row numbers toggle shows original data row numbers even when sorted', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('n\n30\n10\n20\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const toggle = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => b.textContent === 'Row numbers'
        ) as HTMLElement;
        toggle.click();
        clickSort(
            root.querySelector(
                'thead th:not(.omni-csv__rownum):not(.omni-csv__rowops)'
            ) as HTMLElement
        );
        const nums = [...root.querySelectorAll('tbody td.omni-csv__rownum')].map(
            (td) => td.textContent
        );
        expect(nums).toEqual(['2', '3', '1']); // sorted 10,20,30 -> original rows 2,3,1
        handle.dispose();
    });

    it('page size select repaginates', async () => {
        const lines = ['h'];
        for (let i = 0; i < 250; i++) lines.push(String(i));
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput(lines.join('\n')),
            container,
            stubCtx()
        );
        const root = shadow(container);
        expect(root.querySelectorAll('tbody tr').length).toBe(250); // default 500/page
        const sizeSelect = [...root.querySelectorAll('select')].find((s) =>
            [...s.options].some((o) => o.value === '100')
        ) as HTMLSelectElement;
        sizeSelect.value = '100';
        sizeSelect.dispatchEvent(new Event('change'));
        expect(root.querySelectorAll('tbody tr').length).toBe(100);
        expect(root.querySelector('.omni-csv__footer')?.textContent).toContain('1 / 3');
        handle.dispose();
    });

    it('disables the export button without a save service (degraded mode)', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(csvInput('a\n1\n'), container, stubCtx());
        const root = shadow(container);
        const exportBtn = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => b.textContent === 'Export'
        ) as HTMLButtonElement;
        expect(exportBtn.disabled).toBe(true);
        expect(exportBtn.title.length).toBeGreaterThan(0);
        handle.dispose();
    });

    it('exports the filtered display result through the save service', async () => {
        const container = document.createElement('div');
        let saved: { name: string; text: string; mime: string } | null = null;
        const ctx = {
            ...stubCtx(),
            save: {
                saveFile: async (name: string, data: Uint8Array, mime: string) => {
                    saved = { name, text: new TextDecoder().decode(data), mime };
                }
            }
        };
        const handle = await mountCsvViewer(
            csvInput('name\nalice\nbob\n', 'people.csv'),
            container,
            ctx
        );
        const root = shadow(container);
        const input = root.querySelector('input[type="search"]') as HTMLInputElement;
        input.value = 'ali';
        input.dispatchEvent(new Event('input'));

        const exportBtn = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => b.textContent === 'Export'
        ) as HTMLElement;
        expect(exportBtn.title).toContain('search and sorted results');
        exportBtn.click();
        await Promise.resolve();

        expect(saved).toEqual({
            name: 'people-export.csv',
            text: 'name\nalice',
            mime: 'text/csv'
        });
        handle.dispose();
    });

    it('save as opens the host save flow with the complete edited document', async () => {
        const container = document.createElement('div');
        let saved: { name: string; text: string; mime: string } | null = null;
        const ctx = {
            ...stubCtx(),
            save: {
                saveFile: async (name: string, data: Uint8Array, mime: string) => {
                    saved = { name, text: new TextDecoder().decode(data), mime };
                }
            }
        };
        const handle = await mountCsvViewer(
            csvInput('name\nalice\nbob\n', 'people.csv'),
            container,
            ctx
        );
        const root = shadow(container);
        const input = root.querySelector('input[type="search"]') as HTMLInputElement;
        input.value = 'ali';
        input.dispatchEvent(new Event('input'));

        const saveAsBtn = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => b.textContent === 'Save as'
        ) as HTMLElement;
        saveAsBtn.click();
        await Promise.resolve();

        expect(saved).toEqual({
            name: 'people.csv',
            text: 'name\nalice\nbob',
            mime: 'text/csv'
        });
        handle.dispose();
    });

    it('exportFileName picks the extension by delimiter', () => {
        expect(exportFileName('data.csv', ',')).toBe('data-export.csv');
        expect(exportFileName('data.old.tsv', '\t')).toBe('data.old-export.tsv');
        expect(exportFileName('noext', ';')).toBe('noext-export.csv');
    });

    it('saveAsFileName keeps the source stem and uses the active delimiter extension', () => {
        expect(saveAsFileName('data.csv', ',')).toBe('data.csv');
        expect(saveAsFileName('data.old.tsv', '\t')).toBe('data.old.tsv');
        expect(saveAsFileName('noext', ';')).toBe('noext.csv');
    });

    it('surfaces the failure reason for failed parses', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('a,b\n1,2\n'),
            container,
            stubCtx(),
            { limits: { maxInputBytes: 2 } }
        );
        const root = shadow(container);
        const error = root.querySelector('.omni-csv__diag-error');
        expect(error?.textContent).toContain('maximum supported size');
        handle.dispose();
    });

    it('switches delimiter manually and returns via auto detect', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(
            csvInput('a;b\n1;2\n'),
            container,
            stubCtx()
        );
        const root = shadow(container);
        const select = root.querySelector('select') as HTMLSelectElement;
        expect(select.value).toBe(';');

        const dataThCount = () =>
            root.querySelectorAll('thead th:not(.omni-csv__rowops)').length;
        select.value = ',';
        select.dispatchEvent(new Event('change'));
        expect(dataThCount()).toBe(1);

        select.value = 'auto';
        select.dispatchEvent(new Event('change'));
        expect(dataThCount()).toBe(2);
        expect(select.value).toBe(';'); // snaps back to the detected delimiter
        handle.dispose();
    });

    it('refuses clipboard copies above the 1 MiB guard', async () => {
        const container = document.createElement('div');
        let copied: string | null = null;
        const ctx = {
            ...stubCtx(),
            clipboard: {
                writeText: async (text: string) => {
                    copied = text;
                }
            }
        };
        const bigCell = 'x'.repeat(1100 * 1024);
        const handle = await mountCsvViewer(csvInput(`a\n${bigCell}\n`), container, ctx);
        const root = shadow(container);
        const copyBtn = [...root.querySelectorAll('.omni-csv__toolbar button')].find(
            (b) => b.textContent?.includes('TSV')
        ) as HTMLElement;
        copyBtn.click();
        await Promise.resolve();
        expect(copied).toBeNull();
        expect(root.querySelector('.omni-csv__toast')?.textContent).toContain(
            'Too large'
        );
        handle.dispose();
    });

    it('falls back to scoped mode when requested', async () => {
        const container = document.createElement('div');
        const handle = await mountCsvViewer(csvInput('a\n1\n'), container, stubCtx(), {
            styleIsolation: 'scoped'
        });
        expect(container.classList.contains('omni-viewer--csv')).toBe(true);
        expect(container.querySelector('table')).not.toBeNull();
        handle.dispose();
        expect(container.childNodes.length).toBe(0);
        expect(container.classList.contains('omni-viewer--csv')).toBe(false);
    });
});

describe('mountFallbackViewer', () => {
    it('renders a text preview for UTF-8 bytes', async () => {
        const container = document.createElement('div');
        const handle = await mountFallbackViewer(
            { fileName: 'notes.xyz', data: enc.encode('hello world\nline 2') },
            container,
            stubCtx()
        );
        const root = shadow(container);
        expect(root.querySelector('.omni-fallback__content')?.textContent).toContain(
            'hello world'
        );
        handle.dispose();
    });

    it('renders a hex dump for binary bytes', async () => {
        const container = document.createElement('div');
        const handle = await mountFallbackViewer(
            { fileName: 'blob.bin', data: new Uint8Array([0, 1, 2, 0xff, 0x41]) },
            container,
            stubCtx()
        );
        const root = shadow(container);
        const content = root.querySelector('.omni-fallback__content')?.textContent ?? '';
        expect(content).toContain('00000000');
        expect(content).toContain('|...ÿA|'.slice(0, 1)); // ascii column present
        handle.dispose();
    });

    it('rejects with MountAbortedError for an aborted signal', async () => {
        const container = document.createElement('div');
        const controller = new AbortController();
        controller.abort();
        await expect(
            mountFallbackViewer(
                { fileName: 'x.bin', data: new Uint8Array([0]) },
                container,
                stubCtx(),
                { signal: controller.signal }
            )
        ).rejects.toBeInstanceOf(MountAbortedError);
    });

    it('shows the degradation reason when given', async () => {
        const container = document.createElement('div');
        const handle = await mountFallbackViewer(
            { fileName: 'x.bin', data: new Uint8Array([0]) },
            container,
            stubCtx(),
            { reasonKey: 'fallback.reason.missing-dependency' }
        );
        const root = shadow(container);
        expect(root.querySelector('.omni-fallback__reason')?.textContent).toContain(
            'could not be loaded'
        );
        handle.dispose();
    });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountAvroViewer } from '../avro/index.js';
import { mountBagViewer } from '../bag/index.js';
import { mountDb3Viewer } from '../db3/index.js';
import { mountReqifViewer } from '../reqif/index.js';
import { mountStpViewer } from '../stp/index.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const ctx = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };

describe('automotive viewer mounts', () => {
    it.each([
        ['AVRO', mountAvroViewer, Uint8Array.of(0x4f, 0x62, 0x6a, 0x01, 0)],
        ['BAG', mountBagViewer, encode('#ROSBAG V2.0\n')],
        ['STP', mountStpViewer, encode('ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'AP214\'));\nENDSEC;')],
        ['DB3', mountDb3Viewer, encode('SQLite format 3\0')],
        ['REQIF', mountReqifViewer, encode('<REQ-IF><REQ-IF-HEADER><TITLE>Demo</TITLE></REQ-IF-HEADER></REQ-IF>')]
    ] as const)('renders and disposes the %s viewer', async (label, mount, data) => {
        const container = document.createElement('div');
        const handle = await mount({ fileName: `sample.${label.toLowerCase()}`, data }, container, ctx);
        expect(container.shadowRoot?.querySelector('.omni-auto__eyebrow')?.textContent).toBe(label);
        expect(container.shadowRoot?.querySelector('table')).not.toBeNull();
        handle.dispose();
        expect(container.shadowRoot?.childNodes).toHaveLength(0);
    });

    it('filters tables, opens raw preview, and copies the model', async () => {
        const writeText = vi.fn(async () => undefined);
        const container = document.createElement('div');
        await mountStpViewer({ fileName: 'part.stp', data: encode('ISO-10303-21;\nDATA;\n#1=CARTESIAN_POINT(\'A\',(0.,0.,0.));\n#2=DIRECTION(\'Z\',(0.,0.,1.));') }, container, { ...ctx, clipboard: { writeText } });
        const root = container.shadowRoot!;
        const entityTab = [...root.querySelectorAll<HTMLButtonElement>('.omni-auto__tabs button')].find(button => button.textContent === 'Entity preview')!;
        entityTab.click();
        const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
        search.value = 'direction';
        search.dispatchEvent(new Event('input'));
        expect(root.querySelector('tbody')?.textContent).toContain('DIRECTION');
        expect(root.querySelector('tbody')?.textContent).not.toContain('CARTESIAN_POINT');
        [...root.querySelectorAll<HTMLButtonElement>('.omni-auto__tabs button')].find(button => button.textContent === 'Raw Preview')!.click();
        expect(root.querySelector('.omni-auto__raw')?.textContent).toContain('ISO-10303-21');
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy JSON')!.click();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"format": "STP"'));
    });
});

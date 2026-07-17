// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HwpDocument, initSync } from '@rhwp/core';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountHwpViewer } from './index.js';

const require = createRequire(import.meta.url);
initSync({ module: readFileSync(require.resolve('@rhwp/core/rhwp_bg.wasm')) });
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): Uint8Array => Uint8Array.from(Buffer.from(readFileSync(join(fixtureDirectory, `${name}.b64`), 'utf8'), 'base64'));
const context = { assets: { resolveAssetUrl: async (path: string) => path }, i18n: createCatalogI18n(), logger: { log: () => undefined } };

describe('real HWP document layout regression', () => {
    it.each([
        ['aligns.hwp', 16, '872b19f5aaba550489a28fe931ebef34203dccaffaa352383a89eb9438e04b0f', false],
        ['simpletable.hwpx', 1, '4d5acc5459aa6b69d59bcd7d4c54caad087c997bf8b2860c684d28ada6cec901', true]
    ] as const)('renders %s with stable text and layout geometry', async (name, pages, svgHash, hasTableLines) => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const bytes = fixture(name); const document = new HwpDocument(bytes); expect(document.pageCount()).toBe(pages);
        const svg = document.renderPageSvg(0); document.free();
        expect(svg).toContain('<text'); expect(createHash('sha256').update(svg).digest('hex')).toBe(svgHash);
        if (hasTableLines) expect((svg.match(/<line\b/g) ?? []).length).toBeGreaterThan(0);
        const container = window.document.createElement('div'); const handle = await mountHwpViewer({ fileName: name, data: bytes }, container, context, { loadRhwp: async () => ({ HwpDocument }) });
        expect(container.shadowRoot?.querySelector('text')?.textContent?.length).toBeGreaterThan(0); handle.dispose();
    });
});

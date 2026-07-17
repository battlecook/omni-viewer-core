// @vitest-environment jsdom
// Real-engine conformance smoke. Runtime adapters still inject the vendored
// bundle; this exact dev pin only verifies that contract in CI.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import init, { HwpDocument, initSync, version } from '@rhwp/core';
import { mountHwpViewer, SUPPORTED_DEPENDENCY_VERSIONS } from './index.js';

void init; // Keep the default initializer type-checked; Node smoke uses initSync.
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@rhwp/core/rhwp_bg.wasm');
initSync({ module: readFileSync(wasmPath) });

describe('rhwp 0.7.3 conformance', () => {
    it('round-trips and mounts actual HWP and HWPX bytes without stripping images or clips', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        expect(version()).toBe(SUPPORTED_DEPENDENCY_VERSIONS.rhwp);
        const source = HwpDocument.createEmpty();
        source.createBlankDocument();
        const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9f8AAAAASUVORK5CYII=', 'base64'));
        expect(source.insertPicture(0, 0, 0, png, 7200, 7200, 1, 1, 'png', 'smoke')).toContain('"ok":true');
        const bmp = new Uint8Array(58); const bmpView = new DataView(bmp.buffer); bmp.set([0x42, 0x4d]); bmpView.setUint32(2, 58, true); bmpView.setUint32(10, 54, true); bmpView.setUint32(14, 40, true); bmpView.setInt32(18, 1, true); bmpView.setInt32(22, 1, true); bmpView.setUint16(26, 1, true); bmpView.setUint16(28, 24, true); bmpView.setUint32(34, 4, true); bmp.set([0, 0, 255, 0], 54);
        expect(source.insertPicture(0, 1, 0, bmp, 7200, 7200, 1, 1, 'bmp', 'bmp-smoke')).toContain('"ok":true');
        const fixtures = [{ bytes: source.exportHwp(), expectsImage: true }, { bytes: source.exportHwpx(), expectsImage: false }];
        source.free();
        for (const [index, { bytes, expectsImage }] of fixtures.entries()) {
            const document = new HwpDocument(bytes);
            expect(document.pageCount()).toBeGreaterThan(0);
            const svg = document.renderPageSvg(0);
            expect(svg).toMatch(/^<svg\b/);
            expect(svg).toContain('<clipPath');
            if (expectsImage) {
                expect(svg).toContain('<image');
                expect(svg).toContain('href="data:image/png;base64,');
                expect(svg).toContain('href="data:image/bmp;base64,');
            }
            document.free();
            const container = window.document.createElement('div');
            const handle = await mountHwpViewer(
                { fileName: index === 0 ? 'actual.hwp' : 'actual.hwpx', data: bytes }, container,
                { assets: { resolveAssetUrl: async (path) => path }, i18n: { t: (key, args) => `${key}${args ? JSON.stringify(args) : ''}` }, logger: { log: () => undefined } },
                { loadRhwp: async () => ({ HwpDocument }) }
            );
            const mountedSvg = container.shadowRoot?.querySelector('svg');
            expect(mountedSvg?.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'clipPath').length).toBeGreaterThan(0);
            if (expectsImage) expect(mountedSvg?.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')[0]?.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
            if (expectsImage) expect([...mountedSvg?.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image') ?? []].some((node) => node.getAttribute('href')?.startsWith('data:image/bmp;base64,'))).toBe(true);
            handle.dispose();
        }
    });
});

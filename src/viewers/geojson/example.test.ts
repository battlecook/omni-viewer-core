// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { mountGeoJsonViewer } from './index.js';

const html = readFileSync(resolve('examples/geojson/index.html'), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!
    .replace(/^\s*import [^\n]+;$/gm, '');

async function runExample() {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lifecycle = new EventTarget();
    const data = new TextEncoder().encode('{"type":"Point","coordinates":[127,37]}');
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => data.buffer }));
    // Execute the actual example module with local services; its imports are
    // supplied explicitly and its document/lifecycle remain isolated per test.
    new Function('mountGeoJsonViewer', 'createCatalogI18n', 'fetch', 'window', 'document', 'navigator', script)(
        mountGeoJsonViewer, createCatalogI18n, fetch, lifecycle, doc, { language: 'en' }
    );
    const map = () => doc.getElementById('viewer')?.firstElementChild?.shadowRoot?.querySelector('svg');
    await vi.waitFor(() => expect(map()).toBeTruthy());
    return { lifecycle, map, fetch };
}

describe('GeoJSON browser example lifecycle', () => {
    it('retains the map when a cached document is hidden and restored', async () => {
        const example = await runExample();
        try {
            const original = example.map();
            example.lifecycle.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            example.lifecycle.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
            expect(example.map()).toBe(original);
            expect(example.fetch).toHaveBeenCalledTimes(1);
        } finally { example.lifecycle.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); }
    });

    it('disposes the viewer when the document is being discarded', async () => {
        const example = await runExample();
        example.lifecycle.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        expect(example.map()).toBeNull();
    });
});

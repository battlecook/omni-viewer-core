// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogI18n } from '../../i18n/index.js';
import { apiJson, apiObject, apiYaml, swaggerYaml } from '../../parsers/openapi/__tests__/fixtures.js';
import { loadYamlParserDeps } from '../../parsers/yaml/self-loading.js';
import { MountAbortedError, type ViewerHandle } from '../types.js';
import { mountOpenApiViewer, type OpenApiMountOptions, type OpenApiViewerContext } from './index.js';
import { mountSelfLoadingOpenApiViewer } from './self-loading.js';

const handles: ViewerHandle[] = [];
const ctx: OpenApiViewerContext = { assets: { resolveAssetUrl: async path => path }, logger: { log: vi.fn() }, i18n: createCatalogI18n() };
const bytes = (text: string) => new TextEncoder().encode(text);
async function mount(text = apiJson(), options: OpenApiMountOptions = {}, context = ctx) {
    const container = document.createElement('div'); document.body.append(container);
    const handle = await mountOpenApiViewer({ fileName: /^\s*[{[]/.test(text) ? 'api.json' : 'api.yaml', data: bytes(text) }, container, context, options); handles.push(handle);
    return { container, root: container.shadowRoot ?? container, handle };
}
function button(root: ParentNode, label: string): HTMLButtonElement {
    const node = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label);
    if (!node) throw new Error(`Missing button ${label}`); return node;
}
function tab(root: ParentNode, label: string): void { button(root, label).click(); }
afterEach(() => { for (const handle of handles.splice(0)) handle.dispose(); document.body.replaceChildren(); });

describe('OpenAPI viewer', () => {
    it('mounts offline documentation with inherited parameters, resolved responses and lazy definitions', async () => {
        const { root } = await mount();
        expect(root.querySelector('style')?.textContent).toContain('.omni-openapi');
        expect(root.querySelector('h1')?.textContent).toBe('Pet API');
        expect(root.querySelectorAll('.omni-openapi__operation')).toHaveLength(4);
        const detail = root.querySelector('.omni-openapi__detail')!;
        expect(detail.textContent).toContain('Find a pet'); expect(detail.textContent).toContain('Override');
        expect(detail.textContent).toContain('A pet'); expect(detail.textContent).toContain('bearer');
        const definition = detail.querySelector('details')!;
        expect(definition.querySelector('pre')).toBeNull();
        definition.open = true; definition.dispatchEvent(new Event('toggle'));
        expect(definition.querySelector('pre')?.textContent).toContain('schema');
        expect(root.querySelector('iframe,script,img')).toBeNull();
    });

    it('filters by search, HTTP method and tag, and shows an empty result', async () => {
        const { root } = await mount();
        const method = root.querySelector<HTMLSelectElement>('select[data-filter=method]')!;
        method.value = 'POST'; method.dispatchEvent(new Event('change', { bubbles: true }));
        expect(root.querySelectorAll('.omni-openapi__operation')).toHaveLength(2);
        const tags = root.querySelector<HTMLSelectElement>('select[data-filter=tag]')!;
        tags.value = 'pets'; tags.dispatchEvent(new Event('change', { bubbles: true }));
        expect(root.querySelectorAll('.omni-openapi__operation')).toHaveLength(1);
        const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
        search.value = 'MISSING'; search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(root.querySelectorAll('.omni-openapi__operation')).toHaveLength(0);
        expect(root.querySelector('.omni-openapi__detail')?.textContent).toContain('No matching operations.');
    });

    it('selects operations and handles explicit anonymous authentication', async () => {
        const { root } = await mount();
        root.querySelectorAll<HTMLButtonElement>('.omni-openapi__operation')[1]!.click();
        expect(root.querySelector('.omni-openapi__detail')?.textContent).toContain('Deprecated');
        expect(root.querySelector('.omni-openapi__detail')?.textContent).toContain('No authentication requirement');
        expect(root.querySelectorAll('.omni-openapi__operation[aria-pressed=true]')).toHaveLength(1);
    });

    it('switches to schemas, authentication and the exact original source, including comments', async () => {
        const yamlDeps = await loadYamlParserDeps();
        const { root } = await mount(apiYaml, { yamlDeps });
        tab(root, 'Schemas');
        const schemas = root.querySelector<HTMLElement>('[role=tabpanel][aria-label=Schemas]')!;
        expect(schemas.hidden).toBe(false); expect(schemas.textContent).toContain('Pet'); expect(schemas.textContent).toContain('name');
        tab(root, 'Original JSON / YAML');
        expect(root.querySelector('.omni-openapi__source')?.textContent).toBe(apiYaml);
        const json = await mount(); tab(json.root, 'Authentication');
        expect(json.root.querySelector('[role=tabpanel][aria-label=Authentication]')?.textContent).toContain('JWT');
    });

    it('renders Swagger body parameters and response schemas', async () => {
        const yamlDeps = await loadYamlParserDeps();
        const { root } = await mount(swaggerYaml, { yamlDeps });
        const detail = root.querySelector('.omni-openapi__detail')!;
        expect(detail.textContent).toContain('body'); expect(detail.textContent).toContain('application/json');
        expect(detail.textContent).toContain('Created'); expect(detail.textContent).toContain('https://legacy.example.test/v2');
    });

    it('self-loads YAML only when needed', async () => {
        const container = document.createElement('div');
        handles.push(await mountSelfLoadingOpenApiViewer({ fileName: 'api.yaml', data: bytes(apiYaml) }, container, ctx));
        expect(container.shadowRoot?.querySelector('h1')?.textContent).toBe('Pet API');
    });

    it('paginates large lists and resets pagination when filters change', async () => {
        const source = { openapi: '3.1.0', info: { title: 'Large', version: '1' }, paths: Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`/items/${i}`, { get: { responses: {} } }])) };
        const { root } = await mount(JSON.stringify(source));
        expect(root.querySelectorAll('.omni-openapi__operation')).toHaveLength(50);
        button(root, 'Next').click(); button(root, 'Next').click();
        expect(root.querySelectorAll('.omni-openapi__operation')).toHaveLength(25);
        const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
        search.value = '/items/1'; search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(root.querySelector('.omni-openapi__pager')?.textContent).toContain('1 / 1');
    });

    it('bounds rendered rows when many responses share a large referenced schema', async () => {
        const source = { openapi: '3.1.0', info: { title: 'Shared schemas', version: '1' }, paths: { '/items': { get: {
            responses: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [String(200 + i), { description: 'Result', content: {
                'application/json': { schema: { $ref: '#/components/schemas/Item' } }
            } }]))
        } } }, components: { schemas: { Item: { type: 'object', properties: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, { type: 'string' }])) } } } };
        const { root } = await mount(JSON.stringify(source));
        expect(root.querySelectorAll('.omni-openapi__detail tbody tr').length).toBeLessThanOrEqual(1000);
        expect(root.querySelector('.omni-openapi__detail')?.textContent).toContain('View definition');
    });

    it('bounds repeated rendered descriptions while preserving the source', async () => {
        const description = 'd'.repeat(100_000);
        const source = { openapi: '3.1.0', info: { title: 'Shared descriptions', version: '1' }, paths: { '/pets': { get: {
            responses: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(200 + i), { description: 'OK', content: {
                'application/json': { schema: { $ref: '#/components/schemas/Item' } }
            } }]))
        } } }, components: { schemas: { Item: { type: 'string', description } } } };
        const text = JSON.stringify(source);
        const { root } = await mount(text);
        expect(root.querySelector('.omni-openapi__detail')!.textContent!.length).toBeLessThan(530_000);
        expect(root.querySelector('.omni-openapi__detail')!.textContent).toContain('Some text is shortened');
        expect(root.querySelector('.omni-openapi__source')!.textContent).toBe(text);
    });

    it('shows properties and required fields declared beside schema references', async () => {
        const source = { openapi: '3.1.0', info: { title: 'Extended', version: '1' }, components: { schemas: {
            Base: { type: 'object', properties: { id: { type: 'integer' } } },
            Extended: { $ref: '#/components/schemas/Base', properties: { name: { type: 'string' } }, required: ['name'] }
        } } };
        const { root } = await mount(JSON.stringify(source)); tab(root, 'Schemas');
        const panel = root.querySelector('[role=tabpanel][aria-label=Schemas]')!;
        const card = [...panel.querySelectorAll('.omni-openapi__card')].find(node => node.querySelector('h2')?.textContent === 'Extended')!;
        const rows = [...card.querySelectorAll('tbody tr')];
        expect(rows.map(row => row.querySelector('td')?.textContent)).toEqual(['name', 'id']);
        expect(rows[0]!.textContent).toContain('Yes');
        const raw = card.querySelector('details')!; raw.open = true; raw.dispatchEvent(new Event('toggle'));
        expect(raw.querySelector('pre')?.textContent).toContain('"name"');
        expect(raw.querySelector('pre')?.textContent).toContain('"$ref"');
    });

    it('preserves focus when selecting operations and paging through operations or schemas', async () => {
        const small = await mount();
        const second = small.root.querySelectorAll<HTMLButtonElement>('.omni-openapi__operation')[1]!;
        second.focus(); const id = second.dataset.id; second.click();
        expect(small.container.shadowRoot!.activeElement).toMatchObject({ dataset: { id } });
        const source = { openapi: '3.1.0', info: { title: 'Pages', version: '1' },
            paths: Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`/p${i}`, { get: { responses: {} } }])),
            components: { schemas: Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`S${i}`, { type: 'string' }])) } };
        const { root, container } = await mount(JSON.stringify(source));
        const next = root.querySelector<HTMLButtonElement>('button[data-action=next]')!;
        next.focus(); next.click();
        expect((container.shadowRoot!.activeElement as HTMLElement).dataset.action).toBe('next');
        tab(root, 'Schemas');
        const schemaNext = root.querySelector<HTMLButtonElement>('button[data-action=schemaNext]')!;
        schemaNext.focus(); schemaNext.click();
        expect((container.shadowRoot!.activeElement as HTMLElement).dataset.action).toBe('schemaNext');
        (container.shadowRoot!.activeElement as HTMLButtonElement).click();
        expect((container.shadowRoot!.activeElement as HTMLElement).dataset.action).toBe('schemaPrevious');
    });

    it('disables clipboard actions when unavailable and reports copy success or failure', async () => {
        const missing = await mount(); expect(button(missing.root, 'Copy path').disabled).toBe(true);
        const writeText = vi.fn().mockResolvedValue(undefined);
        const { root } = await mount(apiJson(), {}, { ...ctx, clipboard: { writeText } });
        button(root, 'Copy path').click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('/pets/{id}'));
        expect(root.querySelector('[role=status]')?.textContent).toBe('Copied.');
        writeText.mockRejectedValue(new Error('clipboard denied'));
        button(root, 'Copy operation JSON').click();
        await vi.waitFor(() => expect(root.querySelector('[role=status]')?.textContent).toContain('Could not copy'));
    });

    it('copies complete operation JSON beyond the definition preview cap', async () => {
        const value = 'a'.repeat(70_000);
        const writeText = vi.fn().mockResolvedValue(undefined);
        const source = { openapi: '3.1.0', info: { title: 'Large example', version: '1' }, paths: { '/pets': { get: {
            responses: { '200': { description: 'OK', content: { 'text/plain': { example: value } } } }
        } } } };
        const { root } = await mount(JSON.stringify(source), {}, { ...ctx, clipboard: { writeText } });
        button(root, 'Copy operation JSON').click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        const copied = JSON.parse(writeText.mock.calls[0]![0]);
        expect(copied.responses['200'].content['text/plain'].example).toBe(value);
    });

    it('supports keyboard tab navigation and Korean messages', async () => {
        const { root } = await mount(apiJson(), {}, { ...ctx, i18n: createCatalogI18n('ko') });
        const first = root.querySelector<HTMLButtonElement>('[role=tab]')!;
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(root.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('스키마');
        expect(root.querySelector('h1')?.textContent).toBe('Pet API');
    });

    it('renders hostile descriptions as text and never follows external references', async () => {
        const object = apiObject(); object.info.description = '<img src=x onerror=alert(1)><script>alert(1)</script>';
        const { root } = await mount(JSON.stringify(object));
        expect(root.querySelector('img,script')).toBeNull(); expect(root.textContent).toContain('<script>alert(1)</script>');
    });

    it('shows bounded source for malformed documents, unsupported versions and missing YAML dependencies', async () => {
        for (const text of ['{"broken":', apiJson().replace('3.1.0', '4.0.0'), apiYaml]) {
            const { root } = await mount(text);
            expect(root.querySelector('.omni-openapi__warning')).not.toBeNull();
            expect(root.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Original JSON / YAML');
            expect(root.querySelector('.omni-openapi__source')?.textContent).toBe(text);
        }
    });

    it('cleans up shadow and scoped mounts, removes listeners and tolerates repeated disposal', async () => {
        for (const styleIsolation of ['shadow', 'scoped'] as const) {
            const writeText = vi.fn().mockResolvedValue(undefined);
            const { root, container, handle } = await mount(apiJson(), { styleIsolation }, { ...ctx, clipboard: { writeText } });
            const copy = button(root, 'Copy path');
            handle.dispose(); handle.dispose(); copy.click(); await Promise.resolve();
            expect(root.childNodes).toHaveLength(0); expect(container.classList.contains('omni-viewer--openapi')).toBe(false);
            expect(writeText).not.toHaveBeenCalled();
        }
    });

    it('rejects aborted mounts without adding UI', async () => {
        const abort = new AbortController(); abort.abort(); const container = document.createElement('div');
        await expect(mountOpenApiViewer({ fileName: 'api.json', data: bytes(apiJson()) }, container, ctx, { signal: abort.signal })).rejects.toBeInstanceOf(MountAbortedError);
        await expect(mountSelfLoadingOpenApiViewer({ fileName: 'api.yaml', data: bytes(apiYaml) }, container, ctx, { signal: abort.signal })).rejects.toBeInstanceOf(MountAbortedError);
        expect(container.childNodes).toHaveLength(0); expect(container.shadowRoot).toBeNull();
    });
});

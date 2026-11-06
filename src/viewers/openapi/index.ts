import type { ClipboardService, HostContext } from '../../host/index.js';
import { parseOpenApi, openApiField as field, openApiText as textOf, openApiEntries, openApiItems, openApiStrings,
    printOpenApiNode, serializeOpenApiNode, resolveOpenApiRef, type OpenApiDocument, type OpenApiNode, type OpenApiOperation, type OpenApiParseOptions, type OpenApiRefContext } from '../../parsers/openapi/index.js';
import { decodeUtf8, type Diagnostic } from '../../parsers/types.js';
import { MountAbortedError, VIEWER_ROOT_CLASS, type MountOptions, type ViewerHandle, type ViewerInput } from '../types.js';
import { createOpenApiController, OPENAPI_PAGE_SIZE, type OpenApiTab } from './controller.js';
import { openApiViewerCss } from './styles.js';

export { openApiViewerCss } from './styles.js';
export * from './controller.js';
export { parseOpenApi } from '../../parsers/openapi/index.js';
export type { OpenApiDocument, OpenApiOperation, OpenApiNode, OpenApiParseOptions } from '../../parsers/openapi/index.js';
export const OPENAPI_VIEWER_META = { id: 'openapi', displayNameKey: 'openapi.title', extensions: [] as string[], priority: 20,
    requiredServices: [] as const, optionalServices: ['clipboard'] as const, inputOwnership: 'borrows' as const };
export type OpenApiViewerContext = HostContext & { clipboard?: ClipboardService };
export interface OpenApiMountOptions extends MountOptions, OpenApiParseOptions {}

const MAX_SOURCE_CHARS = 512 * 1024;
const MAX_DETAIL_ROWS = 200;
const MAX_RENDER_BUDGET = 1000;
const MAX_RENDER_CHARS = 512 * 1024;
const MAX_LABEL_CHARS = 16 * 1024;
let instanceSequence = 0;

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export async function mountOpenApiViewer(input: ViewerInput, container: HTMLElement, ctx: OpenApiViewerContext, options: OpenApiMountOptions = {}): Promise<ViewerHandle> {
    if (options.signal?.aborted) throw new MountAbortedError();
    const { result } = parseOpenApi(input.data, /\.json$/i.test(input.fileName) && !options.format ? { ...options, format: 'json' } : options);
    if (options.signal?.aborted) throw new MountAbortedError();
    return mountOpenApiDocument(result.status === 'failed' ? undefined : result.document, input, container, ctx, options,
        result.status === 'failed' ? [{ severity: 'error', code: result.failure.code, messageKey: result.failure.messageKey, ...('args' in result.failure ? { args: result.failure.args } : {}) }, ...result.diagnostics] : result.diagnostics);
}

/** Mount a model directly for hosts that parse in a worker. */
export function mountOpenApiDocument(model: OpenApiDocument | undefined, input: ViewerInput, container: HTMLElement,
    ctx: OpenApiViewerContext, options: MountOptions = {}, diagnostics: readonly Diagnostic[] = []): ViewerHandle {
    if (options.signal?.aborted) throw new MountAbortedError();
    const t = (key: string, args?: Record<string, string | number>) => ctx.i18n.t(key, args);
    let textBudget: { remaining: number; truncated: boolean } | undefined;
    let otherTextTruncated = false;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
        if (text === undefined) return createElement(tag, className);
        const source = className === 'omni-openapi__source';
        const limit = source ? MAX_SOURCE_CHARS : Math.max(0, Math.min(MAX_LABEL_CHARS, textBudget?.remaining ?? MAX_LABEL_CHARS));
        const clipped = text.length > limit ? limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : '' : text;
        if (!source && textBudget) { textBudget.remaining -= clipped.length; textBudget.truncated ||= clipped.length < text.length; }
        else if (!source) otherTextTruncated ||= clipped.length < text.length;
        return createElement(tag, className, clipped);
    };
    const finishTextBudget = (target: HTMLElement, previous: typeof textBudget): void => {
        if (textBudget?.truncated) target.append(createElement('p', 'omni-openapi__warning', t('openapi.textLimited')));
        textBudget = previous;
    };
    const shadow = (options.styleIsolation ?? 'shadow') === 'shadow' && typeof container.attachShadow === 'function';
    const root = shadow ? container.shadowRoot ?? container.attachShadow({ mode: 'open' }) : container;
    let style: HTMLStyleElement | undefined;
    if (shadow) { style = element('style'); style.textContent = openApiViewerCss; root.append(style); }
    else container.classList.add(VIEWER_ROOT_CLASS, 'omni-viewer--openapi');
    const frame = element('div', 'omni-openapi');
    root.append(frame);
    const disposers: (() => void)[] = [];
    let disposed = false;
    const status = element('div', 'omni-openapi__status');
    status.setAttribute('role', 'status');
    const controller = model ? createOpenApiController(model) : undefined;
    const tabs = ['operations', 'schemas', 'security', 'source'] as const;
    const panels = new Map<OpenApiTab, HTMLElement>();
    const tabButtons = new Map<OpenApiTab, HTMLButtonElement>();
    const instanceId = `omni-openapi-${++instanceSequence}`;
    const rawNodes = new WeakMap<HTMLDetailsElement, OpenApiNode>();
    const copyValues = new WeakMap<HTMLButtonElement, () => string>();
    let schemaPage = 0;
    let renderBudget = MAX_RENDER_BUDGET;
    const button = (label: string, action: string): HTMLButtonElement => {
        const node = element('button', undefined, label); node.type = 'button'; node.dataset.action = action; return node;
    };
    const copyButton = (label: string, value: () => string): HTMLButtonElement => {
        const node = button(t(label), 'copy'); node.disabled = !ctx.clipboard;
        if (!ctx.clipboard) node.title = t('openapi.noClipboard');
        copyValues.set(node, value); return node;
    };
    const raw = (node: OpenApiNode, label = t('openapi.definition')): HTMLDetailsElement => {
        const details = element('details'); details.append(element('summary', undefined, label)); rawNodes.set(details, node); return details;
    };
    const resolved = (node: OpenApiNode | undefined, context: OpenApiRefContext = 'schema'): OpenApiNode | undefined => model ? resolveOpenApiRef(model.root, node, 32, context) ?? node : node;
    const nodeType = (node: OpenApiNode | undefined): string => {
        const ref = textOf(field(node, '$ref'));
        const schema = resolved(node);
        const type = field(schema, 'type');
        let label = type?.kind === 'array' ? openApiStrings(type).join(' | ') : textOf(type);
        if (!label && schema?.kind === 'boolean') label = String(schema.value);
        if (!label && field(schema, 'properties')) label = 'object';
        if (!label) label = ref || (field(schema, 'oneOf') ? 'oneOf' : field(schema, 'anyOf') ? 'anyOf' : field(schema, 'allOf') ? 'allOf' : '—');
        const format = textOf(field(schema, 'format'));
        return `${label}${format ? ` (${format})` : ''}${field(schema, 'nullable')?.value === true ? ' | null' : ''}`;
    };
    const table = (headers: string[], rows: string[][], total = rows.length): HTMLElement => {
        const wrap = element('div', 'omni-openapi__table-wrap'), node = element('table'), head = element('thead'), tr = element('tr');
        for (const label of headers) { const th = element('th', undefined, t(`openapi.${label}`)); th.scope = 'col'; tr.append(th); }
        head.append(tr); const body = element('tbody');
        const shown = rows.slice(0, Math.max(0, Math.min(MAX_DETAIL_ROWS, renderBudget)));
        renderBudget -= shown.length;
        for (const values of shown) { const row = element('tr'); for (const value of values) row.append(element('td', undefined, value)); body.append(row); }
        node.append(head, body); wrap.append(node);
        if (total > shown.length) wrap.append(element('p', 'omni-openapi__muted', t('openapi.rowsLimited', { count: shown.length })));
        return wrap;
    };
    const schemaRows = new WeakMap<OpenApiNode, { properties: OpenApiNode[]; required: Set<string>; truncated: boolean }>();
    const requiredNames = new WeakMap<OpenApiNode, Set<string>>();
    const propertiesOf = (schema: OpenApiNode) => {
        const cached = schemaRows.get(schema);
        if (cached) return cached;
        const properties = new Map<string, OpenApiNode>(), requirements: OpenApiNode[] = [], seen = new Set<OpenApiNode>();
        const pending: OpenApiNode[] = [schema];
        let truncated = false;
        while (pending.length && seen.size < 256) {
            const current = resolved(pending.pop()!);
            if (!current || seen.has(current)) continue;
            seen.add(current);
            // Inspect each declared layer; getters deliberately preserve the
            // source's sibling keywords instead of flattening shared schemas.
            const own = (key: string) => current.kind === 'object' ? current.children?.find(child => child.key === key) : undefined;
            for (const property of openApiEntries(own('properties'))) {
                if (properties.has(property.key)) continue;
                if (properties.size >= MAX_DETAIL_ROWS) { truncated = true; break; }
                properties.set(property.key, property);
            }
            const required = own('required'); if (required?.kind === 'array') requirements.push(required);
            if (current.referenceTarget) pending.push(current.referenceTarget);
            for (const part of openApiItems(own('allOf'))) pending.push(part);
        }
        truncated ||= pending.length > 0;
        const required = new Set<string>();
        for (const requirement of requirements) {
            let names = requiredNames.get(requirement);
            if (!names) { names = new Set(openApiStrings(requirement)); requiredNames.set(requirement, names); }
            for (const name of properties.keys()) if (names.has(name)) required.add(name);
        }
        const result = { properties: [...properties.values()], required, truncated };
        schemaRows.set(schema, result);
        return result;
    };
    const schemaView = (node: OpenApiNode): HTMLElement => {
        const section = element('section');
        const schema = resolved(node);
        section.append(element('p', 'omni-openapi__muted', nodeType(node)));
        const description = textOf(field(schema, 'description'));
        if (description) section.append(element('p', 'omni-openapi__description', description));
        const { properties, required, truncated } = schema && renderBudget > 0 ? propertiesOf(schema) : { properties: [], required: new Set<string>(), truncated: false };
        if (properties.length) section.append(table(['name', 'type', 'required', 'description'], properties.slice(0, Math.max(0, Math.min(MAX_DETAIL_ROWS, renderBudget))).map(property => [property.key,
            nodeType(property), required.has(property.key) ? t('openapi.yes') : t('openapi.no'), textOf(field(resolved(property), 'description'))]), properties.length + (truncated ? 1 : 0)));
        section.append(raw(node));
        return section;
    };
    const media = (node: OpenApiNode | undefined, fallbackSchema?: OpenApiNode, mediaTypes: readonly string[] = []): HTMLElement => {
        const section = element('section');
        for (const entry of openApiEntries(node).slice(0, MAX_DETAIL_ROWS)) {
            if (renderBudget <= 0) { section.append(raw(node!)); break; }
            renderBudget--;
            const card = element('div', 'omni-openapi__card'); card.append(element('strong', undefined, entry.key));
            const schema = field(entry, 'schema'); if (schema) card.append(schemaView(schema));
            const example = field(entry, 'example'); if (example) card.append(raw(example, t('openapi.example')));
            for (const exampleNode of openApiEntries(field(entry, 'examples')).slice(0, 20)) {
                const value = resolved(exampleNode, 'reference'); if (value) card.append(raw(field(value, 'value') ?? value, `${t('openapi.example')}: ${exampleNode.key}`));
            }
            card.append(raw(entry)); section.append(card);
        }
        if (fallbackSchema) { if (mediaTypes.length) section.append(element('p', 'omni-openapi__muted', mediaTypes.join(', '))); section.append(schemaView(fallbackSchema)); }
        return section;
    };
    const header = element('header');
    header.append(element('div', 'omni-openapi__muted', t('openapi.title')), element('h1', undefined, model?.title ?? input.fileName));
    if (model) {
        header.append(element('div', 'omni-openapi__muted', `${model.specVersion === '2.0' ? 'Swagger' : 'OpenAPI'} ${model.specVersion} · ${model.apiVersion} · ${input.fileName}`));
        if (model.description) header.append(element('p', 'omni-openapi__description', model.description));
        header.append(element('p', 'omni-openapi__muted', t('openapi.summary', { operations: model.operations.length, schemas: model.schemas.length })));
    }
    frame.append(header);
    for (const diagnostic of diagnostics.slice(0, 50)) frame.append(element('div', 'omni-openapi__warning', t(diagnostic.messageKey, diagnostic.args)));
    const tablist = element('nav', 'omni-openapi__tabs'); tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', t('openapi.title'));
    for (const tab of tabs) {
        const node = button(t(`openapi.${tab}`), 'tab'); node.dataset.tab = tab; node.setAttribute('role', 'tab'); node.disabled = !model && tab !== 'source';
        node.id = `${instanceId}-tab-${tab}`;
        node.setAttribute('aria-controls', `${instanceId}-panel-${tab}`);
        tabButtons.set(tab, node); tablist.append(node);
        const panel = element('section'); panel.id = `${instanceId}-panel-${tab}`; panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-label', t(`openapi.${tab}`)); panel.setAttribute('aria-labelledby', node.id); panel.tabIndex = 0; panels.set(tab, panel);
    }
    frame.append(tablist, status, ...panels.values());
    const source = panels.get('source')!;
    const sourceText = model?.text ?? decodeUtf8(input.data.subarray(0, MAX_SOURCE_CHARS * 4));
    source.append(copyButton('openapi.copySource', () => sourceText), element('pre', 'omni-openapi__source', sourceText.slice(0, MAX_SOURCE_CHARS)));
    if (sourceText.length > MAX_SOURCE_CHARS || (!model && input.data.byteLength > MAX_SOURCE_CHARS * 4)) source.append(element('p', 'omni-openapi__warning', t('openapi.sourceLimited', { count: MAX_SOURCE_CHARS })));

    const operationPanel = panels.get('operations')!;
    const filters = element('div', 'omni-openapi__filters'), search = element('input', 'omni-openapi__search'), methodSelect = element('select'), tagSelect = element('select');
    search.type = 'search'; search.placeholder = t('openapi.search'); search.setAttribute('aria-label', t('openapi.search')); search.dataset.filter = 'search';
    methodSelect.setAttribute('aria-label', t('openapi.method')); methodSelect.dataset.filter = 'method';
    tagSelect.setAttribute('aria-label', t('openapi.tag')); tagSelect.dataset.filter = 'tag';
    const addOption = (select: HTMLSelectElement, label: string, value: string): void => { const option = element('option', undefined, label); option.value = value; select.append(option); };
    addOption(methodSelect, t('openapi.allMethods'), ''); addOption(tagSelect, t('openapi.allTags'), '');
    for (const method of new Set(model?.operations.map(operation => operation.method))) addOption(methodSelect, method, method);
    for (const tag of model?.tags ?? []) addOption(tagSelect, tag.name, tag.name);
    filters.append(search, methodSelect, tagSelect);
    const workspace = element('div', 'omni-openapi__workspace'), list = element('aside', 'omni-openapi__list'), detail = element('article', 'omni-openapi__detail');
    list.setAttribute('aria-label', t('openapi.operations')); detail.setAttribute('aria-label', t('openapi.details'));
    workspace.append(list, detail); const pager = element('div', 'omni-openapi__pager'); operationPanel.append(filters, pager, workspace);

    const renderOperation = (operation: OpenApiOperation): void => {
        const previousBudget = textBudget; textBudget = { remaining: MAX_RENDER_CHARS, truncated: false };
        renderBudget = MAX_RENDER_BUDGET;
        detail.replaceChildren();
        const badge = element('span', 'omni-openapi__method', operation.method); badge.dataset.method = operation.method;
        detail.append(badge, element('h2', undefined, operation.path));
        if (operation.kind === 'webhook') detail.append(element('span', 'omni-openapi__badge', t('openapi.webhook')));
        if (operation.deprecated) detail.append(element('span', 'omni-openapi__badge', t('openapi.deprecated')));
        for (const tag of operation.tags.slice(0, MAX_DETAIL_ROWS)) detail.append(element('span', 'omni-openapi__badge', tag));
        if (operation.summary) detail.append(element('h3', undefined, operation.summary));
        if (operation.operationId) detail.append(element('code', undefined, operation.operationId));
        if (operation.description) detail.append(element('p', 'omni-openapi__description', operation.description));
        const actions = element('div', 'omni-openapi__actions');
        actions.append(copyButton('openapi.copyPath', () => operation.path), copyButton('openapi.copyOperation', () => serializeOpenApiNode(operation.node)));
        detail.append(actions, element('h3', undefined, t('openapi.servers')));
        for (const server of operation.servers.slice(0, MAX_DETAIL_ROWS)) detail.append(element('p', 'omni-openapi__muted', `${server.url}${server.description ? ` — ${server.description}` : ''}`));
        detail.append(element('h3', undefined, t('openapi.parameters')));
        if (operation.parameters.length) {
            detail.append(table(['name', 'in', 'type', 'required', 'description'], operation.parameters.slice(0, MAX_DETAIL_ROWS).map(parameter => [textOf(field(parameter, 'name')) || textOf(field(parameter, '$ref')),
                textOf(field(parameter, 'in')), nodeType(field(parameter, 'schema') ?? parameter),
                field(parameter, 'required')?.value === true || textOf(field(parameter, 'in')) === 'path' ? t('openapi.yes') : t('openapi.no'), textOf(field(parameter, 'description'))]), operation.parameters.length));
            for (const parameter of operation.parameters.slice(0, MAX_DETAIL_ROWS)) detail.append(raw(parameter, `${t('openapi.parameter')}: ${textOf(field(parameter, 'name')) || textOf(field(parameter, '$ref'))}`));
        } else detail.append(element('p', 'omni-openapi__muted', t('openapi.none')));
        if (operation.requestBody) {
            detail.append(element('h3', undefined, t('openapi.requestBody')));
            if (field(operation.requestBody, 'required')?.value === true) detail.append(element('span', 'omni-openapi__badge', t('openapi.required')));
            const description = textOf(field(operation.requestBody, 'description')); if (description) detail.append(element('p', 'omni-openapi__description', description));
            detail.append(media(field(operation.requestBody, 'content')), raw(operation.requestBody));
        }
        if (operation.consumes.length) detail.append(element('p', 'omni-openapi__muted', `${t('openapi.consumes')}: ${operation.consumes.join(', ')}`));
        detail.append(element('h3', undefined, t('openapi.responses')));
        if (!operation.responses.length) detail.append(element('p', 'omni-openapi__muted', t('openapi.none')));
        for (const response of operation.responses.slice(0, MAX_DETAIL_ROWS)) {
            const card = element('section', 'omni-openapi__card');
            card.append(element('strong', undefined, response.name), element('p', 'omni-openapi__description', textOf(field(response.node, 'description'))),
                media(field(response.node, 'content'), field(response.node, 'schema'), operation.produces));
            const headers = field(response.node, 'headers'); if (headers) card.append(raw(headers, t('openapi.headers')));
            const examples = field(response.node, 'examples'); if (examples) card.append(raw(examples, t('openapi.example')));
            card.append(raw(response.node)); detail.append(card);
        }
        detail.append(element('h3', undefined, t('openapi.security')));
        const requirements = openApiItems(operation.security);
        detail.append(element('p', 'omni-openapi__muted', requirements.length ? t('openapi.securityAlternatives') : t('openapi.noSecurity')));
        for (const requirement of requirements.slice(0, MAX_DETAIL_ROWS)) {
            const schemes = openApiEntries(requirement);
            detail.append(element('p', undefined, schemes.length ? schemes.map(scheme => `${scheme.key}${openApiStrings(scheme).length ? ` (${openApiStrings(scheme).join(', ')})` : ''}`).join(' + ') : t('openapi.anonymous')));
        }
        detail.append(raw(operation.node, t('openapi.operationSource')));
        finishTextBudget(detail, previousBudget);
    };
    const renderOperations = (): void => {
        if (!controller || !model) return;
        const active = shadow ? (root as ShadowRoot).activeElement : container.ownerDocument.activeElement;
        const focus = active instanceof HTMLElement && (list.contains(active) || pager.contains(active)) ? { action: active.dataset.action, id: active.dataset.id } : undefined;
        const { state, filtered } = controller;
        list.replaceChildren(); pager.replaceChildren();
        const count = element('span', 'omni-openapi__muted', t('openapi.results', { count: filtered.length, total: model.operations.length }));
        const previous = button(t('openapi.previous'), 'previous'), next = button(t('openapi.next'), 'next');
        previous.disabled = state.page === 0; next.disabled = (state.page + 1) * OPENAPI_PAGE_SIZE >= filtered.length;
        pager.append(count, previous, element('span', undefined, t('openapi.page', { page: state.page + 1, pages: Math.max(1, Math.ceil(filtered.length / OPENAPI_PAGE_SIZE)) })), next);
        const page = filtered.slice(state.page * OPENAPI_PAGE_SIZE, (state.page + 1) * OPENAPI_PAGE_SIZE);
        for (const operation of page) {
            const node = button('', 'operation'); node.className = 'omni-openapi__operation'; node.dataset.id = operation.id;
            node.setAttribute('aria-pressed', String(state.selectedId === operation.id));
            const method = element('span', 'omni-openapi__method', operation.method); method.dataset.method = operation.method;
            node.append(method, element('code', undefined, operation.path));
            if (operation.summary) node.append(element('span', 'omni-openapi__muted', operation.summary));
            list.append(node);
        }
        const selected = page.find(operation => operation.id === state.selectedId);
        if (selected) renderOperation(selected); else { detail.replaceChildren(element('p', 'omni-openapi__muted', t('openapi.empty'))); }
        if (focus) {
            const replacement = [...operationPanel.querySelectorAll<HTMLButtonElement>('button[data-action]')].find(node => !node.disabled && node.dataset.action === focus.action && node.dataset.id === focus.id);
            (replacement ?? (previous.disabled ? list.querySelector<HTMLButtonElement>('button') : previous))?.focus();
        }
    };
    const renderSchemas = (): void => {
        if (!model) return;
        const previousBudget = textBudget; textBudget = { remaining: MAX_RENDER_CHARS, truncated: false };
        renderBudget = MAX_RENDER_BUDGET;
        const active = shadow ? (root as ShadowRoot).activeElement : container.ownerDocument.activeElement;
        const focusAction = active instanceof HTMLElement && panels.get('schemas')!.contains(active) ? active.dataset.action : undefined;
        const panel = panels.get('schemas')!; panel.replaceChildren();
        const pager = element('div', 'omni-openapi__pager');
        const previous = button(t('openapi.previous'), 'schemaPrevious'), next = button(t('openapi.next'), 'schemaNext');
        previous.disabled = schemaPage === 0; next.disabled = (schemaPage + 1) * OPENAPI_PAGE_SIZE >= model.schemas.length;
        pager.append(previous, element('span', undefined, t('openapi.page', { page: schemaPage + 1, pages: Math.max(1, Math.ceil(model.schemas.length / OPENAPI_PAGE_SIZE)) })), next); panel.append(pager);
        if (!model.schemas.length) panel.append(element('p', 'omni-openapi__muted', t('openapi.none')));
        for (const schema of model.schemas.slice(schemaPage * OPENAPI_PAGE_SIZE, (schemaPage + 1) * OPENAPI_PAGE_SIZE)) {
            const card = element('article', 'omni-openapi__card'); card.append(element('h2', undefined, schema.name), schemaView(schema.node)); panel.append(card);
        }
        finishTextBudget(panel, previousBudget);
        if (focusAction) {
            const replacement = [previous, next].find(node => node.dataset.action === focusAction && !node.disabled);
            (replacement ?? (previous.disabled ? next : previous)).focus();
        }
    };
    const renderTab = (): void => {
        const active = controller?.state.tab ?? 'source';
        for (const tab of tabs) { const selected = tab === active; panels.get(tab)!.hidden = !selected; tabButtons.get(tab)!.setAttribute('aria-selected', String(selected)); tabButtons.get(tab)!.tabIndex = selected ? 0 : -1; }
    };
    if (model && controller) {
        renderOperations(); renderSchemas();
        const previousBudget = textBudget; textBudget = { remaining: MAX_RENDER_CHARS, truncated: false };
        const securityPanel = panels.get('security')!;
        if (!model.securitySchemes.length) securityPanel.append(element('p', 'omni-openapi__muted', t('openapi.none')));
        for (const scheme of model.securitySchemes.slice(0, MAX_DETAIL_ROWS)) {
            const card = element('article', 'omni-openapi__card'); card.append(element('h2', undefined, scheme.name),
                element('p', 'omni-openapi__muted', [textOf(field(scheme.node, 'type')), textOf(field(scheme.node, 'scheme'))].filter(Boolean).join(' · ')),
                element('p', 'omni-openapi__description', textOf(field(scheme.node, 'description'))), element('pre', undefined, printOpenApiNode(scheme.node)));
            if (scheme.node.referenceTarget) card.append(raw(scheme.node.referenceTarget));
            securityPanel.append(card);
        }
        if (model.securitySchemes.length > MAX_DETAIL_ROWS) securityPanel.append(element('p', 'omni-openapi__muted', t('openapi.rowsLimited', { count: MAX_DETAIL_ROWS })));
        finishTextBudget(securityPanel, previousBudget);
        disposers.push(controller.subscribe(() => { renderOperations(); renderTab(); }));
    }
    renderTab();
    const click = (event: Event): void => {
        const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null;
        if (!target || !frame.contains(target) || target.disabled || disposed) return;
        const action = target.dataset.action;
        if (action === 'tab') controller?.update({ tab: target.dataset.tab as OpenApiTab });
        else if (action === 'operation') controller?.update({ selectedId: target.dataset.id ?? null });
        else if (action === 'previous' || action === 'next') controller?.update({ page: controller.state.page + (action === 'next' ? 1 : -1) });
        else if (action === 'schemaPrevious' || action === 'schemaNext') { schemaPage += action === 'schemaNext' ? 1 : -1; renderSchemas(); }
        else if (action === 'copy' && ctx.clipboard) {
            const value = copyValues.get(target); if (!value) return;
            void Promise.resolve().then(() => disposed ? undefined : ctx.clipboard!.writeText(value())).then(() => { if (!disposed) status.textContent = t('openapi.copied'); })
                .catch(() => { if (!disposed) status.textContent = t('openapi.copyFailed'); });
        }
    };
    const filter = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !controller) return;
        if (target.dataset.filter === 'search' && event.type === 'input') controller.update({ search: target.value });
        else if (target.dataset.filter === 'method') controller.update({ method: target.value });
        else if (target.dataset.filter === 'tag') controller.update({ tag: target.value });
    };
    const toggle = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof HTMLDetailsElement) || !target.open || target.querySelector('pre')) return;
        const node = rawNodes.get(target);
        if (node) {
            target.append(createElement('pre', undefined, printOpenApiNode(node)));
            if (node.referenceTarget) target.append(raw(node.referenceTarget, t('openapi.referencedDefinition')));
        }
    };
    const keydown = (event: KeyboardEvent): void => {
        if (!(event.target instanceof HTMLButtonElement) || event.target.getAttribute('role') !== 'tab') return;
        const enabled = tabs.filter(tab => !tabButtons.get(tab)!.disabled);
        let index = enabled.findIndex(tab => tabButtons.get(tab) === event.target);
        if (event.key === 'ArrowRight') index = (index + 1) % enabled.length;
        else if (event.key === 'ArrowLeft') index = (index + enabled.length - 1) % enabled.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = enabled.length - 1;
        else return;
        event.preventDefault(); const tab = enabled[index]!; controller?.update({ tab }); tabButtons.get(tab)!.focus();
    };
    frame.addEventListener('click', click); frame.addEventListener('input', filter); frame.addEventListener('change', filter); frame.addEventListener('toggle', toggle, true); frame.addEventListener('keydown', keydown);
    if (otherTextTruncated) frame.insertBefore(createElement('p', 'omni-openapi__warning', t('openapi.textLimited')), tablist);
    return { dispose(): void {
        if (disposed) return; disposed = true;
        for (const dispose of disposers) dispose(); controller?.dispose();
        frame.removeEventListener('click', click); frame.removeEventListener('input', filter); frame.removeEventListener('change', filter); frame.removeEventListener('toggle', toggle, true); frame.removeEventListener('keydown', keydown);
        frame.remove(); style?.remove();
        if (!shadow) container.classList.remove(VIEWER_ROOT_CLASS, 'omni-viewer--openapi');
    } };
}
